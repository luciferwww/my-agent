import { describe, expect, it } from 'vitest';

import {
  BuiltinLlmConfigError,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_BUILTIN_CONTEXT_LIMIT,
  validateBuiltinLlmProviderConfig,
} from './config.js';

describe('Built-in LLM configuration', () => {
  it('owns its operational defaults', () => {
    expect(DEFAULT_BUILTIN_CONTEXT_LIMIT).toBe(32_768);
    expect(DEFAULT_ANTHROPIC_MAX_TOKENS).toBe(4_096);
  });

  it('normalizes the endpoint and accepts an empty model catalog', () => {
    expect(validateBuiltinLlmProviderConfig({
      baseURL: 'https://example.test/v1///',
      apiKey: '   ',
      models: [],
    })).toEqual({
      baseURL: 'https://example.test/v1',
      models: [],
    });
  });

  it.each([
    'ftp://example.test/v1',
    'https://user@example.test/v1',
    'https://example.test/v1?secret=value',
    'https://example.test/v1?',
    'https://example.test/v1#fragment',
    'https://example.test/v1#',
    'not a URL',
  ])('rejects invalid base URL %s', (baseURL) => {
    expect(() => validateBuiltinLlmProviderConfig({ baseURL, models: [] }))
      .toThrow(BuiltinLlmConfigError);
  });

  it('validates models and all supported protocols', () => {
    expect(validateBuiltinLlmProviderConfig({
      baseURL: 'http://localhost:5000/v1',
      models: [
        { modelId: 'a', protocol: 'anthropic-messages' },
        { modelId: 'b', protocol: 'openai-responses', displayName: 'Model B' },
        { modelId: 'c', protocol: 'openai-chat-completions' },
      ],
    }).models).toHaveLength(3);
  });

  it.each([
    [[{ modelId: '', protocol: 'openai-responses' }], 'models[0].modelId'],
    [[
      { modelId: 'same', protocol: 'openai-responses' },
      { modelId: 'same', protocol: 'anthropic-messages' },
    ], 'models[1].modelId'],
    [[{ modelId: 'a', protocol: 'unsupported' }], 'models[0].protocol'],
    [[{ modelId: 'a', protocol: 'openai-responses', displayName: ' ' }], 'models[0].displayName'],
  ])('rejects invalid model registrations %#', (models, fieldPath) => {
    try {
      validateBuiltinLlmProviderConfig({
        baseURL: 'https://example.test',
        models,
      });
    } catch (error) {
      expect(error).toMatchObject({ fieldPath });
      return;
    }
    throw new Error('Expected validation to fail.');
  });
});
