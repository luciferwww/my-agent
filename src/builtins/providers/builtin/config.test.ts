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
          reasoning: {
            efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          },
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
        reasoning: {
          efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
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
    [[
      {
        modelId: 'a',
        protocol: 'openai-responses',
        reasoning: null,
      },
    ], 'models[0].reasoning'],
    [[
      {
        modelId: 'a',
        protocol: 'openai-responses',
        reasoning: { effrot: ['high'] },
      },
    ], 'models[0].reasoning.effrot'],
    [[
      {
        modelId: 'a',
        protocol: 'openai-responses',
        reasoning: { thinking: 'on' },
      },
    ], 'models[0].reasoning.thinking'],
    [[
      {
        modelId: 'a',
        protocol: 'openai-responses',
        reasoning: { thinking: ['on', 'on'] },
      },
    ], 'models[0].reasoning.thinking[1]'],
    [[
      {
        modelId: 'a',
        protocol: 'openai-responses',
        reasoning: { efforts: ['default'] },
      },
    ], 'models[0].reasoning.efforts[0]'],
    [[
      {
        modelId: 'a',
        protocol: 'openai-responses',
        reasoning: { efforts: ['high', 'high'] },
      },
    ], 'models[0].reasoning.efforts[1]'],
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

  it('defensively copies and freezes reasoning capability arrays in Provider order', () => {
    const efforts: Array<'high' | 'low' | 'medium'> = ['high', 'low', 'medium'];
    const result = validateBuiltinLlmProviderConfig({
      baseURL: 'https://example.test',
      models: [{
        modelId: 'a',
        protocol: 'openai-chat-completions',
        reasoning: { efforts },
      }],
    });

    efforts.reverse();

    expect(result.models[0]?.reasoning).toEqual({
      efforts: ['high', 'low', 'medium'],
    });
    expect(Object.isFrozen(result.models[0]?.reasoning)).toBe(true);
    expect(Object.isFrozen(result.models[0]?.reasoning?.efforts)).toBe(true);
  });

  it('validates and freezes protocol-private reasoning adapters', () => {
    const result = validateBuiltinLlmProviderConfig({
      baseURL: 'https://example.test',
      models: [
        {
          modelId: 'responses',
          protocol: 'openai-responses',
          reasoning: { thinking: ['on'], efforts: ['high'] },
          readableSummary: 'auto-on-explicit-reasoning',
        },
        {
          modelId: 'adaptive',
          protocol: 'anthropic-messages',
          reasoning: { thinking: ['on', 'off'], efforts: ['none', 'high'] },
          anthropicThinking: { mode: 'adaptive' },
        },
        {
          modelId: 'budget',
          protocol: 'anthropic-messages',
          outputTokenLimit: 8_192,
          reasoning: { thinking: ['on'], efforts: ['low', 'high'] },
          anthropicThinking: {
            mode: 'budget',
            defaultBudgetTokens: 1_024,
            budgets: { low: 1_024, high: 4_096 },
          },
        },
      ],
    });

    expect(result.models[0]).toMatchObject({
      readableSummary: 'auto-on-explicit-reasoning',
    });
    expect(result.models[1]?.anthropicThinking).toEqual({ mode: 'adaptive' });
    expect(result.models[2]?.anthropicThinking).toEqual({
      mode: 'budget',
      defaultBudgetTokens: 1_024,
      budgets: { low: 1_024, high: 4_096 },
    });
    expect(Object.isFrozen(result.models[2]?.anthropicThinking)).toBe(true);
    expect(Object.isFrozen(
      result.models[2]?.anthropicThinking?.mode === 'budget'
        ? result.models[2].anthropicThinking.budgets
        : undefined,
    )).toBe(true);
  });

  it.each([
    [{
      modelId: 'chat',
      protocol: 'openai-chat-completions',
      reasoning: { thinking: ['on'] },
    }, 'models[0].reasoning.thinking[0]'],
    [{
      modelId: 'responses',
      protocol: 'openai-responses',
      reasoning: { thinking: ['off'] },
      readableSummary: 'auto-on-explicit-reasoning',
    }, 'models[0].reasoning.thinking[0]'],
    [{
      modelId: 'responses',
      protocol: 'openai-responses',
      reasoning: { thinking: ['on'] },
    }, 'models[0].reasoning.thinking[0]'],
    [{
      modelId: 'chat',
      protocol: 'openai-chat-completions',
      readableSummary: 'auto-on-explicit-reasoning',
    }, 'models[0].readableSummary'],
    [{
      modelId: 'anthropic',
      protocol: 'anthropic-messages',
      reasoning: { efforts: ['high'] },
    }, 'models[0].anthropicThinking'],
    [{
      modelId: 'anthropic',
      protocol: 'anthropic-messages',
      reasoning: { thinking: ['on'] },
      anthropicThinking: { mode: 'budget' },
    }, 'models[0].anthropicThinking.defaultBudgetTokens'],
    [{
      modelId: 'anthropic',
      protocol: 'anthropic-messages',
      reasoning: { efforts: ['high'] },
      anthropicThinking: { mode: 'budget', budgets: { low: 1024 } },
    }, 'models[0].reasoning.efforts[0]'],
    [{
      modelId: 'anthropic',
      protocol: 'anthropic-messages',
      outputTokenLimit: 4096,
      reasoning: { efforts: ['high'] },
      anthropicThinking: { mode: 'budget', budgets: { high: 4096 } },
    }, 'models[0].anthropicThinking'],
    [{
      modelId: 'anthropic',
      protocol: 'anthropic-messages',
      reasoning: { efforts: ['high'] },
      anthropicThinking: { mode: 'budget', budgets: { high: 512 } },
    }, 'models[0].anthropicThinking.budgets.high'],
  ])('rejects inconsistent reasoning adapter configuration %#', (model, fieldPath) => {
    expect(() => validateBuiltinLlmProviderConfig({
      baseURL: 'https://example.test',
      models: [model],
    })).toThrow(expect.objectContaining({ fieldPath }));
  });
});
