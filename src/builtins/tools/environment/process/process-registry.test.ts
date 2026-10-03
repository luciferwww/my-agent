import { describe, expect, it, vi } from 'vitest';

import type { ProcessRecord } from './exec-types.js';
import {
  InMemoryProcessRegistry,
  MAX_ACTIVE_MANAGED_PROCESSES,
  MAX_PROCESS_OUTPUT_BYTES,
  MAX_RETAINED_TERMINAL_PROCESSES,
  ProcessRegistryCapacityError,
} from './process-registry.js';

function createRecord(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    runId: 'proc_1',
    command: 'node -e "console.log(1)"',
    cwd: process.cwd(),
    env: {},
    status: 'starting',
    visibility: 'internal',
    createdAt: Date.now(),
    chunks: [],
    output: '',
    ...overrides,
    sessionId: overrides.sessionId ?? 'session-1',
  };
}

describe('InMemoryProcessRegistry', () => {
  it('hides internal records from listVisible', () => {
    const registry = new InMemoryProcessRegistry();
    registry.create(createRecord({ runId: 'internal', visibility: 'internal' }));
    registry.create(createRecord({ runId: 'background', visibility: 'background' }));

    const visible = registry.listVisible('session-1');
    expect(visible).toHaveLength(1);
    expect(visible[0]?.runId).toBe('background');
  });

  it('appends chunks and aggregated output together', () => {
    const registry = new InMemoryProcessRegistry();
    registry.create(createRecord({ visibility: 'background' }));

    registry.appendOutput('proc_1', {
      stream: 'stdout',
      text: 'hello',
      timestamp: Date.now(),
    });

    const record = registry.get('proc_1', 'session-1');
    expect(record?.chunks).toHaveLength(1);
    expect(record?.output).toBe('hello');
  });

  it('does not roll back a terminal status', () => {
    const registry = new InMemoryProcessRegistry();
    registry.create(createRecord({ visibility: 'background', status: 'running' }));

    registry.complete('proc_1', {
      status: 'completed',
      endedAt: Date.now(),
      exitCode: 0,
    });
    registry.complete('proc_1', {
      status: 'failed',
      endedAt: Date.now(),
      exitCode: 1,
    });

    const record = registry.get('proc_1', 'session-1');
    expect(record?.status).toBe('completed');
    expect(record?.exitCode).toBe(0);
  });

  it('isolates lookup and listing by Session', () => {
    const registry = new InMemoryProcessRegistry();
    registry.create(createRecord({ runId: 'owned', visibility: 'background' }));

    expect(registry.get('owned', 'other-session')).toBeUndefined();
    expect(registry.listVisible('other-session')).toEqual([]);
    expect(registry.listVisible('session-1')).toHaveLength(1);
  });

  it('rejects the ninth active managed process without a wait queue', () => {
    const registry = new InMemoryProcessRegistry();
    for (let index = 0; index < MAX_ACTIVE_MANAGED_PROCESSES; index++) {
      registry.create(createRecord({ runId: `active-${index}` }));
    }

    expect(() => registry.create(createRecord({ runId: 'overflow' })))
      .toThrow(ProcessRegistryCapacityError);
  });

  it('retains only the newest bounded output bytes', () => {
    const registry = new InMemoryProcessRegistry();
    registry.create(createRecord());
    registry.appendOutput('proc_1', {
      stream: 'stdout',
      text: 'a'.repeat(MAX_PROCESS_OUTPUT_BYTES + 100),
      timestamp: 1,
    });

    const record = registry.get('proc_1', 'session-1');
    expect(Buffer.byteLength(record?.output ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_PROCESS_OUTPUT_BYTES,
    );
    expect(record?.output).toMatch(/^\[Earlier process output truncated\]/);
    expect(record?.outputTruncated).toBe(true);
    expect(record?.chunks).toHaveLength(1);
  });

  it('evicts terminal records beyond the fixed retention bound', () => {
    const registry = new InMemoryProcessRegistry();
    for (let index = 0; index <= MAX_RETAINED_TERMINAL_PROCESSES; index++) {
      const runId = `terminal-${index}`;
      registry.create(createRecord({ runId, createdAt: index }));
      registry.complete(runId, {
        status: 'completed',
        endedAt: index,
        exitCode: 0,
      });
    }

    expect(registry.get('terminal-0', 'session-1')).toBeUndefined();
    expect(registry.get(
      `terminal-${MAX_RETAINED_TERMINAL_PROCESSES}`,
      'session-1',
    )).toBeDefined();
  });

  it('cleans up only the requested Session processes', async () => {
    const registry = new InMemoryProcessRegistry();
    const kill = vi.fn(() => true);
    registry.create(createRecord({
      runId: 'owned',
      status: 'running',
      child: { kill },
    }));
    registry.create(createRecord({
      runId: 'other',
      sessionId: 'session-2',
      visibility: 'background',
    }));

    await registry.cleanupSession('session-1');

    expect(kill).toHaveBeenCalled();
    expect(registry.get('owned', 'session-1')).toBeUndefined();
    expect(registry.get('other', 'session-2')).toBeDefined();
  });
});