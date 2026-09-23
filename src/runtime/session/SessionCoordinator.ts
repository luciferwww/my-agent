import { SessionError } from '../../core/session/errors.js';
import type { SessionManager } from '../../core/session/SessionManager.js';
import type { ContentBlock, SessionEntry } from '../../core/session/types.js';
import { deriveInitialSessionTitle } from '../../core/session/title.js';
import { PendingSessionRegistry } from './PendingSessionRegistry.js';

export type SessionPersistence = Pick<
  SessionManager,
  | 'archiveSession'
  | 'deleteSession'
  | 'forkSession'
  | 'getSession'
  | 'listSessions'
  | 'materializeSession'
  | 'renameSession'
  | 'unarchiveSession'
>;

export interface SessionCoordinatorOptions {
  sessionManager: SessionPersistence;
  pendingSessions?: PendingSessionRegistry;
  isBusy?: (sessionId: string) => boolean;
}

export interface SessionMessageAdmission {
  entry: SessionEntry;
}

export class SessionCoordinator {
  private readonly sessionManager: SessionPersistence;
  private readonly pendingSessions: PendingSessionRegistry;
  private readonly isBusy: (sessionId: string) => boolean;
  private readonly admissionGates = new Map<string, Promise<void>>();

  constructor(options: SessionCoordinatorOptions) {
    this.sessionManager = options.sessionManager;
    this.pendingSessions = options.pendingSessions ?? new PendingSessionRegistry();
    this.isBusy = options.isBusy ?? (() => false);
  }

  async createSession(): Promise<{ sessionId: string }> {
    const { sessionId } = this.pendingSessions.create();
    return { sessionId };
  }

  async listSessions(input?: { archived?: boolean }): Promise<SessionEntry[]> {
    return this.sessionManager.listSessions(input);
  }

  async getSession(sessionId: string): Promise<SessionEntry> {
    return this.requirePersistedSession(sessionId);
  }

  assertLiveSession(sessionId: string): void {
    const persisted = this.sessionManager.getSession(sessionId);
    if (persisted) {
      if (persisted.archivedAt !== undefined) {
        throw new SessionError('SESSION_ARCHIVED', `Session "${sessionId}" is archived.`);
      }
      return;
    }
    if (this.pendingSessions.get(sessionId)) return;
    throw new SessionError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
  }

  async renameSession(sessionId: string, title: string | null): Promise<SessionEntry> {
    return this.sessionManager.renameSession(sessionId, { title });
  }

  async archiveSession(sessionId: string): Promise<SessionEntry> {
    this.assertIdle(sessionId);
    return this.sessionManager.archiveSession(sessionId);
  }

  async unarchiveSession(sessionId: string): Promise<SessionEntry> {
    return this.sessionManager.unarchiveSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.pendingSessions.delete(sessionId)) return;
    this.assertIdle(sessionId);
    await this.sessionManager.deleteSession(sessionId);
  }

  async forkSession(sessionId: string, entryId?: string): Promise<SessionEntry> {
    this.assertIdle(sessionId);
    return this.sessionManager.forkSession(sessionId, entryId);
  }

  async admitMessage(
    sessionId: string,
    content: string | ContentBlock[],
  ): Promise<SessionMessageAdmission> {
    return this.withAdmissionGate(sessionId, async () => {
      const persisted = this.sessionManager.getSession(sessionId);
      if (persisted) {
        if (persisted.archivedAt !== undefined) {
          throw new SessionError('SESSION_ARCHIVED', `Session "${sessionId}" is archived.`);
        }
        return { entry: persisted };
      }

      const pending = this.pendingSessions.get(sessionId);
      if (!pending) {
        throw new SessionError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
      }

      const title = deriveInitialSessionTitle(content);
      const entry = await this.sessionManager.materializeSession({
        sessionId,
        createdAt: pending.createdAt,
        ...(title === undefined ? {} : { title }),
      });
      this.pendingSessions.delete(sessionId);
      return { entry };
    });
  }

  private requirePersistedSession(sessionId: string): SessionEntry {
    const entry = this.sessionManager.getSession(sessionId);
    if (!entry) {
      throw new SessionError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`);
    }
    return entry;
  }

  private assertIdle(sessionId: string): void {
    this.requirePersistedSession(sessionId);
    if (this.isBusy(sessionId)) {
      throw new SessionError('SESSION_BUSY', `Session "${sessionId}" is busy.`);
    }
  }

  private async withAdmissionGate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionGates.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.admissionGates.set(sessionId, current);

    try {
      await previous;
      return await operation();
    } finally {
      release();
      if (this.admissionGates.get(sessionId) === current) {
        this.admissionGates.delete(sessionId);
      }
    }
  }
}