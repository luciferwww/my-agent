# channel-multi-client-user-message-spec

Multi-client user-message visibility for my-agent v1.

Status: **READY** — all open decisions locked.

## 0. Open Decisions

Items marked `?` need user confirmation before implementation.

| # | Question | Recommendation | Status |
|---|---|---|---|
| D1 | User 输入是否作为一等 `AgentEvent` | **是** — 新增 `user_message` 变体。理由：语义对齐（"session 时间轴上的事件"本就包含 user 输入）；未来 transcript 回放、审计日志、其他 channel（CLI mirroring / 未来 GUI）复用同一份广播管线。 | `✓` |
| D2 | 事件是否回显给**发送者本人** | **回显** — 广播时不排除 origin client。理由：(a) 客户端渲染统一走 event stream，不用为"我自己发的"单独维护一条路径；(b) origin client 收到自己的回显作为"服务器已接收"的隐式 ack；(c) 与 assistant 事件行为一致。 | `✓` |
| D3 | 事件 payload 是否包含 `originClientId` | **包含** — 广播出的 `user_message` 事件带 `originClientId: string \| null`。理由：客户端可据此区分"我发的"和"别人发的"做 UI 差异（如高亮、头像）。null 表示来自非 WS channel（CLI / library API）。**显式不加** `originChannel` 区分 CLI/library/服务端注入——YAGNI，没有已知客户端消费点；三分类"我发的 / 同 session 别人 / null"用 `originClientId` 已足够。若未来出现具体消费需求再扩展。 | `✓` |
| D4 | Session transcript 是否重复写入 | **不重复** — 现有 `SessionManager.appendUserMessage` 路径保持唯一写入点；`user_message` 事件仅用于**广播**，不触发 transcript append。理由：避免"入队前发事件 + runner 消费时又 append"造成 double write。 | `✓` |
| D5 | 事件发射时机 | **assemble 通过后、route 分歧前** emit —— 位于 `handleInboundChannelMessage` 中 `assembleInboundMessage()` 成功之后、`shouldRouteMessageToSteering()` 分支判断之前。理由：(a) 让所有 client 立刻看到"消息已接收"，无需等出队；(b) 覆盖 queued 与 steering 两条路径；(c) 退化输入（`assembled === undefined`）不 emit。**不做 error 补发**：`enqueueQueuedTurn` / `enqueueSteeringInput` 都是无失败路径的 `push`，不存在 emit 后入队失败的 split-brain。 | `✓` |
| D6 | 事件如何与后续 turn 关联 | **用 `messageId` 而非 `turnId`** — `user_message` 事件带 emit 时生成的 `messageId: string`（UUID）；后续 `run_start` 事件带 `originMessageId` 反向关联。理由：turnId 语义是"一次 runner 执行"，而 steering 消息**不产生新 turn**（0 turn 关联），强行绑 turnId 是概念漏。messageId 与生命周期解耦，语义纯净。 | `✓` |
| D7 | Steering 消息是否也广播 | **广播** —— steering 与 queued 走同一 emit 点，事件带 `deliveryMode: 'queued' \| 'steering'` 区分。理由：同样是"用户在打字"，B 应该看到；`deliveryMode` 让客户端能对 steering 做差异化 UI（如"打断"样式）。 | `✓` |
| D8 | 附件（image / 二进制 block）如何广播 | **只广播摘要，不广播原始字节** —— `user_message` 事件里文本走 `content: string`，附件抽出为 `attachmentSummaries: AttachmentSummary[]`（`type` 必需，`name` / `bytes` / `mime` 尽力）。原始字节仍进 transcript / LLM 路径，仅**不进事件流**。理由：(a) base64 图片单张就可能 MB 级，广播代价太高；(b) 客户端 UI 至少需要"这条带 N 个附件"的占位，type + name/bytes 已足；(c) 不加 hash/thumbnail/attachmentId——目前无"从摘要拉原文"的 API，YAGNI。**故意的信息不对称**：origin client A 本地看得到原图，client B 只看到摘要占位——见 §5.1 说明，不是 bug。 | `✓` |

---

## 1. Background

