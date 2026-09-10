import { randomUUID } from 'node:crypto';
import { AgentExecutionFailure } from '../core/runner/index.js';
import type { AgentEvent } from '../core/runner/index.js';
import { ModelResolutionError } from '../core/model-resolution/index.js';
import { ModelResolver, type ModelReference } from '../core/model-resolution/index.js';
import type { RegistrySnapshot } from '../core/registry/index.js';
import type { SessionManager } from '../core/session/SessionManager.js';
import { resolveSubagentCapabilities } from '../core/subagent/capabilities.js';
import { deriveSubagentRequestRequirements } from '../core/subagent/request-requirements.js';
import { formatSubagentSessionKey, getSubagentDepth } from '../core/subagent/session-key.js';
import type {
  SubagentDelegationPort,
  SubagentTerminalFailure,
  SubagentTerminalResult,
} from '../core/subagent/types.js';
import type { SubagentExecutor } from '../core/subagent/SubagentExecutor.js';
import type { ContextFile } from '../core/workspace/types.js';
import { Logger } from '../platform/logger/index.js';
import type { MessageRouteContext } from './queue-types.js';

const log = Logger.get('SubagentOrchestration');

export interface ActiveParentTurn {
  readonly requestId: string;
  readonly sessionKey: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly effectiveReference: ModelReference;
  readonly contextFiles: readonly ContextFile[];
  readonly registrySnapshot: RegistrySnapshot;
  registerChild(): () => void;
}

export interface CreateSubagentDelegationPortParams {
  readonly activeParents: ReadonlyMap<string, ActiveParentTurn>;
  readonly routeContextByTurn: Map<string, MessageRouteContext>;
  readonly sessionManager: SessionManager;
  readonly getDefaultProviderId: () => string;
  readonly defaultMaxTokens: number;
  readonly maxDepth: number;
  readonly executor: SubagentExecutor;
  readonly onEvent: (event: AgentEvent) => void;
}

export class SubagentDelegationRejected extends Error {
  readonly kind = 'subagent_delegation_rejected' as const;
}

export function createSubagentDelegationPort(
  params: CreateSubagentDelegationPortParams,
): SubagentDelegationPort {
  return {
    async delegate(request): Promise<SubagentTerminalResult> {
      const parent = params.activeParents.get(request.parent.turnId);
      if (
        !parent
        || parent.sessionKey !== request.parent.sessionKey
        || parent.signal !== request.signal
        || parent.signal.aborted
      ) {
        throw new SubagentDelegationRejected('Subagent requires an active matching Parent Turn.');
      }

      const startedAt = Date.now();
      const releaseChild = parent.registerChild();
      const runId = randomUUID();
      const childTurnId = randomUUID();
      const childDepth = getSubagentDepth(parent.sessionKey) + 1;
      const childSessionKey = formatSubagentSessionKey({
        rootLabel: parent.sessionKey,
        runId,
        depth: childDepth,
      });
      const eventIdentity = {
        requestId: parent.requestId,
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        depth: childDepth,
        subagentType: request.profile.id,
        lifecycle: 'blocking' as const,
        parentSessionKey: parent.sessionKey,
        parentTurnId: parent.turnId,
        parentToolUseId: request.parent.toolUseId,
      };

      let routeRegistered = false;
      let sessionAcquired = false;
      let result: SubagentTerminalResult | undefined;

      try {
        params.onEvent({ type: 'subagent_start', ...eventIdentity });

        const parentRoute = params.routeContextByTurn.get(parent.turnId);
        if (parentRoute) {
          params.routeContextByTurn.set(childTurnId, parentRoute);
          routeRegistered = true;
        }

        const session = await params.sessionManager.resolveSession(childSessionKey, {
          spawnedBy: parent.sessionKey,
        });
        if (!session.isNew) {
          throw new Error('Child session identity already exists.');
        }
        sessionAcquired = true;
        throwIfAborted(parent.signal);

        const capabilities = resolveSubagentCapabilities(childSessionKey, params.maxDepth);
        const prepared = await params.executor.prepare({
          requestId: parent.requestId,
          profile: request.profile,
          description: request.description,
          prompt: request.prompt,
          parentContextFiles: parent.contextFiles,
          childDepth,
          canSpawn: capabilities.canSpawn,
          childSessionKey,
          childTurnId,
          signal: parent.signal,
          toolProjection: parent.registrySnapshot.tools,
          hookProjection: parent.registrySnapshot.hooks,
        });
        throwIfAborted(parent.signal);

        const requirements = deriveSubagentRequestRequirements({
          message: prepared.message,
          tools: prepared.tools,
        });
        const reference = request.profile.model === 'inherit'
          ? parent.effectiveReference
          : request.profile.model;
        const resolvedModel = new ModelResolver(parent.registrySnapshot.providers).resolve({
          reference,
          referenceSource: 'native',
          defaultProviderId: params.getDefaultProviderId(),
          request: requirements,
          policy: { defaultMaxTokens: params.defaultMaxTokens },
        });
        throwIfAborted(parent.signal);

        const runResult = await params.executor.execute(prepared, resolvedModel);
        const outcome: SubagentTerminalResult['outcome'] = runResult.stopReason === 'aborted'
          ? 'aborted'
          : runResult.stopReason === 'max_llm_calls'
            ? 'max_llm_calls'
            : 'ok';
        result = {
          runId,
          sessionKey: childSessionKey,
          turnId: childTurnId,
          text: runResult.text,
          outcome,
          usage: runResult.usage,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        const aborted = isAbortError(error, parent.signal);
        const failure = aborted ? undefined : classifyFailure(error);
        result = {
          runId,
          sessionKey: childSessionKey,
          turnId: childTurnId,
          text: '',
          outcome: aborted ? 'aborted' : 'error',
          ...(failure ? { failure } : {}),
          usage: error instanceof AgentExecutionFailure
            ? error.usage
            : { inputTokens: 0, outputTokens: 0 },
          durationMs: Date.now() - startedAt,
        };
      } finally {
        const terminal = result ?? {
          runId,
          sessionKey: childSessionKey,
          turnId: childTurnId,
          text: '',
          outcome: 'error' as const,
          failure: { phase: 'setup' as const, message: 'Subagent failed before completion.' },
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: Date.now() - startedAt,
        };
        try {
          params.onEvent({
            type: 'subagent_end',
            ...eventIdentity,
            outcome: terminal.outcome,
            ...(terminal.failure ? { failure: terminal.failure } : {}),
            usage: terminal.usage,
            durationMs: terminal.durationMs,
          });
        } catch (error) {
          log.warn('child terminal event delivery failed', {
            sessionKey: childSessionKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        if (routeRegistered) {
          try {
            params.routeContextByTurn.delete(childTurnId);
          } catch (error) {
            log.warn('child route cleanup failed', {
              sessionKey: childSessionKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (sessionAcquired) {
          try {
            await params.sessionManager.deleteSession(childSessionKey);
          } catch (error) {
            log.warn('child session cleanup failed', {
              sessionKey: childSessionKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        releaseChild();
      }

      return result;
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

function classifyFailure(error: unknown): SubagentTerminalFailure {
  if (error instanceof ModelResolutionError) {
    return {
      phase: 'resolution',
      category: error.category,
      message: error.message,
    };
  }
  if (error instanceof AgentExecutionFailure) {
    return { phase: 'execution', message: error.message };
  }
  return {
    phase: 'setup',
    message: error instanceof Error ? error.message : String(error),
  };
}
