/**
 * Attachments end-to-end integration test (PR-6 / Decision 8 boundaries).
 *
 * 真实链路：ws client → WebSocketChannel (real WebSocketServer) → RuntimeApp
 * → AgentRunner → mocked ModelInvocationPort (captures ModelInvocationRequest)。
 *
 * 覆盖 spec lines 748-755 中的 wire / pipeline / session 路径：
 *
 *   1. 小图（~250 KB）端到端 — LLM mock 收到 image block；JSONL 含 image entry
 *   2. 中图（~3 MB）— 服务端静默 resize；LLM mock 收到 < 2 MB base64 的 image；
 *      session JSONL 写入 resize 后的 base64；无附件相关事件 emit
 *   3. 超大图（10.5 MB raw, 14 MB base64）+ 文本 — 图被丢弃（too_large）；
 *      LLM 仅收到文本；入队文本尾部含「1 个附件…已忽略」；无 RUN_REJECTED
 *   4. 5 MB 单图（验证 WS_MAX_PAYLOAD_BYTES=15MB 已生效）— 帧不被 ws 截断
 *
 * Spec 753（steering 带图）已在单测覆盖 (RuntimeApp.intake.test.ts)；
 * Spec 755（发图后 compaction）涉及压缩端到端，留待后续脚本。
 *
 * Usage:
 *   npx tsx scripts/test-runtime-attachments-integration.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';

import sharp from 'sharp';
import { WebSocket } from 'ws';

import { RuntimeApp } from '../src/runtime/RuntimeApp.js';
import type { RuntimeHandle } from '../src/runtime/runtime-composition.js';
import { createLoadedRuntimeUnit } from '../src/runtime/runtime-unit.js';
import { createWebSocketChannelModule } from '../src/runtime-modules/builtin-channels.js';
import {
  ATTACHMENT_INLINE_THRESHOLD_BYTES,
  ATTACHMENT_RAW_MAX_BYTES,
  WS_MAX_PAYLOAD_BYTES,
} from '../src/core/media/constants.js';
import type {
  ChatContentBlock,
  ModelInvocationRequest,
  ModelInvocationResponse,
  ModelInvocationPort,
  ModelStreamEvent as ModelStreamEvent,
} from '../src/core/model-invocation/index.js';
import type { AgentEvent } from '../src/core/runner/index.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

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

// ── PNG 夹具 ────────────────────────────────────────────────────

/**
 * 生成指定原始字节数附近的 PNG（随机像素 + 无压缩，体积 ≈ width*height*3 + overhead）。
 * 调用方传 width/height，自行控制目标体积。
 */
async function makePng(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) & 0xff; // 伪随机但可重复
  return sharp(raw, { raw: { width, height, channels } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

// ── Mock LLM ────────────────────────────────────────────────────

interface CapturedCall {
  params: ModelInvocationRequest;
}

interface MockLLMHandle {
  client: ModelInvocationPort;
  calls: CapturedCall[];
}

function createCapturingLLM(
  response: string | ((params: ModelInvocationRequest) => string) = 'integration ok',
): MockLLMHandle {
  const calls: CapturedCall[] = [];
  const responseFor = typeof response === 'function' ? response : () => response;
  const client: ModelInvocationPort = {
    async *chatStream(params: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
      calls.push({ params });
      const text = responseFor(params);
      yield { type: 'message_start' };
      yield { type: 'text_delta', text };
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    async chat(): Promise<ModelInvocationResponse> {
      throw new Error('chat() not used in integration test');
    },
  };
  return { client, calls };
}

// ── 端口分配 ────────────────────────────────────────────────────

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// ── ws 测试客户端 ───────────────────────────────────────────────

interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

interface TestClient {
  socket: WebSocket;
  events: ServerEvent[];
  /** 等待一条匹配的事件；超时抛错。 */
  waitFor(predicate: (e: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  send(payload: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function connectClient(port: number, clientId: string): Promise<TestClient> {
  // 测试客户端也要把 maxPayload 拉到与 server 同步，否则下行 base64 大消息会被本端截断。
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    maxPayload: WS_MAX_PAYLOAD_BYTES + 1 * 1024 * 1024,
  });
  const events: ServerEvent[] = [];
  const waiters: Array<{ predicate: (e: ServerEvent) => boolean; resolve: (e: ServerEvent) => void }> = [];

  socket.on('message', (raw) => {
    let parsed: ServerEvent;
    try {
      parsed = JSON.parse(raw.toString('utf-8')) as ServerEvent;
    } catch {
      return;
    }
    events.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.predicate(parsed)) {
        w.resolve(parsed);
        waiters.splice(i, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  socket.send(JSON.stringify({ type: 'hello', clientId }));

  // 等待 hello_ack
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('hello_ack timeout')), 5000);
    socket.on('message', function onMsg(raw) {
      const e = JSON.parse(raw.toString('utf-8')) as ServerEvent;
      if (e.type === 'hello_ack') {
        clearTimeout(t);
        socket.off('message', onMsg);
        resolve();
      }
    });
  });

  return {
    socket,
    events,
    waitFor(predicate, timeoutMs = 15000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          const i = waiters.findIndex((w) => w.predicate === predicate);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(t);
            resolve(e);
          },
        });
      });
    },
    send(payload) {
      socket.send(JSON.stringify(payload));
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
      });
    },
  };
}

