import { describe, expect, it } from 'vitest';
import type { CanonicalToolResult, ToolCall, ToolDefinition } from './index.js';
import {
  PORTABLE_FAILED_TOOL_RESULT,
  PORTABLE_FAILED_TOOL_RESULT_ANTHROPIC_WIRE,
  PORTABLE_FAILED_TOOL_RESULT_OPENAI_WIRE,
  PORTABLE_TOOL_DEFINITION,
  PORTABLE_TOOL_DEFINITION_ANTHROPIC_WIRE,
  PORTABLE_TOOL_DEFINITION_OPENAI_WIRE,
} from './provider-portability-fixtures.js';

interface AnthropicToolDefinitionWire {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

interface OpenAICompatibleToolDefinitionWire {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

interface ToolCallFragment {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly inputJson?: string;
}

class ReferenceToolCodecError extends Error {}

describe('Provider Tool contract portability references', () => {
  it('preserves canonical definition semantics through both reference wires', () => {
    const anthropic = encodeAnthropicDefinition(PORTABLE_TOOL_DEFINITION);
    const openai = encodeOpenAIDefinition(PORTABLE_TOOL_DEFINITION);

    expect(anthropic).toEqual(PORTABLE_TOOL_DEFINITION_ANTHROPIC_WIRE);
    expect(openai).toEqual(PORTABLE_TOOL_DEFINITION_OPENAI_WIRE);
    expect(decodeDefinition(anthropic.name, anthropic.description, anthropic.input_schema))
      .toEqual(PORTABLE_TOOL_DEFINITION);
    expect(decodeDefinition(
      openai.function.name,
      openai.function.description,
      openai.function.parameters,
    )).toEqual(PORTABLE_TOOL_DEFINITION);
  });

  it('normalizes complete calls in Provider order', () => {
    expect(decodeCompleteCalls([
      { id: 'call-2', name: 'search', input: { query: 'second' } },
      { id: 'call-1', name: 'search', input: { query: 'first' } },
    ])).toEqual([
      { callId: 'call-2', name: 'search', input: { state: 'ready', value: { query: 'second' } } },
      { callId: 'call-1', name: 'search', input: { state: 'ready', value: { query: 'first' } } },
    ]);
  });

  it('isolates interleaved fragments by call index', () => {
    expect(decodeFragments([
      { index: 1, id: 'call-b', name: 'search' },
      { index: 0, id: 'call-a', name: 'search' },
      { index: 0, inputJson: '{"query":"a' },
      { index: 1, inputJson: '{"query":"' },
      { index: 0, inputJson: '"}' },
      { index: 1, inputJson: 'b"}' },
    ])).toEqual([
      { callId: 'call-a', name: 'search', input: { state: 'ready', value: { query: 'a' } } },
      { callId: 'call-b', name: 'search', input: { state: 'ready', value: { query: 'b' } } },
    ]);
  });

  it('preserves malformed and non-object arguments as invalid canonical input', () => {
    expect(decodeFragments([
      { index: 0, id: 'bad-json', name: 'search', inputJson: '{"query":' },
      { index: 1, id: 'array', name: 'search', inputJson: '[]' },
    ])).toEqual([
      { callId: 'bad-json', name: 'search', input: { state: 'invalid', reason: 'malformed_json' } },
      { callId: 'array', name: 'search', input: { state: 'invalid', reason: 'not_an_object' } },
    ]);
  });

  it.each([
    { fragments: [{ index: 0, name: 'search', inputJson: '{}' }] },
    { fragments: [{ index: 0, id: 'call-1', inputJson: '{}' }] },
    {
      fragments: [
        { index: 0, id: 'same', name: 'search', inputJson: '{}' },
        { index: 1, id: 'same', name: 'search', inputJson: '{}' },
      ],
    },
  ] as const)('fails closed for incomplete or duplicate call identity', ({ fragments }) => {
    expect(() => decodeFragments(fragments)).toThrow(ReferenceToolCodecError);
  });

  it('preserves Tool Result correlation and content on both wires', () => {
    expect(encodeAnthropicResult(PORTABLE_FAILED_TOOL_RESULT))
      .toEqual(PORTABLE_FAILED_TOOL_RESULT_ANTHROPIC_WIRE);
    expect(encodeOpenAIResult(PORTABLE_FAILED_TOOL_RESULT))
      .toEqual(PORTABLE_FAILED_TOOL_RESULT_OPENAI_WIRE);
    expect(decodeResult(
      PORTABLE_FAILED_TOOL_RESULT_ANTHROPIC_WIRE.tool_use_id,
      PORTABLE_FAILED_TOOL_RESULT_ANTHROPIC_WIRE.content,
    )).toEqual({ callId: 'call-1', content: 'search unavailable' });
    expect(decodeResult(
      PORTABLE_FAILED_TOOL_RESULT_OPENAI_WIRE.tool_call_id,
      PORTABLE_FAILED_TOOL_RESULT_OPENAI_WIRE.content,
    )).toEqual({ callId: 'call-1', content: 'search unavailable' });
  });

  it('does not mutate canonical schema or Tool inputs during conversion', () => {
    const before = structuredClone(PORTABLE_TOOL_DEFINITION.inputSchema);
    const input = { query: 'immutable' };
    decodeCompleteCalls([{ id: 'call-1', name: 'search', input }]);
    encodeAnthropicDefinition(PORTABLE_TOOL_DEFINITION);
    encodeOpenAIDefinition(PORTABLE_TOOL_DEFINITION);

    expect(PORTABLE_TOOL_DEFINITION.inputSchema).toEqual(before);
    expect(input).toEqual({ query: 'immutable' });
  });
});

function encodeAnthropicDefinition(definition: ToolDefinition): AnthropicToolDefinitionWire {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    input_schema: definition.inputSchema,
  });
}

