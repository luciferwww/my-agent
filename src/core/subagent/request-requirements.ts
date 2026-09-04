import type { ChatContentBlock, ChatToolDefinition } from '../model-invocation/index.js';
import type { ModelRequestRequirements } from '../model-resolution/index.js';

export interface SubagentExecutionInput {
  readonly message: string | readonly ChatContentBlock[];
  readonly tools?: readonly ChatToolDefinition[];
}

/** Derive resolution requirements from the exact input sent to the Child Runner. */
export function deriveSubagentRequestRequirements(
  input: SubagentExecutionInput,
): ModelRequestRequirements {
  const mediaKinds = new Set<string>();
  if (Array.isArray(input.message)) {
    for (const block of input.message) {
      if (block.type === 'image') {
        mediaKinds.add('image');
      }
    }
  }

  return Object.freeze({
    tools: (input.tools?.length ?? 0) > 0,
    mediaKinds: Object.freeze([...mediaKinds]),
  });
}
