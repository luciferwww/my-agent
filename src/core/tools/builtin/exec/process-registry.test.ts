import { describe, expect, it } from 'vitest';

import type { ProcessRecord } from './exec-types.js';
import { InMemoryProcessRegistry } from './process-registry.js';

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
  };
}

describe('InMemoryProcessRegistry', () => {
  it('hides internal records from listVisible', () => {
    const registry = new InMemoryProcessRegistry();
    registry.create(createRecord({ runId: 'internal', visibility: 'internal' }));
    registry.create(createRecord({ runId: 'background', visibility: 'background' }));

    const visible = registry.listVisible();
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

    const record = registry.get('proc_1');
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

    const record = registry.get('proc_1');
    expect(record?.status).toBe('completed');
    expect(record?.exitCode).toBe(0);
  });
});