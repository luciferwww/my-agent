# 用户消息附件支持 — Server 端 Phase 1 实施文档

> 创建日期：2026-06-12
> 范围：[attachments-support-spec.md](./attachments-support-spec.md) 中 Phase 1（image-only）的 **服务端** 改动
> 不含：chat.html 前端（独立 PR）、CliChannel 附件、document/PDF、file source offload（均为 Phase 2）

---

## 0. 阅读前提

- 设计依据：[attachments-support-spec.md](./attachments-support-spec.md)
- 相关现有模块：
  - [src/adapters/llm/types.ts](../../src/adapters/llm/types.ts)（`ChatContentBlock`）
  - [src/core/session/types.ts](../../src/core/session/types.ts)（`ContentBlock`）
  - [src/core/runner/context/token-estimation.ts](../../src/core/runner/context/token-estimation.ts)
  - [src/core/runner/context/context-budget.ts](../../src/core/runner/context/context-budget.ts)
  - [src/core/runner/context/compaction.ts](../../src/core/runner/context/compaction.ts)
  - [src/core/runner/AgentRunner.ts](../../src/core/runner/AgentRunner.ts)
  - [src/adapters/channel/WebSocketChannel.ts](../../src/adapters/channel/WebSocketChannel.ts)
  - [src/adapters/channel/types.ts](../../src/adapters/channel/types.ts)
  - [src/runtime/RuntimeApp.ts](../../src/runtime/RuntimeApp.ts)（`handleInboundChannelMessage` / `runTurn`）

## 1. PR 切分

| # | PR | 依赖 | 可独立合入 |
|---|---|---|---|
| PR-0 | `src/core/media/constants.ts` + `index.ts` barrel | — | ✅ |
| PR-1 | `image-metadata.ts` sniff 模块 | PR-0 | ✅ |
| PR-2 | `image-optimize.ts`（引入 `sharp`） | PR-0 | ✅ |
| PR-3 | `attachment-pipeline.ts` 单附件编排 | PR-1、PR-2 | ✅ |
| PR-4 | 数据模型 + token 估算 + `dimensions` 字段 | PR-0 | ✅ |
| PR-5 | Layer 3 compaction dehydrate | PR-4 | ✅ |
| PR-6 | Channel 协议升级 + 入站校验（调用 pipeline） | PR-3、PR-4 | 必须最后；本 PR 一合入即开放新能力 |

> PR-4、PR-5 与 PR-6 之间存在隐式 invariant：`ImageBlock.dimensions` 是必选字段，但只有 PR-6 入站校验后才会写入。PR-4 单独合入后，runner 内部从未出现过 image block，不触发 invariant；PR-6 合入时 channel 必须保证写入。
>
> 本文档不考虑向后兼容，包括但不限于老格式 JSONL：dimensions 字段一新增即必填，老数据出现则报错，不动 hydrate 退路。

---

## 2. PR 详细说明

### PR-0：共享常量 + barrel

**动机**：避免 resize 阈值、MIME 白名单等跨模块魔法数散落各处。

**新增文件**

- `src/core/media/constants.ts`
- `src/core/media/index.ts`（barrel）

**导出（最小必要集合，只放「跨模块·含前后端」都需要的定义）**

```ts
// src/core/media/constants.ts
export const ATTACHMENT_INLINE_THRESHOLD_BYTES = 2 * 1024 * 1024;   // 2 MB：触发 resize 的阈值
export const ATTACHMENT_RAW_MAX_BYTES = 10 * 1024 * 1024;            // 10 MB：单文件解码后上限
export const ATTACHMENT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;          // 10 MB：单条消息总解码上限
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
export const WS_MAX_PAYLOAD_BYTES = 15 * 1024 * 1024;                // 15 MB：ws maxPayload

export const SUPPORTED_IMAGE_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number];
```

```ts
// src/core/media/index.ts
export * from './constants.js';
export { sniffImage, type ImageMetadata, type SniffResult } from './image-metadata.js';
export { optimizeImage, type OptimizeResult } from './image-optimize.js';
export {
  processImageAttachment,
  type AttachmentResult,
  type AttachmentRejection,
} from './attachment-pipeline.js';
```

**明确不放进这个文件的常量**