// ── RuntimeApp + ws lifecycle ───────────────────────────────────

interface Harness {
  app: RuntimeHandle;
  port: number;
  llm: MockLLMHandle;
  runtimeEvents: RuntimeEvent[];
  agentEvents: AgentEvent[];
  workspaceDir: string;
  close(): Promise<void>;
}

interface HarnessOptions {
  /** 自带 mock LLM；不传则按默认 createCapturingLLM() 创建。 */
  llm?: MockLLMHandle;
  /** 注入固定的 system prompt 字符串，便于 token 估算可控（compaction 场景用）。 */
  mockSystemPrompt?: string;
  /** 覆盖默认 contextWindowTokens（默认走 config defaults = 200_000）。 */
  contextWindowTokens?: number;
  /** 覆盖 compaction 配置子树。 */
  compaction?: Partial<{
    enabled: boolean;
    reserveTokens: number;
    keepRecentTurns: number;
    toolResultContextShare: number;
    toolResultHeadChars: number;
    toolResultTailChars: number;
    timeoutSeconds: number;
  }>;
}

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'runtime-attach-itest-'));
  const port = await pickFreePort();
  const llm = options.llm ?? createCapturingLLM();
  const runtimeEvents: RuntimeEvent[] = [];
  const agentEvents: AgentEvent[] = [];

  const cliOverrides: Record<string, unknown> = {
    llm: {
      apiKey: 'itest-key',
      model: 'itest-model',
      ...(options.contextWindowTokens != null
        ? { contextWindowTokens: options.contextWindowTokens }
        : {}),
    },
    memory: { enabled: false },
  };
  if (options.compaction) {
    cliOverrides.compaction = options.compaction;
  }

  const dependencies: Record<string, unknown> = {
    createBundledProviderUnit: () => createLoadedRuntimeUnit({
      registration: {
        id: 'builtin-test-provider',
        source: 'builtin',
        register(api) { api.registerProvider({
      id: 'test',
      protocol: 'test',
      invocationPort: llm.client,
      resolveConnection: () => ({
        ok: true,
        connection: { endpointId: 'test' },
      }),
      resolveModel: (modelId: string, connection: { endpointId: string }) => ({
        ok: true,
        descriptor: {
          identity: { providerId: 'test', modelId },
          protocol: 'test',
          connection,
          facts: {
            effectiveContextLimit: {
              value: options.contextWindowTokens ?? 200_000,
              source: 'deployment-config',
            },
            maximumOutputTokens: { value: 8192, source: 'deployment-config' },
            toolUse: { value: true, source: 'deployment-config' },
            mediaKinds: { value: ['image'], source: 'deployment-config' },
          },
        },
      }),
        }); },
      },
      required: true,
    }),
  };
  if (options.mockSystemPrompt !== undefined) {
    const sys = options.mockSystemPrompt;
    dependencies.createSystemPromptBuilder = () => ({ build: () => sys }) as never;
  }

  const app = await RuntimeApp.create({
    workspaceDir,
    loadedUnits: [createWebSocketChannelModule({ port, host: '127.0.0.1', path: '/ws' })],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cliOverrides: cliOverrides as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dependencies: dependencies as any,
    onEvent: (e) => runtimeEvents.push(e),
    onAgentEvent: (e) => agentEvents.push(e),
  });

  return {
    app,
    port,
    llm,
    runtimeEvents,
    agentEvents,
    workspaceDir,
    async close() {
      await app.close('itest done').catch(() => undefined);
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// ── 断言辅助 ────────────────────────────────────────────────────

function findImageBlock(blocks: ChatContentBlock[] | string): ChatContentBlock | undefined {
  if (typeof blocks === 'string') return undefined;
  return blocks.find((b) => b.type === 'image');
}

function findTextBlock(blocks: ChatContentBlock[] | string): string | undefined {
  if (typeof blocks === 'string') return blocks;
  const t = blocks.find((b) => b.type === 'text');
  return t && t.type === 'text' ? t.text : undefined;
}

function lastUserContent(params: ModelInvocationRequest): string | ChatContentBlock[] {
  const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) throw new Error('expected at least one user message in ModelInvocationRequest.messages');
  return lastUser.content;
}

function assertNoAttachmentSideChannels(
  runtimeEvents: RuntimeEvent[],
  agentEvents: AgentEvent[],
  clientEvents: ServerEvent[],
): void {
  for (const e of runtimeEvents) {
    if (e.type === 'error' || e.type === 'warning') {
      assert.notEqual(
        e.info.code,
        'RUN_REJECTED',
        `unexpected RUN_REJECTED: ${e.info.message}`,
      );
      assert.ok(
        !e.info.message.toLowerCase().includes('attachment'),
        `unexpected attachment-related ${e.type}: ${e.info.message}`,
      );
    }
  }
  for (const e of agentEvents) {
    assert.notEqual(
      e.type,
      'attachment_resized' as never,
      'unexpected attachment_resized agent event',
    );
  }
  for (const e of clientEvents) {
    if (e.type === 'channel_error') {
      assert.fail(`unexpected channel_error on wire: ${JSON.stringify(e)}`);
    }
    assert.notEqual(
      e.type,
      'attachment_resized',
      'unexpected attachment_resized event on wire',
    );
  }
}

// ── 测试用例 ────────────────────────────────────────────────────

async function testSmallImageEndToEnd(): Promise<void> {
  const h = await startHarness();
  const client = await connectClient(h.port, 'c-small');
  try {
    const png = await makePng(280, 280); // ~235 KB raw, < inline threshold (2 MB), 不 resize
    assert.ok(png.byteLength < ATTACHMENT_INLINE_THRESHOLD_BYTES, 'fixture < 2MB');

    client.send({
      type: 'run_turn',
      sessionKey: 'small',
      message: [
        { type: 'text', text: 'describe this image' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        },
      ],
    });

    await client.waitFor((e) => e.type === 'run_end' && e.sessionKey === 'small');

    assert.equal(h.llm.calls.length, 1, 'LLM called exactly once');
    const content = lastUserContent(h.llm.calls[0]!.params);
    const img = findImageBlock(content);
    assert.ok(img && img.type === 'image', 'LLM received an image block');
    assert.equal(img.source.media_type, 'image/png', 'image media_type preserved');
    assert.equal(img.source.data.length, png.toString('base64').length, 'no resize occurred for small image');

    // JSONL 应包含 image entry
    const jsonl = await readSessionJsonl(h.workspaceDir, 'small');
    const userLines = jsonl.filter((line) => line.type === 'message' && line.message?.role === 'user');
    assert.ok(userLines.length >= 1, 'user message persisted in JSONL');
    const persisted = userLines[0]!.message!.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(persisted), 'persisted user content is ContentBlock[]');
    const persistedImg = persisted.find((b) => b.type === 'image');
    assert.ok(persistedImg, 'JSONL contains image entry');

    assertNoAttachmentSideChannels(h.runtimeEvents, h.agentEvents, client.events);
  } finally {
    await client.close();
    await h.close();
  }
}

