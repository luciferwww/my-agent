# 用户消息附件支持设计 Spec

## 背景

目前 my-agent 入站消息（CLI / WebSocket / 通过 `RunParams.message`）只接受 `string`，但底层数据模型（`adapters/llm` 的 `ChatContentBlock`、`core/session` 的 `ContentBlock`）已经支持 `image` block，落盘与 LLM 调用层都不需要重新设计。瓶颈在「入站协议是纯字符串」这一段。

为了让用户能在一条消息里携带图片附件（首版仅 image；PDF / 文本文件等未来需求未整理，Phase 2 再设计），本 spec 描述如何在不破坏现有压缩 / sanitize / session 持久化语义的前提下，最小化引入结构化消息体。

## 目标

- 让一条 user message 能携带 0 个或多个 image 附件（document / 文本片段后续扩展）
- 附件经过 LLM 调用、session 持久化、压缩、sanitize 全链路时行为可预测
- 与 Anthropic / OpenAI vision API 的「内容块数组」事实标准对齐
- 入站层（channel / chat.html）承担附件读取与编码，runner / session 不感知 transport 细节
- 单文件不破坏现有的 append-only JSONL 与 leaf 指针语义

## 非目标

- 不支持 assistant 输出图片（当前 Anthropic 不会主动产出，未来再说）
- 不支持 URL 引用（避免 fetch / SSRF / 凭证管理；由 client 端先拉好上传）
- 不为「批量分析 workspace 文件」服务——那类需求继续走 tool（read_file / search 等）
- 不实现跨 turn 的附件库 / 重新引用机制（附件的语义是「产生它的那一轮 user message 的输入」）
- 第一版不允许在 steering 消息里夹带附件（仅文本 steer，详见决策 6）
- **第一版仅 image**：PDF / document / text_file 等非图片附件类型推迟到 Phase 2
- 不实现 OCR 等服务端处理（让 LLM 自己看）

## 现状盘点

| 层 | 是否支持非文本 | 备注 |
|---|---|---|
| `adapters/llm` `ChatContentBlock` | ✅ | 已有 `image`（base64 source） |
| `core/session` `ContentBlock` | ✅ | 同上，shape 一致 |
| `MessageRecord.content` | ✅ | `string \| ContentBlock[]` |
| `RunParams.message` | ❌ | `string` |
| `ChannelRunRequest.message` | ❌ | `string` |
| WebSocket `run_turn.message` | ❌ | `string` |
| `chat.html` composer | ❌ | 只有 textarea |
| `estimatePromptTokens` | ⚠️ | image block 一律按常量 2000 计（无 dimensions 通路），所有图当成等大；其他未识别 block 落 default 返 0（当前 `ChatContentBlock` union 不含 document） |
| 压缩摘要 LLM 输入 | ⚠️ | 摘要 LLM 是文本模型，遇到 image block 当前没有降级路径 |
| 大图处理策略 | ❌ | 用户上传大图直接 inline 会让单条 entry 膨胀到几 MB；当前无任何大小约束 |

## 核心决策

### 决策 1：`message` 升级为 `string | ContentBlock[]`，不引入「正文 + 附件」二元结构

**采用 `ContentBlock[]`，不采用 `{ text: string; attachments: File[] }`**。

理由：

- Anthropic / OpenAI vision API 都把图片建模成 content array 里的 block，是事实标准
- 现有 `ContentBlock` / `ChatContentBlock` 已经是这个形状，runner 一行映射即可
- 「正文 + 附件」二元结构在多附件、文图混排（图 1 → 文字 → 图 2）等场景表达力差
- 与未来扩展（音频、文档块）方向一致

升级路径以「联合类型」限定 API 使用姿势：传入 `string` 是「纯文本消息」的语法糖，传入数组才走有附件的完整路径。两者类型上互为 union，调用方二选一；这不是为了兼容老 client，是为了避免「发一句 hi 也要包成 `[{type:'text',text:'hi'}]`」这种无所谓的 boilerplate。

### 决策 2：附件读取与 base64 编码发生在入站层，channel 协议透传 block 数组

WebSocket / 未来 HTTP channel 都把已经准备好的 ContentBlock 数组直接放进 `ChannelRunRequest.message`：

- WebSocket（Phase 1 唯一入站 channel）：浏览器端 `FileReader.readAsDataURL` → base64 → 直接放进 `image.source.data`
- CliChannel（Phase 2+）：计划通过 `@path/to/img.png` 语法或 `--attach` 参数读取本地文件转 base64；具体语法与多附件类型的交互待 Phase 2 一同设计
- 未来 HTTP/SSE channel：同一接口

> Channel 不做编解码、不做大小校验之外的语义转换；它仅校验形态（block 类型、必需字段）。

### 决策 3：runner / session 数据模型做最小必要扩展