function encodeOpenAIDefinition(definition: ToolDefinition): OpenAICompatibleToolDefinitionWire {
  return Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    }),
  });
}

function decodeDefinition(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
): ToolDefinition {
  return Object.freeze({
    name: requireIdentity(name),
    description,
    inputSchema,
  });
}

function decodeCompleteCalls(
  calls: readonly { readonly id: string; readonly name: string; readonly input: unknown }[],
): readonly ToolCall[] {
  const decoded = calls.map((call) => Object.freeze({
    callId: requireIdentity(call.id),
    name: requireIdentity(call.name),
    input: isPlainObject(call.input)
      ? Object.freeze({ state: 'ready' as const, value: Object.freeze({ ...call.input }) })
      : Object.freeze({ state: 'invalid' as const, reason: 'not_an_object' as const }),
  }));
  assertUnique(decoded);
  return Object.freeze(decoded);
}

function decodeFragments(fragments: readonly ToolCallFragment[]): readonly ToolCall[] {
  const states = new Map<number, { id?: string; name?: string; inputJson: string }>();
  for (const fragment of fragments) {
    const state = states.get(fragment.index) ?? { inputJson: '' };
    state.id = mergeStable(state.id, fragment.id);
    state.name = mergeStable(state.name, fragment.name);
    state.inputJson += fragment.inputJson ?? '';
    states.set(fragment.index, state);
  }
  const calls = [...states.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, state]) => Object.freeze({
      callId: requireIdentity(state.id),
      name: requireIdentity(state.name),
      input: decodeJsonObject(state.inputJson),
    }));
  assertUnique(calls);
  return Object.freeze(calls);
}

function encodeAnthropicResult(result: CanonicalToolResult) {
  return Object.freeze({
    type: 'tool_result' as const,
    tool_use_id: result.callId,
    content: result.content,
    ...(result.outcome === 'success' ? {} : { is_error: true as const }),
  });
}

function encodeOpenAIResult(result: CanonicalToolResult) {
  return Object.freeze({
    role: 'tool' as const,
    tool_call_id: result.callId,
    content: result.content,
  });
}

function decodeResult(callId: string, content: string) {
  return Object.freeze({ callId: requireIdentity(callId), content });
}

function decodeJsonObject(json: string): ToolCall['input'] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return Object.freeze({ state: 'invalid' as const, reason: 'malformed_json' as const });
  }
  return isPlainObject(decoded)
    ? Object.freeze({ state: 'ready' as const, value: Object.freeze({ ...decoded }) })
    : Object.freeze({ state: 'invalid' as const, reason: 'not_an_object' as const });
}

function mergeStable(current: string | undefined, next: string | undefined): string | undefined {
  if (next === undefined || next === '') return current;
  if (current !== undefined && current !== next) throw new ReferenceToolCodecError();
  return next;
}

function requireIdentity(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ReferenceToolCodecError();
  return value;
}

function assertUnique(calls: readonly Pick<ToolCall, 'callId'>[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.callId)) throw new ReferenceToolCodecError();
    ids.add(call.callId);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}