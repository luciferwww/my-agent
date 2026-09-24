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
        {
          modelId: 'b',
          protocol: 'openai-responses',
          displayName: 'Model B',
          maximumContextTokens: 300_000,
          maximumPromptTokens: 272_000,
          maximumOutputTokens: 28_000,
          outputTokenLimit: 16_000,
        },
        { modelId: 'c', protocol: 'openai-chat-completions' },
      ],
    }).models).toEqual([
      { modelId: 'a', protocol: 'anthropic-messages' },
      {
        modelId: 'b',
        protocol: 'openai-responses',
        displayName: 'Model B',
        maximumContextTokens: 300_000,
        maximumPromptTokens: 272_000,
        maximumOutputTokens: 28_000,
        outputTokenLimit: 16_000,
      },
      { modelId: 'c', protocol: 'openai-chat-completions' },
    ]);
  });

  it.each([
    [[{ modelId: '', protocol: 'openai-responses' }], 'models[0].modelId'],
    [[
      { modelId: 'same', protocol: 'openai-responses' },
      { modelId: 'same', protocol: 'anthropic-messages' },
    ], 'models[1].modelId'],
    [[{ modelId: 'a', protocol: 'unsupported' }], 'models[0].protocol'],
    [[{ modelId: 'a', protocol: 'openai-responses', displayName: ' ' }], 'models[0].displayName'],
    [[
      { modelId: 'a', protocol: 'openai-responses', maximumContextTokens: 0 },
    ], 'models[0].maximumContextTokens'],
    [[
      { modelId: 'a', protocol: 'openai-responses', maximumPromptTokens: 1.5 },
    ], 'models[0].maximumPromptTokens'],
    [[
      { modelId: 'a', protocol: 'openai-responses', outputTokenLimit: 0 },
    ], 'models[0].outputTokenLimit'],
    [[
      {
        modelId: 'a',
        protocol: 'openai-responses',
        maximumContextTokens: 100,
        maximumPromptTokens: 101,
      },
    ], 'models[0].maximumPromptTokens'],
    [[
      {
        modelId: 'a',
        protocol: 'openai-responses',
        maximumContextTokens: 100,
        maximumOutputTokens: 101,
      },
    ], 'models[0].maximumOutputTokens'],
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
