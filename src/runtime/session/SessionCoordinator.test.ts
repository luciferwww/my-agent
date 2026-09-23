import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../core/session/SessionManager.js';
import { PendingSessionRegistry } from './PendingSessionRegistry.js';
import { SessionCoordinator } from './SessionCoordinator.js';

describe('SessionCoordinator', () => {
  let agentHome: string;
  let sessionManager: SessionManager;
  let coordinator: SessionCoordinator;
  let now: number;
  let sequence: number;

  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'session-coordinator-test-'));
    now = 100;
    sequence = 0;
    sessionManager = new SessionManager(agentHome, { now: () => now });
    coordinator = new SessionCoordinator({
      sessionManager,
      pendingSessions: new PendingSessionRegistry({
        now: () => now,
        generateSessionId: () => `00000000-0000-4000-8000-${String(sequence += 1).padStart(12, '0')}`,
      }),
    });
  });

  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  it('keeps a newly created Session pending and invisible', async () => {
    const { sessionId } = await coordinator.createSession();

    expect(await coordinator.listSessions()).toEqual([]);
    await expect(coordinator.getSession(sessionId)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('materializes Session metadata and title without persisting the admitted message', async () => {
    const { sessionId } = await coordinator.createSession();
    now = 200;

    const admission = await coordinator.admitMessage(sessionId, '  hello\n world  ');

    expect(admission).toMatchObject({
      entry: {
        sessionId,
        title: 'hello world',
        createdAt: 100,
        updatedAt: 200,
      },
    });
    expect(sessionManager.getMessages(sessionId)).toHaveLength(0);

    expect(await coordinator.admitMessage(sessionId, 'second')).toMatchObject({ entry: { sessionId } });
    expect(sessionManager.getMessages(sessionId)).toHaveLength(0);
  });

  it('serializes concurrent first admissions and materializes at most once', async () => {
    const { sessionId } = await coordinator.createSession();

    const [first, second] = await Promise.all([
      coordinator.admitMessage(sessionId, 'first'),
      coordinator.admitMessage(sessionId, 'second'),
    ]);

    expect(first.entry).toEqual(second.entry);
    expect(sessionManager.getMessages(sessionId)).toHaveLength(0);
  });

  it('retains Pending registration when materialization fails', async () => {
    const { sessionId } = await coordinator.createSession();
    const failingManager = {
      archiveSession: sessionManager.archiveSession.bind(sessionManager),
      deleteSession: sessionManager.deleteSession.bind(sessionManager),
      forkSession: sessionManager.forkSession.bind(sessionManager),
      getSession: sessionManager.getSession.bind(sessionManager),
      listSessions: sessionManager.listSessions.bind(sessionManager),
      materializeSession: async () => {
        throw new Error('disk failure');
      },
      renameSession: sessionManager.renameSession.bind(sessionManager),
      unarchiveSession: sessionManager.unarchiveSession.bind(sessionManager),
    };
    const retryableCoordinator = new SessionCoordinator({
      sessionManager: failingManager,
      pendingSessions: new PendingSessionRegistry({
        now: () => now,
        generateSessionId: () => sessionId,
      }),
    });
    await retryableCoordinator.createSession();

    await expect(retryableCoordinator.admitMessage(sessionId, 'first')).rejects.toThrow('disk failure');
    await expect(retryableCoordinator.admitMessage(sessionId, 'first')).rejects.toThrow('disk failure');
  });

  it('rejects unknown and archived Session admission', async () => {
    await expect(coordinator.admitMessage(
      '00000000-0000-4000-8000-999999999999',
      'unknown',
    )).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });

    const { sessionId } = await coordinator.createSession();
    await coordinator.admitMessage(sessionId, 'first');
    await coordinator.archiveSession(sessionId);
    await expect(coordinator.admitMessage(sessionId, 'again')).rejects.toMatchObject({
      code: 'SESSION_ARCHIVED',
    });
  });

  it('recognizes only pending or unarchived persisted Sessions as live', async () => {
    const { sessionId } = await coordinator.createSession();
    expect(() => coordinator.assertLiveSession(sessionId)).not.toThrow();

    await coordinator.admitMessage(sessionId, 'first');
    expect(() => coordinator.assertLiveSession(sessionId)).not.toThrow();

    await coordinator.archiveSession(sessionId);
    expect(() => coordinator.assertLiveSession(sessionId)).toThrow(
      expect.objectContaining({ code: 'SESSION_ARCHIVED' }),
    );
    expect(() => coordinator.assertLiveSession(
      '00000000-0000-4000-8000-999999999999',
    )).toThrow(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
  });

  it('enforces idle-only lifecycle operations', async () => {
    let busy = false;
    coordinator = new SessionCoordinator({
      sessionManager,
      pendingSessions: new PendingSessionRegistry({
        now: () => now,
        generateSessionId: () => '00000000-0000-4000-8000-000000000001',
      }),
      isBusy: () => busy,
    });
    const { sessionId } = await coordinator.createSession();
    await coordinator.admitMessage(sessionId, 'first');
    busy = true;

    await expect(coordinator.archiveSession(sessionId)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    await expect(coordinator.deleteSession(sessionId)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    await expect(coordinator.forkSession(sessionId)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
  });
});