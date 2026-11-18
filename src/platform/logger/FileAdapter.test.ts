import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileAdapter } from './FileAdapter.js';
import type { LogEntry } from './types.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    unlink: vi.fn(actual.unlink),
    appendFile: vi.fn(actual.appendFile),
  };
});

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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-24T10:00:00.000Z'));
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    dir = await mkdtemp(join(tmpdir(), 'logger-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
    await expect(adapter.close()).rejects.toThrow('queue-overflow');
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

  it('opens the actual current file during startup and rejects an unusable destination', async () => {
    await mkdir(join(dir, 'app.2026-04-24.log'));
    const adapter = new FileAdapter({ dir });
    await expect(adapter.start()).rejects.toThrow();
    await adapter.close();
  });

  it('retains exactly seven UTC dates and leaves unrelated, invalid, future and linked entries alone', async () => {
    const retained = [
      'app.2026-04-18.log', 'app.2026-04-24.log', 'app.2026-04-25.log',
      'other.2026-01-01.log', 'app.2026-02-30.log', 'app.notes.log',
      'app.2026-01-01.log.backup',
    ];
    for (const name of [...retained, 'app.2026-04-17.log', 'app.2025-12-31.log']) {
      await writeFile(join(dir, name), '');
    }
    await mkdir(join(dir, 'app.2026-01-02.log'));
    const target = join(dir, 'target');
    await mkdir(target);
    await writeFile(join(target, 'preserve.txt'), 'preserve');
    await symlink(target, join(dir, 'app.2026-01-03.log'), 'junction');
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    await adapter.close();

    expect(await readdir(dir)).toEqual(expect.arrayContaining([
      ...retained, 'target', 'app.2026-01-02.log', 'app.2026-01-03.log',
    ]));
    expect(await readdir(dir)).not.toContain('app.2026-04-17.log');
    expect(await readdir(dir)).not.toContain('app.2025-12-31.log');
    expect(await readFile(join(target, 'preserve.txt'), 'utf8')).toBe('preserve');
  });

  it('cleans up on the next write after a UTC date change, including an idle interval', async () => {
    await writeFile(join(dir, 'app.2026-04-18.log'), 'old');
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    vi.setSystemTime(new Date('2026-04-25T00:00:00.000Z'));
    expect(await readdir(dir)).toContain('app.2026-04-18.log');
    adapter.write(makeEntry({ timestamp: new Date(), message: 'after midnight' }));
    await vi.waitFor(async () => {
      expect(await readFile(join(dir, 'app.2026-04-25.log'), 'utf8')).toContain('after midnight');
    });
    expect(await readdir(dir)).not.toContain('app.2026-04-18.log');
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
    adapter.write(makeEntry({ timestamp: new Date(), message: 'after idle' }));
    await adapter.close();
    expect(await readdir(dir)).toEqual(['app.2026-05-10.log']);
  });

  it('reports cleanup failure without rejecting usable logging and resets suppression after recovery', async () => {
    const failure = Object.assign(new Error('private filesystem details'), { code: 'EACCES' });
    const scan = vi.spyOn(fileSystem, 'readdir').mockRejectedValue(failure);
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    vi.setSystemTime(new Date('2026-04-25T00:00:00.000Z'));
    adapter.write(makeEntry({ message: 'still logged' }));
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
    scan.mockRestore();
    vi.setSystemTime(new Date('2026-04-26T00:00:00.000Z'));
    adapter.write(makeEntry({ message: 'cleanup recovered' }));
    await vi.waitFor(async () => {
      expect(await readFile(join(dir, 'app.2026-04-24.log'), 'utf8')).toContain('cleanup recovered');
    });
    vi.spyOn(fileSystem, 'readdir').mockRejectedValue(failure);
    vi.setSystemTime(new Date('2026-04-27T00:00:00.000Z'));
    adapter.write(makeEntry({ message: 'cleanup failed again' }));
    await adapter.close();
    expect(process.stderr.write).toHaveBeenCalledTimes(2);
    expect(vi.mocked(process.stderr.write).mock.calls.flat().join('')).not.toContain('private filesystem');
  });

  it('reports unlink failure while preserving the expired file and continuing writes', async () => {
    await writeFile(join(dir, 'app.2026-04-17.log'), 'preserve on failure');
    vi.spyOn(fileSystem, 'unlink').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    adapter.write(makeEntry({ message: 'usable destination' }));
    await adapter.close();
    expect(await readFile(join(dir, 'app.2026-04-17.log'), 'utf8')).toBe('preserve on failure');
    expect(await readFile(join(dir, 'app.2026-04-24.log'), 'utf8')).toContain('usable destination');
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('cleanup failed (EACCES)'));
  });

  it('coalesces append failures, continues after recovery and reports loss on close', async () => {
    const adapter = new FileAdapter({ dir });
    await adapter.start();
    const append = vi.spyOn(fileSystem, 'appendFile').mockRejectedValue(
      Object.assign(new Error('secret payload'), { code: 'ENOSPC' }),
    );
    const writeAndWait = async (count: number) => {
      expect(() => adapter.write(makeEntry({ message: 'private entry' }))).not.toThrow();
      await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(count));
    };
    adapter.write(makeEntry());
    await writeAndWait(1);
    await writeAndWait(2);
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
    append.mockResolvedValueOnce(undefined);
    await writeAndWait(3);
    await writeAndWait(4);
    expect(process.stderr.write).toHaveBeenCalledTimes(2);
    await expect(adapter.close()).rejects.toThrow('append failed (ENOSPC)');
    expect(vi.mocked(process.stderr.write).mock.calls.flat().join('')).not.toMatch(/secret payload|private entry/);
  });

  it('coalesces overflow until the queue drains and still writes retained entries', async () => {
    const adapter = new FileAdapter({ dir, maxQueueSize: 1 });
    await adapter.start();
    adapter.write(makeEntry({ message: 'retained' }));
    adapter.write(makeEntry());
    adapter.write(makeEntry());
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      expect(await readFile(join(dir, 'app.2026-04-24.log'), 'utf8')).toContain('retained');
    });
    adapter.write(makeEntry());
    adapter.write(makeEntry());
    expect(process.stderr.write).toHaveBeenCalledTimes(2);
    await expect(adapter.close()).rejects.toThrow('queue-overflow');
  });
});
