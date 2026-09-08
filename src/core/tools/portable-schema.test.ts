import { describe, expect, it } from 'vitest';
import {
  compilePortableToolSchema,
  PortableToolSchemaError,
} from './portable-schema.js';

describe('portable Tool schema', () => {
  it('compiles the portable Draft-07 subset without mutating input', () => {
    const compiled = compilePortableToolSchema({
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1 },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        retries: { type: 'integer', minimum: 0 },
      },
      required: ['command'],
      additionalProperties: false,
    });
    const input: Record<string, unknown> = { command: 'run', retries: 1 };

    expect(compiled.validate(input)).toEqual({ valid: true, errors: [] });
    expect(input).toEqual({ command: 'run', retries: 1 });
    expect(Object.isFrozen(compiled.schema)).toBe(true);
    expect(Object.isFrozen(compiled.schema.properties)).toBe(true);
  });

  it('does not coerce, add defaults, or remove additional properties', () => {
    const compiled = compilePortableToolSchema({
      type: 'object',
      properties: {
        count: { type: 'integer' },
      },
      required: ['count'],
      additionalProperties: false,
    });
    const input: Record<string, unknown> = { count: '1', extra: true };

    const result = compiled.validate(input);

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.keyword)).toEqual([
      'additionalProperties',
      'type',
    ]);
    expect(input).toEqual({ count: '1', extra: true });
  });

  it.each([
    [{ type: 'string' }, 'root type'],
    [{ type: ['object', 'null'] }, 'one portable JSON Schema type'],
    [{ type: 'object', oneOf: [] }, 'unsupported keyword "oneOf"'],
    [{ type: 'object', properties: {}, required: ['missing'] }, 'undefined property "missing"'],
    [{ type: 'object', properties: { value: { $ref: '#/x' } } }, 'one portable JSON Schema type'],
  ])('rejects schemas outside the portable profile: %j', (schema, message) => {
    expect(() => compilePortableToolSchema(schema as Record<string, unknown>))
      .toThrow(new RegExp(message));
  });

  it('rejects non-JSON schema values', () => {
    expect(() => compilePortableToolSchema({
      type: 'object',
      description: () => 'not JSON',
    })).toThrow(PortableToolSchemaError);
  });
});