- `MAX_SIDE_PX = 2000`、`JPEG_QUALITY_STEPS = [85,75,65,55,45]`：resize 内部决策，前端不需要知道 → 放 `image-optimize.ts` 模块内部常量
- `PATCH_SIZE = 28`（Anthropic patch）/ OpenAI 32 / multiplier / tile：留在 `compaction` config 里按 provider × model 分支

**验收**：纯类型文件，不单独写常量数值快照测试（改常量是 review 的事不是测试的事）。

---

### PR-1：image-metadata 嗅探

**动机**：channel 入站需要 `width × height` 给 PR-4 的 token 估算用；同时做 magic-bytes 校验防 MIME 欺骗。

**新增文件**

- `src/core/media/image-metadata.ts`
- `src/core/media/image-metadata.test.ts`（含 fixture 图片，覆盖每种 MIME 的正/负样本）
- `src/core/media/__fixtures__/`（最小 ≤ 1 KB 的 PNG/JPEG/WebP/GIF 测试图）

**导出**

```ts
import type { SupportedImageMime } from './constants.js';

export interface ImageMetadata {
  width: number;
  height: number;
  mediaType: SupportedImageMime;
}

export type SniffResult =
  | { ok: true; metadata: ImageMetadata }
  | { ok: false; reason: 'unreadable' | 'mime_mismatch' | 'unsupported_variant' };

/**
 * 从原始 bytes 解析 MIME + 尺寸。
 * 实现说明：纯 JS、零依赖；只读前 N 字节（通常 < 256 byte）；不解码像素。
 */
export function sniffImage(bytes: Uint8Array, declaredMime?: string): SniffResult;
```

**实现约束（写进单测，避免后人误删）**

- PNG：IHDR chunk 必读，文件头 `89 50 4E 47 0D 0A 1A 0A`
- JPEG：扫 SOF0(`FFC0`) / SOF2(`FFC2`) 取 w/h；忽略 thumbnail
- WebP：识别 VP8 / VP8L / VP8X 三种 chunk；动图取第一帧画布尺寸
- GIF：87a / 89a，从 logical screen descriptor 读 w/h
- EXIF orientation：若值为 5/6/7/8，**交换 w/h**（避免横竖判错）
- 不认识的变种（如 JPEG 2000、APNG with non-standard chunk order）→ `{ ok: false, reason: 'unsupported_variant' }`，留给 channel 转 `IMAGE_METADATA_UNREADABLE`
- `declaredMime` 与文件头不一致 → `{ ok: false, reason: 'mime_mismatch' }`

**端口来源**：openclaw `src/media/image-ops.ts` 的 sniff 部分（**不** 端口 sharp / resize 部分，那是 PR-2）。

**测试矩阵（必须覆盖）**

| 输入 | 期望 |
|---|---|
| 4 种 MIME × 正常文件 | `ok: true`，w/h 正确 |
| PNG 头被改成 JPEG magic | `ok: false, mime_mismatch` |
| 截断到 8 字节 | `ok: false, unreadable` |
| EXIF orientation = 6 的竖向 JPEG | w/h 已交换 |
| GIF89a 动图 | `ok: true`，画布尺寸（不是每帧） |

**验收**：单独 `pnpm test src/core/media/image-metadata` 跑通。

---

### PR-2：image-optimize（sharp 依赖）

**动机**：channel 收到 > 2 MB 的图时压到 ≤ 2 MB；统一输出 JPEG。

**新增文件**

- `src/core/media/image-optimize.ts`
- `src/core/media/image-optimize.test.ts`

**`package.json` 改动**

```json
{
  "dependencies": {
    "sharp": "^0.33.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": [
      "better-sqlite3",
      "sharp"
    ]
  }
}
```

**导出**

