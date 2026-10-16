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
  ])('materializes a write-only root string %s before schema validation', (
    _label,
    apiKey,
    environment,
    expected,
  ) => {
    const result = prepareExtensionConfig(
      { apiKey },
      objectSchema({ apiKey: { type: 'string', writeOnly: true } }, ['apiKey']),
      environment,
    );

    expect(result).toEqual({ ok: true, config: { apiKey: expected } });
  });

  it.each([undefined, '   '])(
    'rejects a missing or blank exact write-only reference safely',
    (value) => {
      const result = prepareExtensionConfig(
        { apiKey: '${RELAY_API_KEY}' },
        objectSchema({ apiKey: { type: 'string', writeOnly: true } }, ['apiKey']),
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

  it('does not infer sensitive behavior from the apiKey property name', () => {
    const result = prepareExtensionConfig(
      { apiKey: '${RELAY_API_KEY}' },
      objectSchema({ apiKey: { type: 'string' } }, ['apiKey']),
      { RELAY_API_KEY: 'resolved-secret' },
    );

    expect(result).toEqual({
      ok: true,
      config: { apiKey: '${RELAY_API_KEY}' },
    });
  });

  it('materializes any direct root string explicitly marked write-only', () => {
    const result = prepareExtensionConfig(
      { accessToken: '${PROVIDER_TOKEN}' },
      objectSchema({
        accessToken: { type: 'string', writeOnly: true },
      }, ['accessToken']),
      { PROVIDER_TOKEN: 'resolved-token' },
    );

    expect(result).toEqual({
      ok: true,
      config: { accessToken: 'resolved-token' },
    });
  });

  it.each([
    ['non-string', { type: 'number', writeOnly: true }, false],
    ['not write-only', { type: 'string', writeOnly: false }, true],
    ['referenced', {
      type: 'string',
      writeOnly: true,
      $ref: '#/definitions/secret',
    }, true],
    ['composed', {
      type: 'string',
      writeOnly: true,
      allOf: [{ minLength: 1 }],
    }, true],
  ])('does not materialize an unsupported %s property shape', (
    _label,
    propertySchema,
    remainsValid,
  ) => {
    const schema = {
      ...objectSchema({ value: propertySchema }, ['value']),
      definitions: {
        secret: { type: 'string', writeOnly: true },
      },
    };
    const result = prepareExtensionConfig(
      { value: '${PROVIDER_TOKEN}' },
      schema,
      { PROVIDER_TOKEN: 'resolved-token' },
    );

    expect(result).toMatchObject(
      remainsValid
        ? { ok: true, config: { value: '${PROVIDER_TOKEN}' } }
        : { ok: false, code: 'config_validation_failed' },
    );
  });

  it('escapes and bounds sensitive-property diagnostic paths', () => {
    const propertyName = `${'a'.repeat(195)}~`;
    const result = prepareExtensionConfig(
      { [propertyName]: '${MISSING_TOKEN}' },
      objectSchema({
        [propertyName]: { type: 'string', writeOnly: true },
      }, [propertyName]),
      {},
    );

    expect(result).toMatchObject({
      ok: false,
      referencePath: expect.stringMatching(/^\//),
    });
    if (!result.ok) {
      expect(result.referencePath!.length).toBeLessThanOrEqual(200);
      expect(result.referencePath).not.toMatch(/~(?:[^01]|$)/);
    }
  });

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