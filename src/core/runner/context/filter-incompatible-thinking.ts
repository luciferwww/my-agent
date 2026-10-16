import type { ChatMessage } from '../../model-invocation/index.js';
import type { ResolvedModel } from '../../model-resolution/index.js';

export function filterIncompatibleThinking(
  messages: readonly ChatMessage[],
  model: Pick<ResolvedModel, 'identity' | 'endpointId'>,
): ChatMessage[] {
  return messages.flatMap((message): ChatMessage[] => {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      return [message];
    }
    const source = message.invocation?.source;
    if (
      source?.providerId === model.identity.providerId
      && source.requestModelId === model.identity.modelId
      && source.connectionId === model.endpointId
    ) {
      return [message];
    }
    const content = message.content.filter((block) => block.type !== 'thinking');
    if (content.length === message.content.length) return [message];
    return content.length > 0 ? [{ ...message, content }] : [];
  });
}
