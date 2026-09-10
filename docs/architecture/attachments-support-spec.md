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

- `core/session/types.ts` 与 `core/model-invocation/types.ts` 的 `ContentBlock.image` / `ChatContentBlock.image` 已支持 `base64` source；本 spec 只在 `ImageBlock` 上加一个**必选的** `dimensions` 字段（internal-only，wire 上不带，runtime dispatch 阶段由 media pipeline sniff 写入；sniff 失败的附件被丢弃，故内部不会出现缺 `dimensions` 的 image，详见「内部 ContentBlock」小节），其余 shape 不变。`ImageSource` 故意保留联合类型写法，为 Phase 2 可能引入的 `file` source variant 预留扩展位
- 后续按需扩展：`document`（PDF）、`text_file`（短文本附件，可选——用 `text` block 也能表达）
- `RunParams.message` 类型放宽为 `string | ChatContentBlock[]`
- `ChannelRunRequest.message` 类型放宽为 `string | InboundContentBlock[]`（InboundContentBlock 是 ChatContentBlock 中允许 client 入站的子集，**不包括** `tool_use` / `tool_result` 这类只能由 runner 产生的 block）

### 决策 4：阈值三段——小图直接 inline，中等图 server-side resize 后 inline，超大图丢弃

附件存储有三种候选：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. 全部 inline base64 进 JSONL** | 简单、自包含、append-only 不变；transcript 单文件可 replay | 单条 entry 几十 KB ~ 几 MB，累积可让 JSONL 暴增 |
| **B. 文件落 `workspace/<sessionKey>/attachments/<id>.<ext>`，JSONL 存路径句柄 + dispatch hydrate** | transcript 干净；与 session 同进退；可保留高分原图 | 多一层抽象；loadHistory 与 LLM 调用前需 hydrate；前端需独立 HTTP 路由取图；多出孤儿文件 / 路径逃逸 / hydrate 失败降级等风险 |
| **C. 内容寻址 `workspace/.attachments/<sha256>.<ext>`，JSONL 存 hash** | 跨 session 自动去重 | 跨 session 共享 → 删除策略复杂；权限边界模糊 |

**第一版采用 A + server-side resize，三段处理**：

| 解码后字节 | 处理 |
|---|---|
| ≤ `ATTACHMENT_INLINE_THRESHOLD_BYTES`（默认 2 MB） | 原图 base64 直接 inline 进 image block |
| `> 阈值 ≤ ATTACHMENT_RAW_MAX_BYTES`（默认 10 MB） | server-side **两步 resize**（见下）压到 ≤ 2 MB → inline（**静默成功，不发任何事件**） |
| > `ATTACHMENT_RAW_MAX_BYTES` | media pipeline 返回 `{ ok: false, reason: 'too_large' }`，runtime **丢弃该附件**（避免 server 在垃圾大文件上做无意义功夫），消息其余内容照常处理 |

**两步 resize 算法**（sharp，单次 metadata + 至多 N 次 encode）：

1. **Step A — 缩尺寸**：若 `max(width, height) > 2000`，按比例缩到长边 = 2000；否则保持原尺寸。无论是否缩放，统一转码为 JPEG（`mozjpeg: true`）。
2. **Step B — 降画质**：quality 按 `[85, 75, 65, 55, 45]` 顺序试编码，取第一个 ≤ 2 MB 的结果。
3. 全档位仍 > 2 MB → 报错（触发条件：原图长边 ≤ 2000 且 quality 45 的 JPEG 仍 > 2 MB，极高熵的小尺寸图，实际几乎不会出现）。

> **为什么分两步而不是网格搜索 (size × quality)**：网格会跑出明显劣解。比如一张 4K 图，候选 `2000×1500 @ q45` 在三个维度上同时输给 `1568×1176 @ q80`——字节更多、本地 token 估算更高、Anthropic server 还会把它再缩到 1568，但 q45 的压缩痕迹消不掉。要剔除这种劣解就得写「质量评分函数」，主观且易调坏。两步法把尺寸当**约束**、画质当唯一**自由变量**——单维单调，第一个达标的就是最优解，没有评分函数。代价：典型只 encode 1-2 次（网格要 5-15 次）。

