import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentConfig } from '../../platform/config/index.js';
import { FileAdapter, Logger } from '../../platform/logger/index.js';
import { RuntimeApp, type RuntimeHandle } from '../../runtime/index.js';

describe('Runtime logging with a real temporary Agent Home', () => {
  let home: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    vi.restoreAllMocks();
    Logger.__resetForTesting();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    home = await mkdtemp(join(tmpdir(), 'host-logging-'));
    await writeFile(join(home, 'config.json'), JSON.stringify({
      agents: { memory: { enabled: false } },
      logger: { minLevel: 'info' },
    }));
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await Logger.close();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it.each([false, true, undefined])('persists real startup/running records with Console policy %s', async (consoleLogging) => {
    const snapshot = await loadAgentConfig({ agentHome: home });
    runtime = await RuntimeApp.create({
      agentHome: home,
      applicationConfig: snapshot.application,
      ...(consoleLogging === undefined ? {} : { consoleLogging }),
    });
    Logger.get('LoggingIntegration').info('running record');
    const report = await runtime.close();
    runtime = undefined;
    expect(report.outcome).toBe('completed');
    const files = await readdir(join(home, 'logs'));
    expect(files).toHaveLength(1);
    const records = (await readFile(join(home, 'logs', files[0]!), 'utf8'))
      .trim().split('\n').map((line: string) => JSON.parse(line) as { message: string });
    expect(records.some(record => record.message === 'bootstrap start')).toBe(true);
    expect(records.some(record => record.message === 'running record')).toBe(true);
    const consoleOutput = vi.mocked(process.stdout.write).mock.calls
      .map(call => String(call[0])).join('');
    if (consoleLogging === false) {
      expect(consoleOutput).toBe('');
      expect(process.stderr.write).not.toHaveBeenCalled();
    } else {
      expect(consoleOutput).toContain('[LoggingIntegration] running record');
    }
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))).toEqual({
      agents: { memory: { enabled: false } },
      logger: { minLevel: 'info' },
    });
  });

  it('rejects startup before Memory initialization when the file destination cannot open', async () => {
    await writeFile(join(home, 'logs'), 'not a directory');
    const createMemoryManager = vi.fn(async () => null);
    const snapshot = await loadAgentConfig({ agentHome: home });
    await expect(RuntimeApp.create({
      agentHome: home,
      consoleLogging: false,
      applicationConfig: snapshot.application,
      dependencies: { createMemoryManager },
    })).rejects.toThrow();
    expect(createMemoryManager).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(await readFile(join(home, 'logs'), 'utf8')).toBe('not a directory');
  });

  it('attributes a failed log flush to shutdown without hiding it as completed', async () => {
    const snapshot = await loadAgentConfig({ agentHome: home });
    runtime = await RuntimeApp.create({
      agentHome: home,
      consoleLogging: false,
      applicationConfig: snapshot.application,
    });
    const logDir = join(home, 'logs');
    await Logger.close();
    await rm(logDir, { recursive: true });
    await mkdir(logDir);
    const file = new FileAdapter({ dir: logDir });
    await Logger.configure({ adapters: [file] });
    await rm(logDir, { recursive: true });
    await writeFile(logDir, 'destination unavailable');
    expect(() => Logger.get('LoggingIntegration').info('lost record')).not.toThrow();
    const report = await runtime.close();
    runtime = undefined;
    expect(report.failed).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: 'logger' }),
    ]));
    expect(report.completed).not.toContain('logger');
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('File logging append failed'));
  });
});