```ts
import type { ImageMetadata } from './image-metadata.js';

export type OptimizeResult =
  | {
      ok: true;
      bytes: Uint8Array;          // resize 后的 JPEG 字节
      metadata: ImageMetadata;     // mediaType 一定是 'image/jpeg'
      appliedQuality: number;
      appliedMaxSide: number;
    }
  | { ok: false; reason: 'sharp_failed' | 'cannot_fit_budget'; detail: string };

/**
 * 两步算法：
 *   Step A: 若 max(w, h) > MAX_SIDE_PX（模块内部常量 2000），按比例缩到 MAX_SIDE_PX
 *   Step B: 按 JPEG_QUALITY_STEPS（模块内部常量 [85,75,65,55,45]）依次 encode；首个 ≤ targetBytes 即返回
 *   全档位仍超 → { ok: false, reason: 'cannot_fit_budget' }
 *   sharp 异常     → { ok: false, reason: 'sharp_failed' }
 */
export async function optimizeImage(
  input: Uint8Array,
  targetBytes: number,
): Promise<OptimizeResult>;
```

**实现约束**

- 调用 `sharp(input).rotate()` 让 sharp 自动应用 EXIF orientation 再 strip metadata（保证下游 sniff 出来的 w/h 与实际像素方向一致）
- `jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })`
- 不开 progressive（流式渲染不在本期诉求里，progressive JPEG 会略大一点）
- 不输出 PNG / WebP——决策 4 已明确「统一 JPEG，quality 降级只为 JSONL 体积」

**测试矩阵**

| 输入 | 期望 |
|---|---|
| 3 MB PNG、2400×1800 | resize 到 2000×1500，quality=85 即满足 2 MB |
| 8 MB 复杂噪声图 | 需要降到 quality=55 或更低；返回 `appliedQuality` 反映实际档位 |
| 损坏的 JPEG（截断） | `{ ok: false, reason: 'sharp_failed' }` |
| 全 5 档仍 > targetBytes 的极端图（fixture 用高频噪声生成） | `{ ok: false, reason: 'cannot_fit_budget' }` |

**部署文档**：在 README 或 docs/deployment 加一段：

> `sharp` 依赖原生 libvips。
> - 多数环境：`pnpm install` 自动下载预编译二进制
> - Alpine：`apk add --no-cache vips-dev` 后 `pnpm install --build-from-source`
> - 与 `better-sqlite3` 同档处理

**验收**：`pnpm test src/core/media/image-optimize` 跑通；CI 在 Alpine 镜像上 build 不报错（若 CI 用 Alpine）。

---

### PR-3：attachment-pipeline 单附件编排

**动机**：把「一张原始图怎么变成 `ImageBlock`」这件事从 channel 里抽出来。channel 只管协议层（数组长度、跨附件总量、steering 禁令、错误码映射），单张图的 MIME / sniff / resize 调度走 media 层纯函数。

**新增文件**

- `src/core/media/attachment-pipeline.ts`
- `src/core/media/attachment-pipeline.test.ts`

**导出**

```ts
import type { ImageBlock } from '../../adapters/llm/types.js';

export type AttachmentRejection =
  | 'unsupported_mime'       // MIME 不在白名单
  | 'mime_mismatch'           // 文件头与声明不符
  | 'metadata_unreadable'     // sniff 失败
  | 'resize_failed';          // sharp 异常 或 全档位仍超阈值

export type AttachmentResult =
  | {
      ok: true;
      block: ImageBlock;
      resized?: {
        fromBytes: number;
        toBytes: number;
        appliedMaxSide: number;
        appliedQuality: number;
      };
    }
  | { ok: false; reason: AttachmentRejection; detail?: string };

/**
 * 处理单张附件：MIME 白名单 → sniff → resize 决策 → 构造 ImageBlock。
 * 调用方（channel）负责：base64 解码、单文件 / 总量字节上限、steering 禁令、AttachmentRejection → channel 错误码映射。
 */
export async function processImageAttachment(
  rawBytes: Uint8Array,
  declaredMime: string,
): Promise<AttachmentResult>;
```

**实现骨架**

