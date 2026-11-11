import { randomUUID } from 'node:crypto';
import type { ModelCatalogSnapshot } from '../../core/channel/index.js';
import type { SettingsActionRequest, SettingsActionResult, SettingsCapability } from '../../core/settings/index.js';
import {
  ConfigEditError, validateLlmConfiguration,
  saveAgentConfigSection, restoreAgentConfigSection,
  type ConfigSectionEdit,
} from '../../platform/config/index.js';
import type { AgentConfigDocument } from '../../platform/config/types.js';
import type { ExtensionAcquisitionResult, ExtensionDescriptorV1 } from '../../extension/acquisition/types.js';
import { BUILTIN_PROVIDER_ID, createBuiltinLlmProviderUnit, type LLMConfig } from '../../builtins/providers/builtin/index.js';
import { Logger } from '../../platform/logger/index.js';
import type { RuntimeReloadResult } from '../composition/runtime-composition.js';
import type { RuntimeDeadlineBudget, RuntimeDeadlineDriver } from '../runtime-deadline.js';
import type { RuntimeSnapshotAccess } from '../composition/composition-coordinator.js';
import type { RuntimeShutdownReport } from '../types.js';
import { SHARED_AGENT_TOOLS_SECTION, type AgentPolicyState } from '../agent-policy-state.js';
import { ModelTestRunner } from './model-test.js';
import {
  buildLlmSectionView, buildExtensionSectionView, type SettingsApplicationState,
} from './section-views.js';
import {
  SettingsClosingError,
  closingFailure, errorCode, failure, object, onlyKeys, settingsFailure, success,
} from './helpers.js';

const log = Logger.get('SettingsManager');

interface SettingsManagerOptions {
  readonly agentHome: string;
  readonly document: AgentConfigDocument;
  readonly agentPolicies?: AgentPolicyState;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly extensionMetadata?: Readonly<Pick<ExtensionAcquisitionResult, 'discovery' | 'diagnostics'>>;
  readonly getModelCatalog: () => ModelCatalogSnapshot;
  readonly getProviderUnitId?: (providerId: string) => string | undefined;
  readonly applyLlmConfiguration: (configuration: LLMConfig) => Promise<RuntimeReloadResult>;
  readonly snapshotAccess?: RuntimeSnapshotAccess;
  readonly createBuiltinProviderUnit?: typeof createBuiltinLlmProviderUnit;
  readonly deadlineDriver?: RuntimeDeadlineDriver;
  readonly saveSection?: typeof saveAgentConfigSection;
  readonly restoreSection?: typeof restoreAgentConfigSection;
}

interface QueuedUpdate {
  request: SettingsActionRequest | undefined;
  readonly resolve: (result: SettingsActionResult) => void;
}

export class SettingsManager implements SettingsCapability {
  private document: AgentConfigDocument;
  private readonly baseline: AgentConfigDocument;
  private readonly descriptors = new Map<string, ExtensionDescriptorV1>();
  private readonly revisions = new Map<string, string>();
  private readonly queued = new Set<QueuedUpdate>();
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private budget?: RuntimeDeadlineBudget;
  private active?: { requestId: string; phase: string };
  private fileStateUnknown = false;
  private applicationState: SettingsApplicationState = 'current';
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly modelTests: ModelTestRunner;

  constructor(private readonly options: SettingsManagerOptions) {
    this.document = structuredClone(options.document);
    this.baseline = structuredClone(options.document);
    this.environment = Object.freeze({ ...options.environment });
    this.modelTests = new ModelTestRunner({
      getSavedState: () => ({
        document: this.document, revision: this.revisions.get('llm'), fileStateUnknown: this.fileStateUnknown,
      }),
      environment: this.environment,
      snapshotAccess: options.snapshotAccess,
      createBuiltinProviderUnit: options.createBuiltinProviderUnit,
      deadlineDriver: options.deadlineDriver,
    });
    this.revisions.set('llm', randomUUID());
    for (const id of options.agentPolicies?.sectionIds ?? []) this.revisions.set(id, randomUUID());
    for (const candidate of options.extensionMetadata?.discovery.candidates ?? []) {
      this.descriptors.set(`extension:${candidate.descriptor.id}`, candidate.descriptor);
      this.revisions.set(`extension:${candidate.descriptor.id}`, randomUUID());
    }
  }

