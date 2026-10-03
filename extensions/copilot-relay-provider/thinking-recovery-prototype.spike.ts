// Disposable, single-writer, append-only fixture. Not a Provider compatibility policy.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { Ajv } from 'ajv/dist/ajv.js';
import type { ChatContentBlock, ChatToolDefinition } from '../../src/core/model-invocation/index.js';
import { pruneToolResults } from '../../src/core/runner/context/tool-result-pruning.js';

export type PrototypeBlock =
  | Extract<ChatContentBlock, { type: 'text' | 'tool_use' | 'tool_result' }>
  | { type: 'thinking'; id: string; thinking: string; signature: string }
  | { type: 'redacted_thinking'; id: string; data: string }
  | {
      type: 'reasoning';
      id: string;
      summary: { type: 'summary_text'; text: string }[];
      encrypted_content?: string | null;
      content?: { type: 'reasoning_text'; text: string }[];
      status?: 'completed';
    };

export interface PrototypeContext {
  providerId: string;
  routeId: string;
  model: string;
  protocol: 'anthropic-messages' | 'openai-responses';
  system: string;
  tools: ChatToolDefinition[];
}

interface Header {
  type: 'replay-context';
  version: 1;
  projection: 'prototype-v1';
  id: string;
  context: PrototypeContext;
}

export interface PrototypeMessage {
  type: 'message';
  id: string;
  role: 'user' | 'assistant';
  content: PrototypeBlock[];
  protectedDigest?: string;
}

type JournalLine = Header | PrototypeMessage;
export type PrototypeRequest = Record<string, unknown>;
type ConflictCode = 'invalid_record' | 'context_changed' | 'prefix_changed' | 'protocol_mismatch' | 'budget_exceeded';

export class PrototypeConflict extends Error {
  constructor(readonly code: ConflictCode) {
    super(`Thinking recovery prototype: ${code}.`);
  }
}

const string = { type: 'string' };
const identity = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const tagged = (type: string, properties: Record<string, unknown>, required = Object.keys(properties)) =>
  object({ type: { const: type }, ...properties }, ['type', ...required]);
const blockSchema = {
  oneOf: [
    tagged('text', { text: string }),
    tagged('tool_use', { id: identity, name: identity, input: { type: 'object' } }),
    tagged('tool_result', {
      tool_use_id: identity,
      content: string,
      status: { enum: ['success', 'error', 'denied', 'aborted'] },
    }),
    tagged('thinking', { id: identity, thinking: string, signature: identity }),
    tagged('redacted_thinking', { id: identity, data: identity }),
    tagged('reasoning', {
      id: identity,
      summary: { type: 'array', items: tagged('summary_text', { text: string }) },
      encrypted_content: { type: ['string', 'null'] },
      content: { type: 'array', items: tagged('reasoning_text', { text: string }) },
      status: { const: 'completed' },
    }, ['id', 'summary']),
  ],
};
const validateLine = new Ajv({ strict: false }).compile<JournalLine>({
  oneOf: [
    tagged('replay-context', {
      version: { const: 1 }, projection: { const: 'prototype-v1' }, id: identity,
      context: object({
        providerId: identity, routeId: identity, model: identity,
        protocol: { enum: ['anthropic-messages', 'openai-responses'] },
        system: string,
        tools: { type: 'array', items: object({
          name: identity, description: string, inputSchema: { type: 'object' },
        }) },
      }),
    }),
    tagged('message', {
      id: identity, role: { enum: ['user', 'assistant'] },
      content: { type: 'array', minItems: 1, items: blockSchema },
      protectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    }, ['id', 'role', 'content']),
  ],
});

function checked(value: unknown): JournalLine {
  if (!validateLine(value)) throw new PrototypeConflict('invalid_record');
  if (value.type === 'message') {
    if (value.role === 'assistant' && !value.protectedDigest) throw new PrototypeConflict('invalid_record');
    if (value.role === 'user' && value.protectedDigest) throw new PrototypeConflict('invalid_record');
    for (const block of value.content) {
      if (value.role === 'user' && block.type !== 'text' && block.type !== 'tool_result') {
        throw new PrototypeConflict('invalid_record');
      }
      if (value.role === 'assistant' && block.type === 'tool_result') throw new PrototypeConflict('invalid_record');
    }
  }
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  throw new PrototypeConflict('invalid_record');
}

export function projectPrototype(context: PrototypeContext, messages: readonly PrototypeMessage[]): PrototypeRequest {
  if (context.protocol === 'anthropic-messages') {
    return {
      model: context.model,
      ...(context.system ? { system: context.system } : {}),
      ...(context.tools.length ? { tools: context.tools.map((tool) => ({
        name: tool.name, description: tool.description, input_schema: tool.inputSchema,
      })) } : {}),
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content.map((block) => {
          if (block.type === 'reasoning') throw new PrototypeConflict('protocol_mismatch');
          if (block.type === 'thinking') return { type: block.type, thinking: block.thinking, signature: block.signature };
          if (block.type === 'redacted_thinking') return { type: block.type, data: block.data };
          if (block.type === 'tool_result') {
            return {
              type: block.type,
              tool_use_id: block.tool_use_id,
              content: block.content,
            };
          }
          return structuredClone(block);
        }),
      })),
    };
  }
  const input: unknown[] = [];
  for (const message of messages) {
    let pending: unknown[] = [];
    const flush = () => {
      if (pending.length) input.push({ role: message.role, content: pending });
      pending = [];
    };
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          pending.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: block.text });
          break;
        case 'tool_use':
          flush();
          input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
          break;
        case 'tool_result':
          flush();
          input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.content });
          break;
        case 'reasoning':
          flush();
          input.push(structuredClone(block));
          break;
        default:
          throw new PrototypeConflict('protocol_mismatch');
      }
    }
    flush();
  }
  return {
    model: context.model,
    ...(context.system ? { instructions: context.system } : {}),
    ...(context.tools.length ? { tools: context.tools.map((tool) => ({
      type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema,
    })) } : {}),
    input,
  };
}

