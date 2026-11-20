import { describe, expect, it, vi } from 'vitest';
import { bindCopilotModels } from './model-metadata.js';

const model = {
  modelId: 'test-model', displayName: 'Test Model', apiBase: 'https://copilot.invalid',
  metadata: {
    id: 'test-model',
    supported_endpoints: ['/chat/completions', '/responses'],
    capabilities: {
      limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 120_000, max_output_tokens: 16_000 },
      supports: { tool_calls: true, vision: false, streaming: true, reasoning_effort: ['low', 'high'] },
    },
  },
};

describe('Copilot callable model metadata', () => {
  it('binds only declared protocols and facts, preferring Responses when both are declared', () => {
    const [binding] = bindCopilotModels([model], vi.fn());
    expect(binding).toMatchObject({
      modelId: 'test-model', wireProtocol: 'openai-responses',
      facts: {
        effectiveContextLimit: 120_000, maximumContextTokens: 128_000,
        maximumPromptTokens: 120_000, maximumOutputTokens: 16_000,
        toolUse: true, mediaKinds: [], reasoning: { efforts: ['low', 'high'] },
      },
    });
  });

  it('excludes missing/unsupported endpoints and insufficient limits with a visible diagnostic', () => {
    const warn = vi.fn();
    expect(bindCopilotModels([
      { ...model, metadata: { capabilities: model.metadata.capabilities } },
      { ...model, metadata: { ...model.metadata, supported_endpoints: ['/v1/messages'] } },
      { ...model, metadata: { ...model.metadata, capabilities: {} } },
    ], warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('excluded 3'));
  });

  it('does not advertise unknown reasoning values and rejects malformed declared capabilities', () => {
    const warn = vi.fn();
    const metadata = {
      ...model.metadata,
      capabilities: {
        ...model.metadata.capabilities,
        supports: { reasoning_effort: ['future-effort'] },
      },
    };
    expect(bindCopilotModels([{ ...model, metadata }], warn)[0]?.facts.reasoning).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognized'));
    expect(() => bindCopilotModels([{
      ...model,
      metadata: { ...metadata, capabilities: { ...metadata.capabilities, supports: { tool_calls: 'true' } } },
    }], warn)).toThrow('capability');
  });
});
