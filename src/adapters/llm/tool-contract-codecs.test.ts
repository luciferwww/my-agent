import { describe, expect, it } from 'vitest';
import type { CanonicalToolResult, ToolDefinition } from '../../core/tools/index.js';
import {
  ProviderToolCodecError,
  decodeAnthropicToolCallFragments,
  decodeAnthropicToolCalls,
  decodeAnthropicToolDefinition,
  decodeAnthropicToolResult,
  decodeOpenAICompatibleToolCallFragments,
  decodeOpenAICompatibleToolDefinition,
  decodeOpenAICompatibleToolResult,
  encodeAnthropicToolDefinition,
  encodeAnthropicToolResult,
  encodeOpenAICompatibleToolDefinition,
  encodeOpenAICompatibleToolResult,
} from './tool-contract-codecs.js';

const definition: ToolDefinition = Object.freeze({
  name: 'search',
  description: 'Search documents',
  inputSchema: Object.freeze({
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
    additionalProperties: false,
  }),
});

describe('Provider Tool contract reference codecs', () => {
  it('preserves canonical definition semantics through Anthropic and OpenAI-compatible wires', () => {
    const anthropic = encodeAnthropicToolDefinition(definition);
    const openai = encodeOpenAICompatibleToolDefinition(definition);

    expect(anthropic).toEqual({
      name: 'search',
      description: 'Search documents',
      input_schema: definition.inputSchema,
    });
    expect(openai).toEqual({
      type: 'function',
      function: {
        name: 'search',
        description: 'Search documents',
        parameters: definition.inputSchema,
      },
    });
    expect(decodeAnthropicToolDefinition(anthropic)).toEqual(definition);
    expect(decodeOpenAICompatibleToolDefinition(openai)).toEqual(definition);
  });

  it('normalizes complete Anthropic calls in Provider order', () => {
    expect(decodeAnthropicToolCalls([
      { id: 'call-2', name: 'search', input: { query: 'second' } },
      { id: 'call-1', name: 'search', input: { query: 'first' } },
    ])).toEqual([
      {
        callId: 'call-2',
        name: 'search',
        input: { state: 'ready', value: { query: 'second' } },
      },
      {
        callId: 'call-1',
        name: 'search',
        input: { state: 'ready', value: { query: 'first' } },
      },
    ]);
  });

  it('isolates interleaved Anthropic input_json_delta fragments by block index', () => {
    expect(decodeAnthropicToolCallFragments([
      { index: 1, id: 'call-b', name: 'search' },
      { index: 0, id: 'call-a', name: 'search' },
      { index: 0, inputJson: '{"query":"a' },
      { index: 1, inputJson: '{"query":"' },
      { index: 0, inputJson: '"}' },
      { index: 1, inputJson: 'b"}' },
    ])).toEqual([
      {
        callId: 'call-a',
        name: 'search',
        input: { state: 'ready', value: { query: 'a' } },
      },
      {
        callId: 'call-b',
        name: 'search',
        input: { state: 'ready', value: { query: 'b' } },
      },
    ]);
  });

  it('isolates interleaved OpenAI-compatible argument fragments by call index', () => {
    expect(decodeOpenAICompatibleToolCallFragments([
      { index: 1, id: 'call-b', name: 'search', arguments: '{"query":"' },
      { index: 0, id: 'call-a', name: 'search', arguments: '{"query":"a' },
      { index: 1, arguments: 'b"}' },
      { index: 0, arguments: '"}' },
    ])).toEqual([
      {
        callId: 'call-a',
        name: 'search',
        input: { state: 'ready', value: { query: 'a' } },
      },
      {
        callId: 'call-b',
        name: 'search',
        input: { state: 'ready', value: { query: 'b' } },
      },
    ]);
  });

  it('preserves malformed and non-object arguments as invalid canonical input', () => {
    expect(decodeOpenAICompatibleToolCallFragments([
      { index: 0, id: 'bad-json', name: 'search', arguments: '{"query":' },
      { index: 1, id: 'array', name: 'search', arguments: '[]' },
    ])).toEqual([
      {
        callId: 'bad-json',
        name: 'search',
        input: { state: 'invalid', reason: 'malformed_json' },
      },
      {
        callId: 'array',
        name: 'search',
        input: { state: 'invalid', reason: 'not_an_object' },
      },
    ]);
    expect(decodeAnthropicToolCalls([
      { id: 'array', name: 'search', input: [] },
    ])[0]?.input).toEqual({ state: 'invalid', reason: 'not_an_object' });
  });

  it.each([
    {
      label: 'missing call id',
      run: () => decodeOpenAICompatibleToolCallFragments([
        { index: 0, name: 'search', arguments: '{}' },
      ]),
    },
    {
      label: 'missing call name',
      run: () => decodeOpenAICompatibleToolCallFragments([
        { index: 0, id: 'call-1', arguments: '{}' },
      ]),
    },
    {
      label: 'duplicate call id',
      run: () => decodeOpenAICompatibleToolCallFragments([
        { index: 0, id: 'same', name: 'search', arguments: '{}' },
        { index: 1, id: 'same', name: 'search', arguments: '{}' },
      ]),
    },
  ])('fails closed for $label', ({ run }) => {
    expect(run).toThrow(ProviderToolCodecError);
  });

  it('preserves portable Tool Result correlation/content on both wires', () => {
    const result: CanonicalToolResult = Object.freeze({
      callId: 'call-1',
      outcome: 'failed',
      content: 'search unavailable',
    });
    const anthropic = encodeAnthropicToolResult(result);
    const openai = encodeOpenAICompatibleToolResult(result);

    expect(anthropic).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: 'search unavailable',
      is_error: true,
    });
    expect(openai).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'search unavailable',
    });
    expect(decodeAnthropicToolResult(anthropic)).toEqual({
      callId: 'call-1',
      content: 'search unavailable',
    });
    expect(decodeOpenAICompatibleToolResult(openai)).toEqual({
      callId: 'call-1',
      content: 'search unavailable',
    });
  });

  it('does not mutate canonical schema or Tool inputs during conversion', () => {
    const before = structuredClone(definition.inputSchema);
    const input = { query: 'immutable' };
    decodeAnthropicToolCalls([{ id: 'call-1', name: 'search', input }]);
    encodeAnthropicToolDefinition(definition);
    encodeOpenAICompatibleToolDefinition(definition);

    expect(definition.inputSchema).toEqual(before);
    expect(input).toEqual({ query: 'immutable' });
  });
});
