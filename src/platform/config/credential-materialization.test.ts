import { describe, expect, it } from 'vitest';

import {
  CredentialMaterializationError,
  materializeExactStringCredential,
} from './credential-materialization.js';

describe('materializeExactStringCredential', () => {
  it('retains literals and resolves an exact environment reference', () => {
    expect(materializeExactStringCredential(' literal-key ', {})).toBe(' literal-key ');
    expect(materializeExactStringCredential(
      '${SERVICE_API_KEY}',
      { SERVICE_API_KEY: 'secret-value' },
    )).toBe('secret-value');
    expect(materializeExactStringCredential(
      'prefix-${SERVICE_API_KEY}',
      { SERVICE_API_KEY: 'ignored' },
    )).toBe('prefix-${SERVICE_API_KEY}');
  });

  it.each(['${lowercase}', '${1INVALID}', '${}', '${VALID-NAME}'])(
    'rejects malformed exact references: %s',
    (value) => {
      expect(() => materializeExactStringCredential(value, {}))
        .toThrow(CredentialMaterializationError);
    },
  );

  it.each([undefined, '', '   '])(
    'reports missing or blank referenced credentials safely',
    (secret) => {
      try {
        materializeExactStringCredential(
          '${SERVICE_API_KEY}',
          { SERVICE_API_KEY: secret },
        );
      } catch (error) {
        expect(error).toMatchObject({
          secretUnavailable: true,
          environmentVariable: 'SERVICE_API_KEY',
        });
        expect((error as Error).message).not.toContain('secret-value');
        return;
      }
      throw new Error('Expected materialization to fail.');
    },
  );
});
