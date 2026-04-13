import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../agent-runner/types.js';
import type { Tool } from '../tools/types.js';
import { RuntimeApp } from './RuntimeApp.js';
import type { RuntimeDependencies, RuntimeEvent } from './types.js';

describe('RuntimeApp', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-app-test-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('creates, resolves a session automatically, and delegates a turn to AgentRunner', async () => {
    const resolveSession = vi.fn(async () => ({ entry: { sessionId: '1' }, isNew: true }));
    const build = vi.fn(() => 'SYSTEM_PROMPT');
    const runnerRun = vi.fn(async (): Promise<RunResult> => ({
      text: 'hello',
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 2 },
      toolRounds: 0,
    }));

    const deps = createTestDependencies({
      createSessionManager: () => ({ resolveSession } as never),
      createSystemPromptBuilder: () => ({ build } as never),
      createAgentRunner: () => ({ run: runnerRun } as never),
      createMemoryManager: async () => null,
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: deps,
    });

    const result = await app.runTurn({
      sessionKey: 'main',
      message: 'Hello runtime',
    });

    expect(resolveSession).toHaveBeenCalledWith('main');
    expect(build).toHaveBeenCalled();
    expect(runnerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'main',
        message: 'Hello runtime',
        model: 'test-model',
        systemPrompt: 'SYSTEM_PROMPT',
      }),
    );
    expect(result.sessionKey).toBe('main');
    expect(result.text).toBe('hello');
    expect(app.getState().phase).toBe('ready');
  });

  it('degrades to warning when memory initialization fails', async () => {
    const events: RuntimeEvent[] = [];
    const deps = createTestDependencies({
      createMemoryManager: async () => {
        throw new Error('memory init failed');
      },
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
      },
      dependencies: deps,
      onEvent: (event) => events.push(event),
    });

    expect(app.getToolNames()).not.toContain('memory_search');
    expect(events.some((event) => event.type === 'warning')).toBe(true);
    expect(events.some((event) => event.type === 'app_ready')).toBe(true);
  });

  it('reloads context files, closes idempotently, and rejects future runs after close', async () => {
    await writeFile(join(workspaceDir, '.agent', 'IDENTITY.md'), '# Identity', 'utf-8').catch(() => undefined);

    const memoryClose = vi.fn();
    const deps = createTestDependencies({
      createMemoryManager: async () => ({ close: memoryClose } as never),
    });

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: true },
      },
      dependencies: deps,
    });

    const previousVersion = app.getState().contextVersion;
    await app.reloadContextFiles();
    expect(app.getState().contextVersion).toBe(previousVersion + 1);

    await app.close('test shutdown');
    await app.close('test shutdown');

    expect(memoryClose).toHaveBeenCalledTimes(1);
    await expect(app.runTurn({ sessionKey: 'main', message: 'after close' })).rejects.toThrow(
      'Cannot run when runtime phase is closed.',
    );
  });
});

function createTestDependencies(
  overrides: Partial<RuntimeDependencies> = {},
): Partial<RuntimeDependencies> {
  const builtinTool: Tool = {
    name: 'demo_tool',
    description: 'Demo tool',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { content: 'ok' };
    },
  };

  return {
    createLLMClient: () => ({}) as never,
    createSessionManager: () => ({ resolveSession: vi.fn(async () => ({ entry: {}, isNew: true })) }) as never,
    createMemoryManager: async () => null,
    createSystemPromptBuilder: () => ({ build: () => 'SYSTEM_PROMPT' }) as never,
    createAgentRunner: () => ({
      run: async () => ({
        text: 'ok',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolRounds: 0,
      }),
    }) as never,
    getBuiltinTools: () => [builtinTool],
    ...overrides,
  };
}