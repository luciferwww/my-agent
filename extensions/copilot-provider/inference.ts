import { ModelStreamCollector } from 'my-agent/extension-api';
import type {
  ModelInvocationPort, ModelInvocationRequest, ModelInvocationResponse, ModelStreamEvent,
} from 'my-agent/extension-api';
import { LoginCancelledError, LoginError } from './auth.js';
import { CopilotChatCompletionsClient } from './chat-client.js';
import {
  asRecord, CopilotInvocationError, CopilotResponsesClient,
  createCopilotInvalidRequestError, invocationDiagnostics,
} from './responses-client.js';
import type { CopilotModelBinding } from './model-metadata.js';

type Send = (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;

export class CopilotInferenceClient implements ModelInvocationPort {
  constructor(
    private readonly model: CopilotModelBinding,
    private readonly send: Send,
    private readonly lifetime: AbortSignal,
  ) {}

  async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
    const signal = request.signal ? AbortSignal.any([request.signal, this.lifetime]) : this.lifetime;
    try {
      signal.throwIfAborted();
      this.validate(request);
      const fetchImpl: typeof fetch = async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Copilot protocol client must encode a JSON request.');
        const body: unknown = JSON.parse(init.body);
        const record = asRecord(body);
        if (!record) throw new Error('Copilot protocol client returned an invalid request.');
        try { return await this.send(record, signal); }
        catch (error) {
          if (signal.aborted || error instanceof LoginCancelledError) {
            throw new DOMException('Copilot invocation cancelled.', 'AbortError');
          }
          if (!(error instanceof LoginError)) throw error;
          const status = error.httpStatus;
          throw new CopilotInvocationError(
            status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate_limit'
              : status !== undefined && status >= 500 ? 'unavailable' : 'provider_failure',
            invocationDiagnostics(request, {
              ...(status === undefined ? {} : { httpStatus: status }), providerMessage: error.message,
            }),
          );
        }
      };
      const options = { baseURL: this.model.apiBase, fetch: fetchImpl };
      const client: ModelInvocationPort = this.model.wireProtocol === 'openai-responses'
        ? new CopilotResponsesClient(options) : new CopilotChatCompletionsClient(options);
      yield* client.chatStream({ ...request, signal });
    } catch (error) {
      yield {
        type: 'error',
        error: signal.aborted ? new DOMException('Copilot invocation cancelled.', 'AbortError')
          : createCopilotInvalidRequestError(request, error instanceof Error ? error.message : 'Invalid Copilot request.'),
      };
    }
  }

  async chat(request: ModelInvocationRequest): Promise<ModelInvocationResponse> {
    const collector = new ModelStreamCollector();
    for await (const event of this.chatStream(request)) collector.push(event);
    return collector.finish();
  }

  private validate(request: ModelInvocationRequest): void {
    if (request.model !== this.model.modelId) throw new Error('Copilot invocation does not match the bound model.');
    if (request.reasoning?.thinking !== undefined) throw new Error('Copilot does not declare a thinking-switch adapter.');
    const effort = request.reasoning?.effort;
    if (effort !== undefined && effort !== 'default' && !this.model.facts.reasoning?.efforts?.includes(effort)) {
      throw new Error('Copilot does not declare the requested reasoning effort.');
    }
    if (request.outputTokenLimit !== undefined && (!Number.isSafeInteger(request.outputTokenLimit)
      || request.outputTokenLimit <= 0 || request.outputTokenLimit > (this.model.facts.maximumOutputTokens ?? 0))) {
      throw new Error('Copilot output limit exceeds the declared model limit.');
    }
    if (request.tools?.length && this.model.facts.toolUse === false) throw new Error('Copilot model does not support tools.');
    if (this.model.facts.mediaKinds !== undefined && !this.model.facts.mediaKinds.includes('image')
      && request.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === 'image'))) {
      throw new Error('Copilot model does not support images.');
    }
  }
}