  async execute(request: SettingsActionRequest): Promise<SettingsActionResult> {
    if (request.action === 'load') {
      await this.tail;
      try {
        const input = object(request.input, '/input');
        onlyKeys(input, []);
        if (this.fileStateUnknown) {
          return settingsFailure(request, 'file_state_unknown', 'The saved file state could not be confirmed after rollback failed.');
        }
        return success(request, {
          sections: [...this.revisions.keys()].map((id) => this.section(id)),
          modelCatalog: this.modelCatalog(),
          toolCatalog: (this.options.snapshotAccess?.currentSnapshot().tools.definitions ?? [])
            .map(tool => ({ name: tool.name, description: tool.description })),
          diagnostics: this.options.extensionMetadata?.diagnostics ?? [],
          agentDiagnostics: this.options.agentPolicies?.diagnostics() ?? [],
        });
      } catch (error) {
        return failure(request, error);
      }
    }
    if (request.action === 'test_llm_model') return this.modelTests.execute(request);
    if (request.action !== 'update') {
      return settingsFailure(request, 'unsupported_action', 'This Settings action is not available.');
    }
    if (this.closing) return closingFailure(request);
    let admitted: SettingsActionRequest;
    try {
      admitted = { ...request, input: structuredClone(request.input) };
    } catch (error) {
      return failure(request, error);
    }
    return new Promise<SettingsActionResult>((resolve) => {
      const job: QueuedUpdate = { request: admitted, resolve };
      this.queued.add(job);
      this.tail = this.tail.then(() => this.runQueued(job));
    });
  }

  beginShutdown(budget: RuntimeDeadlineBudget): void {
    if (this.closing) return;
    this.closing = true;
    this.budget = budget;
    for (const job of this.queued) {
      if (job.request) job.resolve(closingFailure(job.request));
      job.request = undefined;
    }
    this.queued.clear();
    this.modelTests.beginShutdown();
  }

  async shutdown(budget: RuntimeDeadlineBudget): Promise<Pick<RuntimeShutdownReport, 'failed' | 'residuals'>> {
    this.beginShutdown(budget);
    const testConvergence = this.modelTests.shutdown(budget);
    const failed: RuntimeShutdownReport['failed'][number][] = [];
    const residuals: RuntimeShutdownReport['residuals'][number][] = [];
    if (this.active) {
      const convergence = await budget.raceRemaining(this.tail);
      if (convergence.outcome !== 'completed') {
        if (this.active) {
          log.error('Settings update did not converge before shutdown', { phase: this.active.phase });
          residuals.push({
            owner: 'resource', phase: this.active.phase, requestId: this.active.requestId,
            message: 'Settings file/application work did not converge; file I/O is not assumed cancelled.',
          });
        }
      }
    }
    const tests = await testConvergence;
    failed.push(...tests.failed);
    residuals.push(...tests.residuals);
    if (!this.active && (this.applicationState !== 'current' || this.fileStateUnknown)) {
      failed.push({
        resource: 'settings',
        message: 'Saved LLM configuration and Runtime application are not confirmed consistent.',
      });
    }
    return { failed, residuals };
  }

  private async runQueued(job: QueuedUpdate): Promise<void> {
    this.queued.delete(job);
    const request = job.request;
    job.request = undefined;
    if (!request) return;
    this.active = { requestId: request.requestId, phase: 'settings-preparing' };
    try {
      job.resolve(this.closing ? closingFailure(request) : await this.update(request));
    } catch (error) {
      job.resolve(failure(request, error));
    } finally {
      this.active = undefined;
    }
  }

