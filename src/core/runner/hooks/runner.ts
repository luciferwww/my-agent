import { Logger } from '../../../platform/logger/index.js';
import type {
  BeforeToolCallHook,
  BeforeToolCallPayload,
  BeforeToolCallResult,
  AfterToolCallHook,
  AfterToolCallPayload,
  BeforeCompactionHook,
  BeforeCompactionPayload,
  AfterCompactionHook,
  AfterCompactionPayload,
} from './types.js';

const logger = Logger.get('HookRunner');

export const OBSERVER_HOOK_DEADLINE_MS = 5_000;

export type HookSettlementOutcome = 'fulfilled' | 'rejected' | 'aborted' | 'timed_out';

export interface HookSettlement {
  readonly unitId: string;
  readonly contributionId: string;
  readonly outcome: HookSettlementOutcome;
}

interface HookBinding<T> {
  readonly unitId: string;
  readonly contributionId: string;
  readonly handler: T;
}

type ObserverPayload = { readonly signal: AbortSignal };
type ObserverHook<TPayload extends ObserverPayload> = (payload: TPayload) => void | Promise<void>;

async function runObserverHooks<TPayload extends ObserverPayload>(
  hooks: readonly HookBinding<ObserverHook<TPayload>>[],
  payload: Omit<TPayload, 'signal'>,
  turnSignal: AbortSignal,
  hookName: string,
  deadlineMs: number,
): Promise<readonly HookSettlement[]> {
  return Promise.all(hooks.map((binding) => settleObserver(
    binding,
    payload,
    turnSignal,
    hookName,
    deadlineMs,
  )));
}

async function settleObserver<TPayload extends ObserverPayload>(
  binding: HookBinding<ObserverHook<TPayload>>,
  payload: Omit<TPayload, 'signal'>,
  turnSignal: AbortSignal,
  hookName: string,
  deadlineMs: number,
): Promise<HookSettlement> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeTurnAbort = () => {};

  const handlerPromise = Promise.resolve().then(() => binding.handler({
    ...payload,
    signal: controller.signal,
  } as TPayload));

  const completion = handlerPromise.then(
    () => 'fulfilled' as const,
    (error: unknown) => {
      logger.warn('[hook observer] handler failed', {
        hookName,
        unitId: binding.unitId,
        contributionId: binding.contributionId,
        ...observerCorrelation(payload),
        error: error instanceof Error ? error.message : String(error),
      });
      return 'rejected' as const;
    },
  );

  const aborted = new Promise<'aborted'>((resolve) => {
    const onAbort = () => {
      controller.abort(turnSignal.reason);
      resolve('aborted');
    };
    if (turnSignal.aborted) {
      onAbort();
      return;
    }
    turnSignal.addEventListener('abort', onAbort, { once: true });
    removeTurnAbort = () => turnSignal.removeEventListener('abort', onAbort);
  });

  const timedOut = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Hook observer deadline exceeded', 'TimeoutError'));
      resolve('timed_out');
    }, deadlineMs);
  });

  const outcome = await Promise.race([completion, aborted, timedOut]);
  if (timer) clearTimeout(timer);
  removeTurnAbort();

  if (outcome === 'timed_out') {
    logger.warn('[hook observer] handler timed out', {
      hookName,
      unitId: binding.unitId,
      contributionId: binding.contributionId,
      ...observerCorrelation(payload),
      deadlineMs,
    });
  }

  // Observe a late rejection without allowing it to change logical settlement.
  void handlerPromise.catch(() => {});
  return Object.freeze({
    unitId: binding.unitId,
    contributionId: binding.contributionId,
    outcome,
  });
}

/** Execute before_tool_call interceptors sequentially in Snapshot order. */
export async function runBeforeToolCall(
  hooks: readonly HookBinding<BeforeToolCallHook>[],
  payload: BeforeToolCallPayload,
): Promise<BeforeToolCallResult & { input: Record<string, unknown> }> {
  let currentInput = payload.input;

  for (const { handler, unitId, contributionId } of hooks) {
    const result = await handler({ ...payload, input: currentInput });
    if (result.action === 'deny') {
      logger.warn('[hook interceptor] before_tool_call denied', {
        unitId,
        contributionId,
        tool: payload.toolName,
        reason: result.reason,
      });
      return { action: 'deny', reason: result.reason, input: currentInput };
    }
    if ('input' in result) {
      if (!isPlainJsonObject(result.input)) {
        throw new TypeError(
          `before_tool_call ${unitId}/${contributionId} returned a non-JSON object input.`,
        );
      }
      currentInput = result.input;
    }
  }

  return { action: 'allow', input: currentInput };
}

function observerCorrelation(payload: object): Record<string, string> {
  const correlated = payload as {
    readonly sessionKey?: unknown;
    readonly turnId?: unknown;
    readonly result?: { readonly callId?: unknown };
  };
  return {
    ...(typeof correlated.sessionKey === 'string' ? { sessionKey: correlated.sessionKey } : {}),
    ...(typeof correlated.turnId === 'string' ? { turnId: correlated.turnId } : {}),
    ...(typeof correlated.result?.callId === 'string'
      ? { callId: correlated.result.callId }
      : {}),
  };
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      return Array.isArray(value)
        ? value.every(isJsonValue)
        : isPlainJsonObject(value);
    default:
      return false;
  }
}

export function runAfterToolCall(
  hooks: readonly HookBinding<AfterToolCallHook>[],
  payload: Omit<AfterToolCallPayload, 'signal'>,
  turnSignal: AbortSignal,
  deadlineMs = OBSERVER_HOOK_DEADLINE_MS,
): Promise<readonly HookSettlement[]> {
  return runObserverHooks(hooks, payload, turnSignal, 'after_tool_call', deadlineMs);
}

export function runBeforeCompaction(
  hooks: readonly HookBinding<BeforeCompactionHook>[],
  payload: Omit<BeforeCompactionPayload, 'signal'>,
  turnSignal: AbortSignal,
  deadlineMs = OBSERVER_HOOK_DEADLINE_MS,
): Promise<readonly HookSettlement[]> {
  return runObserverHooks(hooks, payload, turnSignal, 'before_compaction', deadlineMs);
}

export function runAfterCompaction(
  hooks: readonly HookBinding<AfterCompactionHook>[],
  payload: Omit<AfterCompactionPayload, 'signal'>,
  turnSignal: AbortSignal,
  deadlineMs = OBSERVER_HOOK_DEADLINE_MS,
): Promise<readonly HookSettlement[]> {
  return runObserverHooks(hooks, payload, turnSignal, 'after_compaction', deadlineMs);
}
