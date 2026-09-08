import { randomUUID } from 'node:crypto';
import type {
  ChannelRunRequest,
  ChannelRuntimeBinding,
  ChannelRuntimeHost,
  TurnInteractionResponse,
} from '../core/channel/index.js';
import type { AgentEvent } from '../core/runner/index.js';
import { Logger } from '../platform/logger/index.js';
import { bootstrapRuntime } from './bootstrap.js';
import {
  CompositionCoordinator,
  type RuntimeSnapshotAccess,
} from './composition-coordinator.js';
import type {
  RuntimeApplication,
  RuntimeHandle,
  RuntimeReloadChange,
  RuntimeReloadResult,
} from './runtime-composition.js';
import type {
  RuntimeAppOptions,
  RuntimeBootstrapResult,
  RuntimeShutdownReport,
} from './types.js';
import { RuntimeLifecycleLedger } from './runtime-lifecycle.js';

const log = Logger.get('RuntimeBuilder');

export interface RuntimeApplicationKernel {
  readonly application: RuntimeApplication;
  onChannelMessage(binding: ChannelRuntimeBinding, request: ChannelRunRequest): Promise<void>;
  onInteractionResponse(response: TurnInteractionResponse): void;
  onInteractionUnavailable(id: string, reason: 'origin_disconnected'): void;
  querySessionsNeedingAbort(): string[];
  abortTurn(sessionKey: string): { aborted: boolean; dropped: number };
  close(reason?: string): Promise<RuntimeShutdownReport>;
}

export interface RuntimeApplicationKernelInput extends RuntimeBootstrapResult {
  readonly fanoutAgentEvent: (event: AgentEvent) => void;
  readonly snapshotAccess: RuntimeSnapshotAccess;
}

export type RuntimeApplicationKernelFactory = (
  input: RuntimeApplicationKernelInput,
) => RuntimeApplicationKernel;

export async function buildRuntimeHandle(
  options: RuntimeAppOptions,
  createApplication: RuntimeApplicationKernelFactory,
): Promise<RuntimeHandle> {
  const coordinator = new CompositionCoordinator();
  const lifecycleLedger = new RuntimeLifecycleLedger();
  let kernel: RuntimeApplicationKernel | undefined;
  let channelBindings: readonly ChannelRuntimeBinding[] = [];
  const userObserver = options.onAgentEvent;

  const fanoutAgentEvent = (event: AgentEvent): void => {
    for (const channel of channelBindings) {
      try {
        channel.send(event);
      } catch (error) {
        log.warn('channel.send failed', {
          channelId: channel.id,
          eventType: event.type,
          error: messageOf(error),
        });
      }
    }
    try {
      userObserver?.(event);
    } catch (error) {
      log.warn('onAgentEvent observer failed', {
        eventType: event.type,
        error: messageOf(error),
      });
    }
  };

  const channelHost: ChannelRuntimeHost = Object.freeze({
    onMessage(binding: ChannelRuntimeBinding, request: ChannelRunRequest) {
      if (!kernel) {
        return Promise.reject(new Error('Runtime Channel ingress is not ready.'));
      }
      return kernel.onChannelMessage(binding, request);
    },
    onInteractionResponse(response: TurnInteractionResponse) {
      kernel?.onInteractionResponse(response);
    },
    onInteractionUnavailable(id: string, reason: 'origin_disconnected') {
      kernel?.onInteractionUnavailable(id, reason);
    },
    abortHooks: Object.freeze({
      querySessionsNeedingAbort(): string[] {
        return kernel?.querySessionsNeedingAbort() ?? [];
      },
      abortTurn(sessionKey: string) {
        return kernel?.abortTurn(sessionKey) ?? { aborted: false, dropped: 0 };
      },
    }),
  });

  const bootstrap = await bootstrapRuntime({
    ...options,
    onAgentEvent: fanoutAgentEvent,
  }, channelHost, lifecycleLedger);

  try {
    coordinator.commitPublish(bootstrap.resources.registrySnapshot);
    channelBindings = bootstrap.resources.registrySnapshot.channels.bindings;
    kernel = createApplication({
      ...bootstrap,
      fanoutAgentEvent,
      snapshotAccess: coordinator.createSnapshotAccess(),
    });
  } catch (error) {
    const report = await bootstrap.channelShutdownHandoff.runtimeConverged();
    for (const failure of report.failed) {
      log.warn('channel cleanup after Runtime application creation failure failed', {
        channelId: failure.channelId,
        error: failure.message,
      });
    }
    const memoryManager = bootstrap.resources.memoryManager as {
      close?: () => void | Promise<void>;
    } | null;
    if (typeof memoryManager?.close === 'function') {
      try {
        await memoryManager.close();
      } catch (cleanupError) {
        log.warn('Memory cleanup after Runtime application creation failure failed', {
          error: messageOf(cleanupError),
        });
      }
    }
    throw error;
  }

  let closePromise: Promise<RuntimeShutdownReport> | undefined;
  const close = (reason?: string): Promise<RuntimeShutdownReport> => {
    coordinator.beginShutdown();
    closePromise ??= (async () => {
      const applicationReport = await kernel!.close(reason);
      const completed = [...applicationReport.completed];
      const failed = [...applicationReport.failed];

      const channelReport = await bootstrap.channelShutdownHandoff.runtimeConverged();
      completed.push(...channelReport.completed.map((id) => `channel:${id}`));
      failed.push(...channelReport.failed.map((failure) => ({
        resource: `channel:${failure.channelId}`,
        message: failure.message,
      })));

      const memoryManager = bootstrap.resources.memoryManager as {
        close?: () => void | Promise<void>;
      } | null;
      if (typeof memoryManager?.close === 'function') {
        try {
          await memoryManager.close();
          completed.push('memoryManager');
        } catch (error) {
          failed.push({ resource: 'memoryManager', message: messageOf(error) });
        }
      }

      return Object.freeze({
        reason: applicationReport.reason,
        startedAt: applicationReport.startedAt,
        finishedAt: Date.now(),
        completed,
        failed,
      } satisfies RuntimeShutdownReport);
    })();
    return closePromise!;
  };

  const reloadUnavailable = (change: RuntimeReloadChange): RuntimeReloadResult => Object.freeze({
    requestId: randomUUID(),
    outcome: 'rejected',
    change,
    generation: coordinator.current?.generation ?? 1,
    warnings: Object.freeze([]),
    category: 'RELOAD_NOT_IMPLEMENTED',
    message: 'Runtime reload is not available until the reload coordinator is active.',
  });

  return Object.freeze({
    application: kernel.application,
    composition: Object.freeze({
      enableUnit: async (unitId: string) => reloadUnavailable(Object.freeze({
        operation: 'enable',
        unitId,
      })),
      disableUnit: async (unitId: string) => reloadUnavailable(Object.freeze({
        operation: 'disable',
        unitId,
      })),
    }),
    close,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
