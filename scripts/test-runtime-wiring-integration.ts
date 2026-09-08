/**
 * RuntimeApp wiring integration test.
 *
 * 验证 RuntimeApp 与真实 workspace / session / tool / prompt-builder 的装配，
 * mock LLM client 隔离外部依赖。迁移自 src/runtime/RuntimeApp.integration.test.ts
 * 的前三个测试：
 *
 *   1. boots: 真链路启动 + 单次 turn + 系统 prompt + tools 正确传给 LLM
 *   2. memory tools: config 驱动 memory tools 注入 + system prompt 含 memory section
 *   3. context reload: 写文件 → reloadContextFiles → contextVersion 递增 + 新内容生效
 *
 * Usage:
 *   npx tsx scripts/test-runtime-wiring-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import { SessionManager } from '../src/core/session/index.js';
import type {
  ChatParams,
  ChatResponse,
  LLMClient,
  StreamEvent,
} from '../src/adapters/llm/types.js';

// ── runStep 脚手架 ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runStep(name: string, step: () => Promise<void>): Promise<void> {
  console.log(`\n${'-'.repeat(72)}`);
  console.log(`STEP: ${name}`);
  console.log('-'.repeat(72));
  try {
    await step();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAILED: ${name}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

// ── Mock LLM ────────────────────────────────────────────────────

/**
 * 单次响应 mock：每次 chatStream 调用返回相同文本（用于不关心多轮的测试）。
 * 通过 onCall 回调暴露 captured ChatParams 供断言。
 */
function createSingleResponseLLM(opts: {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  onCall?: (params: ChatParams) => void;
}): LLMClient {
  const { text, inputTokens = 10, outputTokens = 5, onCall } = opts;
  return {
    async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
      onCall?.(params);
      yield { type: 'message_start' };
      yield { type: 'text_delta', text };
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens, outputTokens },
      };
    },
    async chat(): Promise<ChatResponse> {
      throw new Error('Not used in this test');
    },
  };
}

// ── 工作区生命周期 ──────────────────────────────────────────────

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-wiring-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 测试用例 ────────────────────────────────────────────────────

async function testBootsAndRunsTurn(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    let capturedParams: ChatParams | undefined;
    let sessionManager: SessionManager | undefined;

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'test-model' },
        memory: { enabled: false },
      },
      dependencies: {
        createLLMClient: () => createSingleResponseLLM({
          text: 'Integration hello',
          inputTokens: 12,
          outputTokens: 8,
          onCall: (p) => { capturedParams = p; },
        }),
        createSessionManager: (dir) => {
          sessionManager = new SessionManager(dir);
          return sessionManager;
        },
      },
    });

    try {
      const result = await app.application.runTurn({
        sessionKey: 'main',
        message: 'Hello integration runtime',
        promptMode: 'full',
      });

      assert.equal(result.text, 'Integration hello', 'result.text should be "Integration hello"');
      assert.equal(capturedParams?.model, 'test-model', 'LLM should receive overridden model');
      assert.ok(
        capturedParams?.system?.includes('# Identity'),
        'system prompt should contain "# Identity" section',
      );
      assert.ok(
        (capturedParams?.tools?.length ?? 0) > 0,
        `tools should be non-empty, got length=${capturedParams?.tools?.length ?? 0}`,
      );
      assert.equal(
        sessionManager?.getMessages('main').length,
        2,
        'session should have 2 messages (user + assistant)',
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

async function testMemoryToolsInjection(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    let capturedParams: ChatParams | undefined;

    await mkdir(join(workspaceDir, '.agent'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.agent', 'config.json'),
      JSON.stringify({
        agents: {
          defaults: {
            llm: { apiKey: 'config-key', model: 'config-model' },
            memory: { enabled: true },
          },
        },
      }),
      'utf-8',
    );

    const app = await RuntimeApp.create({
      workspaceDir,
      dependencies: {
        createLLMClient: () => createSingleResponseLLM({
          text: 'Memory integration',
          inputTokens: 16,
          outputTokens: 9,
          onCall: (p) => { capturedParams = p; },
        }),
        // 用最小 stub 替代真实 MemoryManager，避免引入 sqlite 依赖
        createMemoryManager: async () => ({
          search: async () => [],
          readFile: async () => '',
          writeFile: async () => {},
          reindex: async () => {},
          close: () => {},
        }) as never,
      },
    });

    try {
      const result = await app.application.runTurn({
        sessionKey: 'memory-main',
        message: 'Hello memory runtime',
        promptMode: 'full',
      });

      assert.equal(result.text, 'Memory integration', 'result.text should be "Memory integration"');
      assert.ok(
        app.application.getToolNames().includes('memory_search'),
        `getToolNames() should include "memory_search", got: ${app.application.getToolNames().join(', ')}`,
      );
      assert.equal(capturedParams?.model, 'config-model', 'LLM should receive config model');
      assert.ok(
        capturedParams?.tools?.some((tool) => tool.name === 'memory_search'),
        'tools sent to LLM should include "memory_search"',
      );
      assert.ok(
        capturedParams?.system?.includes('# Memory Recall'),
        'system prompt should contain "# Memory Recall" section',
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

async function testReloadContextFiles(): Promise<void> {
  await withWorkspace(async (workspaceDir) => {
    const capturedSystems: string[] = [];

    const app = await RuntimeApp.create({
      workspaceDir,
      cliOverrides: {
        llm: { apiKey: 'test-key', model: 'reload-model' },
        memory: { enabled: false },
      },
      dependencies: {
        createLLMClient: () => createSingleResponseLLM({
          text: 'Reload integration',
          inputTokens: 10,
          outputTokens: 7,
          onCall: (p) => { capturedSystems.push(p.system ?? ''); },
        }),
      },
    });

    try {
      await app.application.runTurn({ sessionKey: 'reload-main', message: 'First turn', promptMode: 'full' });

      await writeFile(
        join(workspaceDir, '.agent', 'IDENTITY.md'),
        '# Identity\nReloaded context marker',
        'utf-8',
      );

      const previousVersion = app.application.getState().contextVersion;
      await app.application.runTurn({
        sessionKey: 'reload-main',
        message: 'Second turn',
        promptMode: 'full',
        reloadContextFiles: true,
      });

      assert.equal(
        app.application.getState().contextVersion,
        previousVersion + 1,
        `contextVersion should increment by 1: before=${previousVersion}, after=${app.application.getState().contextVersion}`,
      );
      assert.ok(
        capturedSystems.at(-1)?.includes('Reloaded context marker'),
        'system prompt of second turn should include reloaded marker',
      );
    } finally {
      await app.close('test complete').catch(() => undefined);
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== RuntimeApp Wiring Integration Tests ===');

  await runStep(
    'boots with real workspace/session/tool wiring and runs a turn with a mocked llm client',
    testBootsAndRunsTurn,
  );
  await runStep(
    'loads config defaults and injects memory tools when memory is enabled',
    testMemoryToolsInjection,
  );
  await runStep(
    'reloads context files from disk when a turn requests reloadContextFiles',
    testReloadContextFiles,
  );

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(72));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
