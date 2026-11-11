import type { SettingsActionRequest, SettingsActionResult } from '../../core/settings/index.js';
import { ModelResolver, ModelResolutionError, normalizeModelReference } from '../../core/model-resolution/index.js';
import type { ModelReference } from '../../core/model-resolution/index.js';
import { toModelInvocationError } from '../../core/model-invocation/index.js';
import { AgentConfigError, ConfigEditError, editAgentConfigSection, validateLlmConfiguration } from '../../platform/config/index.js';
import type { AgentConfigDocument } from '../../platform/config/types.js';
import { BUILTIN_PROVIDER_ID, createBuiltinLlmProviderUnit } from '../../builtins/providers/builtin/index.js';
import { Logger } from '../../platform/logger/index.js';
import { createSystemRuntimeDeadlineDriver } from '../runtime-deadline.js';
import type { RuntimeDeadlineBudget, RuntimeDeadlineDriver } from '../runtime-deadline.js';
import type { RuntimeSnapshotAccess, RuntimeGenerationPin } from '../composition/composition-coordinator.js';
import type { RuntimeUnitInstance } from '../composition/runtime-unit.js';
import type { RuntimeShutdownReport } from '../types.js';
import { stageRegistryUnit } from '../composition/registry-builder.js';
import {
  SettingsClosingError, closingFailure, failure, isObject, object, onlyKeys, settingsFailure, success,
} from './helpers.js';

const log = Logger.get('SettingsManager');
const MODEL_TEST_TIMEOUT_MS = 30_000;

interface ModelTestRunnerOptions {
  readonly getSavedState: () => {
    readonly document: AgentConfigDocument;
    readonly revision: string | undefined;
    readonly fileStateUnknown: boolean;
  };
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly snapshotAccess?: RuntimeSnapshotAccess;
  readonly createBuiltinProviderUnit?: typeof createBuiltinLlmProviderUnit;
  readonly deadlineDriver?: RuntimeDeadlineDriver;
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

class ModelTestTimeoutError extends Error {}

export class ModelTestRunner {
  private readonly tests = new Set<ActiveModelTest>();
  private readonly deadlineDriver: RuntimeDeadlineDriver;
  private closing = false;

  constructor(private readonly options: ModelTestRunnerOptions) {
    this.deadlineDriver = options.deadlineDriver ?? createSystemRuntimeDeadlineDriver();
  }

  async execute(request: SettingsActionRequest): Promise<SettingsActionResult> {
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

  beginShutdown(): void {
    if (this.closing) return;
    this.closing = true;
    for (const test of this.tests) test.controller.abort(new SettingsClosingError());
  }

  async shutdown(budget: RuntimeDeadlineBudget): Promise<Pick<RuntimeShutdownReport, 'failed' | 'residuals'>> {
    this.beginShutdown();
    const failed: RuntimeShutdownReport['failed'][number][] = [];
    const residuals: RuntimeShutdownReport['residuals'][number][] = [];
    if ([...this.tests].some((test) => !test.settled)) {
      const convergence = await budget.raceRemaining(Promise.all([...this.tests].map((test) => test.done)));
      if (convergence.outcome !== 'completed') {
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
    return { failed, residuals };
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
        const saved = this.options.getSavedState();
        const savedBuiltin = saved.document.llm?.builtin;
        if (keep && isObject(savedBuiltin) && savedBuiltin['apiKey'] !== undefined) {
          if (saved.fileStateUnknown) {
            return settingsFailure(request, 'file_state_unknown', 'Reload the saved file state before retaining its credential.');
          }
          if (candidate['expectedRevision'] !== saved.revision) {
            return settingsFailure(request, 'revision_conflict', 'Reload the LLM section before retaining its saved credential.');
          }
        }
        const edited = editAgentConfigSection(saved.document, {
          kind: 'llm', settings: { builtin: candidate['settings'] }, credentials: candidate['credentials'],
        });
        const configuration = validateLlmConfiguration(edited.document.llm, this.options.environment);
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
    const result = failure(request, error);
    return output === undefined ? result : { ...result, output };
  }
}
