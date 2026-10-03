import { describe, expect, it } from 'vitest';

import { prepareExtensionConfig } from './configuration.js';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

describe('prepareExtensionConfig', () => {
  it.each([
    { baseURL: { $env: 'RELAY_URL' } },
    { apiKey: { $secret: { source: 'env', name: 'RELAY_API_KEY' } } },
  ])('does not interpret legacy Extension reference wrappers %#', (input) => {
    const key = 'baseURL' in input ? 'baseURL' : 'apiKey';
    const result = prepareExtensionConfig(
      input,
      objectSchema({ [key]: { type: 'string' } }, [key]),
      {
        RELAY_URL: 'https://relay.invalid',
        RELAY_API_KEY: 'secret-value',
      },
    );

    expect(result).toEqual({
      ok: false,
      category: 'config_invalid',
      code: 'config_validation_failed',
    });
    expect(input[key]).toEqual(expect.any(Object));
  });

  it.each([
    ['literal', 'relay-secret', {}, 'relay-secret'],
    ['exact reference', '${RELAY_API_KEY}', { RELAY_API_KEY: 'resolved-secret' }, 'resolved-secret'],
    ['embedded non-reference', 'prefix-${RELAY_API_KEY}', { RELAY_API_KEY: 'ignored' }, 'prefix-${RELAY_API_KEY}'],
  ])('materializes an extension apiKey %s before schema validation', (
    _label,
    apiKey,
    environment,
    expected,
  ) => {
    const result = prepareExtensionConfig(
      { apiKey },
      objectSchema({ apiKey: { type: 'string' } }, ['apiKey']),
      environment,
    );

    expect(result).toEqual({ ok: true, config: { apiKey: expected } });
  });

  it.each([undefined, '   '])(
    'rejects a missing or blank exact apiKey reference safely',
    (value) => {
      const result = prepareExtensionConfig(
        { apiKey: '${RELAY_API_KEY}' },
        objectSchema({ apiKey: { type: 'string' } }, ['apiKey']),
        { RELAY_API_KEY: value },
      );

      expect(result).toMatchObject({
        ok: false,
        category: 'secret_unavailable',
        code: 'environment_secret_unavailable',
        referencePath: '/apiKey',
        environmentVariable: 'RELAY_API_KEY',
      });
      expect(JSON.stringify(result)).not.toContain('   ');
    },
  );

  it('applies static defaults only to the cloned config', () => {
    const input = {};
    const result = prepareExtensionConfig(
      input,
      objectSchema({ retries: { type: 'integer', default: 2 } }),
      {},
    );

    expect(result).toEqual({ ok: true, config: { retries: 2 } });
    expect(input).toEqual({});
  });

  it('does not coerce types or remove unknown fields', () => {
    const wrongType = { retries: '2' };
    const unknown = { extra: true };

    expect(prepareExtensionConfig(
      wrongType,
      objectSchema({ retries: { type: 'integer' } }),
      {},
    )).toMatchObject({ ok: false, code: 'config_validation_failed' });
    expect(wrongType).toEqual({ retries: '2' });

    expect(prepareExtensionConfig(unknown, objectSchema({}), {}))
      .toMatchObject({ ok: false, code: 'config_validation_failed' });
    expect(unknown).toEqual({ extra: true });
  });

  it('supports valid internal references', () => {
    const schema = {
      ...objectSchema({ value: { $ref: '#/definitions/text' } }, ['value']),
      definitions: { text: { type: 'string' } },
    };

    expect(prepareExtensionConfig({ value: 'ok' }, schema, {}))
      .toEqual({ ok: true, config: { value: 'ok' } });
  });

  it.each([
    ['an external reference', {
      ...objectSchema({ value: { $ref: 'https://example.invalid/schema.json' } }),
    }],
    ['a strict-mode unknown keyword', {
      ...objectSchema({}),
      unknownKeyword: true,
    }],
  ])('rejects %s during Schema compilation', (_label, schema) => {
    expect(prepareExtensionConfig({}, schema, {})).toEqual({
      ok: false,
      category: 'config_invalid',
      code: 'config_schema_invalid',
    });
  });

  it('rejects non-JSON values without retaining raw input', () => {
    expect(prepareExtensionConfig(
      { invalid: () => 'secret' },
      objectSchema({}),
      {},
    )).toEqual({
      ok: false,
      category: 'config_invalid',
      code: 'config_validation_failed',
    });
  });
});

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    $schema: DRAFT_07,
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}