async function testMediumImageResized(): Promise<void> {
  const h = await startHarness();
  const client = await connectClient(h.port, 'c-medium');
  try {
    // ~3 MB raw → 应触发 resize（threshold 2 MB）
    const png = await makePng(1100, 1100);
    assert.ok(
      png.byteLength > ATTACHMENT_INLINE_THRESHOLD_BYTES,
      `fixture > 2MB (got ${png.byteLength})`,
    );
    assert.ok(png.byteLength < ATTACHMENT_RAW_MAX_BYTES, 'fixture under raw cap');

    const originalB64Len = png.toString('base64').length;

    client.send({
      type: 'run_turn',
      sessionKey: 'medium',
      message: [
        { type: 'text', text: 'analyze' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        },
      ],
    });

    await client.waitFor((e) => e.type === 'run_end' && e.sessionKey === 'medium');

    const content = lastUserContent(h.llm.calls[0]!.params);
    const img = findImageBlock(content);
    assert.ok(img && img.type === 'image', 'LLM received an image block after resize');
    assert.ok(
      img.source.data.length < originalB64Len,
      `resized base64 should be smaller than original (orig=${originalB64Len}, got=${img.source.data.length})`,
    );
    const resizedRawBytes = Buffer.from(img.source.data, 'base64').byteLength;
    assert.ok(
      resizedRawBytes <= ATTACHMENT_INLINE_THRESHOLD_BYTES,
      `resized raw bytes should be <= 2 MB (got ${resizedRawBytes})`,
    );

    // JSONL 也应当写 resize 后的 base64（dehydration 在 prompt 摘要路径，不影响 session 持久化）
    const jsonl = await readSessionJsonl(h.workspaceDir, 'medium');
    const userLine = jsonl.find((l) => l.type === 'message' && l.message?.role === 'user');
    const persistedImg = (userLine!.message!.content as Array<Record<string, unknown>>).find(
      (b) => b.type === 'image',
    ) as { source: { data: string } } | undefined;
    assert.ok(persistedImg, 'JSONL contains image entry');
    assert.equal(
      persistedImg.source.data.length,
      img.source.data.length,
      'JSONL stores the resized base64, not the original',
    );

    assertNoAttachmentSideChannels(h.runtimeEvents, h.agentEvents, client.events);
  } finally {
    await client.close();
    await h.close();
  }
}

