import { ContextPrepender } from './ContextPrepender.js';
import type {
  ContextHook,
  UserPromptInput,
  BuiltUserPrompt,
} from './types.js';

/**
 * Builds the user prompt.
 *
 * Assembly order (following OpenClaw's prepend pattern):
 *   Turn start time (UTC)
 *   Prepended hook text blocks (in registration order)
 *   Original user message (always last)
 *
 * Media attachments are returned separately, not embedded in the text (as in OpenClaw).
 */
export class UserPromptBuilder {
  private prepender = new ContextPrepender();

  /** Registers a context hook (chainable). */
  useContextHook(hook: ContextHook): this {
    this.prepender.register(hook);
    return this;
  }

  /** Unregisters a context hook (chainable). */
  removeContextHook(id: string): this {
    this.prepender.unregister(id);
    return this;
  }

  /** Builds the user prompt. */
  async build(input: UserPromptInput): Promise<BuiltUserPrompt> {
    const timestamp = `<turn_start>${new Date().toISOString()}</turn_start>`;
    const { text: rawInput, attachments = [], metadata = {} } = input;

    // Collect prepended context.
    const prependedChunks = await this.prepender.prepend(rawInput, metadata);

    // Assemble: timestamp, hooks, then the original message.
    const parts = [timestamp, ...prependedChunks, rawInput].filter(Boolean);
    const text = parts.join('\n\n');

    return {
      text,
      attachments,
      _debug: {
        rawInput,
        prependedChunks,
      },
    };
  }
}