- `core/session/types.ts` 与 `adapters/llm/types.ts` 的 `ContentBlock.image` 已支持 `base64` source；本 spec 只在 `ImageBlock` 上加一个可选的 `dimensions` 字段（见「内部 ContentBlock」小节），其余 shape 不变。`ImageSource` 故意保留联合类型写法，为 Phase 2 可能引入的 `file` source variant 预留扩展位
- 后续按需扩展：`document`（PDF）、`text_file`（短文本附件，可选——用 `text` block 也能表达）
- `RunParams.message` 类型放宽为 `string | ChatContentBlock[]`
- `ChannelRunRequest.message` 类型放宽为 `string | InboundContentBlock[]`（InboundContentBlock 是 ChatContentBlock 中允许 client 入站的子集，**不包括** `tool_use` / `tool_result` 这类只能由 runner 产生的 block）

### 决策 4：阈值三段——小图直接 inline，中等图 server-side resize 后 inline，超大图拒收

附件存储有三种候选：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. 全部 inline base64 进 JSONL** | 简单、自包含、append-only 不变；transcript 单文件可 replay | 单条 entry 几十 KB ~ 几 MB，累积可让 JSONL 暴增 |
| **B. 文件落 `workspace/<sessionKey>/attachments/<id>.<ext>`，JSONL 存路径句柄 + dispatch hydrate** | transcript 干净；与 session 同进退；可保留高分原图 | 多一层抽象；loadHistory 与 LLM 调用前需 hydrate；前端需独立 HTTP 路由取图；多出孤儿文件 / 路径逃逸 / hydrate 失败降级等风险 |
| **C. 内容寻址 `workspace/.attachments/<sha256>.<ext>`，JSONL 存 hash** | 跨 session 自动去重 | 跨 session 共享 → 删除策略复杂；权限边界模糊 |

**第一版采用 A + server-side resize，三段处理**：

| 解码后字节 | 处理 |
|---|---|
| ≤ `attachmentInlineThresholdBytes`（默认 2 MB） | 原图 base64 直接 inline 进 image block |
| `> 阈值 ≤ attachmentRawMaxBytes`（默认 10 MB） | server-side **两步 resize**（见下）压到 ≤ 2 MB → inline → emit `attachment_resized` 事件（含原 size / 后 size / 最终 max-side / 最终 quality） |
| > `attachmentRawMaxBytes` | 直接拒收 `channel_error: ATTACHMENT_TOO_LARGE`（避免 server 在垃圾大文件上做无意义功夫） |

**两步 resize 算法**（sharp，单次 metadata + 至多 N 次 encode）：

1. **Step A — 缩尺寸**：若 `max(width, height) > 2000`，按比例缩到长边 = 2000；否则跳过。统一转 JPEG（`mozjpeg: true`）。
2. **Step B — 降画质**：quality 按 `[85, 75, 65, 55, 45]` 顺序试编码，取第一个 ≤ 2 MB 的结果。
3. 全档位仍 > 2 MB → 抛错（极端罕见，超细节大图）。

> **为什么分两步而不是网格搜索 (size × quality)**：网格会跑出明显劣解。比如一张 4K 图，候选 `2000×1500 @ q45` 在三个维度上同时输给 `1568×1176 @ q80`——字节更多、本地 token 估算更高、Anthropic server 还会把它再缩到 1568，但 q45 的压缩痕迹消不掉。要剔除这种劣解就得写「质量评分函数」，主观且易调坏。两步法把尺寸当**约束**、画质当唯一**自由变量**——单维单调，第一个达标的就是最优解，没有评分函数。代价：典型只 encode 1-2 次（网格要 5-15 次）。