  private async update(request: SettingsActionRequest): Promise<SettingsActionResult> {
    const input = object(request.input, '/input');
    onlyKeys(input, ['sectionId', 'expectedRevision', 'settings', 'credentials']);
    const id = input['sectionId'];
    if (typeof id !== 'string' || !this.revisions.has(id)) throw new ConfigEditError('/sectionId', 'Unknown Settings section.');
    if (typeof input['expectedRevision'] !== 'string') throw new ConfigEditError('/expectedRevision');
    if (input['expectedRevision'] !== this.revisions.get(id)) {
      return settingsFailure(request, 'revision_conflict', 'Reload and re-edit this section before saving.');
    }
    const descriptor = this.descriptors.get(id);
    const agentSection = id === SHARED_AGENT_TOOLS_SECTION || id.startsWith('agent:');
    if (agentSection && input['credentials'] !== undefined) throw new ConfigEditError('/credentials');
    const edit: ConfigSectionEdit = agentSection
      ? id === SHARED_AGENT_TOOLS_SECTION
        ? { kind: 'agent-defaults', settings: input['settings'] }
        : { kind: 'agent', agentId: id.slice('agent:'.length), settings: input['settings'] }
      : descriptor
      ? { kind: 'extension', extensionId: descriptor.id, schema: descriptor.configSchema, settings: input['settings'], credentials: input['credentials'] }
      : { kind: 'llm', settings: input['settings'], credentials: input['credentials'] };
    const publishAgentPolicy = edit.kind === 'agent' || edit.kind === 'agent-defaults'
      ? this.options.agentPolicies!.prepare(edit) : undefined;
    const previousApplicationState = this.applicationState;
    const committed = await (this.options.saveSection ?? saveAgentConfigSection)(
      this.options.agentHome, edit, (candidate) => {
        if (this.closing) throw new SettingsClosingError();
        if (id === 'llm') this.validateReference(candidate);
        this.active = { requestId: request.requestId, phase: 'settings-writing' };
      },
    );
    publishAgentPolicy?.();
    this.document = committed.document;
    this.fileStateUnknown = false;
    this.revisions.set(id, randomUUID());
    if (id !== 'llm') return success(request, {
      section: this.section(id),
      ...(agentSection ? {
        agentSections: this.options.agentPolicies!.sectionIds.map(sectionId => this.section(sectionId)),
        agentDiagnostics: this.options.agentPolicies!.diagnostics(),
      } : {}),
    });
    this.applicationState = 'not_applied';
    let configuration: LLMConfig;
    try {
      configuration = validateLlmConfiguration(committed.document.llm, this.environment);
    } catch (error) {
      log.error('Saved LLM configuration could not be materialized', { code: errorCode(error) });
      return this.rollback(request, committed.previous, previousApplicationState, 'materialization_failed');
    }
    if (this.closing) {
      return this.rollback(request, committed.previous, previousApplicationState, 'runtime_closing');
    }
    this.active = { requestId: request.requestId, phase: 'settings-applying' };
    let application: RuntimeReloadResult;
    try {
      application = await this.options.applyLlmConfiguration(configuration);
    } catch (error) {
      this.applicationState = 'unknown';
      log.error('LLM application threw without a confirmed publication outcome; file rollback was not attempted', { code: errorCode(error) });
      return settingsFailure(request, 'application_state_unknown', 'Configuration was saved, but Runtime publication could not be confirmed. No rollback was attempted.', {
        section: this.section(id), fileState: 'saved', rollback: 'not_attempted',
      });
    }
    if (application.outcome === 'published' || application.outcome === 'no-op') {
      this.applicationState = 'current';
      return success(request, {
        section: this.section(id), modelCatalog: this.modelCatalog(),
        warnings: application.warnings.map(({ code, unitId }) => ({
          code, ...(unitId === undefined ? {} : { unitId }),
        })),
      });
    }
    log.error('LLM application failed before publication', { outcome: application.outcome });
    return this.rollback(request, committed.previous, previousApplicationState, application.outcome);
  }

