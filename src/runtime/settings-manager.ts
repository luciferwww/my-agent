import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ModelCatalogSnapshot, SettingsActionRequest, SettingsActionResult, SettingsCapability,
} from '../core/channel/index.js';
import {
  AgentConfigError, ConfigEditError, validateLlmConfiguration,
  saveAgentConfigSection, restoreAgentConfigSection, editAgentConfigSection,
  type ConfigSectionEdit,
} from '../platform/config/index.js';
import type { AgentConfigDocument } from '../platform/config/types.js';
import { CredentialMaterializationError, parseCredentialEnvironmentReference } from '../platform/config/credential-materialization.js';
import {
  extensionSettingsFields, prepareExtensionConfig,
} from '../extension/acquisition/configuration.js';
import type { ExtensionAcquisitionResult, ExtensionDescriptorV1 } from '../extension/acquisition/types.js';
import { BUILTIN_PROVIDER_ID, createBuiltinLlmProviderUnit, type LLMConfig } from '../builtins/providers/builtin/index.js';
import { ModelResolver, ModelResolutionError, normalizeModelReference, type ModelReference } from '../core/model-resolution/index.js';
import { toModelInvocationError } from '../core/model-invocation/index.js';
import { Logger } from '../platform/logger/index.js';
import type { RuntimeReloadResult } from './runtime-composition.js';
import { createSystemRuntimeDeadlineDriver, type RuntimeDeadlineBudget, type RuntimeDeadlineDriver } from './runtime-deadline.js';
import type { RuntimeSnapshotAccess, RuntimeGenerationPin } from './composition-coordinator.js';
import type { RuntimeUnitInstance } from './runtime-unit.js';
import { stageRegistryUnit } from './registry-builder.js';
import type { RuntimeShutdownReport } from './types.js';
import { SHARED_AGENT_TOOLS_SECTION, type AgentPolicyState } from './agent-policy-state.js';

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

interface ActiveModelTest {
  readonly requestId: string;
  readonly controller: AbortController;
  readonly deadline: number;
  readonly done: Promise<void>;
  phase: string;
  settled: boolean;
  cleanupFailed: boolean;
  instance?: RuntimeUnitInstance;
  reference?: ModelReference;
}

const MODEL_TEST_TIMEOUT_MS = 30_000;