```ts
import { SUPPORTED_IMAGE_MIME, ATTACHMENT_INLINE_THRESHOLD_BYTES } from './constants.js';
import { sniffImage } from './image-metadata.js';
import { optimizeImage } from './image-optimize.js';

export async function processImageAttachment(
  rawBytes: Uint8Array,
  declaredMime: string,
): Promise<AttachmentResult> {
  if (!SUPPORTED_IMAGE_MIME.includes(declaredMime as never)) {
    return { ok: false, reason: 'unsupported_mime', detail: declaredMime };
  }

  const sniff = sniffImage(rawBytes, declaredMime);
  if (!sniff.ok) {
    return sniff.reason === 'mime_mismatch'
      ? { ok: false, reason: 'mime_mismatch' }
      : { ok: false, reason: 'metadata_unreadable', detail: sniff.reason };
  }

  let finalBytes = rawBytes;
  let finalMeta = sniff.metadata;
  let resizedInfo: AttachmentResult['resized'];

  if (rawBytes.byteLength > ATTACHMENT_INLINE_THRESHOLD_BYTES) {
    const optimized = await optimizeImage(rawBytes, ATTACHMENT_INLINE_THRESHOLD_BYTES);
    if (!optimized.ok) {
      return { ok: false, reason: 'resize_failed', detail: `${optimized.reason}: ${optimized.detail}` };
    }
    finalBytes = optimized.bytes;
    finalMeta = optimized.metadata;
    resizedInfo = {
      fromBytes: rawBytes.byteLength,
      toBytes: optimized.bytes.byteLength,
      appliedMaxSide: optimized.appliedMaxSide,
      appliedQuality: optimized.appliedQuality,
    };
  }

  return {
    ok: true,
    block: {
      type: 'image',
      source: {
        type: 'base64',
        media_type: finalMeta.mediaType,
        data: Buffer.from(finalBytes).toString('base64'),
      },
      dimensions: { width: finalMeta.width, height: finalMeta.height },
    },
    resized: resizedInfo,
  };
}
```

**设计要点**

- `AttachmentRejection` 用中性词汇（小写），不采用 channel 那套大写错误码 → media 层对 channel 零依赖
- 错误码映射表由 channel 拥有（见 PR-6）
- 未来补充 HTTP channel 可直接复用本函数

**测试矩阵**

| 输入 | 期望 |
|---|---|
| 200 KB 正常 PNG | `ok: true`，`resized` undefined，`block.dimensions` 填入 |
| 3 MB PNG | `ok: true`，`resized.fromBytes/toBytes/appliedQuality` 均填入，`block.source.media_type === 'image/jpeg'` |
| MIME = `image/bmp` | `ok: false, reason: 'unsupported_mime'` |
| 声明 PNG 但文件头是 JPEG | `ok: false, reason: 'mime_mismatch'` |
| 损坏头 | `ok: false, reason: 'metadata_unreadable'` |
| sharp mock 报错 | `ok: false, reason: 'resize_failed'`，`detail` 包含 `sharp_failed` |

**验收**：`pnpm test src/core/media/attachment-pipeline` 跑通；不需要起 ws server。

---

### PR-4：数据模型 + token 估算 + dimensions 字段

**动机**：让 internal `ImageBlock` 携带 `dimensions`，并把 token 估算从常量 2000 改为 patch 公式。

**改动文件**

| 文件 | 改动 |
|---|---|
| [src/adapters/llm/types.ts](../../src/adapters/llm/types.ts) | `ChatContentBlock` 的 image variant 加 `dimensions: { width: number; height: number }` 必选字段 |
| [src/core/session/types.ts](../../src/core/session/types.ts) | `ContentBlock` 同步加 `dimensions` |
| [src/core/runner/context/token-estimation.ts](../../src/core/runner/context/token-estimation.ts) | `estimateBlockTokens` 的 `case 'image'` 改 patch 公式；删 `IMAGE_TOKEN_ESTIMATE`；`estimatePromptTokens` 的 `currentPrompt` 类型放宽为 `string \| ChatContentBlock[]` |
| [src/core/runner/context/context-budget.ts](../../src/core/runner/context/context-budget.ts) | `currentPrompt` 字段类型同步放宽 |
| [src/core/runner/AgentRunner.ts](../../src/core/runner/AgentRunner.ts) | `runAttempt` 里调用 `checkContextBudget` 时把 `params.message`（已是 union）原样传给 `currentPrompt`；无逻辑改动，仅类型 |
| [src/adapters/llm/AnthropicClient.ts](../../src/adapters/llm/AnthropicClient.ts) | 出站请求体里 **strip** `dimensions` 字段（dimensions 仅 internal） |

**关键代码骨架**