async function testOversizedImageDroppedKeepText(): Promise<void> {
  const h = await startHarness();
  const client = await connectClient(h.port, 'c-large');
  try {
    // 目标：raw > 10 MB（触发 too_large），同时 base64 + JSON 帧 < 15 MB（不触发 ws 截断）。
    // 10.5 MB raw → 14 MB base64 → ws OK；pipeline 丢弃。
    const png = await makePng(1900, 1900); // ~10.8 MB raw
    assert.ok(
      png.byteLength > ATTACHMENT_RAW_MAX_BYTES,
      `fixture must exceed raw cap (got ${png.byteLength})`,
    );
    const b64Len = Math.ceil(png.byteLength / 3) * 4;
    assert.ok(b64Len < WS_MAX_PAYLOAD_BYTES, `base64 must fit ws frame (got ${b64Len})`);

    client.send({
      type: 'run_turn',
      sessionKey: 'large',
      message: [
        { type: 'text', text: 'huge image incoming' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        },
      ],
    });

    await client.waitFor((e) => e.type === 'run_end' && e.sessionKey === 'large');

    const content = lastUserContent(h.llm.calls[0]!.params);
    // image 被丢弃后，normalized 仍可能保持 ContentBlock[] 形态（仅剩文本块）；
    // assembleInboundMessage 将「已忽略」notice 追加到该文本块内。
    assert.equal(findImageBlock(content), undefined, 'no image block reached the LLM');
    const text = findTextBlock(content);
    assert.ok(text, 'LLM received some text content');
    assert.ok(text!.includes('huge image incoming'), 'original text preserved');
    assert.ok(text!.includes('1 个附件'), `drop notice appended (got: ${text!.slice(-200)})`);

    assertNoAttachmentSideChannels(h.runtimeEvents, h.agentEvents, client.events);
  } finally {
    await client.close();
    await h.close();
  }
}