> **为什么 `MAX_SIDE = 2000`**：Anthropic vision API 自己会把图缩到模型上限再算 token——Sonnet 4.6 等主流模型 1568 px，Opus 4.7+ / Fable 5 / Mythos 5 是 2576 px。2000 这个值对 Sonnet 系 LLM 视角无差异（server 强制再缩到 1568，只是本地估算偏高 ~3×、量级正确不至于误发 Layer 2）；对 Opus 4.7+ 会主动降采样，若主要服务这类模型可调到 2576。第一版以兼容性最广的 2000 为默认。详细计费规则见 [Appendix A](#appendix-a-anthropic--openai-图片-token-计算参考)。

> **统一转 JPEG**：PNG 截图会有边缘 artifact，但对 LLM 识别影响小，省体积优先。HEIC 转换、EXIF 旋转等 openclaw 的复杂能力 phase 1 不做。

> **vs 方案 B/C**：选 A 砍掉了一整层 plumbing——`file` source variant、attachment-store 路径安全、`hydrateAttachmentsForDispatch`、`/attachment/<sessionKey>/<id>` 静态路由、孤儿文件清理；代价只是引入 `sharp` 与 ~15 行 resize 代码。C 的跨 session 去重价值不抵复杂度，暂缓。

落地形式：
- 新增 `src/core/media/image-optimize.ts`：sharp 两步处理（cap max-side 到 2000 → JPEG quality 线性降级），目标 ≤ 2 MB；
- channel 入站校验阶段：若解码字节 > 2 MB 且 ≤ 10 MB，调用 `image-optimize` 重写 `source.data`；
- resize 失败（损坏图 / 全档位仍超 2 MB）→ `channel_error: ATTACHMENT_RESIZE_FAILED`；
- 所有 image block 最终都是 `{ type: 'base64', media_type, data }`，session 持久化与 LLM 调用看到的是同一形态——**没有 dispatch hydrate 这一步**。

> **关于 Phase 2 升级路径**：当出现 (a) 用户提出「保留原图」需求；或 (b) JSONL 平均体积 > 50 MB 导致明显加载延迟，再引入 file source offload。届时改动是单向兼容的：`ImageSource` 联合体加 `file` variant、加 `hydrateAttachmentsForDispatch`、加 `/attachment/<...>` 端点。当前 spec 把 `ImageSource` 写成 union（而非裸 object）正是为此预留。

### 决策 5：image block 在估算与压缩中显式登记 token 占位

回答两个问题：**一张图占多少 token？** 和 **压缩历史时图怎么处理？**

- **算 token**：按 Anthropic patch 公式 `ceil(width/28) * ceil(height/28)`（每 28×28 像素 = 1 token，详见 [Appendix A](#appendix-a-anthropic--openai-图片-token-计算参考)）。`width × height` 在 channel 入站 sniff 时拿到、挂到内部 block 上；sniff 失败直接 `channel_error: IMAGE_METADATA_UNREADABLE`，到 Layer 2 不会有缺尺寸的 image。结合决策 4 的 max-side=2000，**单图 token 上界 = 72² = 5184**，封顶。

  > 注：本地按 max-side=2000 估算（72² = 5184），不同模型 server 端会再缩到自己 native cap 后计费（如 Sonnet 4.6 → 1568）。本地偏高方向上对 Layer 2 安全。

- **压缩历史时**：摘要 LLM 是文本模型，看不懂图。`compactMessages` 内部把 image block 临时换成文字 `[image: media_type=${block.source.media_type}, ~{n} tokens]` 喂给摘要模型，**session 持久化的原始 block 不动**。保留区天然护住最近几轮 user 图，第一版不加额外保护。
- **OpenAI provider** 接入时再按 model 分支（patch family `ceil(w/32)×ceil(h/32)×multiplier`，tile family `base+tiles×per_tile`），常量进 `compaction` config。

### 决策 6：附件不参与 steering（v1）

第一版禁止 steering 消息携带附件。理由：

- **快速插队体验差**：附件准备（client 端 FileReader → base64 → 入站 sniff → server resize）本身耗时；steering 的产品定位是「打断当前 turn、立刻让 LLM 看到新指令」，让用户先等几百 ms 才能 steer 不符合直觉
- **降低实现复杂度**：steering 注入路径目前只处理纯文本字符串（`appendInjectedMessages` 调用点位于工具循环中段），引入 ContentBlock 数组需要同步改 channel 校验 / inbox 类型 / runner 注入逻辑三处；与首版主流程价值不匹配
- **失败语义不易解释**：若 steering 注入后 turn 因 crash / context overflow 等异常中断，残留的 steering user 会在下次 run 进来时被 `sanitizeSessionTail` 剥离（这是 sanitize 的设计目的，正常路径不触发）。带附件的情况下「附件副本随分支被舍弃且 client 不会重发」对用户更难解释，第一版避开

入站校验：runtime 层在「正在跑 turn 时收到 run_turn」的 steering 路径上，若 message 是数组形态且包含非 text block，直接返回 channel_error。

### 决策 7：附件 ≠ workspace 资源访问

**原则**：能走 tool（path access、fetch URL）就走 tool，附件作为兜底。前提是 agent 真的够得着——本地部署够得着用户文件，云部署只够得着自己的临时目录和公网。

| 用户意图 | 本地部署 | 云部署 |
|---|---|---|
| 「看这张截图」（不在磁盘上） | ✅ 附件 | ✅ 附件 |
| 「分析这个项目代码」 | ✅ tool（`read_file` 等） | ✅ GitHub URL + fetch tool |
| 「分析我刚 push 的 PR」 | ✅ github tool / fetch tool | ✅ 同左 |
| 「这份本地 PDF 帮我总结」 | ✅ `read_pdf` tool | ✅ 附件（Phase 2 document block） |

**为什么优先 tool**：附件每次都把内容塞进 context，多轮对话会重复占 token；tool 是按需读取、读完即弃。本地能 tool 就 tool。

**附件什么时候不可替代**：截图 / 拍照这类「数据只在用户那边、agent 根本访问不到」的输入。云部署下，「本地文件」也归这类。

这是产品 / 文档约束，不在代码里强制——用户硬要把整个项目打包成附件传也能传（受大小限制）。

## 数据模型

### 入站 ContentBlock（client → channel → runtime）

入站协议仅允许 `base64` source（client 不直接构造 file path，避免路径注入）：

```ts
export type InboundContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string };
    };
// 后续按需扩展：
//   | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
//   | { type: 'text_file'; name: string; media_type: string; text: string }
```

### 内部 ContentBlock（channel resize 后 → runtime / session）

channel 在入站校验阶段：(a) 可能 resize `image` block 的 `source.data`；(b) sniff 出 `width × height` 写入 `dimensions`。换言之 **`dimensions` 是 internal-only 字段，wire schema (`InboundContentBlock`) 上没有，client 即使传也会被忽略**。以下是 runner / session / LLM adapter 看到的形状：

```ts
// 联合体形态保留，便于 Phase 2 加 file variant 时不破坏现有消费者
export type ImageSource =
  | { type: 'base64'; media_type: string; data: string };
  // Phase 2 可能：| { type: 'file'; media_type: string; path: string };

export interface ImageBlock {
  type: 'image';
  source: ImageSource;
  dimensions: { width: number; height: number }; // 入站 sniff 写入；sniff 失败则 channel 直接拒收，不会有没 dimensions 的 ImageBlock 进入 runtime。resize 后更新为新尺寸
}
```

`dimensions` 字段不参与 LLM 调用（送给 model 之前剥掉），仅用于 token 估算。

### `ChannelRunRequest`

```ts
export interface ChannelRunRequest {
  sessionKey: string;
  message: string | InboundContentBlock[];
  model?: string;
  maxTokens?: number;
  maxLlmCalls?: number;
  clientId?: string;
}
```

### `RunParams`

```ts
export interface RunParams {
  // ... 既有字段
  message: string | ChatContentBlock[]; // 之前是 string
}
```

`ChatContentBlock` 已存在，复用即可；runner 内部把它包进 `{ role: 'user', content }` 后，下游全链路（loadHistory / sanitize / compaction / LLM stream）已经接受 `ContentBlock[]`，零改动。

### WebSocket 协议升级

```ts
type ClientMessage =
  | { type: 'hello'; clientId: string }
  | {
      type: 'run_turn';
      sessionKey: string;
      message: string | InboundContentBlock[]; // ← 升级
      model?: string;
      maxTokens?: number;
      maxLlmCalls?: number;
    }
  | { type: 'approval_resolve'; id: string; decision: ApprovalDecision };
```

`message` 的 `string | InboundContentBlock[]` union 只是 API 使用姿势（纯文本不用包数组）；不是为了兼容老 client。本 spec 不考虑任何 backward compat，包括但不限于老格式 JSONL、老协议客户端、历史 image block 的 dimensions 缺失。

## 入站校验（必须有）

`channel` 收到 `run_turn` 时执行：

| 校验 | 默认值（可配置） | 失败时 |
|---|---|---|
| 单 attachment base64 解码后字节 | ≤ `attachmentRawMaxBytes`（10 MB） | `channel_error` code=`ATTACHMENT_TOO_LARGE` |
| 单条消息附件数 | ≤ 20（数组长度安检，防 `Array(1e6)` 这类病态输入） | `channel_error` code=`ATTACHMENT_LIMIT_EXCEEDED` |
| 单条消息总附件解码字节 | ≤ 10 MB（与 `maxPayload` 对齐的真实字节预算） | `channel_error` code=`ATTACHMENT_TOTAL_TOO_LARGE` |
| MIME 白名单 | image/png\|jpeg\|webp\|gif（Phase 1） | `channel_error` code=`UNSUPPORTED_MEDIA_TYPE` |
| Magic-bytes 校验 | image 类必须匹配 client 声明的 `media_type` | `channel_error` code=`MEDIA_TYPE_MISMATCH` |
| WebSocket frame 大小 | server 端 `maxPayload` 提升至 15 MB | 超过则 socket 自身关闭 |
| Resize 决策 | 解码字节 > `attachmentInlineThresholdBytes`（2 MB）→ 调用 `image-optimize` 两步压到 ≤ 2 MB（cap max-side=2000 → JPEG quality 线性降级）+ 更新 `dimensions` + emit `attachment_resized`；否则原样 inline | 全档位仍超阈值或 sharp 报错 → `channel_error: ATTACHMENT_RESIZE_FAILED` |
| 维度嗅探 | image 类必须 sniff 出 `width×height` 并写入 `dimensions` 字段 | sniff 失败（损坏头 / 不认识的变种格式）→ `channel_error: IMAGE_METADATA_UNREADABLE` |
| Steering 路径附件禁令 | 在「正在跑 turn 时收到 run_turn」的 steering 分支上，若 message 是数组且含非 text block | `channel_error` code=`STEERING_ATTACHMENT_FORBIDDEN`（详见决策 6） |

> 全部错误以 `channel_error` 形式返回；不开新错误协议。具体 code 加入 `ChannelErrorCode` 联合体。

注意 WebSocket 默认 frame 上限通常是 1 MB，必须显式调高。`maxPayload` 是 **整条 message** 的上限（`ws` 库会自动分帧重组），不是单帧上限。

**上限对齐推导**：
- 单条总附件解码 10 MB × 1.35 (base64) ≈ 13.5 MB 文本 + JSON wrap + 其他字段 ≈ 14–15 MB → frame `maxPayload` 15 MB 刚好装下
- 「单文件 ≤ 10 MB × 20 个」是数组长度安检；实际上限由「单条总附件 ≤ 10 MB」锁死（一条消息里 20 张 2 MB 图 > 10 MB 总额，会被 `ATTACHMENT_TOTAL_TOO_LARGE` 拦住）
- 若未来需要同时携带更多附件，总阈值应与 `maxPayload` 同步上调

## 安全考虑

- **Prompt injection**：附件中提取的文本（图片里的文字；Phase 2 起含 PDF 内容）应被视为不可信输入，**不得**被拼接进 system prompt 或工具的 input 字段。LLM 自身处理 untrusted content 的能力 + 现有 hook 是首要防线
- **Magic-bytes**：服务端对 image 做最低成本的 sniff（前 8 字节），media_type 与实际不符直接拒
- **病毒扫描钩子**：在校验流程里预留一个 `attachmentScanHook`（默认 noop），让部署方按需接入扫描器
- **日志脱敏**：base64 内容**不进** logger / event；事件流里只记 `attachmentCount`、`totalBytes`、`mediaTypes`
- **Workspace 隔离**：附件不写入 workspace 根目录，与 tool 的文件写入路径互不重叠

## 上下文管理交互

### Layer 1（pruneToolResults）

不动。它只裁剪 tool_result content，与 user image 无关。

### Layer 2（checkContextBudget）

现有 `estimateBlockTokens`（`src/core/runner/context/token-estimation.ts`）对 `image` 返回常量 `IMAGE_TOKEN_ESTIMATE = 2000`，本 spec 把它换成 patch 公式；`dimensions` 是强制字段（sniff 失败 → channel 拒收），这里不需要 fallback：

```ts
function estimateBlockTokens(block: ChatContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);
    case 'image':
      // Anthropic patch 公式：每个 28×28 patch = 1 visual token
      return Math.ceil(block.dimensions.width / 28) * Math.ceil(block.dimensions.height / 28);
    case 'tool_use':
    case 'tool_result':
      return /* 既有路径不动、代码省略 */ 0;
    default:
      return 0;
  }
}
```

> `block.dimensions` 不可空。原有的常量 `IMAGE_TOKEN_ESTIMATE = 2000` 随本次改造一起删除。

> `estimateBlockTokens` 不读 `source.data` 长度（base64 体积与实际 token 没有线性关系）。

> Phase 2 加 document block 时再扩 switch 与 `ChatContentBlock` union。当前不动 `default` 分支。

具体常量进 `compaction` config，便于按模型调整。

### Layer 3（compactMessages）

摘要 LLM 是文本模型。在送给摘要 LLM 前，对 messages 做一遍 `dehydrateForSummary`：

- `image` block → `text { text: '[image: media_type=${block.source.media_type}, ~{n} tokens]' }`（`{n}` 是 `estimateBlockTokens(block)` 的 patch 公式值）
- 其他 block 不变（Phase 2 加 document 时同理扩展）

这一步只发生在「送给摘要 LLM 的临时副本」，**不影响**：

1. session 持久化的原始 entry
2. `firstKeptEntryId` 截断后保留区里的真实 image block（保留区不进摘要 LLM）
3. 下次 `loadHistory` 加载到的内容

### Dispatch（送给主 LLM 之前）

Phase 1 **不存在 hydrate 这一步**——所有 `image.source` 都是 `base64`，直接送 LLM 即可。`dimensions` 字段在送 LLM 之前剥掉（既有 adapter 已只读 `type` / `source`，保留 `dimensions` 也不影响，但建议显式 strip 以减少 wire payload）。

> Phase 2 若加 `file` source variant，需在 LLM adapter 包装层增加一个 `hydrateAttachmentsForDispatch`：读盘 → 转 base64 → 临时替换；失败降级为 text 占位 + emit `attachment_hydrate_failed`。当前 spec 不实现。

### `sanitizeSessionTail`

不动。它只看 `role === 'user'`，被剥离的 entry 仍在 JSONL 中可审计。带附件的孤立 user 被清洗时，附件 base64 跟着脱离当前分支——这是预期行为。

## 客户端（chat.html）改动概要

不属于 spec 主体，只列要点：

- composer 加 📎 按钮 → `<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif">`（Phase 1 仅 image；Phase 2 加 PDF / text）
- 选好的文件在 textarea 上方以 chip 展示（图片缩略图用 `URL.createObjectURL`，后续 PDF / text 显示文件名 + 大小）
- 发送时 `FileReader.readAsDataURL` 转 base64，构造 `InboundContentBlock[]`
- 实时显示已选附件总字节数；超 `attachmentRawMaxBytes` 时禁用 Send 并提示「单图最大 10 MB，请压缩后重传」
- 前端不做 token 估算（估出来用户也无法对照 server Layer 2 budget，避免前后端两套常量同步负担）；chat.html 与后端共享 `src/core/media/constants.ts` 仅用于 MIME 白名单 / 大小阈值这类「前后端都需要」的常量（构建脚本注入或 `/static/media-constants.json` fetch）。`PATCH_SIZE` 这类只后端估算需用的常量不走共享路径
- 服务端 resize 后通过 `attachment_resized` 事件回传「原 size → 后 size / quality」，前端可在对应 chip 上展示「已压缩 4.2 MB → 1.8 MB」标记，让用户知情
- 拖拽 / 粘贴：textarea 监听 `paste` / `drop`，直接接图片
- user bubble 在 chat 流里渲染 image block：`source.type === 'base64'` 直显 `<img src="data:...">`（Phase 1 所有 image 都是 base64）
- 旧 message 流（纯文本）不受影响

## 验收标准

### 单元测试

| 用例 | 期望 |
|---|---|
| `RunParams.message` 为 string | 与改造前行为完全一致 |
| `RunParams.message` 为 `[{type:'text', ...}, {type:'image', ...}]` | session 写入 ContentBlock[]，LLM 调用 messages 包含 image block |
| `estimatePromptTokens` 包含带 dimensions 的 image block | 返回值 ≈ 文本 token + ceil(w/28) × ceil(h/28) |
| `compactMessages` dehydrate | 送给摘要 LLM 的 messages 中无 image block；session 原始 entry 不变 |
| `sanitizeSessionTail` 末尾是带 image 的孤立 user | 正常剥离（branch 回 parentId），emit `session_tail_sanitized` |
| Channel 校验：单文件 > `attachmentRawMaxBytes`（10 MB） | 返回 `channel_error: ATTACHMENT_TOO_LARGE`，session 未写入 |
| Channel 校验：MIME 不在白名单 | 返回 `channel_error: UNSUPPORTED_MEDIA_TYPE` |
| Channel 校验：魔数 magic-bytes mismatch | 返回 `channel_error: MEDIA_TYPE_MISMATCH` |
| Channel resize：解码字节 ∈ (2 MB, 10 MB] 的 image | 调用 `image-optimize` 成功压到 ≤ 2 MB，`source.data` 被替换为 JPEG base64，`dimensions` 更新为新尺寸，emit `attachment_resized`（含 from/to bytes、side、quality） |
| Channel resize：损坏图或全档位仍超 2 MB | 返回 `channel_error: ATTACHMENT_RESIZE_FAILED`，session 未写入 |
| Channel 维度嗅探失败（损坏头 / 不认识的变种格式） | 返回 `channel_error: IMAGE_METADATA_UNREADABLE`，session 未写入 |
| Steering 路径携带附件 | 返回 `channel_error: STEERING_ATTACHMENT_FORBIDDEN` |

### 集成测试

| 用例 | 期望 |
|---|---|
| 浏览器发小图（≤ 2 MB）→ run_turn 完整跑通 | LLM 收到 image，session JSONL 有 inline base64 image entry，下次连接重放历史时 image bubble 正常渲染 |
| 浏览器发中等图（2-10 MB）→ run_turn 完整跑通 | 服务端 resize 后 `source.data` ≤ 2 MB；前端收到 `attachment_resized` 事件并在 chip 上展示「原 size → 压缩后 size」；JSONL 写入 resize 后的 base64；LLM 收到 resize 后的 base64 |
| 浏览器发超大图（> 10 MB） | 收到 `channel_error: ATTACHMENT_TOO_LARGE`，session 未写入 |
| 同 session 发 image 后触发压缩 | 压缩成功，摘要文本包含「曾发送 1 张图片」类提示，session 摘要后保留区仍含原始 image |
| 同时跨多 session 并发上传图片 | 入站队列正常调度，无串扰；sharp 并发不互相阻塞（必要时加 semaphore） |
| 重连场景：断线后重连，前一条带图 user message 被重新加载到 chat.html | UI 能渲染 image bubble |

### 不应破坏的现有行为

- 纯文本 user message 路径无任何延迟 / token 估算回归
- 既有 sanitize / compaction / approval / steering 行为不变

## 实施计划

按价值递减排序：

0. **`src/core/media/constants.ts` + `index.ts` barrel**（独立可提交，零依赖）
   - 共享常量（跨模块·含前后端）：`ATTACHMENT_INLINE_THRESHOLD_BYTES = 2 MB`、`ATTACHMENT_RAW_MAX_BYTES = 10 MB`、`ATTACHMENT_TOTAL_MAX_BYTES = 10 MB`、`MAX_ATTACHMENTS_PER_MESSAGE = 20`、`WS_MAX_PAYLOAD_BYTES = 15 MB`、`SUPPORTED_IMAGE_MIME` 白名单
   - **不进共享常量**：`MAX_SIDE_PX = 2000`、`JPEG_QUALITY_STEPS = [85,75,65,55,45]` 是 resize 内部决策，前端不需要知道 → 放 `image-optimize.ts` 内部常量
   - **provider-specific 常量也不进**：`PATCH_SIZE = 28`（Anthropic）/ OpenAI 32 / multiplier / tile 进 `compaction` config 按 provider × model 维护（见决策 5 的 provider 适配 TODO）
   - `index.ts` barrel 统一导出 `constants` / `sniffImage` / `optimizeImage` / `processImageAttachment`
   - 前端复用方式：构建脚本注入到 bundle，或暴露成 `/static/media-constants.json` 由前端 fetch
   - **约定**：任何用到这些数值的地方禁止直接写魔法数
1. **image-metadata 嗅探模块**（独立可提交，零依赖）
   - 新增 `src/core/media/image-metadata.ts`，sniff PNG / JPEG / WebP / GIF 头部，提取 `width × height` 与 magic-bytes 校验
   - 返回 discriminated union `SniffResult = { ok: true, metadata } | { ok: false, reason }`；不抛异常
   - 端口自 openclaw `src/media/image-ops.ts` 的轻量部分（不包含 sharp / resize）
   - 具体 variant 覆盖范围（GIF87a/89a、WebP VP8/VP8L/VP8X 动图取首帧、APNG 取首帧、JPEG SOF0/SOF2、是否应用 EXIF orientation 交换 w/h 等细节）在该 PR 里明确并补测试，避免「肉眼是 PNG 却被拒」这类坑
2. **image-optimize 模块**（引入 sharp 依赖）
   - 新增 `src/core/media/image-optimize.ts`：两步算法（Step A: cap max-side 到 2000；Step B: JPEG quality 按 `[85,75,65,55,45]` 线性降级），目标 ≤ 2 MB；统一输出 JPEG（`mozjpeg: true`）
   - 返回 discriminated union `OptimizeResult = { ok: true, ... } | { ok: false, reason }`；不抛异常
   - `package.json` 加 `sharp` dependency（与现有 `better-sqlite3` 同档原生模块；部署文档补 Alpine `apk add vips` 等环境说明）
   - 比 openclaw 的双层网格更线性：典型情况只需 1-2 次 encode（详见决策 4「两步 resize 算法」）
3. **attachment-pipeline 单附件编排**（独立可提交）
   - 新增 `src/core/media/attachment-pipeline.ts`，导出 `processImageAttachment(rawBytes, declaredMime)`：串起 MIME 白名单 → sniff → resize 决策
   - 返回 discriminated union `AttachmentResult`，`reason` 用中性词汇（`unsupported_mime` / `mime_mismatch` / `metadata_unreadable` / `resize_failed`），不耦合 channel 层错误码
   - 动机：channel 只管协议层（数组长度、跨附件总量、steering 禁令、`channel_error` 错码映射）；「单张图怎么变成 ImageBlock」是 media 层纯函数，便于单测与未来 HTTP channel 复用
4. **数据模型 + token 估算 + image 维度**（一次合并提交）
   - `ImageBlock` 加 `dimensions` 必选字段（internal-only，wire 上不带，channel 入站 sniff 后写入；详见数据模型节）；`ImageSource` 保留联合类型写法（当前只有 `base64` variant）
   - `estimateBlockTokens` 的 `case 'image'` 从返回常量 2000 改为 patch 公式；同时删除 `IMAGE_TOKEN_ESTIMATE` 常量
   - `estimatePromptTokens` 的 `currentPrompt` 参数类型放宽为 `string | ChatContentBlock[]`，因为 `AgentRunner.runAttempt` 在 `checkContextBudget` 之后才 append user 消息（`AgentRunner.ts:259/293`），本次 user message 的附件 token 必须通过 `currentPrompt` 参数算进去
5. **剩余入站接口扩展**
   - `RunParams.message` / `ChannelRunRequest.message` 类型扩展为 `string | ChatContentBlock[]`
   - WebSocket 协议升级（请求负载型 union，server 端 `maxPayload` 调高到 15 MB）
6. **入站校验 + resize 编排**
   - channel 调用 `processImageAttachment` 处理单张图；自己负责数组长度、跨附件总字节、steering 禁令、AttachmentRejection → ChannelErrorCode 映射、`attachment_resized` 事件 emit
7. **Layer 3 dehydrate 摘要 LLM 输入**
8. **chat.html 端到端跑通图片**
   - 浏览器端 FileReader + paste / drop
   - chip 展示「原 size → resize 后 size」（消费 `attachment_resized` 事件）
   - user bubble 渲染 base64 image
9. **PDF document block + `estimateBlockTokens` document case**（Phase 2，含扩展 `ChatContentBlock` union）
10. **CliChannel 附件支持**（Phase 2+）
    - `@path` / `--attach` 语法与多附件类型的交互一起设计；Phase 1 CLI 仅走纯文本路径
11. **File source offload**（Phase 2，按需触发）
    - 触发条件：JSONL 体积观察值超阈值 或 出现「保留原图」需求
    - 新增 attachment-store、`hydrateAttachmentsForDispatch`、`/attachment/<sessionKey>/<id>` 路由；`ImageSource` 加 `file` variant

step 0-3 与主流程解耦，可以独立合入；4-8 是 MVP；9-11 后续。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| WebSocket frame 上限默认 1 MB，第一次跑就被截断 | server 端 `maxPayload` 必须显式提到至少 15 MB 并写进 spec / 配置默认值 |
| Token 占位估算偏差导致预判过严 / 过松 | 维度嗅探让估算贴近真实值；常量进 `compaction` config；事件流加 `attachment_token_estimate` 观测点 |
| JSONL 文件因 base64 累积膨胀 | 单图上限 2 MB（resize 后）+ 单条消息 20 张上限；预期典型 session 不会超 50 MB。若观察值超阈值再启动 Phase 2 file offload |
| `sharp` 在 Alpine / 受限环境装失败 | 部署文档明示与 `better-sqlite3` 同档处理（`apk add vips-dev` 或 `pnpm install --build-from-source`）；包管理器在 `onlyBuiltDependencies` 白名单加 `sharp` |
| Resize 失败（损坏图 / 全档位仍超 2 MB） | 返回 `channel_error: ATTACHMENT_RESIZE_FAILED`，让用户在前端看到明确提示；不静默吞掉 |
| Resize 阻塞 event loop / 并发竞争 | sharp 本身释放 GIL；典型情况只需 1-2 次 encode；若观察到大并发上传时延迟明显，加 semaphore 限制同时 resize 数（Phase 2 优化） |
| PNG 截图被强转 JPEG 出现边缘 artifact | 文档明示「resize 后统一 JPEG」；前端在 chip 上展示「已压缩」标记；Phase 2 可按需对 PNG 走「仅 resize 不转码」路径（quality 降级只为 JSONL 体积，与 LLM 信息量无关，所以 PNG 路径理论上可保留无损） |
| Prompt injection（图内 OCR 文字；Phase 2 起含 PDF 内文字） | 附件文本仅作为 user content 进 LLM，不进 system prompt / tool input；hook 系统已具备拦截能力 |
| 摘要 LLM dehydrate 漏掉某种 block 类型 | 在 dehydrate 函数里对未识别 block 主动抛错，新增 block 时强制开发者更新 |
| 附件被 `sanitizeSessionTail` 清掉时用户感觉「丢了」 | 文档明确「孤立 user 的语义包含其附件」；前端在 send 失败时保留 chip，让用户重发 |

## Appendix A：Anthropic / OpenAI 图片 Token 计算参考

本附录整理两家 vision API 的 token 计费规则，作为决策 4（resize 阈值选择）和决策 5（`estimateBlockTokens`）的事实依据。Anthropic 文档：<https://platform.claude.com/docs/en/build-with-claude/vision>；OpenAI 文档：<https://developers.openai.com/api/docs/guides/images-vision>。

### A.1 Anthropic Claude（patch-based，统一算法）

**公式**：tokens = ⌈w / 28⌉ × ⌈h / 28⌉（每个 28×28 像素 patch = 1 visual token）

**预处理**：超限时 server 自动 resize 到「同时满足边长上限 + token 上限」的最大保形尺寸，再向右/下 pad 到 28 倍数（pad 不计 token）。调用方**无法**控制 resize 行为。

**模型上限**：

| 模型族 | 长边上限 | token 上限 |
|---|---|---|
| Sonnet 4.6 等主流模型 | 1568 px | 1568 |
| Opus 4.7 / 4.8 / Fable 5 / Mythos 5 | 2576 px | 4784 |

**典型尺寸 token 数**（Sonnet 系）：

| 像素 | tokens |
|---|---|
| 200×200 | 64 |
| 1000×1000 | 1296 |
| 1920×1080 | 1560（已被下采到 1456×819） |
| 3840×2160 | 1560（同上，超出长边的部分被丢弃） |

### A.2 OpenAI（双算法，按模型族分支）

#### A.2.1 Patch-based（GPT-5.x、GPT-4.1-mini/nano、o4-mini）

**公式**：tokens = ⌈w / 32⌉ × ⌈h / 32⌉ × multiplier

**预处理**：超 patch 预算时按 `shrink_factor = sqrt(32² × budget / (w×h))` 等比缩放。

| 模型 | patch 预算 | 长边 | multiplier |
|---|---|---|---|
| GPT-5.5（`detail: high`） | 2,500 | 2048 | 1.0 |
| GPT-5.5（`detail: original`） | 10,000 | 6000 | 1.0 |
| GPT-5-mini / GPT-4.1-mini | 1,536 | 2048 | 1.62 |
| GPT-5-nano / GPT-4.1-nano | 1,536 | 2048 | 2.46 |
| o4-mini | 1,536 | 2048 | 1.72 |

#### A.2.2 Tile-based（GPT-4o、GPT-4.1、o1/o3 等老模型）

- `detail: low` → 固定 base token（GPT-4o：85）
- `detail: high`：① fit 进 2048×2048；② 短边缩到 768 px；③ 数 512×512 tile；④ tokens = base + tiles × per_tile（GPT-4o：85 + 170×tiles）

#### A.2.3 关键差异

OpenAI 暴露 `detail`（`low` / `high` / `original` / `auto`）让调用方控制精度；Anthropic 不允许调用方控制。

### A.3 与 my-agent spec 的关联

1. **token 数只取决于像素尺寸**——与文件字节、JPEG quality、PNG/WebP 格式无关。这正是决策 4「quality 降级只为 JSONL 体积、与 LLM 信息量无关」的根据，对 Anthropic 与 OpenAI 同时成立。
2. **`MAX_SIDE = 2000` 的语义因模型而异**：
   - Sonnet 4.6 等主流 Claude：原生上限 1568，my-agent 缩到 2000 后 server 还会强制再缩到 1568——**LLM 视角无差异**，仅本地 token 估算偏高 ~3×（量级正确，不至于误发 Layer 2）
   - Opus 4.7+ / Fable 5 / Mythos 5：原生上限 2576，2000 px **会主动降采样**——可接受（仍远高于绝大多数截图分辨率），但若主要服务这类模型可调高到 2576
   - OpenAI patch-family：原生上限 2048（`detail: high`），2000 px ≈ 持平；`detail: original` 才到 6000，my-agent 当前不主动选择 detail，依赖默认
3. **第一版 `estimateBlockTokens` 仅按 Anthropic patch 公式**。OpenAI adapter 接入时按 A.2 分支扩展，常量与 multiplier 进 `compaction` config。
