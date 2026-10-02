import type { ToolCall } from '../tools/types.js';
import type {
  AssistantInvocation,
  ChatContentBlock,
  InvocationSource,
  InvocationUsage,
  ModelInvocationResponse,
  ModelStreamEvent,
  PresentationContentBlock,
  ThinkingCompletion,
  ThinkingContentBlock,
} from './types.js';

type ContentSlot =
  | { readonly type: 'text'; text: string }
  | { readonly type: 'tool'; block: ChatContentBlock }
  | {
      readonly type: 'thinking';
      readonly blockId: string;
      text: string;
      completion?: ThinkingCompletion;
    };

export class ModelStreamCollector {
  private readonly slots: ContentSlot[] = [];
  private readonly thinking = new Map<string, Extract<ContentSlot, { type: 'thinking' }>>();
  private readonly toolCalls: ToolCall[] = [];
  private invocationStart?: { id: string; source: InvocationSource };
  private terminal?: { stopReason: string; usage: InvocationUsage };

  push(event: ModelStreamEvent): void {
    switch (event.type) {
      case 'message_start':
        if (this.invocationStart || this.slots.length > 0) {
          throw new Error('Model invocation sent a duplicate or late message_start event.');
        }
        this.invocationStart = event.invocation;
        return;
      case 'thinking_start': {
        if (!this.invocationStart) {
          throw new Error('Model invocation started Thinking without invocation metadata.');
        }
        if (this.thinking.has(event.blockId)) {
          throw new Error(`Model invocation sent duplicate Thinking block "${event.blockId}".`);
        }
        const slot: Extract<ContentSlot, { type: 'thinking' }> = {
          type: 'thinking',
          blockId: event.blockId,
          text: '',
        };
        this.thinking.set(event.blockId, slot);
        this.slots.push(slot);
        return;
      }
      case 'thinking_delta': {
        const slot = this.requireThinking(event.blockId);
        if (slot.completion) {
          throw new Error(`Model invocation sent Thinking delta after end for "${event.blockId}".`);
        }
        slot.text += event.text;
        return;
      }
      case 'thinking_end': {
        const slot = this.requireThinking(event.blockId);
        if (slot.completion) {
          throw new Error(`Model invocation sent duplicate Thinking end for "${event.blockId}".`);
        }
        slot.completion = event.completion;
        return;
      }
      case 'text_delta': {
        const last = this.slots[this.slots.length - 1];
        if (last?.type === 'text') last.text += event.text;
        else this.slots.push({ type: 'text', text: event.text });
        return;
      }
      case 'tool_call': {
        this.toolCalls.push(event.call);
        if (event.call.input.state === 'ready') {
          this.slots.push({
            type: 'tool',
            block: {
              type: 'tool_use',
              id: event.call.callId,
              name: event.call.name,
              input: { ...event.call.input.value },
            },
          });
        }
        return;
      }
      case 'message_end':
        if (this.terminal) {
          throw new Error('Model invocation sent duplicate message_end events.');
        }
        this.terminal = { stopReason: event.stopReason, usage: event.usage };
        return;
      case 'error':
        throw event.error;
    }
  }

  finish(): ModelInvocationResponse {
    if (!this.terminal) {
      throw new Error('Model invocation completed without a terminal event.');
    }
    for (const slot of this.thinking.values()) {
      if (!slot.completion) {
        throw new Error(`Model invocation left Thinking block "${slot.blockId}" incomplete.`);
      }
    }
    const content = this.collectContent();
    return Object.freeze({
      content,
      toolCalls: Object.freeze([...this.toolCalls]),
      stopReason: this.terminal.stopReason,
      usage: Object.freeze({ ...this.terminal.usage }),
      ...(this.invocationStart
        ? {
            invocation: Object.freeze({
              id: this.invocationStart.id,
              source: Object.freeze({ ...this.invocationStart.source }),
              completion: Object.freeze({
                status: 'complete' as const,
                stopReason: this.terminal.stopReason,
                usage: Object.freeze({ ...this.terminal.usage }),
              }),
            }),
          }
        : {}),
    });
  }

  finishPartial(stopReason: 'aborted' | 'error'): {
    content: ChatContentBlock[];
    toolCalls: readonly ToolCall[];
    invocation?: AssistantInvocation;
  } {
    for (const slot of this.thinking.values()) {
      if (!slot.completion) slot.completion = { status: 'partial', text: slot.text };
    }
    return {
      content: this.collectContent(),
      toolCalls: Object.freeze([...this.toolCalls]),
      ...(this.invocationStart
        ? {
            invocation: Object.freeze({
              id: this.invocationStart.id,
              source: Object.freeze({ ...this.invocationStart.source }),
              completion: Object.freeze({ status: 'partial' as const, stopReason }),
            }),
          }
        : {}),
    };
  }

  private requireThinking(
    blockId: string,
  ): Extract<ContentSlot, { type: 'thinking' }> {
    const slot = this.thinking.get(blockId);
    if (!slot) throw new Error(`Model invocation referenced unknown Thinking block "${blockId}".`);
    return slot;
  }

  private collectContent(): ChatContentBlock[] {
    const invocationId = this.invocationStart?.id;
    const content: ChatContentBlock[] = [];
    for (const slot of this.slots) {
      if (slot.type === 'text') {
        if (slot.text) content.push({ type: 'text', text: slot.text });
        continue;
      }
      if (slot.type === 'tool') {
        content.push(slot.block);
        continue;
      }
      if (!slot.completion || !invocationId) continue;
      if (slot.completion.status === 'partial' && slot.completion.text === '') continue;
      const block: ThinkingContentBlock = {
        type: 'thinking',
        id: `${invocationId}:${slot.blockId}`,
        ...slot.completion,
      };
      content.push(block);
    }
    return content;
  }
}

export function projectThinkingText(block: ThinkingContentBlock): string {
  return block.text;
}

export function projectContentForPresentation(
  content: readonly ChatContentBlock[],
): PresentationContentBlock[] {
  return content.flatMap((block): PresentationContentBlock[] => {
    if (block.type !== 'thinking') return [{ ...block }];
    const text = projectThinkingText(block);
    return text
      ? [{
          type: 'thinking',
          id: block.id,
          text,
          status: block.status,
        }]
      : [];
  });
}
