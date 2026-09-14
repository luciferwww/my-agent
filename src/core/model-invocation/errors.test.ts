import { describe, expect, it, vi } from 'vitest';
import {
  ModelInvocationError,
  toModelInvocationError,
  type ModelInvocationDiagnostics,
  type ModelInvocationFailureCategory,
  type ModelInvocationStructuralErrorV1,
} from './index.js';

const requestDiagnostics = {
  model: '  model\r\n\t\u0000  ',
  maxTokens: 128,
  hasSystem: true,
  messageCount: 4,
  userMessageCount: 2,
  assistantMessageCount: 2,
  stringContentMessageCount: 1,
  textBlockCount: 2,
  imageBlockCount: 3,
  toolUseBlockCount: 1,
  toolResultBlockCount: 1,
  toolDefinitionCount: 2,
};

const diagnostics: ModelInvocationDiagnostics = {
  providerId: 'provider_1',
  httpStatus: 429,
  providerErrorType: 'rate_limit_error',
  providerErrorCode: 'quota_exhausted',
  providerMessage: 'Retry later.',
  requestId: 'request-1',
  request: requestDiagnostics,
};

class ForeignModelInvocationError extends Error implements ModelInvocationStructuralErrorV1 {
  readonly protocol = 'my-agent.model-invocation-error';
  readonly version = 1 as const;

  constructor(
    readonly category: ModelInvocationFailureCategory,
    readonly diagnostics?: ModelInvocationDiagnostics,
  ) {
    super('foreign message must not survive');
    this.name = 'ForeignModelInvocationError';
  }
}

