import { describe, expect, it } from 'vitest';

import { pickSchemaKeys, diffAgainstDefaults, buildNextConfig } from './diff.js';
import { DEFAULT_AGENT_CONFIG, DEFAULT_LOGGER_CONFIG } from '../defaults.js';

// ── pickSchemaKeys ─────────────────────────────────────────

describe('pickSchemaKeys', () => {
  const schema = {
    llm: { apiKey: 'x', maxTokens: 4096 },
    memory: { enabled: true, search: { maxResults: 6, minScore: 0.25 } },
  };

  it('keeps schema keys and discards schema-外 keys at top level', () => {
    const input = {
      llm: { apiKey: 'sk-xxx' },
      experimental: { fooFlag: true },
    };
    const { kept, discarded } = pickSchemaKeys(input, schema);
    expect(kept).toEqual({ llm: { apiKey: 'sk-xxx' } });
    expect(discarded).toEqual(['experimental.fooFlag']);
  });

  it('recurses into nested objects', () => {
    const input = {
      memory: {
        enabled: false,
        unknown: 'gone',
        search: { maxResults: 10, foo: 'gone too' },
      },
    };
    const { kept, discarded } = pickSchemaKeys(input, schema);
    expect(kept).toEqual({
      memory: { enabled: false, search: { maxResults: 10 } },
    });
    expect(discarded.sort()).toEqual(
      ['memory.search.foo', 'memory.unknown'].sort(),
    );
  });

  it('records leaf paths for discarded object sub-tree', () => {
    const input = {
      experimental: {
        a: 1,
        b: { c: 2, d: 3 },
      },
    };
    const { kept, discarded } = pickSchemaKeys(input, schema);
    expect(kept).toEqual({});
    expect(discarded.sort()).toEqual(
      ['experimental.a', 'experimental.b.c', 'experimental.b.d'].sort(),
    );
  });

  it('passes arrays through without recursing into elements', () => {
    const arrSchema = { items: ['default'] };
    const input = { items: [1, { foo: 'bar' }, 'baz'] };
    const { kept, discarded } = pickSchemaKeys(input, arrSchema);
    expect(kept).toEqual({ items: [1, { foo: 'bar' }, 'baz'] });
    expect(discarded).toEqual([]);
  });

  it('returns empty kept when input is not a plain object but schema is', () => {
    const { kept, discarded } = pickSchemaKeys('not-an-object', schema);
    expect(kept).toEqual({});
    expect(discarded).toEqual([]);
  });

  it('applies path prefix to discarded paths', () => {
    const input = { llm: { apiKey: 'x', oops: 'y' } };
    const { discarded } = pickSchemaKeys(input, schema, 'agents.defaults');
    expect(discarded).toEqual(['agents.defaults.llm.oops']);
  });

  it('against real DEFAULT_AGENT_CONFIG: drops experimental field', () => {
    const input = {
      llm: { apiKey: 'sk-xxx', maxTokens: 8192 },
      experimental: { fooFlag: true },
    };
    const { kept, discarded } = pickSchemaKeys(input, DEFAULT_AGENT_CONFIG);
    expect((kept as { llm: { apiKey: string } }).llm.apiKey).toBe('sk-xxx');
    expect(discarded).toContain('experimental.fooFlag');
  });
});

// ── diffAgainstDefaults ────────────────────────────────────

describe('diffAgainstDefaults', () => {
  it('omits scalar fields equal to default', () => {
    const result = diffAgainstDefaults(
      { a: 1, b: 2 },
      { a: 1, b: 5 },
    );
    expect(result).toEqual({ b: 2 });
  });

  it('returns empty object when everything matches', () => {
    const result = diffAgainstDefaults({ a: 1, b: 2 }, { a: 1, b: 2 });
    expect(result).toEqual({});
  });

  it('recurses into nested objects', () => {
    const result = diffAgainstDefaults(
      { nested: { x: 1, y: 99 } },
      { nested: { x: 1, y: 2 } },
    );
    expect(result).toEqual({ nested: { y: 99 } });
  });

  it('omits parent when all nested children match', () => {
    const result = diffAgainstDefaults(
      { nested: { x: 1, y: 2 }, other: 99 },
      { nested: { x: 1, y: 2 }, other: 0 },
    );
    expect(result).toEqual({ other: 99 });
  });

  it('skips undefined fields in collected', () => {
    const result = diffAgainstDefaults(
      { a: 1, b: undefined as unknown as number },
      { a: 0, b: 0 },
    );
    expect(result).toEqual({ a: 1 });
  });

  it('compares arrays by JSON content', () => {
    expect(diffAgainstDefaults({ arr: [1, 2, 3] }, { arr: [1, 2, 3] })).toEqual({});
    expect(diffAgainstDefaults({ arr: [1, 2, 3] }, { arr: [1, 2] })).toEqual({
      arr: [1, 2, 3],
    });
  });

  it('keeps collected value when types differ', () => {
    const result = diffAgainstDefaults(
      { a: 'string' as unknown as number },
      { a: 1 },
    );
    expect(result).toEqual({ a: 'string' });
  });
});

