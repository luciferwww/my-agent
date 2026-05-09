import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAdapter } from './FileAdapter.js';
import type { LogEntry } from './types.js';

function makeEntry(overrides?: Partial<LogEntry>): LogEntry {
  return {
    level: 'info',
    message: 'test',
    module: 'M',
    timestamp: new Date('2026-04-24T10:00:00.000Z'),
    ...overrides,
  };
}

describe('FileAdapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'logger-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('start() creates dir if not exists', async () => {
    const adapter = new FileAdapter({ dir: join(dir, 'sub') });
    await adapter.start();
    // start しても close まで書き込まれないが、dir は作成されている
    await adapter.close();
  });

  it('writes JSONL entry to date-named file after close', async () => {
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    adapter.write(makeEntry({ message: 'hello' }));
    await adapter.close();

    const content = await readFile(join(dir, 'app.2026-04-24.log'), 'utf-8');
    const line = JSON.parse(content.trim());
    expect(line.message).toBe('hello');
    expect(line.level).toBe('info');
    expect(line.module).toBe('M');
    expect(line.timestamp).toBe('2026-04-24T10:00:00.000Z');
  });

  it('omits context field when undefined', async () => {
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    adapter.write(makeEntry({ context: undefined }));
    await adapter.close();

    const content = await readFile(join(dir, 'app.2026-04-24.log'), 'utf-8');
    const line = JSON.parse(content.trim());
    expect(Object.keys(line)).not.toContain('context');
  });

  it('includes context when provided', async () => {
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    adapter.write(makeEntry({ context: { sessionKey: 'main' } }));
    await adapter.close();

    const content = await readFile(join(dir, 'app.2026-04-24.log'), 'utf-8');
    const line = JSON.parse(content.trim());
    expect(line.context).toEqual({ sessionKey: 'main' });
  });

  it('writes entries to different files by date', async () => {
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    adapter.write(makeEntry({ timestamp: new Date('2026-04-24T10:00:00.000Z') }));
    adapter.write(makeEntry({ timestamp: new Date('2026-04-25T10:00:00.000Z') }));
    await adapter.close();

    const day1 = await readFile(join(dir, 'app.2026-04-24.log'), 'utf-8');
    const day2 = await readFile(join(dir, 'app.2026-04-25.log'), 'utf-8');
    expect(day1.trim()).toBeTruthy();
    expect(day2.trim()).toBeTruthy();
  });

  it('respects minLevel filter', async () => {
    const adapter = new FileAdapter({ dir, minLevel: 'warn' });
    await adapter.start();
    adapter.write(makeEntry({ level: 'debug' }));
    adapter.write(makeEntry({ level: 'info' }));
    adapter.write(makeEntry({ level: 'warn', message: 'kept' }));
    await adapter.close();

    const content = await readFile(join(dir, 'app.2026-04-24.log'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).message).toBe('kept');
  });

  it('triggers onError when queue is full', async () => {
    const errors: Error[] = [];
    const adapter = new FileAdapter({ dir, maxQueueSize: 2 });
    adapter.onError = (err) => { errors.push(err); };
    await adapter.start();
    adapter.write(makeEntry());
    adapter.write(makeEntry());
    adapter.write(makeEntry()); // overflow
    await adapter.close();
    expect(errors).toHaveLength(1);
  });

  it('uses custom prefix in filename', async () => {
    const adapter = new FileAdapter({ dir, prefix: 'server' });
    await adapter.start();
    adapter.write(makeEntry());
    await adapter.close();

    const content = await readFile(join(dir, 'server.2026-04-24.log'), 'utf-8');
    expect(content.trim()).toBeTruthy();
  });
});