```ts
// token-estimation.ts
import type { ChatContentBlock, ChatMessage } from '../../../adapters/llm/types.js';

const ANTHROPIC_PATCH_SIZE = 28; // TODO: provider 化时迁移到 compaction config

function estimateBlockTokens(block: ChatContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);
    case 'image':
      // Anthropic patch 公式；其他 provider 接入时按 model 分支
      return Math.ceil(block.dimensions.width / ANTHROPIC_PATCH_SIZE)
           * Math.ceil(block.dimensions.height / ANTHROPIC_PATCH_SIZE);
    case 'tool_use':
      try {
        return estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input));
      } catch {
        return 128;
      }
    case 'tool_result':
      return estimateTextTokens(block.content);
    default:
      return 0;
  }
}

export function estimatePromptTokens(params: {
  messages: ChatMessage[];
  systemPrompt?: string;
  currentPrompt?: string | ChatContentBlock[];   // ← 类型放宽
}): number {
  let rawTokens = 0;
  if (params.systemPrompt) rawTokens += estimateTextTokens(params.systemPrompt);
  for (const msg of params.messages) rawTokens += estimateMessageTokens(msg);

  if (params.currentPrompt !== undefined) {
    rawTokens += MESSAGE_OVERHEAD_TOKENS;
    if (typeof params.currentPrompt === 'string') {
      rawTokens += estimateTextTokens(params.currentPrompt);
    } else {
      for (const b of params.currentPrompt) rawTokens += estimateBlockTokens(b);
    }
  }
  return Math.ceil(rawTokens * SAFETY_MARGIN);
}
```

```ts
// AnthropicClient.ts —— 出站映射
function toAnthropicContentBlock(block: ChatContentBlock): unknown {
  if (block.type === 'image') {
    const { dimensions, ...rest } = block; // strip dimensions
    return rest;
  }
  return block;
}
```

**为什么 `dimensions` 必选而不是可选**

让 type system 强制 channel 必须 sniff 成功才能构造 `ImageBlock`。本项目不考虑任何向后兼容，老 JSONL 里的 image block 若缺 `dimensions` 会在加载时直接报错（`loadHistory` 不动 hydrate 退路）。

**测试**

| 用例 | 期望 |
|---|---|
| `estimateBlockTokens` 对 `{ type: 'image', dimensions: { width: 2000, height: 1500 } }` | `ceil(2000/28) × ceil(1500/28) = 72 × 54 = 3888` |
| `estimateBlockTokens` 对 `{ type: 'image', dimensions: { width: 200, height: 200 } }` | `8 × 8 = 64` |
| `estimatePromptTokens` 包含带 image 的 `currentPrompt: ChatContentBlock[]` | 返回值 ≥ 文本 token + patch token |
| `AnthropicClient` 出站请求体 | image block 不含 `dimensions` 字段 |

**验收**：相关测试套件全绿；现有所有压缩 / sanitize / runner 测试不回归。

---

### PR-5：Layer 3 compaction dehydrate

**动机**：摘要 LLM 是文本模型，不能直接把 image block 喂给它；需要在送给摘要 LLM 前替换成文字占位。

**改动文件**

- [src/core/runner/context/compaction.ts](../../src/core/runner/context/compaction.ts)

**关键改动**：`serializeMessagesForSummary` 加 `image` 分支

