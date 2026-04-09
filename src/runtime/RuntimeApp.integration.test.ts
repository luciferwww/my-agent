import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatParams, ChatResponse, LLMClient, StreamEvent } from '../llm-client/types.js';
import { SessionManager } from '../session/SessionManager.js';
import { RuntimeApp } from './RuntimeApp.js';

describe('RuntimeApp integration', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-int-test-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('boots with real workspace/session/tool wiring and runs a turn with a mocked llm client', async () => {
    let capturedParams: ChatParams | undefined;
    let sessionManager: SessionManager | undefined;

    const llmClient: LLMClient = {
      async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
        capturedParams = params;
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'Integration hello' };
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 12, outputTokens: 8 },
        };
      },
      async chat(): Promise<ChatResponse> {
        throw new Error('Not used in this test');
      },
    };

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: {
        createLLMClient: () => llmClient,
        createSessionManager: (dir) => {
          sessionManager = new SessionManager(dir);
          return sessionManager;
        },
      },
    });

    const result = await app.runTurn({
      sessionKey: 'main',
      message: 'Hello integration runtime',
    });

    expect(result.text).toBe('Integration hello');
    expect(capturedParams?.model).toBe('test-model');
    expect(capturedParams?.system).toContain('# Identity');
    expect(capturedParams?.tools?.length).toBeGreaterThan(0);
    expect(sessionManager?.getMessages('main')).toHaveLength(2);
  });

  it('loads config defaults and injects memory tools when memory is enabled', async () => {
    let capturedParams: ChatParams | undefined;

    const llmClient: LLMClient = {
      async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
        capturedParams = params;
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'Memory integration' };
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 16, outputTokens: 9 },
        };
      },
      async chat(): Promise<ChatResponse> {
        throw new Error('Not used in this test');
      },
    };

    await mkdir(join(workspaceDir, '.agent'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.agent', 'config.json'),
      JSON.stringify({
        agents: {
          defaults: {
            llm: {
              apiKey: 'config-key',
              model: 'config-model',
            },
            memory: {
              enabled: true,
            },
          },
        },
      }),
      'utf-8',
    );

    const app = await RuntimeApp.create({
      workspaceDir,
      dependencies: {
        createLLMClient: () => llmClient,
        createMemoryManager: async () => ({
          search: async () => [],
          readFile: async () => '',
          writeFile: async () => {},
          reindex: async () => {},
          close: () => {},
        }) as never,
      },
    });

    const result = await app.runTurn({
      sessionKey: 'memory-main',
      message: 'Hello memory runtime',
    });

    expect(result.text).toBe('Memory integration');
    expect(app.getToolNames()).toContain('memory_search');
    expect(capturedParams?.model).toBe('config-model');
    expect(capturedParams?.tools?.some((tool) => tool.name === 'memory_search')).toBe(true);
    expect(capturedParams?.system).toContain('# Memory Recall');
  });

  it('reloads context files from disk when a turn requests reloadContextFiles', async () => {
    const capturedSystems: string[] = [];

    const llmClient: LLMClient = {
      async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
        capturedSystems.push(params.system ?? '');
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: 'Reload integration' };
        yield {
          type: 'message_end',
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 7 },
        };
      },
      async chat(): Promise<ChatResponse> {
        throw new Error('Not used in this test');
      },
    };

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'reload-model' },
        memory: { enabled: false },
      },
      dependencies: {
        createLLMClient: () => llmClient,
      },
    });

    await app.runTurn({
      sessionKey: 'reload-main',
      message: 'First turn',
    });

    await writeFile(
      join(workspaceDir, '.agent', 'IDENTITY.md'),
      '# Identity\nReloaded context marker',
      'utf-8',
    );

    const previousVersion = app.getState().contextVersion;
    await app.runTurn({
      sessionKey: 'reload-main',
      message: 'Second turn',
      reloadContextFiles: true,
    });

    expect(app.getState().contextVersion).toBe(previousVersion + 1);
    expect(capturedSystems.at(-1)).toContain('Reloaded context marker');
  });
});