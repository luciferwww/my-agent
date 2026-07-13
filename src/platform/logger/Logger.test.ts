import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // Test setup (src/test-setup.ts) globally mocks Logger.configure to silence
  // logger output during tests. This file's tests EXERCISE Logger.configure,
  // so we restore the real implementation here.
  beforeAll(() => {
    vi.restoreAllMocks();
  });

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

  describe('startup buffer', () => {
    beforeEach(() => {
      // 把 Logger 复位到"未 configure"态，以便测试启动期 buffer 行为
      Logger.__resetForTesting();
    });

    it('drains pre-configure entries to adapter on first configure', async () => {
      Logger.get('M').info('first');
      Logger.get('M').warn('second');

      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'debug' });

      expect(adapter.entries.map((e) => e.message)).toEqual(['first', 'second']);
    });

    it('applies minLevel from configure() to buffered entries (not pre-configure)', async () => {
      // buffer 阶段不按 minLevel 过滤——所有级别都进 buffer
      Logger.get('M').debug('d');
      Logger.get('M').info('i');
      Logger.get('M').warn('w');

      // configure 时用 'warn' 过滤，所以只有 warn 应该出现
      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'warn' });

      expect(adapter.entries.map((e) => e.message)).toEqual(['w']);
    });

    it('emits sentinel when entries dropped due to overflow', async () => {
      // HEAD_LIMIT(20) + TAIL_LIMIT(80) = 100，多 5 条触发 dropped=5
      const total = 20 + 80 + 5;
      for (let i = 0; i < total; i++) {
        Logger.get('M').info(`msg-${i}`);
      }

      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'debug' });

      // 应有 head(20) + sentinel(1) + tail(80) = 101 条
      expect(adapter.entries).toHaveLength(20 + 1 + 80);

      // head 部分：msg-0 .. msg-19
      expect(adapter.entries[0]?.message).toBe('msg-0');
      expect(adapter.entries[19]?.message).toBe('msg-19');

      // sentinel 紧跟在 head 之后
      const sentinel = adapter.entries[20]!;
      expect(sentinel.module).toBe('Logger');
      expect(sentinel.level).toBe('warn');
      expect(sentinel.message).toMatch(/^5 log entries dropped during startup buffer overflow$/);

      // tail 部分：保留最后 80 条 → msg-25 .. msg-104
      expect(adapter.entries[21]?.message).toBe('msg-25');
      expect(adapter.entries.at(-1)?.message).toBe(`msg-${total - 1}`);
    });

    it('does not emit sentinel when no overflow', async () => {
      Logger.get('M').info('only-one');

      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'debug' });

      expect(adapter.entries).toHaveLength(1);
      expect(adapter.entries[0]?.message).toBe('only-one');
    });

    it('does not re-buffer on second configure()', async () => {
      // 首次 configure 关闭 buffer
      await Logger.configure({ adapters: [makeMockAdapter()], minLevel: 'debug' });

      // 此后写入应该直接派发，不进 buffer
      const adapter = makeMockAdapter();
      await Logger.configure({ adapters: [adapter], minLevel: 'debug' });
      Logger.get('M').info('after-second-configure');

      // 这条直接派发，没有走 buffer drain 路径
      expect(adapter.entries).toHaveLength(1);
      expect(adapter.entries[0]?.message).toBe('after-second-configure');
    });
  });
});
