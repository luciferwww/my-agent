import type {
  ChatMessage,
  ModelInvocationPort,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelStreamEvent,
} from '../../../core/model-invocation/index.js';
import type { ToolCall } from '../../../core/tools/index.js';
import {
  asRecord,
  collectChat,
  createHttpError,
  createStreamError,
  normalizeError,
  parseRecord,
  parseToolInput,
  readNonEmptyString,
  readNonNegativeInteger,
  readSseData,
  readString,
  type ProtocolClientOptions,
  type Terminal,
} from './client-common.js';

export type OpenAIResponsesClientOptions = ProtocolClientOptions;

export class OpenAIResponsesClient implements ModelInvocationPort {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIResponsesClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    try {
      const apiKey = this.options.apiKey?.trim();
      const response = await this.fetchImpl(`${this.options.baseURL}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(buildRequest(request)),
        signal: request.signal,
      });
      if (!response.ok) throw await createHttpError(response, request);
      if (!response.body) throw new Error('OpenAI Responses streaming response has no body.');

      let started = false;
      let terminal: Terminal | undefined;
      let done = false;
      const seenCallIds = new Set<string>();
      for await (const data of readSseData(response.body, request.signal)) {
        if (data === '[DONE]') {
          if (!terminal || done) throw new Error('OpenAI Responses sent an invalid [DONE] marker.');
          done = true;
          continue;
        }
        if (done) throw new Error('OpenAI Responses sent an event after [DONE].');
        const event = parseRecord(data, 'OpenAI Responses sent malformed SSE JSON.');
        const type = readNonEmptyString(event.type, 'OpenAI Responses event type');
        if (!started && isOutputEvent(type)) {
          throw new Error(`OpenAI Responses sent "${type}" before response.created.`);
        }
        if (terminal) throw new Error('OpenAI Responses sent an event after its terminal event.');
        switch (type) {
          case 'response.created':
            if (started) throw new Error('OpenAI Responses sent duplicate response.created events.');
            started = true;
            yield { type: 'message_start' };
            break;
          case 'response.output_text.delta': {
            const text = readString(event.delta);
            if (text === undefined) throw new Error('OpenAI Responses text delta is invalid.');
            yield { type: 'text_delta', text };
            break;
          }
          case 'response.output_item.done': {
            const item = asRecord(event.item);
            if (item?.type !== 'function_call') break;
            const callId = readNonEmptyString(item.call_id, 'OpenAI Responses Tool Call call_id');
            const name = readNonEmptyString(item.name, 'OpenAI Responses Tool Call name');
            if (seenCallIds.has(callId)) {
              throw new Error(`OpenAI Responses sent duplicate Tool Call id "${callId}".`);
            }
            seenCallIds.add(callId);
            const call: ToolCall = Object.freeze({
              callId,
              name,
              input: parseToolInput(item.arguments),
            });
            yield { type: 'tool_call', call };
            break;
          }
          case 'response.completed':
            terminal = terminalFromResponse(event.response, seenCallIds.size, false);
            break;
          case 'response.incomplete':
            terminal = terminalFromResponse(event.response, seenCallIds.size, true);
            break;
          case 'response.failed':
          case 'error':
            throw createStreamError(event, request);
          default:
            if (/^response\.[^.]+$/u.test(type)
              && type !== 'response.queued'
              && type !== 'response.in_progress') {
              throw new Error(`OpenAI Responses sent unsupported response state "${type}".`);
            }
        }
      }
      if (!started) throw new Error('OpenAI Responses stream ended before response.created.');
      if (!terminal) throw new Error('OpenAI Responses stream ended before a terminal event.');
      yield { type: 'message_end', ...terminal };
    } catch (error) {
      yield { type: 'error', error: normalizeError(error, request) };
    }
  }

  chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    return collectChat(this.chatStream(request));
  }
}

function buildRequest(request: ModelInvocationRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: true,
    ...(request.system ? { instructions: request.system } : {}),
    input: convertMessages(request.messages),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }
      : {}),
  };
}

function convertMessages(messages: readonly ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      input.push({
        role: message.role,
        content: [{
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content,
        }],
      });
      continue;
    }
    let pending: unknown[] = [];
    const flush = (): void => {
      if (!pending.length) return;
      input.push({ role: message.role, content: pending });
      pending = [];
    };
    for (const block of message.content) {
      if (block.type === 'text') {
        pending.push({
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: block.text,
        });
      } else if (block.type === 'image') {
        pending.push({
          type: 'input_image',
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        });
      } else if (block.type === 'tool_use') {
        flush();
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else {
        flush();
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        });
      }
    }
    flush();
  }
  return input;
}

function terminalFromResponse(value: unknown, toolCalls: number, incomplete: boolean): Terminal {
  const response = asRecord(value);
  if (!response) throw new Error('OpenAI Responses terminal response is invalid.');
  let stopReason = toolCalls ? 'tool_use' : 'end_turn';
  if (incomplete) {
    if (asRecord(response.incomplete_details)?.reason !== 'max_output_tokens') {
      throw new Error('OpenAI Responses returned an unsupported incomplete reason.');
    }
    stopReason = 'max_tokens';
  }
  const usage = asRecord(response.usage);
  return Object.freeze({
    stopReason,
    usage: Object.freeze({
      inputTokens: readNonNegativeInteger(
        usage?.input_tokens,
        'OpenAI Responses usage.input_tokens',
      ),
      outputTokens: readNonNegativeInteger(
        usage?.output_tokens,
        'OpenAI Responses usage.output_tokens',
      ),
    }),
  });
}

function isOutputEvent(type: string): boolean {
  return type.startsWith('response.output_')
    || type.startsWith('response.content_part.')
    || type.startsWith('response.function_call_arguments.');
}