type ApplicationState = 'current' | 'not_applied' | 'unknown';

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
  private applicationState: ApplicationState = 'current';
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly tests = new Set<ActiveModelTest>();
  private readonly deadlineDriver: RuntimeDeadlineDriver;

  constructor(private readonly options: SettingsManagerOptions) {
    this.document = structuredClone(options.document);
    this.baseline = structuredClone(options.document);
    this.environment = Object.freeze({ ...options.environment });
    this.deadlineDriver = options.deadlineDriver ?? createSystemRuntimeDeadlineDriver();
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
        return this.failure(request, error);
      }
    }
    if (request.action === 'test_llm_model') return this.testModel(request);
    if (request.action !== 'update') {
      return settingsFailure(request, 'unsupported_action', 'This Settings action is not available.');
    }
    if (this.closing) return closingFailure(request);
    let admitted: SettingsActionRequest;
    try {
      admitted = { ...request, input: structuredClone(request.input) };
    } catch (error) {
      return this.failure(request, error);
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
    for (const test of this.tests) test.controller.abort(new SettingsClosingError());
  }

  async shutdown(budget: RuntimeDeadlineBudget): Promise<Pick<RuntimeShutdownReport, 'failed' | 'residuals'>> {
    this.beginShutdown(budget);
    const failed: RuntimeShutdownReport['failed'][number][] = [];
    const residuals: RuntimeShutdownReport['residuals'][number][] = [];
    if (this.active || [...this.tests].some((test) => !test.settled)) {
      const convergence = await budget.raceRemaining(Promise.all([
        this.tail, ...[...this.tests].map((test) => test.done),
      ]));
      if (convergence.outcome !== 'completed') {
        if (this.active) {
          log.error('Settings update did not converge before shutdown', { phase: this.active.phase });
          residuals.push({
            owner: 'resource', phase: this.active.phase, requestId: this.active.requestId,
            message: 'Settings file/application work did not converge; file I/O is not assumed cancelled.',
          });
        }
        for (const test of this.tests) {
          if (test.settled) continue;
          log.error('Settings model Test did not converge before shutdown', { phase: test.phase });
          residuals.push({
            owner: 'resource', phase: test.phase, requestId: test.requestId,
            message: 'Model Test still owns resources; invocation cancellation and cleanup are not assumed complete.',
          });
        }
      }
    }
    for (const test of this.tests) {
      if (test.cleanupFailed) failed.push({
        resource: `settings-test:${test.requestId}`, message: 'Temporary model Test resource cleanup failed.',
      });
    }
    if (!this.active && (this.applicationState !== 'current' || this.fileStateUnknown)) {
      failed.push({
        resource: 'settings',
        message: 'Saved LLM configuration and Runtime application are not confirmed consistent.',
      });
    }
    return { failed, residuals };
  }

  private async testModel(request: SettingsActionRequest): Promise<SettingsActionResult> {
    if (this.closing) return closingFailure(request);
    let finish!: () => void;
    const test: ActiveModelTest = {
      requestId: request.requestId, controller: new AbortController(),
      deadline: this.deadlineDriver.now() + MODEL_TEST_TIMEOUT_MS,
      done: new Promise<void>((resolve) => { finish = resolve; }),
      phase: 'settings-test-preparing', settled: false, cleanupFailed: false,
    };
    this.tests.add(test);
    const timer = setTimeout(() => test.controller.abort(new ModelTestTimeoutError()), MODEL_TEST_TIMEOUT_MS);
    timer.unref?.();
    let onAbort!: () => void;
    const cancelled = new Promise<SettingsActionResult>((resolve) => {
      onAbort = () => resolve(this.testFailure(request, test, test.controller.signal.reason));
      test.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const work = this.runModelTest(request, test)
      .catch((error: unknown) => this.testFailure(request, test, error))
      .finally(() => {
        test.settled = true;
        if (!test.cleanupFailed) this.tests.delete(test);
        finish();
      });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      clearTimeout(timer);
      test.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private async runModelTest(request: SettingsActionRequest, test: ActiveModelTest): Promise<SettingsActionResult> {
    let pin: RuntimeGenerationPin | undefined;
    let result: SettingsActionResult;
    try {
      const input = object(structuredClone(request.input), '/input');
      onlyKeys(input, ['reference', 'builtin']);
      const reference = object(input['reference'], '/reference');
      onlyKeys(reference, ['providerId', 'modelId']);
      if (typeof reference['providerId'] !== 'string' || typeof reference['modelId'] !== 'string') {
        throw new ConfigEditError('/reference');
      }
      test.reference = normalizeModelReference({
        providerId: reference['providerId'], modelId: reference['modelId'],
      });
      this.assertTestActive(test);
      let resolver: ModelResolver;
      if (input['builtin'] !== undefined) {
        if (test.reference.providerId !== BUILTIN_PROVIDER_ID) {
          throw new ConfigEditError('/builtin', 'Extension model Tests use the current loaded instance, not candidate settings.');
        }
        const candidate = object(input['builtin'], '/builtin');
        onlyKeys(candidate, ['settings', 'credentials', 'expectedRevision']);
        const changes = candidate['credentials'] === undefined ? {} : object(candidate['credentials'], '/builtin/credentials');
        const intent = changes['/builtin/apiKey'];
        const keep = intent === undefined || object(intent, '/builtin/credentials')['operation'] === 'keep';
        const savedBuiltin = this.document.llm?.builtin;
        if (keep && isObject(savedBuiltin) && savedBuiltin['apiKey'] !== undefined) {
          if (this.fileStateUnknown) {
            return settingsFailure(request, 'file_state_unknown', 'Reload the saved file state before retaining its credential.');
          }
          if (candidate['expectedRevision'] !== this.revisions.get('llm')) {
            return settingsFailure(request, 'revision_conflict', 'Reload the LLM section before retaining its saved credential.');
          }
        }
        const edited = editAgentConfigSection(this.document, {
          kind: 'llm', settings: { builtin: candidate['settings'] }, credentials: candidate['credentials'],
        });
        const configuration = validateLlmConfiguration(edited.document.llm, this.environment);
        if (!configuration.builtin) throw new ConfigEditError('/builtin/settings');
        this.assertTestActive(test);
        const unit = (this.options.createBuiltinProviderUnit ?? createBuiltinLlmProviderUnit)(configuration.builtin);
        test.instance = await unit.create(test.controller.signal);
        this.assertTestActive(test);
        const staged = stageRegistryUnit(test.instance.registration);
        await test.instance.start(test.controller.signal);
        this.assertTestActive(test);
        resolver = new ModelResolver(staged.providers);
      } else {
        if (!this.options.snapshotAccess) {
          return settingsFailure(request, 'settings_unavailable', 'Loaded model Test access is unavailable.');
        }
        pin = this.options.snapshotAccess.captureRootGeneration();
        resolver = new ModelResolver(pin.snapshot.providers);
      }
      const resolved = resolver.resolve({
        reference: test.reference, request: { tools: false, mediaKinds: [] }, policy: {},
      });
      this.assertTestActive(test);
      test.phase = 'settings-test-invoking';
      const response = await resolved.invocationPort.chat({
        model: resolved.identity.modelId,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        outputTokenLimit: Math.min(64, resolved.invocationDefaults.outputTokenLimit ?? 64, resolved.facts.maximumOutputTokens ?? 64),
        signal: test.controller.signal,
      });
      this.assertTestActive(test);
      result = response.invocation?.completion.status === 'partial'
        || response.stopReason === 'error' || response.stopReason === 'aborted'
        ? settingsFailure(request, 'test_incomplete', 'The model Test did not complete.', { reference: test.reference })
        : success(request, { reference: test.reference, outcome: 'completed' });
    } catch (error) {
      result = this.testFailure(request, test, error);
    } finally {
      test.phase = 'settings-test-cleanup';
      try {
        await test.instance?.stop();
        test.instance = undefined;
      } catch {
        test.cleanupFailed = true;
        log.error('Temporary model Test cleanup failed');
        result = settingsFailure(request, 'test_cleanup_failed', 'The temporary model Test resource could not be cleaned up.', {
          reference: test.reference,
        });
      } finally {
        pin?.release();
      }
    }
    return result;
  }

  private assertTestActive(test: ActiveModelTest): void {
    if (!test.controller.signal.aborted && this.deadlineDriver.now() >= test.deadline) {
      test.controller.abort(new ModelTestTimeoutError());
    }
    if (!test.controller.signal.aborted && this.closing) test.controller.abort(new SettingsClosingError());
    if (test.controller.signal.aborted) throw test.controller.signal.reason;
  }

  private testFailure(request: SettingsActionRequest, test: ActiveModelTest, error: unknown): SettingsActionResult {
    const output = test.reference === undefined ? undefined : { reference: test.reference };
    if (test.controller.signal.aborted) error = test.controller.signal.reason;
    if (error instanceof SettingsClosingError) return closingFailure(request, output);
    if (error instanceof ModelTestTimeoutError) {
      return settingsFailure(request, 'test_timeout', 'The model Test exceeded its 30,000 ms total deadline.', output);
    }
    if (error instanceof ModelResolutionError) {
      log.warn('Settings model Test resolution failed', { phase: test.phase });
      return settingsFailure(request, 'model_resolution_failed', 'The selected model could not be resolved.', output);
    }
    if (error instanceof AgentConfigError) {
      log.warn('Settings model Test configuration failed', { code: error.code });
      return settingsFailure(request, error.code, 'The model Test configuration is invalid or its credential is unavailable.', output, error.fieldPath);
    }
    const invocation = toModelInvocationError(error);
    if (invocation) {
      log.warn('Settings model Test invocation failed', { category: invocation.category });
      return settingsFailure(request, 'test_invocation_failed', `Model Test invocation failed: ${invocation.category}.`, output);
    }
    const failure = this.failure(request, error);
    return output === undefined ? failure : { ...failure, output };
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
      job.resolve(this.failure(request, error));
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
    previousApplicationState: ApplicationState,
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
      const llm = validateLlmConfiguration(this.document.llm);
      const { apiKey, ...builtin } = llm.builtin ?? {};
      return {
        id, revision: this.revisions.get(id), restartRequired: false,
        applicationStatus: this.applicationState,
        settings: {
          ...(llm.defaultModel === undefined ? {} : { defaultModel: llm.defaultModel }),
          ...(llm.builtin === undefined ? {} : { builtin }),
        },
        form: { credentials: { '/builtin/apiKey': credentialMetadata(apiKey) } },
      };
    }
    const entry = this.document.extensions?.entries?.[descriptor.id];
    const config = isObject(entry) && isObject(entry['config']) ? entry['config'] : {};
    const fields = extensionSettingsFields(descriptor.configSchema);
    const settings = Object.fromEntries(fields.filter((field) => field.editable && !field.sensitive
      && Object.hasOwn(config, field.name) && isScalar(config[field.name]))
      .map((field) => [field.name, config[field.name]]));
    const credentials = Object.fromEntries(fields.filter((field) => field.editable && field.sensitive)
      .map((field) => [field.path, credentialMetadata(Object.hasOwn(config, field.name) ? config[field.name] : undefined)]));
    const baseline = this.baseline.extensions?.entries?.[descriptor.id];
    const restartRequired = !isDeepStrictEqual(
      comparisonEntry(entry, descriptor), comparisonEntry(baseline, descriptor),
    );
    return {
      id, name: descriptor.name ?? descriptor.id, revision: this.revisions.get(id), restartRequired,
      applicationStatus: restartRequired ? 'restart_required' : 'current',
      settings: { enabled: !isObject(entry) || entry['enabled'] !== false, config: settings },
      form: { fields, credentials },
      diagnostics: this.options.extensionMetadata?.diagnostics.filter((diagnostic) => diagnostic.extensionId === descriptor.id) ?? [],
    };
  }

  private failure(request: SettingsActionRequest, error: unknown): SettingsActionResult {
    if (error instanceof SettingsClosingError) return closingFailure(request);
    if (error instanceof ConfigEditError || error instanceof AgentConfigError) {
      return settingsFailure(request, errorCode(error), error.message, undefined, error.fieldPath);
    }
    if (error instanceof CredentialMaterializationError) {
      return settingsFailure(request, 'invalid_credential', 'Invalid credential syntax.');
    }
    log.error('Settings operation failed', { action: request.action, code: errorCode(error) });
    return settingsFailure(request, 'settings_failed', 'The Settings operation failed.');
  }
}

export function settingsFailure(
  request: SettingsActionRequest, code: string, message: string, output?: unknown, fieldPath?: string,
): SettingsActionResult {
  return {
    requestId: request.requestId, action: request.action, ok: false,
    error: { code, message, ...(fieldPath === undefined ? {} : { fieldPath }) },
    ...(output === undefined ? {} : { output }),
  };
}

function success(request: SettingsActionRequest, output: unknown): SettingsActionResult {
  return { requestId: request.requestId, action: request.action, ok: true, output };
}

function closingFailure(request: SettingsActionRequest, output?: unknown): SettingsActionResult {
  return settingsFailure(request, 'runtime_closing', 'Runtime is closing; no new Settings updates or model Tests are admitted.', output);
}

class SettingsClosingError extends Error {}
class ModelTestTimeoutError extends Error {}

function errorCode(error: unknown): string {
  if (error instanceof AgentConfigError) return error.code;
  if (error instanceof ConfigEditError) return 'validation_failed';
  if (error instanceof CredentialMaterializationError) return 'invalid_credential';
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOSPC', 'EBUSY'].includes(error.code)) {
    return error.code;
  }
  return 'unexpected_failure';
}

function credentialMetadata(value: unknown) {
  if (value === undefined || typeof value === 'string' && value.trim().length === 0) return { configured: false };
  try {
    return { configured: true, source: parseCredentialEnvironmentReference(value) === undefined ? 'literal' : 'environment' };
  } catch (error) {
    if (!(error instanceof CredentialMaterializationError)) throw error;
    return { configured: true, error: 'invalid_credential' };
  }
}

function comparisonEntry(entry: unknown, descriptor: ExtensionDescriptorV1): unknown {
  if (entry !== undefined && !isObject(entry)) return { invalid: true, value: entry };
  const config = entry?.['config'] ?? {};
  const validation = isObject(config) ? prepareExtensionConfig(config, descriptor.configSchema, {}, 'save') : undefined;
  return {
    enabled: entry?.['enabled'] !== false,
    config: validation?.ok ? validation.config : { invalid: true, value: config },
  };
}

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function object(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isObject(value)) throw new ConfigEditError(fieldPath);
  return value;
}

function onlyKeys(input: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new ConfigEditError('/input');
}