```ts
// compaction.ts
import { estimateBlockTokens } from './token-estimation.js';

function serializeMessagesForSummary(messages: ChatMessage[]): string {
  const MAX_TOOL_RESULT_CHARS = 500;
  const parts: string[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(`[User]: ${msg.content}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      switch (block.type) {
        case 'text': {
          const prefix = msg.role === 'user' ? '[User]' : '[Assistant]';
          parts.push(`${prefix}: ${block.text}`);
          break;
        }
        case 'tool_use':
          parts.push(`[Tool Use]: ${block.name}`);
          break;
        case 'tool_result': {
          const preview = block.content.length > MAX_TOOL_RESULT_CHARS
            ? block.content.slice(0, MAX_TOOL_RESULT_CHARS) + '...[truncated]'
            : block.content;
          parts.push(`[Tool Result]: ${preview}`);
          break;
        }
        case 'image': {
          // dehydrate：摘要 LLM 看不懂 base64，给它一个文字 placeholder
          const n = estimateBlockTokens(block);
          parts.push(`[Image]: media_type=${block.source.media_type}, ~${n} tokens`);
          break;
        }
        default: {
          // 防御：未来加新 block 类型时编译期发现遗漏
          const _exhaustive: never = block;
          throw new Error(`Unsupported block in summary dehydrate: ${(_exhaustive as { type: string }).type}`);
        }
      }
    }
  }

  return parts.join('\n\n');
}
```

**注意：session 持久化的原 message 不动**，dehydrate 只发生在 `serializeMessagesForSummary` 这个内存副本。

**测试**

| 用例 | 期望 |
|---|---|
| `compactMessages` 输入含 image block | 摘要 LLM 收到的 prompt 文本含 `[Image]: media_type=image/png, ~N tokens`；不含 base64 |
| `compactMessages` 调用前后 | 输入 messages 数组未被原地修改 |
| 加一个未来 block 类型（用 `as never` 构造） | `serializeMessagesForSummary` 抛错 |

**验收**：现有 compaction 测试 + 新增 image dehydrate 测试全绿。

---

### PR-6：Channel 协议升级 + 入站校验 + resize 编排

**动机**：把 PR-0 ~ PR-5 串起来，对外开放新能力。这是用户视角「附件能用了」的开关。

**改动文件**

| 文件 | 改动 |
|---|---|
| [src/adapters/channel/types.ts](../../src/adapters/channel/types.ts) | `ChannelRunRequest.message: string \| InboundContentBlock[]`；导出 `InboundContentBlock`；扩展 `ChannelErrorCode`（如果存在统一类型）；新增 `AttachmentResizedEvent` |
| [src/adapters/channel/WebSocketChannel.ts](../../src/adapters/channel/WebSocketChannel.ts) | `ClientMessage.run_turn.message` 类型升级；`parseMessage` 加数组解析；`handleRunTurn` 加附件校验/resize/sniff 流水线；server 创建时传 `maxPayload: WS_MAX_PAYLOAD_BYTES`；扩展 `ChannelErrorCode` 联合；steering 路径数组形态拒非 text |
| [src/runtime/RuntimeApp.ts](../../src/runtime/RuntimeApp.ts) | `ChannelRunRequest.message` 类型变更级联；`shouldRouteMessageToSteering` 配套检查；事件 fan-out `attachment_resized` |
| [src/core/runner/AgentRunner.ts](../../src/core/runner/AgentRunner.ts) | `RunParams.message: string \| ChatContentBlock[]`；`appendMessage` / `messages.push` 直接透传；类型变更带来的级联 |
| [src/core/session/SessionManager.ts](../../src/core/session/SessionManager.ts) | `appendMessage` 已接受 `string \| ContentBlock[]`，仅类型层验证 |

**入站校验流水线（在 `handleRunTurn` 内顺序执行）**

```ts
// WebSocketChannel.ts 伪代码
import { processImageAttachment, type AttachmentRejection } from '../../core/media/index.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  ATTACHMENT_RAW_MAX_BYTES,
  ATTACHMENT_TOTAL_MAX_BYTES,
} from '../../core/media/index.js';

const REJECTION_TO_CODE: Record<AttachmentRejection, ChannelErrorCode> = {
  unsupported_mime:    'UNSUPPORTED_MEDIA_TYPE',
  mime_mismatch:       'MEDIA_TYPE_MISMATCH',
  metadata_unreadable: 'IMAGE_METADATA_UNREADABLE',
  resize_failed:       'ATTACHMENT_RESIZE_FAILED',
};

