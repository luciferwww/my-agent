import type { QueuedUserMessage } from './queue-types.js';

export class SessionMessageScheduler {
  private readonly queues = new Map<string, QueuedUserMessage[]>();
  private readonly runningSessions = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  enqueue(item: QueuedUserMessage): void {
    const queue = this.queues.get(item.sessionId) ?? [];
    queue.push(item);
    this.queues.set(item.sessionId, queue);
    this.notifyWaiters(item.sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.isRunning(sessionId) || this.pendingCount(sessionId) > 0;
  }

  pendingCount(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  pendingSessionIds(): string[] {
    return [...this.queues.keys()];
  }

  reserve(sessionId: string): void {
    if (this.isRunning(sessionId)) {
      throw new Error(`Session ${sessionId} already has a turn in flight.`);
    }
    this.runningSessions.add(sessionId);
  }

  takeNext(sessionId: string): QueuedUserMessage | undefined {
    if (this.isRunning(sessionId)) return undefined;
    const queue = this.queues.get(sessionId);
    const next = queue?.[0];
    if (!queue || !next) return undefined;

    this.reserve(sessionId);
    queue.shift();
    if (queue.length === 0) this.queues.delete(sessionId);
    return next;
  }

  release(sessionId: string): void {
    this.runningSessions.delete(sessionId);
  }

  claimReady(
    sessionId: string,
    isCompatible: (item: QueuedUserMessage) => boolean,
  ): QueuedUserMessage[] {
    const queue = this.queues.get(sessionId);
    if (!queue) return [];

    let count = 0;
    while (count < queue.length && isCompatible(queue[count]!)) count++;
    const claimed = queue.splice(0, count);
    if (queue.length === 0) this.queues.delete(sessionId);
    return claimed;
  }

  dropPending(sessionId: string): QueuedUserMessage[] {
    const queue = this.queues.get(sessionId) ?? [];
    this.queues.delete(sessionId);
    return queue;
  }

  waitUntilReady(sessionId: string, signal: AbortSignal): Promise<void> {
    if (this.pendingCount(sessionId) > 0) return Promise.resolve();
    if (signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    return new Promise<void>((resolve, reject) => {
      const waiters = this.waiters.get(sessionId) ?? new Set<() => void>();
      const settle = () => {
        signal.removeEventListener('abort', onAbort);
        waiters.delete(settle);
        if (waiters.size === 0) this.waiters.delete(sessionId);
        resolve();
      };
      const onAbort = () => {
        waiters.delete(settle);
        if (waiters.size === 0) this.waiters.delete(sessionId);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      waiters.add(settle);
      this.waiters.set(sessionId, waiters);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notifyWaiters(sessionId: string): void {
    const waiters = this.waiters.get(sessionId);
    if (!waiters) return;
    this.waiters.delete(sessionId);
    for (const settle of waiters) settle();
  }
}
