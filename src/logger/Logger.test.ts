import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from './Logger.js';
import type { LogAdapter, LogEntry } from './types.js';

function makeMockAdapter(): LogAdapter & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    write: (entry) => { entries.push(entry); },
  };
}

describe('Logger', () => {
  afterEach(async () => {
    // 重置为默认 ConsoleAdapter 状态
    await Logger.configure({ adapters: [], minLevel: 'error' });
  });

  describe('get', () => {
    it('returns same instance for same module name', () => {
      const a = Logger.get('Foo');
      const b = Logger.get('Foo');
      expect(a).toBe(b);
    });

    it('returns different instances for different module names', () => {
      const a = Logger.get('Foo');
      const b = Logger.get('Bar');
      expect(a).not.toBe(b);
    });
  });

  describe('configure', () => {
    it('routes entries to configured adapters', async () => {
      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'debug' });
      Logger.get('M').info('hello');
      expect(adapter.entries).toHaveLength(1);
      expect(adapter.entries[0]?.message).toBe('hello');
      expect(adapter.entries[0]?.module).toBe('M');
    });

    it('closes old adapters before switching', async () => {
      let closed = false;
      const old: LogAdapter = {
        write: () => {},
        close: async () => { closed = true; },
      };
      await Logger.configure({ adapters: [old] });
      await Logger.configure({ adapters: [] });
      expect(closed).toBe(true);
    });

    it('calls start() on new adapters', async () => {
      let started = false;
      const adapter: LogAdapter = {
        write: () => {},
        start: async () => { started = true; },
      };
      await Logger.configure({ adapters: [adapter] });
      expect(started).toBe(true);
    });
  });

  describe('minLevel filtering', () => {
    it('drops entries below minLevel', async () => {
      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'warn' });
      Logger.get('M').debug('d');
      Logger.get('M').info('i');
      Logger.get('M').warn('w');
      expect(adapter.entries).toHaveLength(1);
      expect(adapter.entries[0]?.level).toBe('warn');
    });

    it('setLevel adjusts level immediately', async () => {
      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'error' });
      Logger.get('M').warn('before');
      Logger.setLevel('warn');
      Logger.get('M').warn('after');
      expect(adapter.entries).toHaveLength(1);
      expect(adapter.entries[0]?.message).toBe('after');
    });
  });

  describe('LoggerInstance', () => {
    it('attaches module name to entries', async () => {
      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'debug' });
      Logger.get('MyModule').debug('msg');
      expect(adapter.entries[0]?.module).toBe('MyModule');
    });

    it('attaches context when provided', async () => {
      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'debug' });
      Logger.get('M').info('msg', { key: 'val' });
      expect(adapter.entries[0]?.context).toEqual({ key: 'val' });
    });

    it('omits context field when not provided', async () => {
      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'debug' });
      Logger.get('M').info('msg');
      expect(adapter.entries[0]?.context).toBeUndefined();
    });
  });

  describe('close', () => {
    it('calls close() on all adapters', async () => {
      const closed: string[] = [];
      const a: LogAdapter = { write: () => {}, close: async () => { closed.push('a'); } };
      const b: LogAdapter = { write: () => {}, close: async () => { closed.push('b'); } };
      await Logger.configure({ adapters: [a, b] });
      await Logger.close();
      expect(closed).toEqual(['a', 'b']);
    });
  });
});