async function handleRunTurn(socket, message) {
  // 纯文本是 API 语法糖：channel 入口把 string 包成单 text block 后走同一条路径
  if (typeof message.message === 'string') {
    return handler(toChannelRequest(message));
  }

  const blocks = message.message; // InboundContentBlock[]

  // 1. 数组长度安检
  if (blocks.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return sendChannelError('ATTACHMENT_LIMIT_EXCEEDED', ...);
  }

  // 2. steering 路径附件禁令
  if (isSteeringContext(message.sessionKey) && containsNonText(blocks)) {
    return sendChannelError('STEERING_ATTACHMENT_FORBIDDEN', ...);
  }

  // 3. 逐 block 处理：channel 只管协议层，单张图走 pipeline
  let totalDecodedBytes = 0;
  const outBlocks: ChatContentBlock[] = [];

  for (const b of blocks) {
    if (b.type === 'text') {
      outBlocks.push(b);
      continue;
    }
    // b.type === 'image'

    let raw: Uint8Array;
    try {
      raw = Buffer.from(b.source.data, 'base64');
    } catch {
      return sendChannelError('UNSUPPORTED_MEDIA_TYPE', 'invalid base64');
    }

    if (raw.byteLength > ATTACHMENT_RAW_MAX_BYTES) {
      return sendChannelError('ATTACHMENT_TOO_LARGE', ...);
    }
    totalDecodedBytes += raw.byteLength;
    if (totalDecodedBytes > ATTACHMENT_TOTAL_MAX_BYTES) {
      return sendChannelError('ATTACHMENT_TOTAL_TOO_LARGE', ...);
    }

    const result = await processImageAttachment(raw, b.source.media_type);
    if (!result.ok) {
      return sendChannelError(REJECTION_TO_CODE[result.reason], result.detail);
    }

    if (result.resized) {
      this.send({
        type: 'attachment_resized',
        sessionKey: message.sessionKey,
        ...result.resized,
      });
    }
    outBlocks.push(result.block);
  }

  await handler({
    clientId,
    sessionKey: message.sessionKey,
    message: outBlocks,
    model: message.model,
    maxTokens: message.maxTokens,
    maxLlmCalls: message.maxLlmCalls,
  });
}
```

**怎么理解 channel 与 pipeline 的职责划分**

| Channel 负责 | Pipeline 负责 |
|---|---|
| 协议解析（string vs array、字段检查） | MIME 白名单 |
| 数组长度上限 | magic-bytes 校验 |
| 跨附件总量上限 | 维度 sniff |
| 单文件原始字节上限 | resize 决策与执行 |
| base64 解码 | 构造 `ImageBlock`（含 dimensions） |
| steering 禁令 | 返回中性 `AttachmentRejection` |
| `AttachmentRejection` → `ChannelErrorCode` 映射 | |
| `attachment_resized` 事件 emit | |

**`WebSocketServer` 构造参数**

```ts
// WebSocketChannel.start()
this.server = new WebSocketServer({
  host: this.host,
  path: this.path,
  port: this.config.port,
  maxPayload: WS_MAX_PAYLOAD_BYTES,   // ← 必须显式设置；默认 1 MB 直接截断附件
});
```

**`ChannelErrorCode` 扩展**

```ts
type ChannelErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_MESSAGE'
  | 'SERVER_NOT_READY'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_TOTAL_TOO_LARGE'
  | 'ATTACHMENT_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MEDIA_TYPE_MISMATCH'
  | 'IMAGE_METADATA_UNREADABLE'
  | 'ATTACHMENT_RESIZE_FAILED'
  | 'STEERING_ATTACHMENT_FORBIDDEN';
```

**`AgentEvent` 扩展**

```ts
// src/core/runner/types.ts（或事件类型定义所在文件）
| {
    type: 'attachment_resized';
    sessionKey: string;
    fromBytes: number;
    toBytes: number;
    appliedMaxSide: number;
    appliedQuality: number;
  }
