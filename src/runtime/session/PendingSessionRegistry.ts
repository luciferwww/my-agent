import { randomUUID } from 'node:crypto';
import { SessionError } from '../../core/session/errors.js';

export interface PendingSessionRegistration {
  sessionId: string;
  createdAt: number;
}

export interface PendingSessionRegistryOptions {
  ttlMs?: number;
  capacity?: number;
  now?: () => number;
  generateSessionId?: () => string;
  onExpire?: (sessionId: string) => void;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CAPACITY = 4096;

export class PendingSessionRegistry {
  private readonly registrations = new Map<string, PendingSessionRegistration>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly generateSessionId: () => string;
  private readonly onExpire?: (sessionId: string) => void;

  constructor(options: PendingSessionRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.now = options.now ?? Date.now;
    this.generateSessionId = options.generateSessionId ?? randomUUID;
    this.onExpire = options.onExpire;

    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new TypeError('Pending Session TTL must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.capacity) || this.capacity <= 0) {
      throw new TypeError('Pending Session capacity must be a positive integer.');
    }
  }

  create(): PendingSessionRegistration {
    const now = this.now();
    this.removeExpired(now);
    if (this.registrations.size >= this.capacity) {
      throw new SessionError(
        'SESSION_CAPACITY_EXCEEDED',
        'Pending Session capacity is exhausted.',
      );
    }

    const registration = Object.freeze({
      sessionId: this.generateSessionId(),
      createdAt: now,
    });
    this.registrations.set(registration.sessionId, registration);
    return registration;
  }

  get(sessionId: string): PendingSessionRegistration | undefined {
    this.removeExpired(this.now());
    return this.registrations.get(sessionId);
  }

  delete(sessionId: string): boolean {
    return this.registrations.delete(sessionId);
  }

  private removeExpired(now: number): void {
    for (const [sessionId, registration] of this.registrations) {
      if (now - registration.createdAt >= this.ttlMs) {
        this.registrations.delete(sessionId);
        this.onExpire?.(sessionId);
      }
    }
  }
}