function digest(header: Header, messages: readonly PrototypeMessage[]): string {
  return createHash('sha256').update(canonical({
    contextId: header.id,
    ids: messages.map((message) => message.id),
    request: projectPrototype(header.context, messages),
  })).digest('hex');
}

function verifyPrefix(header: Header, original: readonly PrototypeMessage[], candidate: readonly PrototypeMessage[]): void {
  const ids = new Set<string>();
  for (const message of candidate) {
    checked(message);
    if (ids.has(message.id)) throw new PrototypeConflict('invalid_record');
    ids.add(message.id);
  }
  for (const message of original) {
    if (!message.protectedDigest) continue;
    const index = candidate.findIndex((entry) => entry.id === message.id);
    if (index < 0 || digest(header, candidate.slice(0, index + 1)) !== message.protectedDigest) {
      throw new PrototypeConflict('prefix_changed');
    }
  }
}

export class PrototypeJournal {
  private constructor(
    private readonly file: string,
    private readonly header: Header,
    private readonly entries: PrototypeMessage[],
  ) {}

  static async create(file: string, context: PrototypeContext): Promise<PrototypeJournal> {
    const header: Header = {
      type: 'replay-context', version: 1, projection: 'prototype-v1',
      id: randomUUID(), context: structuredClone(context),
    };
    checked(header);
    await writeFile(file, JSON.stringify(header) + '\n', { flag: 'wx' });
    return new PrototypeJournal(file, header, []);
  }

  static async load(file: string): Promise<PrototypeJournal> {
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim());
    const records = lines.map((line) => {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { throw new PrototypeConflict('invalid_record'); }
      return checked(value);
    });
    const header = records.shift();
    if (!header || header.type !== 'replay-context') throw new PrototypeConflict('invalid_record');
    const entries: PrototypeMessage[] = [];
    for (const record of records) {
      if (record.type !== 'message') throw new PrototypeConflict('invalid_record');
      entries.push(record);
    }
    verifyPrefix(header, entries, entries);
    return new PrototypeJournal(file, header, entries);
  }

  messages(): PrototypeMessage[] { return structuredClone(this.entries); }

  async appendUser(text: string): Promise<void> {
    await this.append('user', [{ type: 'text', text }]);
  }

  async appendAssistant(content: PrototypeBlock[]): Promise<void> {
    await this.append('assistant', content);
  }

  async appendToolResult(callId: string, raw: string, firstInputBudget: number): Promise<string> {
    const normalized = pruneToolResults([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: raw, status: 'success' }],
    }], { toolResultHeadChars: 16, toolResultTailChars: 8, toolResultContextShare: 0.5 }, firstInputBudget);
    const content = normalized[0]?.content;
    const block = Array.isArray(content) ? content[0] : undefined;
    if (!block || block.type !== 'tool_result') throw new PrototypeConflict('invalid_record');
    await this.append('user', [block]);
    return block.content;
  }

  private async append(role: PrototypeMessage['role'], content: PrototypeBlock[]): Promise<void> {
    const message: PrototypeMessage = { type: 'message', id: randomUUID(), role, content: structuredClone(content) };
    if (role === 'assistant') message.protectedDigest = digest(this.header, [...this.entries, message]);
    checked(message);
    await appendFile(this.file, JSON.stringify(message) + '\n');
    this.entries.push(message);
  }

  prepare(
    requested: PrototypeContext,
    budget: { limit: number; estimate: (request: PrototypeRequest) => number },
    candidate = this.messages(),
  ): PrototypeRequest {
    // Exact fixture scope only: not a real account/model compatibility policy.
    if (canonical(requested) !== canonical(this.header.context)) throw new PrototypeConflict('context_changed');
    verifyPrefix(this.header, this.entries, candidate);
    const request = projectPrototype(requested, candidate);
    const estimate = budget.estimate(request);
    if (!Number.isFinite(estimate) || estimate < 0 || !Number.isFinite(budget.limit) || budget.limit < 0) {
      throw new PrototypeConflict('invalid_record');
    }
    if (estimate > budget.limit) throw new PrototypeConflict('budget_exceeded');
    return request;
  }

  async send(
    requested: PrototypeContext,
    budget: { limit: number; estimate: (request: PrototypeRequest) => number },
    transport: (request: PrototypeRequest) => Promise<void>,
  ): Promise<PrototypeRequest> {
    const request = this.prepare(requested, budget);
    await transport(structuredClone(request));
    return request;
  }
}