  private async rollback(
    request: SettingsActionRequest,
    previous: Awaited<ReturnType<typeof saveAgentConfigSection>>['previous'],
    previousApplicationState: SettingsApplicationState,
    applicationFailure: string,
  ): Promise<SettingsActionResult> {
    if (this.budget && this.budget.remaining() <= 0) {
      log.error('LLM rollback could not start before the shared shutdown deadline', { applicationFailure });
      return settingsFailure(request, 'rollback_deadline_exhausted', 'Configuration was saved but not applied; the shutdown deadline prevented rollback.', {
        section: this.section('llm'), fileState: 'saved', rollback: 'not_started', applicationFailure,
      });
    }
    this.active = { requestId: request.requestId, phase: 'settings-rollback' };
    try {
      this.document = await (this.options.restoreSection ?? restoreAgentConfigSection)(this.options.agentHome, previous);
      this.fileStateUnknown = false;
      this.applicationState = previousApplicationState;
      this.revisions.set('llm', randomUUID());
    } catch (error) {
      this.fileStateUnknown = true;
      log.error('LLM file rollback failed after application failed', { applicationFailure, rollbackFailure: errorCode(error) });
      return settingsFailure(request, 'rollback_failed', 'Runtime application failed and restoring the saved file also failed. The file state is unknown; later updates remain allowed.', {
        sectionId: 'llm', revision: this.revisions.get('llm'),
        fileState: 'unknown', rollback: 'failed', applicationFailure, rollbackFailure: 'file_restore_failed',
      });
    }
    return settingsFailure(request, 'application_failed_rolled_back', 'Runtime application failed; the saved LLM section was restored.', {
      section: this.section('llm'), modelCatalog: this.modelCatalog(),
      fileState: 'restored', rollback: 'completed', applicationFailure,
    });
  }

  private validateReference(document: AgentConfigDocument): void {
    const configuration = validateLlmConfiguration(document.llm);
    const reference = configuration.defaultModel;
    if (!reference) return;
    const models = reference.providerId === BUILTIN_PROVIDER_ID
      ? configuration.builtin?.models
      : this.options.getModelCatalog().providers.find((provider) => provider.providerId === reference.providerId)?.models;
    if (!models?.some((model) => model.modelId === reference.modelId)) {
      throw new ConfigEditError('/settings/defaultModel', 'The selected default model is not in the candidate Built-in or current Runtime model catalog.');
    }
  }

  private modelCatalog() {
    const catalog = this.options.getModelCatalog();
    return {
      ...catalog,
      providers: catalog.providers.map((provider) => {
        const unitId = this.options.getProviderUnitId?.(provider.providerId);
        const configurationSectionId = provider.providerId === BUILTIN_PROVIDER_ID
          ? 'llm'
          : unitId !== undefined && this.descriptors.has(`extension:${unitId}`)
            ? `extension:${unitId}` : undefined;
        return { ...provider, ...(configurationSectionId === undefined ? {} : { configurationSectionId }) };
      }),
    };
  }

  private section(id: string) {
    if (id === SHARED_AGENT_TOOLS_SECTION || id.startsWith('agent:')) {
      const section = this.options.agentPolicies!.section(id, this.document);
      const model = 'model' in section ? section.model : undefined;
      return {
        ...section,
        revision: this.revisions.get(id),
        form: { credentials: {} },
        ...(typeof model !== 'object' ? {} : {
          modelAvailable: this.options.getModelCatalog().providers
            .some(provider => provider.providerId === model.providerId
              && provider.models.some(candidate => candidate.modelId === model.modelId)),
        }),
      };
    }
    const descriptor = this.descriptors.get(id);
    if (!descriptor) {
      return buildLlmSectionView({
        id, revision: this.revisions.get(id), llm: this.document.llm,
        applicationStatus: this.applicationState,
      });
    }
    return buildExtensionSectionView({
      id, revision: this.revisions.get(id), descriptor,
      entry: this.document.extensions?.entries?.[descriptor.id],
      baseline: this.baseline.extensions?.entries?.[descriptor.id],
      diagnostics: this.options.extensionMetadata?.diagnostics ?? [],
    });
  }
}
