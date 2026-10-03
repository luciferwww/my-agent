import type {
  SessionPermissionMode,
  SessionPermissionState,
} from '../../core/approval/index.js';

export interface SessionPermissionRegistryOptions {
  readonly now?: () => number;
}

export class SessionPermissionRegistry {
  private readonly states = new Map<string, SessionPermissionState>();
  private readonly listeners = new Set<(state: SessionPermissionState) => void>();
  private readonly now: () => number;

  constructor(options: SessionPermissionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  initialize(
    sessionId: string,
    mode: SessionPermissionMode = 'manual',
    changedByClientId?: string,
  ): SessionPermissionState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    return this.set(sessionId, mode, changedByClientId);
  }

  get(sessionId: string): SessionPermissionState {
    return this.initialize(sessionId);
  }

  peek(sessionId: string): SessionPermissionState | undefined {
    return this.states.get(sessionId);
  }

  set(
    sessionId: string,
    mode: SessionPermissionMode,
    changedByClientId?: string,
  ): SessionPermissionState {
    const existing = this.states.get(sessionId);
    if (existing?.mode === mode) return existing;
    const state = Object.freeze({
      sessionId,
      mode,
      changedAt: this.now(),
      ...(changedByClientId === undefined ? {} : { changedByClientId }),
    });
    this.states.set(sessionId, state);
    for (const listener of this.listeners) listener(state);
    return state;
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId);
  }

  clear(): void {
    this.states.clear();
  }

  onChange(listener: (state: SessionPermissionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