WebSocketChannel 支持多客户端订阅同一 session：`sessions: Map<sessionKey, Set<clientId>>`，`send(event)` 会广播 `AgentEvent` 给该 session 下所有 client。

但当前实现存在**事件不对称**：

- ✅ Server → clients 的事件（`text_delta` / `tool_use` / `tool_result` / `subagent_start` / `subagent_end` / …）会广播到所有订阅者。
- ❌ Client → server 的 user 输入（`run_turn` 消息里的 user message）**不产生任何 AgentEvent**，因此不会广播到同 session 的其他 client。

用户实测现象：两个 client 加入同一 session，A 发消息后 B 看不到那条 user message，但**能看到** server 对该消息的回复——因为回复走的是 assistant event 广播路径。

## 2. Non-Goals (v1)

- **不做**"未订阅 client 补历史"：新加入的 client 不会自动收到过去的 user_message 回放（transcript replay 是独立议题）。
- **不做**权限校验：与 [core-abort-spec](core-abort-spec.md) §2 保持一致——WS server 单信任域，不区分 client 身份权限。
- **不改**用户消息的持久化路径：`SessionManager` 现有 append 语义不动。

## 3. Root cause

```
Client A                  RuntimeApp                     AgentRunner            Channel.send()      All clients
  │  run_turn(msg)            │                                │                      │              │
  ├──────────────────────────►│                                │                      │              │
  │                           │ (validate + enqueue)           │                      │              │
  │                           │  ← user 输入到此为止 ✗          │                      │              │
  │                           │                                │                      │              │
  │                           ├──── runTurn(params) ──────────►│                      │              │
  │                           │                                │  emit events         │              │
  │                           │                                ├────── event ────────►│              │
  │                           │                                │                      ├── broadcast ─┤
  │                           │                                │                      │              ▼
  │                           │                                │                      │        ✅ 所有 client 看到
```