async function testFiveMbImagePassesWire(): Promise<void> {
  const h = await startHarness();
  const client = await connectClient(h.port, 'c-5mb');
  try {
    // ~5 MB raw → 7 MB base64 → 必须能通过 ws 帧（验证 WS_MAX_PAYLOAD_BYTES 已生效）
    const png = await makePng(1300, 1300); // ~5.0 MB raw
    assert.ok(png.byteLength > 4 * 1024 * 1024, `fixture > 4MB (got ${png.byteLength})`);
    assert.ok(png.byteLength < ATTACHMENT_RAW_MAX_BYTES, 'fixture under raw cap');

    client.send({
      type: 'run_turn',
      sessionKey: '5mb',
      message: [
        { type: 'text', text: 'five-megabyte test' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
        },
      ],
    });

    // 关键断言：socket 没有被 ws 用 1009 关闭，且 run 正常结束
    await client.waitFor((e) => e.type === 'run_end' && e.sessionKey === '5mb');
    assert.equal(client.socket.readyState, WebSocket.OPEN, 'socket still open (frame not rejected)');

    const content = lastUserContent(h.llm.calls[0]!.params);
    const img = findImageBlock(content);
    assert.ok(img && img.type === 'image', 'LLM received image (post-resize)');

    assertNoAttachmentSideChannels(h.runtimeEvents, h.agentEvents, client.events);
  } finally {
    await client.close();
    await h.close();
  }
}

// 覆盖 spec line 755：发图后触发 compaction → 摘要文本含 `[Image]:` 占位；
// 保留区（JSONL 原始记录）仍是 base64。
//
// 触发策略：
//   - contextWindowTokens=2000, reserveTokens=600 → 可用预算 1400 tokens
//   - 注入 mockSystemPrompt='SYS'（1 token）、固定 mock LLM 文本 'ack'（5 token/msg）
//   - 4 轮 user 消息：text 'zero' / text+800x800 image / text 'second' / ~1600 字符大文本
//   - 第 4 轮 preflight 时 estimated ≈ 1534 > 1400 → 'compact' 路由 → 摘要 + 重试
//   - keepRecentTurns=1 → splitForCompaction 落点 = user3，user2（含图）落入压缩区
async function testCompactionAfterImage(): Promise<void> {
  const SUMMARY_PROMPT_PREFIX = 'Please provide a concise summary';
  const SUMMARY_TEXT = 'SUMMARIZED HISTORY for compaction-image test';

  const llm = createCapturingLLM((params: ModelInvocationRequest) => {
    const first = params.messages[0]?.content;
    if (typeof first === 'string' && first.startsWith(SUMMARY_PROMPT_PREFIX)) {
      return SUMMARY_TEXT;
    }
    return 'ack';
  });

  const h = await startHarness({
    llm,
    mockSystemPrompt: 'SYS',
    contextWindowTokens: 2000,
    compaction: { reserveTokens: 600, keepRecentTurns: 1 },
  });
  const client = await connectClient(h.port, 'c-compact');

  // 单 session 多轮：events 累积，需用 startIdx 隔离每轮 run_end
  const sendAndWait = async (payload: Record<string, unknown>): Promise<ServerEvent> => {
    const startIdx = client.events.length;
    client.send(payload);
    return client.waitFor((e) => {
      if (e.type !== 'run_end' || e.sessionKey !== 'compact') return false;
      return client.events.indexOf(e) >= startIdx;
    });
  };

  try {
    const png = await makePng(800, 800); // ~1.92MB raw，< 2MB inline threshold，不 resize
    assert.ok(
      png.byteLength < ATTACHMENT_INLINE_THRESHOLD_BYTES,
      `fixture must stay under inline threshold (got ${png.byteLength})`,
    );
    const originalB64 = png.toString('base64');

    // Turn 1：小文本
    await sendAndWait({ type: 'run_turn', sessionKey: 'compact', message: 'zero' });
    // Turn 2：文本 + 图（图将落入压缩区）
    await sendAndWait({
      type: 'run_turn',
      sessionKey: 'compact',
      message: [
        { type: 'text', text: 'observe' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: originalB64 },
        },
      ],
    });
    // Turn 3：小文本，作为 keepRecentTurns=1 的 split 锚点
    await sendAndWait({ type: 'run_turn', sessionKey: 'compact', message: 'second' });

    const callsBeforeBig = llm.calls.length;
    assert.equal(
      callsBeforeBig,
      3,
      `expected 3 LLM calls before compaction trigger (got ${callsBeforeBig})`,
    );

    // Turn 4：大文本，预算超出 → 触发 preemptive compaction
    const bigText = 'X '.repeat(800); // 1600 chars ≈ 404 tokens
    await sendAndWait({ type: 'run_turn', sessionKey: 'compact', message: bigText });

    // 期望：1 个摘要调用 + 1 个 turn-4 retry 调用 → 总共 5 次 LLM
    const newCalls = llm.calls.slice(callsBeforeBig);
    const summaryCalls = newCalls.filter((c) => {
      const first = c.params.messages[0]?.content;
      return typeof first === 'string' && first.startsWith(SUMMARY_PROMPT_PREFIX);
    });
    assert.equal(
      summaryCalls.length,
      1,
      `expected exactly one summary LLM call (got ${summaryCalls.length}; totalCalls=${llm.calls.length})`,
    );

    // Spec 755 ①：摘要 prompt 的对话文本含 [Image]: 占位
    const summaryPromptText = summaryCalls[0]!.params.messages[0]!.content as string;
    assert.ok(
      summaryPromptText.includes('[Image]: media_type=image/png'),
      `summary prompt should contain [Image] placeholder; got tail:\n${summaryPromptText.slice(-400)}`,
    );
    // 同时验证：原始 base64 数据没有泄漏进摘要 prompt（dehydration 生效）
    assert.ok(
      !summaryPromptText.includes(originalB64.slice(0, 200)),
      'original base64 must not leak into the summary prompt',
    );

    // 压缩后重试调用：messages[0] 必为 [Previous conversation summary] 头
    const retryCall = newCalls.find((c) => {
      const first = c.params.messages[0]?.content;
      return (
        typeof first === 'string' && first.startsWith('[Previous conversation summary]')
      );
    });
    assert.ok(
      retryCall,
      'expected a post-compaction retry LLM call carrying [Previous conversation summary] header',
    );

    // Spec 755 ②：JSONL 保留区仍是原始 base64
    const jsonl = await readSessionJsonl(h.workspaceDir, 'compact');
    const imgBearing = jsonl.find(
      (l) =>
        l.type === 'message' &&
        l.message?.role === 'user' &&
        Array.isArray(l.message.content) &&
        (l.message.content as Array<Record<string, unknown>>).some((b) => b.type === 'image'),
    );
    assert.ok(imgBearing, 'JSONL still has the image-bearing user record after compaction');
    const persistedImg = (imgBearing!.message!.content as Array<Record<string, unknown>>).find(
      (b) => b.type === 'image',
    ) as { source: { data: string; media_type: string } } | undefined;
    assert.ok(persistedImg, 'image block present in JSONL record');
    assert.equal(
      persistedImg!.source.data.length,
      originalB64.length,
      'JSONL stores the original base64 length (not dehydrated, not resized)',
    );
    assert.equal(
      persistedImg!.source.data,
      originalB64,
      'JSONL base64 bytes match the original PNG',
    );

    // CompactionRecord 必须落盘
    const compactionRecords = jsonl.filter((l) => l.type === 'compaction');
    assert.equal(
      compactionRecords.length,
      1,
      `expected exactly one compaction record (got ${compactionRecords.length})`,
    );

    assertNoAttachmentSideChannels(h.runtimeEvents, h.agentEvents, client.events);
  } finally {
    await client.close();
    await h.close();
  }
}