// ── buildNextConfig ────────────────────────────────────────

describe('buildNextConfig', () => {
  it('writes empty config when collected is empty and existing is empty', () => {
    const { next, discarded } = buildNextConfig({
      existing: {},
      collected: { agentsDefaults: {}, logger: {} },
    });
    expect(next).toEqual({});
    expect(discarded).toEqual([]);
  });

  it('discards schema-外 fields and reports them', () => {
    const existing = {
      agents: {
        defaults: {
          llm: { apiKey: 'sk-xxx' },
          experimental: { fooFlag: true },
        } as unknown,
      },
      logger: { trace: { enabled: true } } as unknown,
    } as Parameters<typeof buildNextConfig>[0]['existing'];

    const { next, discarded } = buildNextConfig({
      existing,
      collected: { agentsDefaults: {}, logger: {} },
    });

    expect(next.agents?.defaults).toEqual({ llm: { apiKey: 'sk-xxx' } });
    expect(next.logger).toBeUndefined(); // logger 内全是 schema 外字段 → 空 → 清理
    expect(discarded.sort()).toEqual(
      ['agents.defaults.experimental.fooFlag', 'logger.trace.enabled'].sort(),
    );
  });

  it('preserves agents.list[] (top-level non-touched)', () => {
    const existing = {
      agents: {
        defaults: { llm: { apiKey: 'sk-xxx' } } as unknown,
        list: [{ id: 'main', default: true }],
      },
    } as Parameters<typeof buildNextConfig>[0]['existing'];

    const { next } = buildNextConfig({
      existing,
      collected: { agentsDefaults: {}, logger: {} },
    });

    expect(next.agents?.list).toEqual([{ id: 'main', default: true }]);
    expect(next.agents?.defaults).toEqual({ llm: { apiKey: 'sk-xxx' } });
  });

  it('lets collected override existing kept fields', () => {
    const existing = {
      agents: {
        defaults: { llm: { maxTokens: 8192 } } as unknown,
      },
    } as Parameters<typeof buildNextConfig>[0]['existing'];

    const { next } = buildNextConfig({
      existing,
      collected: { agentsDefaults: { llm: { maxTokens: 16384 } }, logger: {} },
    });

    expect(next.agents?.defaults).toEqual({ llm: { maxTokens: 16384 } });
  });

  it('corner case: user actively resets a non-default field back to default → field is removed', () => {
    // existing: maxTokens=10000 (非 default 4096); wizard 中用户改回 4096
    const existing = {
      agents: {
        defaults: { llm: { maxTokens: 10000 } } as unknown,
      },
    } as Parameters<typeof buildNextConfig>[0]['existing'];

    const { next } = buildNextConfig({
      existing,
      collected: {
        agentsDefaults: { llm: { maxTokens: DEFAULT_AGENT_CONFIG.llm.maxTokens } },
        logger: {},
      },
    });

    // 写入文件不应再包含 maxTokens override
    expect(next.agents?.defaults).toBeUndefined();
  });

  it('discards the removed legacy context-window field', () => {
    const existing = {
      agents: {
        defaults: { llm: { contextWindowTokens: 32000 } } as unknown,
      },
    } as Parameters<typeof buildNextConfig>[0]['existing'];

    const { next, discarded } = buildNextConfig({
      existing,
      collected: { agentsDefaults: {}, logger: {} },
    });

    expect(next.agents?.defaults).toBeUndefined();
    expect(discarded).toContain('agents.defaults.llm.contextWindowTokens');
  });

  it('cleans up empty {} sections (agents.defaults, agents, logger)', () => {
    const { next } = buildNextConfig({
      existing: {},
      collected: { agentsDefaults: {}, logger: {} },
    });

    expect('agents' in next).toBe(false);
    expect('logger' in next).toBe(false);
  });

  it('keeps non-default logger field that user kept from existing', () => {
    const existing = {
      logger: { minLevel: 'debug' },
    } as Parameters<typeof buildNextConfig>[0]['existing'];

    const { next } = buildNextConfig({
      existing,
      collected: { agentsDefaults: {}, logger: {} },
    });

    // existing 中 minLevel=debug ≠ default 'info' → 保留
    expect(next.logger).toEqual({ minLevel: 'debug' });
    // sanity check: DEFAULT_LOGGER_CONFIG.minLevel 是 'info'
    expect(DEFAULT_LOGGER_CONFIG.minLevel).toBe('info');
  });
});
