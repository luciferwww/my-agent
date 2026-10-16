import { describe, expect, it, vi } from 'vitest';

import type { ExtensionDescriptorV1 } from '../../../extension/acquisition/index.js';
import type { InitializationPrompter } from './prompts.js';
import {
  collectExtensionConfiguration,
  UnsupportedInitializationSchemaError,
} from './schema.js';

describe('initialization Schema prompts', () => {
  it('omits defaults and optional unset values while preserving authored scalars', async () => {
    const prompter = fakePrompter({
      select: ['value:1', 'unset'],
      confirm: [true],
      text: ['', '12'],
    });
    const config = await collectExtensionConfiguration(descriptor({
      mode: { type: 'string', enum: ['fast', 'safe'], default: 'fast' },
      enabled: { type: 'boolean', default: true },
      optionalFlag: { type: 'boolean' },
      label: { type: 'string', default: 'default-label' },
      limit: { type: 'integer', minimum: 1 },
    }), prompter, {});

    expect(config).toEqual({ mode: 'safe', limit: 12 });
  });

  it('authors an exact environment reference only for a write-only string', async () => {
    const prompter = fakePrompter({
      select: ['environment'],
      text: ['PROVIDER_TOKEN', '${UNCHANGED}'],
    });
    const config = await collectExtensionConfiguration(descriptor({
      token: { type: 'string', writeOnly: true },
      apiKey: { type: 'string' },
    }), prompter, {
      PROVIDER_TOKEN: 'secret',
    });

    expect(config).toEqual({
      token: '${PROVIDER_TOKEN}',
      apiKey: '${UNCHANGED}',
    });
  });

  it('blocks an unsupported required authored field before entry import', async () => {
    const schema = descriptor({
      nested: { type: 'object', properties: {} },
    }, ['nested']);

    await expect(collectExtensionConfiguration(schema, fakePrompter({}), {}))
      .rejects.toEqual(expect.objectContaining<Partial<UnsupportedInitializationSchemaError>>({
        propertyName: 'nested',
      }));
  });

  it('skips optional or defaulted unsupported fields', async () => {
    const config = await collectExtensionConfiguration(descriptor({
      optionalNested: { type: 'object', properties: {} },
      defaultedNested: { type: 'object', default: {}, properties: {} },
    }, ['defaultedNested']), fakePrompter({}), {});

    expect(config).toEqual({});
  });
});

function descriptor(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): ExtensionDescriptorV1 {
  return Object.freeze({
    manifestVersion: 1,
    id: 'fixture',
    version: '1.0.0',
    entry: 'entry.js',
    contributes: Object.freeze(['provider'] as const),
    configSchema: Object.freeze({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length === 0 ? {} : { required }),
    }),
  });
}

function fakePrompter(values: {
  readonly select?: readonly string[];
  readonly text?: readonly string[];
  readonly confirm?: readonly boolean[];
}): InitializationPrompter {
  const selects = [...(values.select ?? [])];
  const texts = [...(values.text ?? [])];
  const confirms = [...(values.confirm ?? [])];
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(async () => requiredQueueValue(selects)),
    confirm: vi.fn(async () => requiredQueueValue(confirms)),
    text: vi.fn(async () => requiredQueueValue(texts)),
    progress: vi.fn(async (_message, operation) => operation()),
  };
}

function requiredQueueValue<T>(queue: T[]): T {
  const value = queue.shift();
  if (value === undefined) throw new Error('Fake prompt queue is empty.');
  return value;
}