// ── JSONL 读取辅助 ──────────────────────────────────────────────

async function readSessionJsonl(
  workspaceDir: string,
  sessionKey: string,
): Promise<Array<Record<string, never> & { type: string; message?: { role: string; content: unknown } }>> {
  // sessions.json 索引解析 sessionFile
  const storePath = join(workspaceDir, '.agent', 'sessions', 'sessions.json');
  const store = JSON.parse(await readFile(storePath, 'utf-8')) as Record<
    string,
    { sessionFile: string }
  >;
  const entry = store[sessionKey];
  if (!entry) throw new Error(`session ${sessionKey} not in store`);
  const transcriptPath = join(workspaceDir, '.agent', 'sessions', entry.sessionFile);
  const raw = await readFile(transcriptPath, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== RuntimeApp Attachments Integration Tests ===');

  await runStep('small image (~250KB) reaches LLM and JSONL untouched', testSmallImageEndToEnd);
  await runStep('medium image (~3MB) is silently resized below 2MB threshold', testMediumImageResized);
  await runStep(
    'oversized image (10.5MB raw, fits ws frame) is dropped while text + notice continue',
    testOversizedImageDroppedKeepText,
  );
  await runStep('5MB image traverses ws frame without 1009 truncation', testFiveMbImagePassesWire);
  await runStep(
    'spec 755: post-image compaction dehydrates to [Image]: placeholder while JSONL keeps original base64',
    testCompactionAfterImage,
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