```

**测试矩阵（必须覆盖）**

| 用例 | 期望 |
|---|---|
| `message: 'hello'`（string） | 零附件路径，透传为 `[{type:'text',text:'hello'}]` 语义等价，下游行为与改造前一致 |
| `message: [{type:'text', text:'foo'}, {type:'image', ...小图}]` | session 写入 ContentBlock[]，下游 LLM 收到含 image |
| 数组长度 21 | `ATTACHMENT_LIMIT_EXCEEDED` |
| 单文件 > 10 MB（base64 解码后） | `ATTACHMENT_TOO_LARGE` |
| 单条总 > 10 MB（多张 2.5 MB 图） | `ATTACHMENT_TOTAL_TOO_LARGE` |
| MIME 非白名单（如 `image/bmp`） | `UNSUPPORTED_MEDIA_TYPE` |
| 声明 `image/png` 但文件头是 JPEG | `MEDIA_TYPE_MISMATCH` |
| 损坏头（不可识别） | `IMAGE_METADATA_UNREADABLE` |
| 3 MB 正常 PNG | resize 后 `source.data` 解码 ≤ 2 MB；`media_type: 'image/jpeg'`；`dimensions` 更新；emit `attachment_resized` |
| Resize 全档位仍超阈值或 sharp 报错 | `ATTACHMENT_RESIZE_FAILED` |
| Steering 路径携带 image | `STEERING_ATTACHMENT_FORBIDDEN` |
| WS frame > 15 MB | 由 `ws` 库关闭 socket（不进 handler） |

**集成测试（用真实 ws + RuntimeApp + memory LLM mock）**

| 场景 | 期望 |
|---|---|
| 小图（200 KB）端到端跑通 | LLM mock 收到 image block；JSONL 含 image entry；下次 loadHistory 还原 |
| 中图（3 MB） | 服务端 resize；client 收到 `attachment_resized`；JSONL 写入 resize 后 base64 |
| 超大图（12 MB） | 客户端收到 `channel_error: ATTACHMENT_TOO_LARGE`，session 未写入（用 SessionManager spy 验证） |
| 同 session 发 image 后触发 compaction | 摘要文本含 `[Image]:` 占位；session 保留区里仍是原始 base64 image |

**验收**：上述 single-PR 全套测试绿；前后端按本契约通信无错。

---

## 3. 风险检查表

| 风险 | 触发条件 | 缓解 / 检测 |
|---|---|---|
| `maxPayload` 忘了设 → 大附件被默默截断（关闭 socket，错误码 1009） | PR-6 漏改 `WebSocketServer` 构造 | 集成测试：发 5 MB 图必须成功；不通过则说明 maxPayload 没生效 |
| `dimensions` 字段透传给 Anthropic 导致 API 报 unknown field | PR-4 漏改 AnthropicClient | 单测断言出站请求 body 不含 `dimensions` |
| sharp 在 Alpine CI 安装失败 | PR-2 合入后 CI 切换基础镜像 | 部署文档明示；`onlyBuiltDependencies` 加 sharp |
| 摘要 LLM 看到 image base64 | PR-5 漏改 `serializeMessagesForSummary` | 单测：验证 dehydrate 后的 prompt 文本不含 `data:` 或大段 base64 |
| Resize 阻塞 event loop | 高并发上传大图 | 第一版不加 semaphore；若观察到延迟，加 sharp pool 或 p-limit（Phase 2 优化） |
| Steering 路径意外接收附件 | PR-6 漏校验 | 单测覆盖；运行期再加日志告警 |
| `currentPrompt` 类型放宽后 budget 计算与既有路径回归 | PR-4 改 token-estimation 时 | 保留全部既有 string 路径单测；新增 union 单测 |
| pipeline / channel 责任边界被绕走（channel 重新快手调 sniff / sharp） | 后续加功能时绕开 pipeline | code review 原则：单附件逻辑一律走 `processImageAttachment`；channel 只管协议、跨附件上限、错误码映射 |

---

## 4. 不在本文档范围

- **前端（chat.html）**：📎 按钮 / paste / drop / chip / base64 编码 / `attachment_resized` 消费 / image bubble 渲染 → 独立前端 PR
- **CliChannel 附件**：`@path` / `--attach` 语法 → Phase 2
- **Phase 2 全部**：document/PDF block、file source offload、OpenAI provider 适配、`attachmentScanHook`、resize 并发 semaphore

---

## 5. 合入顺序建议

```
PR-0 (constants + barrel) ─┬─→ PR-1 (sniff) ─┐
                           ├─→ PR-2 (sharp) ─┤→ PR-3 (attachment-pipeline) ─┐
                           └─→ PR-4 (model) ─────────────────────────────────┼→ PR-6 (channel)
                                              └→ PR-5 (compaction dehydrate)─┘
```

PR-0/1/2/4/5 可并行评审；PR-3 需 PR-1 / PR-2；PR-6 必须最后。每个 PR 单独 deployable（合入后服务不崩，新能力暂未开放），直到 PR-6 翻开开关。