describe('Model Invocation structural error boundary', () => {
  it('passes through a Host-local ModelInvocationError', () => {
    const error = new ModelInvocationError('transport', diagnostics);

    expect(toModelInvocationError(error)).toBe(error);
    expect(error).toMatchObject({
      protocol: 'my-agent.model-invocation-error',
      version: 1,
      category: 'transport',
    });
  });

  it('canonicalizes a foreign constructor and copies only validated fields', () => {
    const foreign = new ForeignModelInvocationError('rate_limit', {
      ...diagnostics,
      unknown: 'ignored',
      rawResponse: { secret: true },
      request: {
        ...requestDiagnostics,
        unknownCount: 99,
        prompt: 'secret',
      },
    } as ModelInvocationDiagnostics);
    Object.defineProperty(foreign, 'privateSecret', { value: 'do not copy' });

    const canonical = toModelInvocationError(foreign);

    expect(canonical).toBeInstanceOf(ModelInvocationError);
    expect(canonical).not.toBe(foreign);
    expect(canonical).toEqual(expect.objectContaining({
      protocol: 'my-agent.model-invocation-error',
      version: 1,
      category: 'rate_limit',
      message: 'Model invocation failed: rate_limit.',
      diagnostics,
    }));
    expect(canonical).not.toHaveProperty('privateSecret');
    expect(canonical?.diagnostics).not.toHaveProperty('unknown');
    expect(canonical?.diagnostics).not.toHaveProperty('rawResponse');
    expect(canonical?.diagnostics?.request).not.toHaveProperty('unknownCount');
    expect(canonical?.diagnostics?.request).not.toHaveProperty('prompt');
    expect(Object.isFrozen(canonical?.diagnostics)).toBe(true);
    expect(Object.isFrozen(canonical?.diagnostics?.request)).toBe(true);
    expect(canonical?.diagnostics?.request.model).toBe(requestDiagnostics.model);
  });

  it.each([
    ['missing protocol', { version: 1, category: 'transport' }],
    ['wrong protocol', { protocol: 'other', version: 1, category: 'transport' }],
    ['unknown version', {
      protocol: 'my-agent.model-invocation-error', version: 2, category: 'transport',
    }],
    ['invalid category', {
      protocol: 'my-agent.model-invocation-error', version: 1, category: 'timeout',
    }],
  ])('rejects %s', (_label, fields) => {
    const error = Object.assign(new Error('lookalike'), fields);
    error.name = 'ModelInvocationError';

    expect(toModelInvocationError(error)).toBeUndefined();
  });

  it('accepts a valid category without diagnostics', () => {
    const foreign = new ForeignModelInvocationError('unavailable');

    expect(toModelInvocationError(foreign)).toMatchObject({
      category: 'unavailable',
      diagnostics: undefined,
    });
  });

  it.each([
    ['invalid provider identity', { ...diagnostics, providerId: 'invalid provider' }],
    ['out-of-range status', { ...diagnostics, httpStatus: 99 }],
    ['unsafe status', { ...diagnostics, httpStatus: Number.MAX_SAFE_INTEGER + 1 }],
    ['control character', { ...diagnostics, providerMessage: 'line\nbreak' }],
    ['oversized string', { ...diagnostics, requestId: 'x'.repeat(501) }],
    ['non-plain request', {
      ...diagnostics,
      request: Object.assign(Object.create({ inherited: true }), requestDiagnostics),
    }],
    ['invalid maxTokens', {
      ...diagnostics,
      request: { ...requestDiagnostics, maxTokens: 0 },
    }],
    ['invalid count', {
      ...diagnostics,
      request: { ...requestDiagnostics, imageBlockCount: -1 },
    }],
  ])('discards all diagnostics for %s while preserving category', (_label, invalid) => {
    const foreign = new ForeignModelInvocationError(
      'provider_failure',
      invalid as ModelInvocationDiagnostics,
    );

    expect(toModelInvocationError(foreign)).toMatchObject({
      category: 'provider_failure',
      diagnostics: undefined,
    });
  });

  it('rejects inherited discriminator fields', () => {
    const prototype = Object.assign(Object.create(Error.prototype), {
      protocol: 'my-agent.model-invocation-error',
      version: 1,
      category: 'transport',
    });
    const error = Object.setPrototypeOf(new Error('inherited'), prototype);

    expect(toModelInvocationError(error)).toBeUndefined();
  });

  it('does not execute discriminator or diagnostics accessors', () => {
    const discriminatorGetter = vi.fn(() => 'my-agent.model-invocation-error');
    const invalidEnvelope = new Error('accessor discriminator');
    Object.defineProperties(invalidEnvelope, {
      protocol: { get: discriminatorGetter },
      version: { value: 1 },
      category: { value: 'transport' },
    });

    const diagnosticsGetter = vi.fn(() => diagnostics);
    const validEnvelope = new ForeignModelInvocationError('transport');
    Object.defineProperty(validEnvelope, 'diagnostics', { get: diagnosticsGetter });

    expect(toModelInvocationError(invalidEnvelope)).toBeUndefined();
    expect(discriminatorGetter).not.toHaveBeenCalled();
    expect(toModelInvocationError(validEnvelope)).toMatchObject({
      category: 'transport',
      diagnostics: undefined,
    });
    expect(diagnosticsGetter).not.toHaveBeenCalled();
  });

  it('does not let descriptor failures escape', () => {
    const foreign = new Proxy(new Error('proxy failure'), {
      getOwnPropertyDescriptor() {
        throw new Error('descriptor trap');
      },
    });

    expect(() => toModelInvocationError(foreign)).not.toThrow();
    expect(toModelInvocationError(foreign)).toBeUndefined();
  });

  it('does not execute nested diagnostics or request accessors', () => {
    const requestGetter = vi.fn(() => requestDiagnostics);
    const accessorDiagnostics = { ...diagnostics } as Record<string, unknown>;
    Object.defineProperty(accessorDiagnostics, 'request', { get: requestGetter });

    const modelGetter = vi.fn(() => requestDiagnostics.model);
    const accessorRequest = { ...requestDiagnostics } as Record<string, unknown>;
    Object.defineProperty(accessorRequest, 'model', { get: modelGetter });

    expect(toModelInvocationError(new ForeignModelInvocationError(
      'transport',
      accessorDiagnostics as unknown as ModelInvocationDiagnostics,
    ))).toMatchObject({ category: 'transport', diagnostics: undefined });
    expect(toModelInvocationError(new ForeignModelInvocationError(
      'transport',
      { ...diagnostics, request: accessorRequest } as unknown as ModelInvocationDiagnostics,
    ))).toMatchObject({ category: 'transport', diagnostics: undefined });
    expect(requestGetter).not.toHaveBeenCalled();
    expect(modelGetter).not.toHaveBeenCalled();
  });

  it('does not let nested descriptor or prototype failures escape', () => {
    const descriptorFailure = new ForeignModelInvocationError('transport', new Proxy(diagnostics, {
      getOwnPropertyDescriptor() {
        throw new Error('nested descriptor trap');
      },
    }));
    const prototypeFailure = new ForeignModelInvocationError('transport', {
      ...diagnostics,
      request: new Proxy(requestDiagnostics, {
        getPrototypeOf() {
          throw new Error('prototype trap');
        },
      }),
    });

    expect(() => toModelInvocationError(descriptorFailure)).not.toThrow();
    expect(toModelInvocationError(descriptorFailure)).toBeUndefined();
    expect(() => toModelInvocationError(prototypeFailure)).not.toThrow();
    expect(toModelInvocationError(prototypeFailure)).toBeUndefined();
  });
});