`AgentEvent` 联合类型（[src/core/runner/types.ts:81-100](../../src/core/runner/types.ts#L81-L100)）**没有 `user_message` 变体**——它只描述 runner 的产出。User 输入在 `RuntimeApp.handleInboundChannelMessage`（[src/runtime/RuntimeApp.ts:454-538](../../src/runtime/RuntimeApp.ts#L454-L538)）里被直接塞进 message queue，从未通过 event 通道回流到 `WebSocketChannel.send()`（[src/adapters/channel/WebSocketChannel.ts:103-131](../../src/adapters/channel/WebSocketChannel.ts#L103-L131)）——广播管线只覆盖 runner 事件，不覆盖 client 输入。

## 4. Goals

- Client A 发送 user message 后，同 session 的所有其他 client 在 ≤50ms 内收到该 user message 事件。
- Origin client 收到自己的回显，作为服务器"已接收"的隐式 ack。
- Transcript 持久化行为不变（单次 append，来自 runner 消费时的既有路径）。
- **跨 channel 覆盖**：非 WS 入口（CLI / library API）注入的消息也应能广播到 WS clients；WS 入口的消息也应能在 CLI 终端显示——两者共享 fanout 管线，不做单向限制。（详见 §5.4）

## 5. Design

### 5.1 扩展 `AgentEvent`

在 [src/core/runner/types.ts](../../src/core/runner/types.ts) 的 `AgentEvent` 联合类型新增一个变体：

```ts
| {
    type: 'user_message';
    sessionKey: string;
    messageId: string;                              // emit 时生成的 UUID；不等同于 turnId
    content: string;                                // 用户输入的文本部分（从 assembled 抽出并拼接）
    attachmentSummaries?: AttachmentSummary[];      // 附件摘要；无附件时省略
    originClientId: string | null;                  // WS clientId；来自非 WS channel 则为 null
    deliveryMode: 'queued' | 'steering';            // 走 queue 排队 vs 注入运行中 turn 的 steering
    timestamp: number;                              // ms since epoch
  }
```

同时新增一个类型（同一文件）：

```ts
export interface AttachmentSummary {
  type: 'image' | 'other';                // 必需——UI 至少要知道渲染哪种占位；未来加类型是 additive
  name?: string;                          // 文件名（若可得）
  bytes?: number;                         // 原始字节数（若可得）
  mime?: string;                          // MIME type（若可得）
}
```

并在既有 `run_start` 事件新增可选字段 `originMessageId?: string`，供客户端把 turn 反向关联到触发它的 `user_message`（仅 queued 模式有值；steering 不产生 turn，因此无 run_start 需要关联）。

**故意不加的字段（YAGNI）**：
- `hash` / `contentDigest`：无 CAS / 去重消费点。
- `thumbnail` / 缩略图：一旦加入就退化为"广播内容"，与 D8 决策矛盾。
- `attachmentId`：v1 无"从摘要反查原文"的 API。
- `type: 'document'`：现 `ChatContentBlock` 只有 text 与 image；预留字面量属于 aspirational placeholder，未来 additive 即可。

**信息不对称说明**（三层，均为**有意**设计）：
1. **同 session 客户端之间**：origin client A 本地渲染完整附件；其他 client 只收到摘要占位。D8 的直接后果。
2. **实时广播 vs 未来 transcript replay**：replay 通道读的是 transcript 里的 assembled 原文（完整附件），与广播摘要不一致。双通道设计（广播优化带宽；回放优化保真度），不应对齐。
3. **广播事件 vs runner 消费**：steering 路径下附件仅参与广播摘要，**不**进 runner（见 §5.3 R1'）。让 runner 消费 steering 附件是独立议题，超出本 spec。

### 5.2 `summarizeAssembled` 提炼规则

`summarizeAssembled(assembled: string | ChatContentBlock[]) → { text: string; attachmentSummaries: AttachmentSummary[] }` 是本 spec 引入的辅助函数。字符串 → `{text, attachmentSummaries: []}`；数组按下表逐 block 处理：

当前 [`ChatContentBlock`](../../src/adapters/llm/types.ts#L5-L18) 面向 user 消息的有效变体是 `text` 和 `image`（`tool_use` / `tool_result` 是 assistant 侧产物，不会出现在 user 消息里）。

| 输入 block | text 结果 | AttachmentSummary |
|---|---|---|
| `{ type: 'text', text }` | 追加进 `text`（多段用 `\n\n` 连接） | — |
| `{ type: 'image', source: { type: 'base64', media_type, data }, ... }` | — | `{ type: 'image', mime: media_type, bytes: base64ByteLen(data) }` |
| `{ type: 'image', source: { type: <非 base64> } }` | — | `{ type: 'image', mime?: 尽力提取, bytes: undefined }` + `log.warn` 一次 |
| 其他 `type`（未来 additive 变体） | — | `{ type: 'other' }` |

**防御性契约**：对 `source.type` 做 exhaustive narrow，非 `'base64'` 分支省略 `bytes` 而不是沿用 `base64ByteLen(data)`（那会把 URL 字符串长度当字节数错报）。不为未来分支预写实际逻辑（YAGNI），仅保证不错报、不崩、不泄漏未知字段。

`name` 在当前 `ChatContentBlock` shape 下拿不到（`image` 没有文件名），v1 通常为 undefined；未来 shape 加了字段可直接透传。

### 5.3 发射时机

在 `RuntimeApp.handleInboundChannelMessage`（[src/runtime/RuntimeApp.ts:476-538](../../src/runtime/RuntimeApp.ts#L476-L538)）里，**`assembleInboundMessage` 返回有效 assembled 之后、`shouldRouteMessageToSteering` 分支之前**，emit 一次 `user_message`。这样 queued 与 steering 两条路径都被覆盖（D5 + D7）。

伪代码（方法名与真实代码对齐；`fanoutAgentEvent` 为新增实例方法/字段的示意名，具体命名由 impl 决定）：

```ts
private async handleInboundChannelMessage(
  channel: Channel,
  req: ChannelRunRequest,
): Promise<void> {
  // 1. 复用现有 intake（不动）
  const { normalized, dropped } = await processInboundMessage(req.message);
  const assembled = this.assembleInboundMessage(normalized, dropped);
  if (assembled === undefined) return;   // 退化输入：既不入队也不 emit

  // 2. 决定路由（不动分支逻辑本身，只把 emit 前移到分歧点之前）
  const routeToSteering = this.shouldRouteMessageToSteering(req.sessionKey);
  const deliveryMode: 'queued' | 'steering' = routeToSteering ? 'steering' : 'queued';

  // 3. 拆出「文本 + 附件摘要」
  const { text, attachmentSummaries } = summarizeAssembled(assembled);

  // 4. 广播 user_message
  const messageId = randomUUID();
  this.fanoutAgentEvent({
    type: 'user_message',
    sessionKey: req.sessionKey,
    messageId,
    content: text,
    attachmentSummaries: attachmentSummaries.length ? attachmentSummaries : undefined,
    originClientId: req.clientId ?? null,
    deliveryMode,
    timestamp: Date.now(),
  });

  // 5. 按原有分支入队；messageId 透传给下游做 originMessageId 关联
  if (routeToSteering) {
    // 纯附件 steering 消息：广播已完成，但 runner 只收 text，不入队。见 R1'。
    if (text.trim() === '') return;
    this.enqueueSteeringInput(
      req.sessionKey,
      text,
      this.buildMessageRouteContext(channel, req),
      messageId,
    );
  } else {
    this.enqueueQueuedTurn({
      sessionKey: req.sessionKey,
      message: assembled,
      launchContext: this.buildTurnLaunchContext(req),
      routeContext: this.buildMessageRouteContext(channel, req),
      originMessageId: messageId,
    });
  }
  const started = this.scheduleNextQueuedTurn(req.sessionKey);
  if (started) await started;
}
```

**实现要点**：
- `fanoutAgentEvent` 目前不存在——`fanout` 是 [RuntimeApp.ts:127-141](../../src/runtime/RuntimeApp.ts#L127-L141) `create()` 内的闭包，`this.emit()` 走的是另一套 `RuntimeEvent` 通道不能复用。落地时把 fanout 引用挂到实例（如 `this.fanoutAgentEvent = fanout`）或提供等价方法。
- `originMessageId` 需向下透传到 `QueuedChannelTurn`（`src/runtime/queue-types.ts`），供 `startQueuedTurn` 在生成 `turnId` 时塞进后续 `run_start` 事件。
- **R1 决策：Steering 只收 text**。[enqueueSteeringInput:624-628](../../src/runtime/RuntimeApp.ts#L624-L628) 现签名只收 `text: string`，注释明确 "当前 runner 只消费文本"。本 spec 不扩宽这层——附件在 steering 路径**仅通过广播摘要参与 UI，不进 runner**。让 runner 消费 steering 附件需同步改 runner 侧消费逻辑，是独立议题。
- **R1' 决策：纯附件 steering 消息不入队**。R1 的自然后果：当 steering 消息只有图无文时，`text` 为空——`enqueueSteeringInput` 早退。此时 B 端 UI 会看到附件占位，但 runner/LLM 完全不知情。（拒绝的替代：把空 text 检查提前到 emit 之前违反 D7+D8；强制走 queued 触发范围膨胀。）
  - **UI 层建议（非强制）**：origin client 收到自己的回显且 `deliveryMode === 'steering' && content 为空 && attachmentSummaries 非空` 时，显示提示："⚠️ 附件仅其他客户端可见，不参与本次 turn；如需 LLM 处理，请等当前 turn 结束后再发送。"

### 5.4 Channel 侧的 `user_message` 处理

RuntimeApp 的 [`fanout`](../../src/runtime/RuntimeApp.ts#L127-L141) 无差别地把每个 `AgentEvent` 派发给所有已注册的 channel。因此 `user_message` 天然跨 channel 广播——**无须**为"WS → CLI"或"CLI → WS"写专门的路由逻辑，只需两侧的 `Channel.send()` 各自处理该变体。

**WebSocketChannel**（[src/adapters/channel/WebSocketChannel.ts:103-131](../../src/adapters/channel/WebSocketChannel.ts#L103-L131)）：
`send` 无需特化——已有的 `sessionAudience` 广播循环会自动覆盖新事件。仅需在 `serializeEvent` 里把 `user_message` 的 JSON 形状对上客户端协议（若客户端有严格类型校验）。

**CliChannel**（[src/adapters/channel/CliChannel.ts:117](../../src/adapters/channel/CliChannel.ts#L117) 的 `send` switch）：
必须新增 `case 'user_message'`，否则 CLI 与 WS 同 session 混用时，WS 用户发的消息在 CLI 终端**完全看不到**（只看到凭空冒出的 assistant 回复，不知道是回复什么）。渲染规则：

```ts
case 'user_message': {
  // originClientId === null 表示来自 CLI / library 入口——CLI 用户自己刚敲下过，
  // 无需回显；仅在 WS（externally-triggered）时在终端渲染。
  if (event.originClientId === null) break;
  this.breakStream();
  const attachHint = event.attachmentSummaries?.length
    ? dim(` (+${event.attachmentSummaries.length} attachment${event.attachmentSummaries.length > 1 ? 's' : ''})`)
    : '';
  const who = event.originClientId ? `@${event.originClientId.slice(0, 6)}` : '';
  this.output.write(cyan(`[user${who ? ' ' + who : ''}]`) + ` ${event.content}${attachHint}\n`);
  break;
}
```

**关键判定**：`originClientId === null` 早退——这是 D3 保留 `originClientId` 的意外收益，天然区分了"外部客户端触发"和"本进程触发"，不需要额外的 origin channel 标记。

**Known limitation（G1）**：`originClientId === null` 同时覆盖"CLI 键盘输入"和"library `app.runTurn(...)` 注入"两种入口——CliChannel 无法区分二者。因此在 CLI + library **同进程**混用的边缘场景中，library 注入的消息在 CLI 终端不可见（用户会看到 assistant 凭空回答）。这是 D3 拒绝 `originChannel` 字段的直接后果。

若未来该场景成为真实需求，escape hatch 是重开 D3 加 `originChannel: 'ws' \| 'cli' \| 'library'`，把 CliChannel 判据从 `originClientId === null` 改为 `originChannel === 'cli' && originClientId === null`。v1 不做——大多数用户要么脚本 library、要么终端 CLI，不会同进程混用；且该限制以测试 lock 定，不会静默退化。

### 5.5 Transcript 隔离（D4 落地）

- `user_message` 事件**只**用于跨 client 广播。
- `SessionManager.appendUserMessage` 的调用点保持在 `AgentRunner` 消费 `QueuedChannelTurn` 时的既有路径（当前实现），不引入第二个写入点。
- 结果：transcript 只写一次，但事件出去两次（广播 + 后续 assistant 事件）——这是正确的语义。

### 5.6 `originClientId` 取值

按 channel 入口不同：
- WS 入口：`req.clientId`。
- CLI / library 入口：`null`。

客户端渲染建议（非强制）：`originClientId === myClientId` → "我发的"；其它 → "别人发的"。（不区分 CLI vs library 的理由见 D3。）

### 5.7 与 core-abort-spec 的交互

[core-abort-spec §0 D3](core-abort-spec.md) 规定 abort 时会 drop 排队消息并发 `messages_dropped`。本 spec 落地后，被 drop 的消息此前**已经**通过 `user_message` 广播给了所有 client——UI 需要能撤销这些消息的显示状态。

**Open question（归 core-abort-spec 决定）**：`messages_dropped` 事件是否应携带被 drop 消息的 `messageId` 列表？当前只带 `{queued, steering}` 计数，客户端只能"知道有 N 条掉了"而无法定位。

- 若携带 `messageId`：本 spec 已足够支持（emit 时生成并透传到入队结构）。
- 若不携带：客户端只能退化策略（例如把"最近 N 条尚未 `run_start` 的 `user_message`"标灰）。本 spec 不阻塞该决定。

## 6. Alternatives considered

### Alt A：Channel 层就近旁路广播（不改核心类型）

在 `WebSocketChannel.handleRunTurn` 里收到消息后，直接向该 session 的**其他 client** push 一条 `user_message` 帧。

- ✅ 改动小，不动核心类型。
- ❌ 只 WS 生效；未来若 CLI 想 mirror、GUI 想接入，各自要重复实现。
- ❌ 与 runner 事件时序脱耦，需额外的顺序保证（如果 WS 帧比 `run_start` 早/晚到，客户端 UI 逻辑更复杂）。
- ❌ 与"session 时间轴 = event stream"的模型分裂。

**结论**：不采纳。留作若 §5 方案落地代价过大时的降级方案。

### Alt B：让 client 自己回显

Client A 发送 user message 后本地立刻渲染，不等 server 回。Client B 通过 WS 侧信道感知。

- ❌ Client B 依然看不到——问题没解决。
- ❌ 引入本地/远程状态不一致风险。

**结论**：不采纳。

## 7. Test plan

- **Unit**：`RuntimeApp.handleInboundChannelMessage` 收到合法 run_turn（queued 路径）→ 恰好 emit 一次 `user_message` 事件（sessionKey / messageId / content / originClientId / `deliveryMode: 'queued'` 字段正确）。
- **Unit**：`handleInboundChannelMessage` 在活跃 turn 存在时（steering 路径）→ 恰好 emit 一次 `user_message` 事件，`deliveryMode: 'steering'`；不产生 `run_start`。
- **Unit**：`assembleInboundMessage` 返回 `undefined`（退化输入）→ **不 emit** `user_message`，也不入队。
- **Unit**：`summarizeAssembled` 输入纯字符串 → `attachmentSummaries` 为空。
- **Unit**：`summarizeAssembled` 输入含 image block 的数组 → `content` 是拼接的文本，`attachmentSummaries[0]` 为 `{ type: 'image', mime, bytes }`；原始 base64 数据不出现在事件里。
- **Unit（健壮性 / R2）**：`summarizeAssembled` 输入 image block 且 `source.type` 不是 `'base64'`（用 unsafe cast 构造未来变体）→ `attachmentSummaries[0].bytes` 为 undefined、不抛错、不把非 base64 数据当字节数错报，且不泄漏 `source.data` 到事件字段。
- **Unit（Steering 附件语义 / R1）**：steering 路径下发的消息含 image block → 广播事件里 `attachmentSummaries` 有条目，但 `enqueueSteeringInput` 收到的 `text` 参数**不**携带图片信息（附件不进 runner）。
- **Unit（Steering 纯附件 / R1'）**：steering 路径下发的消息**仅**含 image block（无文本）→ 广播事件里 `content === ''` 且 `attachmentSummaries` 非空；`enqueueSteeringInput` **未被调用**（runner 无输入）；不 emit 任何 `run_start`。
- **Unit**：`AgentEvent` 类型扩展后，`WebSocketChannel.serializeEvent(user_message)` 输出契合客户端协议。
- **Integration**：两个 mock WS client 加入同一 session，client A 发 `run_turn` → client B 在 ≤50ms 内收到 `user_message` 事件；client A 本人也收到回显；随后的 `run_start` 事件带 `originMessageId === user_message.messageId`。
- **Integration**：session 有活跃 turn 时，client A 发第二条消息（走 steering）→ client B 收到 `user_message` 带 `deliveryMode: 'steering'`，不出现新的 `run_start`。
- **Integration**：CLI 入口发消息，同 session 的 WS client 收到 `user_message` 事件且 `originClientId === null`。
- **Integration（CLI ↔ WS 混合 / 关键回归）**：CliChannel 与 WebSocketChannel 同 session 混用。WS client 发消息 → CLI 终端渲染 `[user @xxxxxx] hello`；CLI 用户敲消息 → CLI 终端**不**回显该消息（`originClientId === null` 早退），但 WS client 收到 `user_message` 事件。
- **Integration（Library 注入 / known limitation G1）**：CliChannel + WebSocketChannel 同 session；直接调用 `app.runTurn(...)` 注入消息 → CLI 终端**不**渲染（`originClientId === null` 与 CLI 键盘输入无法区分，见 §5.4 known limitation）；WS client **仍**收到 `user_message` 事件。此测试锁定当前限制契约，防止静默退化。
- **Regression**：transcript 里 user message 恰好被 append 一次（不 double write）。
- **Regression**：单 client 场景下事件流的相对顺序不变（`user_message` → `run_start` → `text_delta`... → `run_end`）。

## 8. Rollout

- 新增字段是 `AgentEvent` union 的**加法**，对未识别新事件的旧客户端应通过 default 分支忽略——需在客户端 SDK / demo 里补一条 fallback。
- 无迁移脚本；无持久化格式变动。
