import type {
  CanonicalToolResult,
  ToolCall,
  ToolDefinition,
} from '../../core/tools/index.js';

export interface AnthropicToolDefinitionWire {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

export interface OpenAICompatibleToolDefinitionWire {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly strict?: false;
  };
}

export interface OpenAICompatibleToolCallFragment {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

export interface AnthropicToolCallFragment {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly inputJson?: string;
}

export interface AnthropicToolResultWire {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: true;
}

export interface OpenAICompatibleToolResultWire {
  readonly role: 'tool';
  readonly tool_call_id: string;
  readonly content: string;
}

export class ProviderToolCodecError extends Error {
  readonly kind = 'provider_tool_codec_error' as const;
}

export function encodeAnthropicToolDefinition(
  definition: ToolDefinition,
): AnthropicToolDefinitionWire {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    input_schema: definition.inputSchema,
  });
}

export function decodeAnthropicToolDefinition(
  wire: AnthropicToolDefinitionWire,
): ToolDefinition {
  assertDefinition(wire.name, wire.description, wire.input_schema);
  return freezeDefinition(wire.name, wire.description, wire.input_schema);
}

export function encodeOpenAICompatibleToolDefinition(
  definition: ToolDefinition,
): OpenAICompatibleToolDefinitionWire {
  return Object.freeze({
    type: 'function' as const,
    function: Object.freeze({
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    }),
  });
}

export function decodeOpenAICompatibleToolDefinition(
  wire: OpenAICompatibleToolDefinitionWire,
): ToolDefinition {
  if (wire.type !== 'function') {
    throw new ProviderToolCodecError('OpenAI-compatible Tool definition must use function type.');
  }
  const fn = wire.function;
  assertDefinition(fn.name, fn.description, fn.parameters);
  return freezeDefinition(fn.name, fn.description, fn.parameters);
}

export function decodeAnthropicToolCalls(
  calls: readonly { readonly id: string; readonly name: string; readonly input: unknown }[],
): readonly ToolCall[] {
  const result = calls.map((call) => Object.freeze({
    callId: requireIdentity(call.id, 'Anthropic Tool Call id'),
    name: requireIdentity(call.name, 'Anthropic Tool Call name'),
    input: isPlainObject(call.input)
      ? Object.freeze({ state: 'ready' as const, value: Object.freeze({ ...call.input }) })
      : Object.freeze({ state: 'invalid' as const, reason: 'not_an_object' as const }),
  }));
  assertUniqueCallIds(result);
  return Object.freeze(result);
}

export function decodeAnthropicToolCallFragments(
  fragments: readonly AnthropicToolCallFragment[],
): readonly ToolCall[] {
  const states = new Map<number, { id?: string; name?: string; inputJson: string }>();
  for (const fragment of fragments) {
    if (!Number.isInteger(fragment.index) || fragment.index < 0) {
      throw new ProviderToolCodecError('Anthropic Tool Call index must be a non-negative integer.');
    }
    const state = states.get(fragment.index) ?? { inputJson: '' };
    state.id = mergeStablePart(state.id, fragment.id, `Anthropic Tool Call ${fragment.index} id`);
    state.name = mergeStablePart(
      state.name,
      fragment.name,
      `Anthropic Tool Call ${fragment.index} name`,
    );
    state.inputJson += fragment.inputJson ?? '';
    states.set(fragment.index, state);
  }

  const calls = [...states.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, state]) => Object.freeze({
      callId: requireIdentity(state.id, `Anthropic Tool Call ${index} id`),
      name: requireIdentity(state.name, `Anthropic Tool Call ${index} name`),
      input: decodeJsonObject(state.inputJson),
    }));
  assertUniqueCallIds(calls);
  return Object.freeze(calls);
}

export function decodeOpenAICompatibleToolCallFragments(
  fragments: readonly OpenAICompatibleToolCallFragment[],
): readonly ToolCall[] {
  const states = new Map<number, { id?: string; name?: string; argumentsJson: string }>();
  for (const fragment of fragments) {
    if (!Number.isInteger(fragment.index) || fragment.index < 0) {
      throw new ProviderToolCodecError('OpenAI-compatible Tool Call index must be a non-negative integer.');
    }
    const state = states.get(fragment.index) ?? { argumentsJson: '' };
    state.id = mergeStablePart(state.id, fragment.id, `Tool Call ${fragment.index} id`);
    state.name = mergeStablePart(state.name, fragment.name, `Tool Call ${fragment.index} name`);
    state.argumentsJson += fragment.arguments ?? '';
    states.set(fragment.index, state);
  }

  const calls = [...states.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, state]) => Object.freeze({
      callId: requireIdentity(state.id, `OpenAI-compatible Tool Call ${index} id`),
      name: requireIdentity(state.name, `OpenAI-compatible Tool Call ${index} name`),
      input: decodeJsonObject(state.argumentsJson),
    }));
  assertUniqueCallIds(calls);
  return Object.freeze(calls);
}

export function encodeAnthropicToolResult(
  result: CanonicalToolResult,
): AnthropicToolResultWire {
  return Object.freeze({
    type: 'tool_result' as const,
    tool_use_id: result.callId,
    content: result.content,
    ...(result.outcome === 'success' ? {} : { is_error: true as const }),
  });
}

export function encodeOpenAICompatibleToolResult(
  result: CanonicalToolResult,
): OpenAICompatibleToolResultWire {
  return Object.freeze({
    role: 'tool' as const,
    tool_call_id: result.callId,
    content: result.content,
  });
}

export function decodeAnthropicToolResult(
  wire: AnthropicToolResultWire,
): Readonly<{ callId: string; content: string }> {
  return decodePortableResult(wire.tool_use_id, wire.content);
}

export function decodeOpenAICompatibleToolResult(
  wire: OpenAICompatibleToolResultWire,
): Readonly<{ callId: string; content: string }> {
  return decodePortableResult(wire.tool_call_id, wire.content);
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

function assertDefinition(name: string, description: string, schema: unknown): void {
  requireIdentity(name, 'Tool definition name');
  if (typeof description !== 'string') {
    throw new ProviderToolCodecError('Tool definition description must be a string.');
  }
  if (!isPlainObject(schema)) {
    throw new ProviderToolCodecError('Tool definition schema must be an object.');
  }
}

function freezeDefinition(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
): ToolDefinition {
  return Object.freeze({ name, description, inputSchema });
}

function requireIdentity(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProviderToolCodecError(`${label} must be non-empty.`);
  }
  return value;
}

function mergeStablePart(
  current: string | undefined,
  next: string | undefined,
  label: string,
): string | undefined {
  if (next === undefined || next === '') return current;
  if (current !== undefined && current !== next) {
    throw new ProviderToolCodecError(`${label} changed across fragments.`);
  }
  return next;
}

function assertUniqueCallIds(calls: readonly Pick<ToolCall, 'callId'>[]): void {
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.callId)) {
      throw new ProviderToolCodecError(`Duplicate Tool Call id "${call.callId}".`);
    }
    seen.add(call.callId);
  }
}

function decodePortableResult(
  callId: string,
  content: string,
): Readonly<{ callId: string; content: string }> {
  requireIdentity(callId, 'Tool Result call id');
  if (typeof content !== 'string') {
    throw new ProviderToolCodecError('Tool Result content must be a string.');
  }
  return Object.freeze({ callId, content });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