> **为什么 `MAX_SIDE = 2000`**：Anthropic vision API 自己会把图缩到模型上限再算 token——Sonnet 4.6 等主流模型 1568 px，Opus 4.7+ / Fable 5 / Mythos 5 是 2576 px。2000 这个值对 Sonnet 系 LLM 视角无差异（server 强制再缩到 1568，只是本地估算上界偏高 ~3×、典型截图 ~2×，量级正确不至于误发 Layer 2）；对 Opus 4.7+ 会主动降采样，若主要服务这类模型可调到 2576。第一版以兼容性最广的 2000 为默认。详细计费规则见 [Appendix A](#appendix-aanthropic--openai-图片-token-计算参考)。

> **统一转 JPEG**：PNG 截图会有边缘 artifact，但对 LLM 识别影响小，省体积优先。HEIC 转换、EXIF 旋转等 openclaw 的复杂能力 phase 1 不做。

> **透明图（RGBA / 32-bit）处理**：LLM vision encoder 只接受 RGB、不感知 alpha——任何带透明通道的图在送模型前都会被合成到某个背景色上。两条路径行为不一致：
> - **resize 路径（JPEG）**：JPEG 无 alpha，sharp 转码时**默认黑底**合成。本 spec 显式 `flatten` 到**白底**（`#ffffff`，模块内常量 `FLATTEN_BACKGROUND`，留改色口子）。选白底因为：vision encoder 训练分布偏白底素材（图标 / logo / UI 切图多为浅底）、透明图前景多为深色（白底对比度更高、深线条不会糊进黑底）、且对齐浏览器对透明 PNG 的默认呈现。
> - **inline 路径（≤2MB，原样 PNG）**：保留 alpha 送 provider，**不转码**，背景如何合成由各厂商决定，无跨厂商保证，可能与 JPEG 路径的白底不一致。
>
> Phase 1 取舍：仅在 resize 路径强制白底 flatten；小图 PNG 维持原样（实现最简，且小图多为照片类无 alpha）。已知不一致：同一张透明 PNG，≤2MB 版本送带 alpha 的 PNG、2–10MB 版本送白底 JPEG，透明区呈现可能不同。若日后要求「所有透明图呈现一致」，再把 flatten 前移到所有 image 的入站统一步骤（代价：小图也丢 alpha，但对 LLM 识别无损）。

> **vs 方案 B/C**：选 A 砍掉了一整层 plumbing——`file` source variant、attachment-store 路径安全、`hydrateAttachmentsForDispatch`、`/attachment/<sessionKey>/<id>` 静态路由、孤儿文件清理；代价只是引入 `sharp` 与 ~15 行 resize 代码。C 的跨 session 去重价值不抵复杂度，暂缓。

落地形式：
- 新增 `src/core/media/image-optimize.ts`：sharp 两步处理（cap max-side 到 2000 → JPEG quality 线性降级），目标 ≤ 2 MB；
- runtime dispatch 在 media 校验阶段调 `processImageAttachment`：若解码字节 > 2 MB 且 ≤ 10 MB 即触发 `image-optimize`，成功则重写 `source.data` 与 `dimensions`；
- resize 失败（损坏图 / 全档位仍超 2 MB）→ media pipeline 返回 `{ ok: false, reason: 'resize_failed' }`，runtime **丢弃该附件**，消息其余内容照常处理；
- 所有 image block 最终都是 `{ type: 'base64', media_type, data }`，session 持久化与 LLM 调用看到的是同一形态——**没有 dispatch hydrate 这一步**。

> **关于 Phase 2 升级路径**：当出现 (a) 用户提出「保留原图」需求；或 (b) JSONL 平均体积 > 50 MB 导致明显加载延迟，再引入 file source offload。届时改动是单向兼容的：`ImageSource` 联合体加 `file` variant、加 `hydrateAttachmentsForDispatch`、加 `/attachment/<...>` 端点。当前 spec 把 `ImageSource` 写成 union（而非裸 object）正是为此预留。

### 决策 5：image block 在估算与压缩中显式登记 token 占位

回答两个问题：**一张图占多少 token？** 和 **压缩历史时图怎么处理？**

- **算 token**：按 Anthropic patch 公式 `ceil(width/28) * ceil(height/28)`（每 28×28 像素 = 1 token，详见 [Appendix A](#appendix-aanthropic--openai-图片-token-计算参考)）。`width × height` 在 runtime dispatch 阶段由 media pipeline sniff 出、挂到内部 block 上；sniff 失败由 media pipeline 返回 `{ ok: false, reason: 'metadata_unreadable' }`，runtime **丢弃该附件**——所以「到 Layer 2 不会有缺尺寸的 image」这一不变量靠**丢弃**而非拒收来保证。结合决策 4 的 max-side=2000，**单图 token 上界 = 72² = 5184**，封顶。

  > 注：本地按 max-side=2000 估算（72² = 5184），不同模型 server 端会再缩到自己 native cap 后计费（如 Sonnet 4.6 → 1568）。本地偏高方向上对 Layer 2 安全。

- **压缩历史时**：摘要 LLM 是文本模型，看不懂图。`compactMessages` 内部把 image block 临时换成文字 `[image: media_type=${block.source.media_type}, ~{n} tokens]` 喂给摘要模型，**session 持久化的原始 block 不动**。保留区天然护住最近几轮 user 图，第一版不加额外保护。
- **OpenAI provider** 接入时再按 model 分支（patch family `ceil(w/32)×ceil(h/32)×multiplier`，tile family `base+tiles×per_tile`），常量进 `compaction` config。

### 决策 6：附件不参与 steering（v1）

第一版禁止 steering 消息携带附件。理由：

- **快速插队体验差**：附件准备（client 端 FileReader → base64 → 入站 sniff → server resize）本身耗时；steering 的产品定位是「打断当前 turn、立刻让 LLM 看到新指令」，让用户先等几百 ms 才能 steer 不符合直觉
- **降低实现复杂度**：steering 注入路径目前只处理纯文本字符串（`appendInjectedMessages` 调用点位于工具循环中段），引入 ContentBlock 数组需要同步改 runtime 校验 / inbox 类型 / runner 注入逻辑三处；与首版主流程价值不匹配
- **失败语义不易解释**：若 steering 注入后 turn 因 crash / context overflow 等异常中断，残留的 steering user 会在下次 run 进来时被 `sanitizeSessionTail` 剥离（这是 sanitize 的设计目的，正常路径不触发）。带附件的情况下「附件副本随分支被舍弃且 client 不会重发」对用户更难解释，第一版避开

这条规则在 runtime dispatch 里实现：检测到 message 是数组且含非 text block、且该 session 处于 steering 条件时，**剥离掉这些非 text block（连同其 sniff / resize 结果一并丢弃），仅用文本部分照常 steer**；若剥离后文本为空，则按「空消息」规则处理（见决策 8）。不另外拒收、不通知——与「失败附件直接忽略」保持同一套语义。channel 不参与此判断——所有 message 一律送到 runtime，是否是 steering 是 runtime 对当前 session 状态的认知。

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

### 决策 8：失败附件直接丢弃 + 空消息占位（学习 openclaw）

**核心选择**：附件处理失败**不阻断本次对话**，也**不向 client 推送任何拒收事件**——失败的附件被静默丢弃，消息其余内容（文本 + 处理成功的附件）照常进入 turn。这与 openclaw 的生产做法一致（`monitor-processing.ts`：附件过大 / 下载失败时 `continue`，仅 `logVerbose`，turn 用剩余内容继续）。

**为什么不做拒收 / 通知投递**：

- `RuntimeEvent` 在生产 server 里根本没被订阅（`server.ts` 的 `RuntimeApp.create({...})` 既没接 `onEvent` 也没接 `onAgentEvent`），它只是 host 进程可观测信号，推不到前端
- `AgentEvent` 每个 variant 都强制要求 `turnId`，而附件校验发生在 turn 启动**之前**（`turnId` 由 `startQueuedTurn` 出队时才 `randomUUID()` 生成），此刻没有 `turnId` 可填；为了发一条拒收而伪造 turn 是反模式
- 让失败「悄悄丢弃 + 一条文本提示」既不引入新的投递通道，又能让用户从对话流里知情，复杂度最低

**丢弃 + 占位规则**（在 runtime dispatch 的 intake 装配阶段执行）：

1. media pipeline 对每个附件独立判定：成功 → 保留（中等图压缩后 inline）；失败（`too_large` / `metadata_unreadable` / `mime_mismatch` / `unsupported_mime` / `resize_failed`）→ 记一条 drop record（含 `blockIndex` / `reason`），**不抛异常、不发事件**
2. 若本条消息有任何 drop 且开关 `ATTACHMENT_DROP_NOTICE`（**默认开**，可配置关）为开：在消息文本尾部追加一行系统提示，例如 `\n\n[系统提示：N 个附件因无法处理已忽略]`
3. 若丢弃后消息正文为空（纯坏附件、没有文本）→ 用占位文本作为整条正文：`[系统提示：N 个附件因无法处理已忽略]`，保证送进 runner 的 user message 非空
4. 若连占位都为空（既无文本也无附件的退化输入）→ 直接 skip，不入队、不写 session
5. 否则照常走既有 `runTurn` / steering 路径，runner 完全无感

> **与 openclaw 对齐**：openclaw 用 `text || placeholder`（`text` 为空时回落到占位）保证 body 非空，`if (!rawBody) return` 仅在占位也为空时丢弃整条。本 spec 第 3、4 步是同一套边界规则。

> **resize 成功是静默的**：中等图压缩成功不再发 `attachment_resized` 事件——前端若要展示「已压缩」可在客户端本地根据自己上传的原始大小推断，不依赖 server 回传。`AgentEvent` / `RuntimeEvent` 联合体都不因附件改动。

> **未来可选（不在当前阶段实现）**：若希望服务端权威地让用户知道「图片被压缩过」，可复用本节同一套「文本提示装配」机制，在消息尾部追加一行 `[系统提示：N 张图片已压缩]`，由独立开关（如 `ATTACHMENT_RESIZE_NOTICE`，默认关）控制。它与失败提示共用同一段代码、同样不引入事件、不碰 `turnId`，与当前默认静默方案完全兼容。细节待后续讨论。

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

### 内部 ContentBlock（media pipeline resize 后 → runner / session）

runtime dispatch 在调 `core/media` 阶段：(a) 可能 resize `image` block 的 `source.data`；(b) sniff 出 `width × height` 写入 `dimensions`。换言之 **`dimensions` 是 internal-only 字段，wire schema (`InboundContentBlock`) 上没有，client 即使传也会被忽略**。以下是 runner / session / LLM adapter 看到的形状：

```ts
// 联合体形态保留，便于 Phase 2 加 file variant 时不破坏现有消费者
export type ImageSource =
  | { type: 'base64'; media_type: string; data: string }
  // Phase 2 可能：| { type: 'file'; media_type: string; path: string }
  ;

export interface ImageBlock {
  type: 'image';
  source: ImageSource;
  dimensions: { width: number; height: number }; // runtime dispatch 阶段由 media pipeline sniff 写入；sniff 失败则该附件被丢弃，不会有没 dimensions 的 ImageBlock 进入 runner / session。resize 后更新为新尺寸
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

### 事件模型：附件相关**不新增任何事件**

本 spec **不**向 `AgentEvent` / `RuntimeEvent` / `channel_error` 添加任何附件相关的 variant 或 code：

- **失败附件**：静默丢弃（决策 8），仅可选地在消息文本里追加一行系统提示，不发事件
- **resize 成功**：静默 inline，不发 `attachment_resized` 事件
- **steering 夹带附件**：剥离非 text block 后照常 steer，不发事件
- **wire 层错误**（JSON 解析失败、未知 type、必填字段缺失、frame 超 `maxPayload`）：沿用既有 `channel_error`，与附件无关

这样 `RuntimeErrorInfo` / `RuntimeRunRejectionReason` / `attachment_resized` 等一概不引入，附件特性对事件层零侵入。前端要展示「已压缩」可在客户端依据自己上传的原始字节本地推断（决策 8）。

## Media pipeline 契约（transport-agnostic）

`core/media/attachment-pipeline.ts` 是纯函数，不知道任何 transport：

```ts
export interface AttachmentResizedInfo {
  fromBytes: number;
  toBytes: number;
  finalMaxSide: number;
  finalQuality: number;
}

export type AttachmentResult =
  | { ok: true; block: ChatContentBlock; resized?: AttachmentResizedInfo }
  | { ok: false; reason: AttachmentDropReason };

export type AttachmentDropReason =
  | 'unsupported_mime'
  | 'mime_mismatch'
  | 'metadata_unreadable'
  | 'too_large'
  | 'resize_failed';

// 单张图：MIME 白名单 → sniff → 必要时 resize；失败返回 ok:false，调用方据此丢弃该附件
export async function processImageAttachment(
  rawBytes: Uint8Array,
  declaredMime: string,
): Promise<AttachmentResult>;

export interface DroppedAttachment {
  blockIndex: number;
  reason: AttachmentDropReason | 'limit_exceeded' | 'total_exceeded';
}

// 整条 message：**永不整体失败**——失败附件进 dropped[]，其余文本 + 成功附件照常进 normalized
export async function processInboundMessage(
  message: string | InboundContentBlock[],
): Promise<{
  normalized: string | ChatContentBlock[]; // 文本 + 处理成功的 image block
  dropped: DroppedAttachment[];            // 被丢弃的附件，供 intake 装配阶段生成占位提示
}>;
```

阈值与默认值（均在 `src/core/media/constants.ts`）：

| 校验项 | 默认值 | 丢弃 `reason` |
|---|---|---|
| 单 attachment 解码字节 | ≤ `ATTACHMENT_RAW_MAX_BYTES`（10 MB） | `too_large` |
| 单条消息附件数 | ≤ `MAX_ATTACHMENTS_PER_MESSAGE`（20，数组长度安检防 `Array(1e6)` 病态输入） | `limit_exceeded`（超出的附件被丢弃） |
| 单条消息总附件解码字节 | ≤ `ATTACHMENT_TOTAL_MAX_BYTES`（10 MB） | `total_exceeded`（超过预算后的附件被丢弃） |
| MIME 白名单 | image/png \| jpeg \| webp \| gif（Phase 1） | `unsupported_mime` |
| Magic-bytes 校验 | image 类必须匹配声明的 `media_type` | `mime_mismatch` |
| 维度嗅探 | image 必须 sniff 出 `width × height` 写入 `dimensions` | `metadata_unreadable` |
| Resize 决策 | 解码字节 > `ATTACHMENT_INLINE_THRESHOLD_BYTES`（2 MB）→ 两步 resize 压到 ≤ 2 MB；否则原样 inline | `resize_failed`（损坏图 / 全档位仍超） |

> **三个上限不是相加关系，取最严者生效**：当前默认下「单文件上限 = 总额上限 = 10 MB」，所以**总额是真正的约束**——不是「20 张 × 10 MB = 200 MB」。`MAX_ATTACHMENTS_PER_MESSAGE = 20` 只在文件都很小时才会先于总额触发（例：20 张 0.4 MB 图先撞数量上限），它的主要作用是数组长度安检（防 `Array(1e6)` 病态输入），而非提升可上传体积。若未来要支持更大批量，需同步上调总额阈值与 `maxPayload`（详见「上限对齐推导」）。

> resize 成功是**静默**的，不再有 `attachment_resized` 事件载体；`AttachmentResult.resized?` 仅供 verbose 日志用途。失败附件统一进 `dropped[]`，由 runtime intake 装配阶段转成可选的文本提示（决策 8），不走任何事件通道。

## Runtime dispatch 流水

`RuntimeApp.handleInboundChannelMessage` 是 channel 与 runner 之间唯一的入口，是 channel 与 runner 之间的 intake（入站处理入口）。校验顺序：

1. **协议层已通过**：channel 已确保 `sessionKey` / `message` 必填、JSON 合法、frame 未超 `maxPayload`
2. **session 解析 / 创建**：照旧
3. **Media pipeline 处理**：调 `processInboundMessage(req.message)` → `{ normalized, dropped }`；失败附件已在内部静默丢弃，**绝不整体失败**
4. **失败附件占位装配**：若 `dropped` 非空且 `ATTACHMENT_DROP_NOTICE`（默认开）开 → 在 `normalized` 文本尾部追加一行 `[系统提示：N 个附件因无法处理已忽略]`；若 `normalized` 正文为空（纯坏附件）→ 用该提示作为整条正文；若连提示都为空（无文本无附件的退化输入）→ 直接 `return`，不入队、不写 session
5. **Steering 状态处理**：若该 session 当前在 steering 条件下（`shouldRouteMessageToSteering === true`）且 `normalized` 含非 text block → **剥离掉这些 block，仅留文本照常 steer**；剥离后文本为空则按第 4 步空消息规则 `return`
6. **进入既有路径**：steering 走 inbox / 否则走队列 `enqueueQueuedTurn`

> **顺序说明**：media 处理 **在** steering 检查之前——因为 steering 检查需要看 normalized message 的 block 类型，而原 `InboundContentBlock[]` 还没经过 sniff/resize。
>
> **绝不整体拒收**：附件失败只丢弃单个附件，turn 用剩余内容继续；不存在「因附件校验失败而整条消息被拒、需要向 client 投递通知」的路径——这正是决策 8 砍掉整个 `RUN_REJECTED` 子系统、不引入 notice / clientId / 队列时序改动的依据。

### Channel 层职责（收窄后）

channel 只负责：

1. I/O framing（如 WebSocket frame 大小、`maxPayload` 配置）
2. wire format 解析（JSON parse）
3. shape sanity check（`sessionKey` / `message` 必填、`type` 字段存在）
4. **失败时**通过 transport-specific 通路反馈（WebSocketChannel 用 `channel_error`；未来 HTTP channel 用 4xx；CliChannel 用 stderr）

`channel_error` / `ChannelErrorCode` 不引入任何与附件相关的新 code。本 spec 对 channel 实现的唯一改动是：

- `ChannelRunRequest.message` 类型放宽为 `string | InboundContentBlock[]`
- WebSocketChannel `maxPayload` 提升至 15 MB

**上限对齐推导**：
- 单条总附件解码 10 MB × 1.35 (base64) ≈ 13.5 MB 文本 + JSON wrap + 其他字段 ≈ 14–15 MB → frame `maxPayload` 15 MB 刚好装下
- 「单文件 ≤ 10 MB × 20 个」是数组长度安检；实际上限由「单条总附件 ≤ 10 MB」锁死（一条消息里 20 张 2 MB 图 > 10 MB 总额，超出预算的附件以 `total_exceeded` 被丢弃）
- 若未来需要同时携带更多附件，总阈值应与 `maxPayload` 同步上调

WebSocket 默认 frame 上限通常是 1 MB，必须显式调高。`maxPayload` 是 **整条 message** 的上限（`ws` 库会自动分帧重组），不是单帧上限。

## 安全考虑

- **Prompt injection**：附件中提取的文本（图片里的文字；Phase 2 起含 PDF 内容）应被视为不可信输入，**不得**被拼接进 system prompt 或工具的 input 字段。LLM 自身处理 untrusted content 的能力 + 现有 hook 是首要防线
- **Magic-bytes**：服务端对 image 做最低成本的 sniff（前 8 字节），media_type 与实际不符则丢弃该附件（决策 8）
- **病毒扫描钩子**：在校验流程里预留一个 `attachmentScanHook`（默认 noop），让部署方按需接入扫描器
- **日志脱敏**：base64 内容**不进** logger / event；事件流里只记 `attachmentCount`、`totalBytes`、`mediaTypes`
- **Workspace 隔离**：附件不写入 workspace 根目录，与 tool 的文件写入路径互不重叠

## 上下文管理交互

### Layer 1（pruneToolResults）

不动。它只裁剪 tool_result content，与 user image 无关。

### Layer 2（checkContextBudget）

现有 `estimateBlockTokens`（`src/core/runner/context/token-estimation.ts`）对 `image` 返回常量 `IMAGE_TOKEN_ESTIMATE = 2000`，本 spec 把它换成 patch 公式；`dimensions` 是强制字段（sniff 失败 → media pipeline 丢弃该附件，缺尺寸的 image 不会到达这里），这里不需要 fallback：

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
- 实时显示已选附件总字节数；超 `ATTACHMENT_RAW_MAX_BYTES` 时禁用 Send 并提示「单图最大 10 MB，请压缩后重传」
- 前端不做 token 估算（估出来用户也无法对照 server Layer 2 budget，避免前后端两套常量同步负担）；chat.html 与后端共享 `src/core/media/constants.ts` 仅用于 MIME 白名单 / 大小阈值这类「前后端都需要」的常量（构建脚本注入或 `/static/media-constants.json` fetch）。`PATCH_SIZE` 这类只后端估算需用的常量不走共享路径
- 服务端 resize 是**静默**的（不回传事件）；前端若要展示「已压缩」标记，可在客户端根据自己上传的原始字节本地推断（决策 8）
- 拖拽 / 粘贴：textarea 监听 `paste` / `drop`，直接接图片
- user bubble 在 chat 流里渲染 image block：`source.type === 'base64'` 直显 `<img src="data:...">`（Phase 1 所有 image 都是 base64）
- 旧 message 流（纯文本）不受影响

## 验收标准

### Media pipeline 单元测试（纯函数 / 不涉及 channel 与 runtime）

| 用例 | 期望 |
|---|---|
| `processInboundMessage`：单文件解码 > `ATTACHMENT_RAW_MAX_BYTES`（10 MB） | 该附件进 `dropped`（`reason: 'too_large'`），其余照常；**不**整体失败（单文件字节上限由 `processInboundMessage` 把关，`processImageAttachment` 只管 MIME/sniff/resize） |
| `processImageAttachment`：MIME 不在白名单 | 返回 `{ ok: false, reason: 'unsupported_mime' }` |
| `processImageAttachment`：魔数 magic-bytes mismatch | 返回 `{ ok: false, reason: 'mime_mismatch' }` |
| `processImageAttachment`：损坏头不认识变种 | 返回 `{ ok: false, reason: 'metadata_unreadable' }` |
| `processImageAttachment`：解码字节 ∈ (2 MB, 10 MB] 的 image | 返回 `{ ok: true, block, resized: { fromBytes, toBytes, finalMaxSide, finalQuality } }`；block.source.data 为 JPEG base64，`dimensions` 为新尺寸，`toBytes ≤ 2 MB` |
| `processImageAttachment`：损坏图或全档位仍超 2 MB | 返回 `{ ok: false, reason: 'resize_failed' }` |
| `processInboundMessage`：附件数 > 20 | 前 20 个正常处理，其余进 `dropped`（`reason: 'limit_exceeded'`） |
| `processInboundMessage`：单条消息总附件字节 > 10 MB | 超预算的附件进 `dropped`（`reason: 'total_exceeded'`） |
| `processInboundMessage`：一条含 1 坏图 + 文本 | `normalized` 保留文本，坏图进 `dropped`；**不**整体失败 |
| `processInboundMessage`：纯文本 string | 返回 `{ normalized: <string>, dropped: [] }` |

### Runtime dispatch 单元测试（mock channel / mock media）

| 用例 | 期望 |
|---|---|
| `dropped` 含 `too_large` 、原消息有文本 | 丢弃该附件；其余内容照常入队；文本尾部追加「N 个附件已忽略」提示（开关开时）；runner 正常启动 |
| 全部附件被丢弃、原消息无文本 | `normalized` 用占位提示作为正文；正常入队 |
| 无文本、无附件（退化输入） | 直接 return；不入队、不写 session |
| `normalized` 含非 text block、且 session 在 steering 状态 | 剥离非 text block，仅文本走既有 steering inbox 路径；剥离后空则 return |
| `normalized` 仅含 text、steering 状态 | 走既有 steering inbox 路径（行为与现状一致） |
| 非 steering、含成功附件 | 走既有 `enqueueQueuedTurn` 路径；runner 启动时收到 normalized message |
| 全程：任何样本都不应 emit 附件相关事件 | 无 `RuntimeEvent` / `AgentEvent` / `channel_error` 新增 |

### Runner / session 单元测试（不动 dispatch）

| 用例 | 期望 |
|---|---|
| `RunParams.message` 为 string | 与改造前行为完全一致 |
| `RunParams.message` 为 `[{type:'text', ...}, {type:'image', ...}]` | session 写入 ContentBlock[]，LLM 调用 messages 包含 image block |
| `estimatePromptTokens` 包含带 dimensions 的 image block | 返回值 ≈ 文本 token + ceil(w/28) × ceil(h/28) |
| `compactMessages` dehydrate | 送给摘要 LLM 的 messages 中无 image block；session 原始 entry 不变 |
| `sanitizeSessionTail` 末尾是带 image 的孤立 user | 正常剥离（branch 回 parentId），emit `session_tail_sanitized` |

### Channel 单元测试（仅验证线上协议）

| 用例 | 期望 |
|---|---|
| WebSocketChannel 收到非法 JSON | 返回 `channel_error: INVALID_JSON`（现有行为） |
| WebSocketChannel 收到 `run_turn.message: InboundContentBlock[]` | 原样包装成 `ChannelRunRequest`，**不** 做附件内容校验，投递给 runtime |
| Runtime 处理含坏附件的消息 | channel 不参与附件校验；不新增任何 `AgentEvent` / `RuntimeEvent` / `channel_error` 类型 |

### 集成测试

| 用例 | 期望 |
|---|---|
| 浏览器发小图（≤ 2 MB）→ run_turn 完整跑通 | LLM 收到 image，session JSONL 有 inline base64 image entry，下次连接重放历史时 image bubble 正常渲染 |
| 浏览器发中等图（2-10 MB）→ run_turn 完整跑通 | 服务端 resize 后 `source.data` ≤ 2 MB（静默，无事件）；JSONL 写入 resize 后的 base64；LLM 收到 resize 后的 base64 |
| 浏览器发超大图（> 10 MB）+ 文本 | 图被静默丢弃；turn 用文本继续；消息文本含「1 个附件已忽略」提示 |
| Steering 状态下发带附件消息 | 附件被剥离，仅文本注入 steering；当前 turn 不受影响 |
| 同 session 发 image 后触发压缩 | 压缩成功，摘要文本包含「曾发送 1 张图片」类提示，session 摘要后保留区仍含原始 image |
| 同时跨多 session 并发上传图片 | runtime dispatch 调度正常，无串扰；sharp 并发不互相阻塞（必要时在 media 模块内部加 semaphore） |
| 重连场景：断线后重连，前一条带图 user message 被重新加载到 chat.html | UI 能渲染 image bubble |

### 不应破坏的现有行为

- 纯文本 user message 路径无任何延迟 / token 估算回归
- 既有 sanitize / compaction / approval / steering 行为不变
- `channel_error` / `ChannelErrorCode` 未增加任何与附件相关的 code

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
3. **attachment-pipeline 编排**（独立可提交）
   - 新增 `src/core/media/attachment-pipeline.ts`，导出 `processImageAttachment(rawBytes, declaredMime)` 与 `processInboundMessage(message)`：前者串起 MIME 白名单 → sniff → resize 决策；后者负责数组长度、跨附件总量、逐个调 `processImageAttachment`
  - 返回「逐附件独立判定」结果：成功进 `normalized`、失败进 `dropped[]`，`reason` 用中性词汇（`unsupported_mime` / `mime_mismatch` / `metadata_unreadable` / `too_large` / `total_exceeded` / `limit_exceeded` / `resize_failed`），**不耦合 channel 错误码也不耦合任何事件类型**；`processInboundMessage` **永不整体失败**
   - 动机：channel 只管协议层；「单张图怎么变成 ImageBlock」与「一条 message 怎么处理」都是 media 层纯函数，便于单测与未来 HTTP channel 复用
4. **数据模型 + token 估算 + image 维度**（一次合并提交）
   - `ImageBlock` 加 `dimensions` 必选字段（internal-only，wire 上不带，runtime dispatch 阶段由 media pipeline 写入）；`ImageSource` 保留联合类型写法（当前只有 `base64` variant，在 type 定义邻近加注释说明是为 Phase 2 file variant 预留，避免被 lint “清理”）
   - `estimateBlockTokens` 的 `case 'image'` 从返回常量 2000 改为 patch 公式；同时删除 `IMAGE_TOKEN_ESTIMATE` 常量
   - `estimatePromptTokens` 的 `currentPrompt` 参数类型放宽为 `string | ChatContentBlock[]`，因为 `AgentRunner.runAttempt` 在 `checkContextBudget` 之后才 append user 消息（`AgentRunner.ts:259/293`），本次 user message 的附件 token 必须通过 `currentPrompt` 参数算进去
   - **不新增任何事件 / 错误类型**：不改 `RuntimeErrorInfo`、不引入 `RuntimeRunRejectionReason`、不动 `AgentEvent` / `channel_error`
5. **剩余入站接口扩展**
   - `RunParams.message` / `ChannelRunRequest.message` 类型扩展为 `string | ChatContentBlock[]`（前者）/ `string | InboundContentBlock[]`（后者）
   - WebSocket 协议升级（请求负载型 union，server 端 `maxPayload` 调高到 15 MB）；**channel 不加任何附件相关的 `ChannelErrorCode`**
6. **Runtime dispatch 集成 media 与丢弃 / 占位路径**
  - `RuntimeApp.handleInboundChannelMessage` 在 session 解析后插入 `processInboundMessage` 调用；拿到 `{ normalized, dropped }` 后做「失败附件占位装配」（决策 8）+ steering 附件剥离（决策 6）
  - 失败附件静默丢弃 + 可选文本提示；空消息走占位 / skip 边界；**不 emit 任何事件、不写额外状态**
  - 不需要 `AttachmentDropReason` → 错误码映射表（既无拒收也无事件）；drop reason 仅用于 verbose 日志 / 可选提示文案
7. **Layer 3 dehydrate 摘要 LLM 输入**
8. **chat.html 端到端跑通图片**
   - 浏览器端 FileReader + paste / drop
   - chip 展示本地推断的「原 size →（预估）压缩后」（不依赖 server 回传）
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
| Token 占位估算偏差导致预判过严 / 过松 | 维度嗅探让估算贴近真实值；常量进 `compaction` config；估算偏差用 verbose 日志观测（**不引入任何附件事件**，与决策 8 一致） |
| JSONL 文件因 base64 累积膨胀 | 单图上限 2 MB（resize 后）+ 单条消息 20 张上限；预期典型 session 不会超 50 MB。若观察值超阈值再启动 Phase 2 file offload |
| `sharp` 在 Alpine / 受限环境装失败 | 部署文档明示与 `better-sqlite3` 同档处理（Alpine ：`apk add vips-dev` build-time + `vips` runtime；或 `pnpm install --build-from-source`）；包管理器在 `onlyBuiltDependencies` 白名单加 `sharp` |
| Resize 失败（损坏图 / 全档位仍超 2 MB） | 静默丢弃该附件，turn 用其余内容继续；可选在消息文本里追加「N 个附件已忽略」提示让用户知情（决策 8） |
| Resize 阻塞 event loop / 并发竞争 | sharp 本身释放 GIL；典型情况只需 1-2 次 encode；若观察到大并发上传时延迟明显，加 semaphore 限制同时 resize 数（Phase 2 优化） |
| PNG 截图被强转 JPEG 出现边缘 artifact | 文档明示「resize 后统一 JPEG」；前端如需展示「已压缩」标记可在客户端本地依据上传原始字节推断（resize 静默、不回传事件，决策 8）；Phase 2 可按需对 PNG 走「仅 resize 不转码」路径（quality 降级只为 JSONL 体积，与 LLM 信息量无关，所以 PNG 路径理论上可保留无损） |
| Prompt injection（图内 OCR 文字；Phase 2 起含 PDF 内文字） | 附件文本仅作为 user content 进 LLM，不进 system prompt / tool input；hook 系统已具备拦截能力 |
| 摘要 LLM dehydrate 漏掉某种 block 类型 | dehydrate 沿用 `serializeMessagesForSummary` 现有的松散 `if / else if` 链（无 `else`），未识别 block **静默跳过**而非抛错；新增 block 类型时靠 code review 检查是否补分支。不写 `default: never` 穷尽检查（松散 cast 后收敛不到 `never`、编译不过，且会把现状的「跳过」变成「抛异常」回归） |
| 附件被 `sanitizeSessionTail` 清掉时用户感觉「丢了」 | 文档明确「孤立 user 的语义包含其附件」；前端在 send 失败时保留 chip，让用户重发 |

## Appendix A：Anthropic / OpenAI 图片 Token 计算参考

本附录整理两家 vision API 的 token 计费规则，作为决策 4（resize 阈值选择）和决策 5（`estimateBlockTokens`）的事实依据。Anthropic 文档：<https://platform.claude.com/docs/en/build-with-claude/vision>；OpenAI 文档：<https://developers.openai.com/api/docs/guides/images-vision>。

### A.1 Anthropic Claude（patch-based，统一算法）

**公式**：tokens = ⌈w / 28⌉ × ⌈h / 28⌉（每个 28×28 像素 patch = 1 visual token）

**预处理**：超限时 server 自动 resize 到「同时满足边长上限 + token 上限」的最大保形尺寸，再向右/下 pad 到 28 倍数（pad 不计 token）。调用方**无法**控制 resize 行为。

**模型上限**：

| 模型族 | 长边上限 (px) | token 上限 (tokens) |
|---|---|---|
| Sonnet 4.6 等主流模型 | 1568 | 1568 |
| Opus 4.7 / 4.8 / Fable 5 / Mythos 5 | 2576 | 4784 |

> **两列是两条独立约束，server 取更严者后再 resize，并非互相推导**。Sonnet 系「长边 1568px」与「1568 token」数值相同纯属巧合（对应真实 Anthropic 文档的 1568px 长边 + ~1600 token 上限），不要用 ⌈1568/28⌉² 去验算 token 列——那算的是「1568×1568 正方形」，而 token 上限会先把正方形压到约 1092px（⌈1092/28⌉²=1521≤1568），根本到不了 1568×1568。token 列由下方「典型尺寸」表的实际下采样结果佐证（如 1920×1080 → 1456×819 = 1560 ≤ 1568）。

**典型尺寸 token 数**（Sonnet 系）：

| 像素 | tokens |
|---|---|
| 200×200 | 64 |
| 1000×1000 | 1296 |
| 1920×1080 | 1560（已被下采到1456×819） |
| 3840×2160 | 1560（同上，按 token 上限等比缩放） |

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
   - Sonnet 4.6 等主流 Claude：原生上限 1568，my-agent 缩到 2000 后 server 还会强制再缩到 1568——**LLM 视角无差异**，仅本地 token 估算上界偏高 ~3×、典型截图 ~2×（量级正确，不至于误发 Layer 2）
   - Opus 4.7+ / Fable 5 / Mythos 5：原生上限 2576，2000 px **会主动降采样**——可接受（仍远高于绝大多数截图分辨率），但若主要服务这类模型可调高到 2576
   - OpenAI patch-family：原生上限 2048（`detail: high`），2000 px ≈ 持平；`detail: original` 才到 6000，my-agent 当前不主动选择 detail，依赖默认
3. **第一版 `estimateBlockTokens` 仅按 Anthropic patch 公式**。OpenAI adapter 接入时按 A.2 分支扩展，常量与 multiplier 进 `compaction` config。
