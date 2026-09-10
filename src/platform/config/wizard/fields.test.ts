import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_CONFIG, DEFAULT_LOGGER_CONFIG } from '../defaults.js';
import { askAdvancedFields, askCoreFields } from './fields.js';
import type { ReadlineSession } from './prompts.js';

describe('Config Wizard fields', () => {
  it('collects the default model as a structured Provider and Model pair', async () => {
    const answers = ['', '', 'anthropic', 'claude-test', '', '', '', ''];
    const questions: string[] = [];
    const session: ReadlineSession = {
      async question(prompt): Promise<string> {
        questions.push(prompt);
        return answers.shift() ?? '';
      },
      close: vi.fn(),
    };

    const result = await askCoreFields(session, {
      agentsDefaults: DEFAULT_AGENT_CONFIG,
      logger: DEFAULT_LOGGER_CONFIG,
    });

    expect(result.agentsDefaults.model).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-test',
    });
    expect(questions.join('\n')).not.toMatch(/context window/u);
  });

  it('does not prompt for implementation-owned fields removed from the config schema', async () => {
    const questions: string[] = [];
    let firstQuestion = true;
    const session: ReadlineSession = {
      async question(prompt): Promise<string> {
        questions.push(prompt);
        if (firstQuestion) {
          firstQuestion = false;
          return 'y';
        }
        return '';
      },
      close: vi.fn(),
    };

    const result = await askAdvancedFields(
      session,
      { agentsDefaults: DEFAULT_AGENT_CONFIG, logger: DEFAULT_LOGGER_CONFIG },
      {
        agentsDefaults: {},
        logger: { file: { enabled: true } },
        flags: { memoryEnabled: true, loggerFileEnabled: true },
      },
    );

    expect(questions.join('\n')).not.toMatch(
      /Embedding vector dimensions|File adapter dir|filename prefix|max queue size/u,
    );
    expect(result.agentsDefaults.memory?.embedding).not.toHaveProperty('dimensions');
    expect(result.logger.file).not.toHaveProperty('dir');
    expect(result.logger.file).not.toHaveProperty('prefix');
    expect(result.logger.file).not.toHaveProperty('maxQueueSize');
  });
});