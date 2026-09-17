import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { ConsoleAdapter } from './ConsoleAdapter.js';
import type { LogEntry } from './types.js';

function makeEntry(overrides?: Partial<LogEntry>): LogEntry {
  return {
    level: 'info',
    message: 'test message',
    module: 'TestModule',
    timestamp: new Date('2026-04-24T10:00:00.000Z'),
    ...overrides,
  };
}

describe('ConsoleAdapter', () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('write', () => {
    it('writes info to stdout', () => {
      const adapter = new ConsoleAdapter({ colors: false });
      adapter.write(makeEntry({ level: 'info' }));
      expect(stdoutSpy).toHaveBeenCalledOnce();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('uses the terminal default color for info', () => {
      const adapter = new ConsoleAdapter({ colors: true });
      adapter.write(makeEntry({ level: 'info' }));
      expect(stdoutSpy).toHaveBeenCalledWith(
        '[2026-04-24T10:00:00.000Z] [INFO ] [TestModule] test message\n',
      );
    });

    it('uses gray for debug', () => {
      const adapter = new ConsoleAdapter({ colors: true });
      adapter.write(makeEntry({ level: 'debug' }));
      expect(stdoutSpy).toHaveBeenCalledWith(
        '\x1b[90m[2026-04-24T10:00:00.000Z] [DEBUG] [TestModule] test message\x1b[0m\n',
      );
    });

    it('writes error to stderr', () => {
      const adapter = new ConsoleAdapter({ colors: false });
      adapter.write(makeEntry({ level: 'error' }));
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('includes timestamp, level, module, message in output', () => {
      const adapter = new ConsoleAdapter({ colors: false });
      adapter.write(makeEntry());
      const output = String(stdoutSpy.mock.calls[0]?.[0]);
      expect(output).toContain('2026-04-24T10:00:00.000Z');
      expect(output).toContain('INFO ');
      expect(output).toContain('TestModule');
      expect(output).toContain('test message');
    });

    it('includes context as JSON when present', () => {
      const adapter = new ConsoleAdapter({ colors: false });
      adapter.write(makeEntry({ context: { sessionKey: 'main' } }));
      const output = String(stdoutSpy.mock.calls[0]?.[0]);
      expect(output).toContain('{"sessionKey":"main"}');
    });

    it('omits context when undefined', () => {
      const adapter = new ConsoleAdapter({ colors: false });
      adapter.write(makeEntry({ context: undefined }));
      const output = String(stdoutSpy.mock.calls[0]?.[0]);
      expect(output).not.toContain('{');
    });

    it('respects minLevel filter', () => {
      const adapter = new ConsoleAdapter({ colors: false, minLevel: 'warn' });
      adapter.write(makeEntry({ level: 'debug' }));
      adapter.write(makeEntry({ level: 'info' }));
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it('passes entries at or above minLevel', () => {
      const adapter = new ConsoleAdapter({ colors: false, minLevel: 'warn' });
      adapter.write(makeEntry({ level: 'warn' }));
      adapter.write(makeEntry({ level: 'error' }));
      expect(stdoutSpy).toHaveBeenCalledOnce();  // warn → stdout
      expect(stderrSpy).toHaveBeenCalledOnce();  // error → stderr
    });
  });
});
