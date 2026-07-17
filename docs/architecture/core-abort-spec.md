# core-abort-spec

User-initiated turn abort for my-agent v1.

Status: **READY** — all open decisions locked. See §0 for the audit trail.

## 0. Open Decisions

Items marked `?` need user confirmation before implementation. Each has a
recommended option + rationale; flip the marker to `✓` (accept) or
`✗ (alt)` to lock in.

| # | Question | Recommendation | Status |
|---|---|---|---|
| D1 | Ctrl+C 第一次按下时**无活动 turn**怎样？ | `warn` — 显示 "press again within 1s to exit" 提示，不立刻退出。1s 内二次 → `process.exit(130)`。 | `✓` |
| D2 | LLM 流到一半 abort，partial assistant 文本怎样？ | **保留** — 写入 session 作为 assistant msg + 加 `abortMeta: { stopReason: 'aborted', partial: true }`。理由：用户已经看到了 N tokens，再问一次浪费；下次 turn 的 prompt 历史也连贯。 | `✓` |
| D3 | session 消息队列里**未处理**的 turn，abort 时怎样？ | **同时清空** — `abortTurn(sk)` 既 abort 当前 turn 也 `messageQueueBySession.delete(sk)`。CLI 单次 Ctrl+C 干净。理由：用户按 Ctrl+C 时通常想"我不要 agent 继续了"，而不是"只停这个，下条还要跑"。`followup` 队列里的消息只是字符串副本，user 知道发过什么，必要时再敲一次成本低。被 drop 的消息数会写 log + emit `messages_dropped` runtime event，避免静默丢失。 | `✓` |
| D4 | `RuntimeApp.close()` shutdown 路径 | **abort-then-wait** — 关闭前先把所有 active turn `abort()`，再 `Promise.allSettled` 等回收。理由：避免 shutdown 被一个慢 turn 卡住。 | `✓` |
| D5 | WebSocketChannel abort 协议 | **单向 inbound message** `{type:'abort_turn', sessionKey}`，无显式 ack。客户端通过随后的 `run_end.stopReason==='aborted'` event 自然感知。 | `✓` |
| D6 | abort 期间已开始执行的 tool 怎样？ | **跑完才退出**。abort 检查只在工具循环之间（next tool 启动前）。`ToolContext.signal` 仍传给 tool（基础设施已就位），但 v1 **不**强制任何工具响应：<br/>• `exec` 工具历史上已在自己内部读 ctx.signal 透给 child_process — 这是巧合的好处，保留<br/>• 其他 builtin（web_fetch / search / fs / apply_patch）v1 不加 signal 响应<br/>• MCP / 第三方工具：响应与否由各工具自己决定，my-agent 不强制<br/><br/>理由：(a) MCP 等第三方工具无法强制实现 signal；(b) 工具种类异构，承诺"abort 即取消"会是半真话，不如契约清晰；(c) 单工具大多 <1s，循环间检查的延迟用户能接受；(d) 真有"web_fetch 卡 30s" 这种用户痛点，v1.x 单独补 web_fetch 一行即可，不在 v1 范围。 | `✓` |

---

## 1. Background

v1 subagent 落地后剩下的最显眼用户体验问题：长任务（大量工具调用 / 卡 LLM
请求 / subagent 嵌套）一旦启动，用户**无法中断**。需要：

- CLI: `Ctrl+C` → abort 当前 turn
- WebSocket: 客户端发 `abort_turn` 消息
- Library: `app.abortTurn(sessionKey)` 公共 API
- 不影响：session 队列里其他消息、其他 session 的并行 turn、`runSubagentTurn` 库 API（也能 abort）

## 2. Non-Goals (v1)

- 不支持工具级 abort（"取消这个 tool 调用但 turn 继续"）
- 不支持 hook 级 abort（hook 是短逻辑，跑完即可）
- 不支持 abort-then-resume（resume 留给压缩重试做）
- 不实现 turn timeout（abort 子系统提供基础 hook，timeout 之后用 `setTimeout + abortTurn` 自然实现，不在 v1 范围）
- **不做 WebSocket `abort_turn` 授权校验**：v1 假设 WS server 单信任域（本地 dev / 单用户场景）。客户端 self-declared `sessionKey` 即可 abort 该 session；多客户端场景下 A 能 abort B 的 turn。多租户 / 跨客户端隔离留给未来 auth 层，不在 v1 范围。

## 3. Reference implementations

借鉴自：
- **openclaw** ([openclaw/src/acp](../../openclaw/src/acp/), [openclaw/src/gateway/chat-abort.ts](../../openclaw/src/gateway/chat-abort.ts)) — per-session controller、`AbortSignal.any` 组合、双击 Ctrl+C UX、partial 持久化
- **Claude Code 逆向报告** — 触发语义、双击退出窗口

详细对比见 §15。

## 4. Goals

- 用户 Ctrl+C 后 abort 信号**同步** flip 到 `params.signal`（微秒级，纯内存操作）；LLM streaming 与正在跑的 exec 进程随后被打断——**实际停止延迟取决于外部组件**：SDK 内部读循环响应 signal 的粒度、Node event loop 拥塞、`child_process.kill` 的 OS 语义、第三方工具是否合作。**v1 不承诺硬性墙钟 SLA**；正常网络与轻负载下经验值 <1s，但不做保证。
- abort 永远不抛错给调用方：`runTurn` 返回 `RunTurnResult.stopReason='aborted'`，`runSubagentTurn` 返回 `SubagentRunResult.outcome='aborted'`
- abort 自动级联到当前 turn 直系子 subagent，**无需 SubagentRunner 写显式 cascade 代码**（靠 AbortSignal 透传实现）
- abort 后 session 状态干净：可以立即起新 turn，不会因孤儿 tool_use / stale controller 等问题崩
- 与现有 ContextOverflowError / max_llm_calls 路径正交：互不干扰

## 5. Architecture overview

```
触发源（任一）                  ─►  RuntimeApp.abortTurn(sessionKey)
  CLI: SIGINT handler                   │
  WS:  {type:'abort_turn'}              │
  Lib: app.abortTurn(...)               │
                                        ▼
                              activeAborts: Map<sessionKey, AbortController>
                                        │  controller.abort()
                                        ▼
                              params.signal 触发
                                        │
        ┌───────────────────────────────┼─────────────────────────────────┐
        ▼                               ▼                                 ▼
  AgentRunner.run                AnthropicClient                    Tool execution
   - 循环顶 check                  - SDK fetch abort                  - exec.ts:
   - chatStream({signal})          - 抛 AbortError                       child_process.kill
   - ToolContext.signal=…                                              - 其他工具：跑完才退
        │                               │
        ▼                               ▼
  catch AbortError                  partial text 已 buffered
   → stopReason='aborted'           → 写入 session (§7.2)
   → emit run_end
        │
        ▼
  cascade: ctx.signal → task tool → SubagentRunner.run(req.signal)
                                  → child AgentRunner.run({signal: req.signal})
   子 chatStream / 子 ToolContext 同样响应 → 子 outcome='aborted'
   子 task ToolResult: 'Subagent was aborted before completing.'
   父继续 catch AbortError 流程（已在 abort 路径，不会再被消费）
```

### 5.1 关键依赖：AbortSignal 自然透传

cascade 完全靠 signal 引用透传实现，**任何中间层都不需要"我是 parent / child"的概念**：

```
RuntimeApp.activeAborts.get(sk).signal
  → RunParams.signal (parent)
    → ToolContext.signal (parent task tool 调用时)
      → SubagentRunRequest.signal
        → RunParams.signal (child)
          → ToolContext.signal (child 内部工具调用)
```

这是 openclaw 的做法，已被验证。比"显式 cascade 调用"少 50% 的代码。

## 6. Types changes

### 6.1 `core/runner/types.ts`

```typescript
export interface RunParams {
  // ...现有字段...
  /** 用户中断 / turn timeout / shutdown 等都通过此 signal 传递。
   *  AgentRunner 在 chatStream 调用 + ToolContext 构造时透传；
   *  catch AbortError 后返回 RunResult.stopReason='aborted'，不抛。 */
  signal?: AbortSignal;
}
```

新增 `RunResult.stopReason` 取值 `'aborted'`（注：union 是 string，已经接受）。

### 6.2 `core/tools/types.ts`

删除 ToolContext.signal 的"v1 不消费"注释，更新为：

```typescript
/**
 * 用户 abort / turn timeout / shutdown 的中断信号。
 *
 * Contract: my-agent 保证传入有效 signal，但是否响应**由各 tool 自己决定**——
 * abort 的不变量是"停止 LOOP（不再启动下一个工具）"，**不**保证 in-flight 调用
 * 立即终止。原因：MCP / 第三方工具异构，无法强制实现 signal 响应。
 *
 * v1 实际响应情况：
 *  - `exec` 工具：内部已读 ctx.signal 透给 child_process，进程被 kill
 *  - 其他 builtin（web_fetch / search / fs / apply_patch）：v1 不响应，跑完才退
 *  - MCP / 第三方工具：响应与否由工具实现决定
 *
 * 建议第三方工具实现者：长操作（>500ms）请在 await 前后 `if (ctx.signal?.aborted)` 检查并抛 AbortError。
 */
signal?: AbortSignal;
```

### 6.3 `adapters/llm/types.ts`

```typescript
export interface ChatParams {
  // ...现有...
  signal?: AbortSignal;
}
```

### 6.4 `core/subagent/types.ts`

`SubagentRunInput.signal?` 与 `SubagentRunRequest.signal?` 均已存在（前者为库 API / task tool 入口，后者为 `SubagentRunner.run(...)` 内部请求）——删除两处的 “v1 未消费 / Reserved” 注释，注明语义。

### 6.5 `core/session/types.ts` + `SessionManager`【B2 需同步改】

D2 决策要求 partial assistant 写 session 时携 `abortMeta` marker——当前
`SessionManager.appendMessage` 和 `MessageRecord` 类型**都不接受该字段**，
必须同步扩展。

```typescript
// core/session/types.ts
export interface MessageRecord extends TranscriptEntryBase {
  type: 'message';
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: string | ContentBlock[];
    /**
     * abort 路径标记。**透明持久化到 JSONL**，供调试 / audit / 未来不同
     * UI 渲染使用；**不反向影响 LLM 请求**——loadHistory() 出口的
     * ChatMessage 不携这个字段，对话历史连贯如同一条正常消息。
     */
    abortMeta?: {
      partial: boolean;
      stopReason: 'aborted';
    };
  };
}
```

```typescript
// core/session/SessionManager.ts
async appendMessage(
  key: string,
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: string | ContentBlock[];
    abortMeta?: { partial: boolean; stopReason: 'aborted' };
  },
): Promise<string> {
  // 实现不变：直接将 abortMeta 一起写进记录即可
  // （capToolResults / loadTranscript / resolveLinearPath 都不需要修改，
  // 因为它们原本就是透明透传 record.message）
}
```

请服务于三个不变量：

1. **JSONL 透明持久化**：写入 / 读出 × 同样传递该字段，不丢。
2. **LLM 不可见**：AgentRunner.loadHistory() 转 ChatMessage 时丢弃 abortMeta，
   使 LLM 仅看到 partial content 本身，不看到"这条被中断了"的元信息。
3. **Channel UI 可选读取**：未来 transcript 渲染器可以在 partial 消息后顯示
   "[中断]" 标识，不是 v1 所需但预留接口。

**类型安全性**：`MessageRecord` 在 `TranscriptEntry` union 里，v1 其他读者
（compaction.ts / pruneToolResults / loadTranscript 等）不读该字段，optional
扩展充分兼容。

## 7. AgentRunner 改造

### 7.1 入口 + 顶层 run() 结构

```typescript
async run(params: RunParams): Promise<RunResult> {
  // ...现有 turnCtx 构造...
  this.emit(turnCtx, { type: 'run_start' });   // ← 已于顶层 signal 检查之前发出

  // 顶层快速检查（防御性 — 入口就被 abort 时直接返回）
  // R1'：run_start 已先发，下面发 run_end 保证事件对完整。
  // 此路径下未跑任何 LLM 调用，usage/toolRounds 天然为 0，用 helper 默认值。
  if (params.signal?.aborted) {
    const finalResult: RunResult = {
      ...this.buildAbortedResult([]),   // lastContent = 空，无 accumulated
      compacted: false,
    };
    this.emit(turnCtx, { type: 'run_end', result: finalResult });
    return finalResult;
  }

  // 外层 while 循环（现有 compaction retry）
  let compactionAttempts = 0;
  let compacted = false;
  while (true) {
    try {
      const result = await this.runAttempt(turnCtx, params, contextWindowTokens, compaction);
      const finalResult: RunResult = { ...result, compacted };
      this.emit(turnCtx, { type: 'run_end', result: finalResult });
      return finalResult;
    } catch (err) {
      // ⚠ 注意：abort 在 runAttempt 内部就被优雅返回为 stopReason='aborted'（§7.2），
      // 不会 throw 到这里。这里的 catch 只处理 ContextOverflowError（现有）
      // 和其他意外 error（现有）。abort 不需要特殊分支。
      if (err instanceof ContextOverflowError && compactionAttempts < MAX_COMPACTION_RETRIES) {
        // ...现有 compact + retry...
        await this.compactHistory(turnCtx, params, compaction, err.trigger);
        compacted = true;
        compactionAttempts++;
        continue;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit(turnCtx, { type: 'error', error });
      throw error;
    }
  }
}

private isAbortByName(err: Error): boolean {
  // 抽出的名字判据。callLLMStream / runAttempt 的 catch 也复用（判别 fallback 命中）。
  // 标准 DOMException + Node native fetch: name === 'AbortError'
  // Anthropic SDK 可能抛 `APIUserAbortError` 或 `AbortError` — 实现时
  // 需 manual verify（跳进 @anthropic-ai/sdk 看），必要时补加名字。
  return (
    err.name === 'AbortError' ||
    err.name === 'APIUserAbortError' ||
    (err as { code?: string }).code === 'ABORT_ERR'
  );
}

private isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (!(err instanceof Error)) return false;
  if (this.isAbortByName(err)) return true;
  // Fallback：SDK 升级或第三方 wrapper 可能吞掉 err.name。若调用方能提供
  // 关联 signal 且 signal.aborted === true，倾向按 abort 处理，避免 abort
  // 语义悄悄退化成 'error' 停止原因。调用点凡是拿得到 signal 都应传入。
  //
  // 【副作用，读者必知】本 fallback 是粗粒度的——**只要 signal 已 abort，任何
  // error 都会被归到 abort 分支**，包括与 abort 无关的 IO error / TypeError /
  // 其他 Bug 引发的 exception。这是主动取舍：§4 "never throws" 优先于 "错误
  // 类型保真"——宁可丢失非-abort error 的具体类型（降为 stopReason='aborted'
  // 返回），也不能让 abort 路径抛错。
  //
  // 【诊断兜底】fallback 命中的非-abort error 必须在调用方 catch 里显式
  // 写一条 warn log（见下方 `logIfSwallowedByAbortFallback`，在 §7.2 两个
  // catch 点都调用）——否则内部 Bug 会被完全静默，无法从 stopReason='aborted'
  // 反推真相。`isAbortError` 本身不 log（仅 predicate，且不确定上下文能否拿到
  // sessionKey）；由调用点负责。
  if (signal?.aborted) return true;
  return false;
}

/**
 * 当 `isAbortError` 返回 true 但 err 并非 abort 名字（仅被 signal fallback
 * 兜进来）时，写一条 warn log。runAttempt 外层 catch 与 callLLMStream catch
 * 两处复用，避免各自重写名字列表。
 */
private logIfSwallowedByAbortFallback(err: unknown, sessionKey: string): void {
  if (err instanceof Error && !this.isAbortByName(err)) {
    log.warn('non-abort error swallowed by abort fallback', {
      sessionKey,
      errName: err.name,
      errMessage: err.message,
    });
  }
}

/**
 * 构造 abort 时的返回值。**返回 Omit<RunResult, 'compacted'>**，
 * run() 顶层负责拼 compacted flag（与现有正常路径一致）。
 *
 * `lastContent` 传空数组表示"还没跑过任何 LLM 调用"（顶层 signal.aborted
 * 命中路径）；否则传出 catch/aborted 分支时的最后一条 assistant content。
 * 不扫 messages 数组——scope 里已有 lastContent 变量（AgentRunner.runAttempt
 * 的局部），直接用即可，避免耦合 messages 结构。
 *
 * `accumulated`：runAttempt 在 abort 命中之前已跑过 N 轮 LLM/tool 调用，
 * 那些 usage 早已被 Anthropic 计费、tool rounds 也真实发生。abort 路径
 * 必须把截止时刻的累计值传上来，否则 telemetry / cost 追踪会以为这一
 * turn 免费——违反 audit 完整性。顶层 `signal.aborted` 早退路径可省略
 * （默认 {0,0}/0），因为那条路径下一次 LLM 调用都没发生。
 */
private buildAbortedResult(
  lastContent: ChatContentBlock[],
  accumulated?: { usage: Usage; toolRounds: number },
): Omit<RunResult, 'compacted'> {
  return {
    text: this.extractText(lastContent),
    content: lastContent,
    stopReason: 'aborted',
    usage: accumulated?.usage ?? { inputTokens: 0, outputTokens: 0 },
    toolRounds: accumulated?.toolRounds ?? 0,
  };
}
```

**关键设计变更**（R1）：abort 由 `runAttempt` 内部 catch + return 处理（§7.2），
**不** rethrow 到 `run()`。理由：让 abort 路径直接产生 `stopReason='aborted'` 的正常
return，避免 `run()` 顶层 catch 需要判 abort vs 其他 error 两条分支；abort 与
正常完成在 `run()` 视角外观完全一致（都是一个合法 RunResult），只靠
`stopReason` 区分。旧版本曾以 “run() catch scope 拿不到 in-memory messages” 为
理由，该理由随 §7.3 重构后已失效（修复改从磁盘读），结论仍成立，
但支撑论据已换。

### 7.2 Partial assistant + runAttempt 内部 abort 处理（D2 + R1 决策）

两个 abort 触发点都在 `runAttempt` 内处理（不 rethrow到 `run()`）：

**（1）callLLMStream 拿到 AbortError（partial stream）**：

```typescript
// callLLMStream catch 分支——返回类型保持现状，仅用 stopReason 区分
// （M3：不加 aborted: true 字段，避免 inline 返回类型满天飞 bool flag）
catch (err) {
  if (this.isAbortError(err, params.signal)) {
    // 【fallback 诊断 log】与 §7.2 (2) runAttempt 外层 catch 同样需要：
    // 仅因 signal.aborted fallback 命中的非-abort error 必须写 warn log。
    this.logIfSwallowedByAbortFallback(err, params.sessionKey);
    // flush 已 buffered 的 currentText 到 contentBlocks
    if (currentText) contentBlocks.push({ type: 'text', text: currentText });
    // 【R8】过滤未闭合的 tool_use：Anthropic streaming 的 tool_use.input
    // 是由 input_json_delta 增量组装，abort 命中时可能是 `'{"path": "foo/ba'`
    // 这种残缺 JSON。若直接把残缺 block 写进 session，下一 turn LLM 看到
    // input=null 或半截 JSON 的 assistant 消息可能触发奇怪重试。
    //
    // 【不变量（正确性硬约束）】**仅当该 tool_use block 已收到 SDK 的
    // `content_block_stop` 事件后才 flush 进 contentBlocks**；未闭合的
    // 一律丢弃——`content_block_stop` 是 Anthropic streaming 协议中
    // "该 block 完成"的唯一权威信号，其他判据（例如本地尝试 JSON.parse
    // 成功）都是启发式，可能在 partial JSON 恰好构成合法子对象时误判。
    //
    // impl 侧在 callLLMStream 里维护 in-progress block 的 `done` 标记
    // （例如 Set<index> 或每个累积 block 上的 boolean），仅把 done=true
    // 的 block push 到 contentBlocks。效果：flush 出去的 contentBlocks 里
    // 每个 tool_use.input 必然是可 parse 的完整对象，Anthropic API 下一
    // turn 不会因半截 JSON 拒绝请求。
    return {
      content: contentBlocks,
      stopReason: 'aborted',   // ← 调用方判这个值走 abort 分支
      usage,                    // {0,0} (best-effort)
    };
  }
  // ...其他 catch 不变
}
```

> **usage** 说明：中断发生在 `message_end` 事件之前 → SDK 未返回 usage →
> 处为 `{0,0}` (best-effort)。理论上 Anthropic API 已计费完整 input tokens，
> 这里丢失计量；v2 如需精准可启 streaming usage delta。

**（2）runAttempt 内部 while + tool 循环包 try/catch**，同时处理上面两种 abort 来源：

```typescript
private async runAttempt(
  turnCtx: TurnContext,
  params: RunParams,
  contextWindowTokens: number,
  compaction: CompactionConfig,
): Promise<Omit<RunResult, 'compacted'>> {
  // ...现有 preflight / loadHistory / 当前 user msg append...

  const messages: ChatMessage[] = ...;
  let lastContent: ChatContentBlock[] = [];
  
  try {
    while (hasMoreToolCalls || pendingSteeringMessages.length > 0) {
      // ∅ 每个 LLM 调用前 abort check。
      // 【R5' 行为声明】若此时 pendingSteeringMessages 里有已 drain 但未注入
      // 的 steering 消息：**丢弃**（不写 session，不回填 inbox）。与 D3
      // "abort 清空 queue" 语义一致——用户 abort 时就是想停一切，包括
      // 即将被消费的 steering。
      //
      // 【R5''】该丢弃**仅写 log，不 emit event**。理由：
      //  1. pendingSteering 非空的时间窗极窄（上一轮 tool 循环末尾
      //     pull inbox 与下一次 LLM 调用启动之间），count 实际为 0 或 1 居多
      //  2. `messages_dropped` event 的产生点在 `RuntimeApp.abortTurn`（§8.3），
      //     那里拿不到 `runAttempt` 局部变量 —— 强行合并 event 会造成
      //     turnCtx 反向传递 count / event emit 延迟到 finally 等跨模块耦合，
      //     代价远高于信息价值
      //  3. 运维只需 log grep 即可回溯，CLI/UI 也不需要区分
      //     "steering vs queue" 来渲染丢弃总数
      //  4. D3 "避免静默丢失" 原 scope 是 `messageQueueBySession`，本
      //     内存 pending 属于 R5' 开拓的次要 case，log-only 满足审计需求
      //
      // 日志级别建议 `info`（预期行为不是 warn，但默认可见便于追查
      // "用户抱怨 steering 没生效" 类场景）。数组不需显式清空——
      // runAttempt 抛后函数退栈，局部 const 自然 GC。
      if (params.signal?.aborted) {
        if (pendingSteeringMessages.length > 0) {
          log.info('dropped pending steering on abort', {
            sessionKey: params.sessionKey,
            count: pendingSteeringMessages.length,
          });
        }
        throw new DOMException('Aborted', 'AbortError');
      }
      // ...pendingSteering 注入 / llm_call emit / callLLMStream...
      
      lastContent = llmResult.content;
      
      // ⑰ Partial stream 分支：callLLMStream 优雅返回 stopReason='aborted'
      if (llmResult.stopReason === 'aborted') {
        messages.push({ role: 'assistant', content: llmResult.content });
        // 【前提不变量】本分支进入时 `params.signal.aborted === true`：
        // callLLMStream 仅在 `isAbortError=true` 时返回 'aborted'，而在本项目中
        // 真 AbortError 只从外部触发一 controller.abort() 产生（signal 已 flip）。
        // 未来若放宽 callLLMStream 返回 'aborted' 的触发条件（例如 SDK 内部
        // timeout 也走 AbortError），这个不变量会失效，需在本处重新审视 IO
        // 抛错处理。
        // appendMessage 同其他调用点一致，不为 abort 路径特化错误处理：
        // 若 IO 抛出，依靠 §7.1 isAbortError fallback（signal.aborted 为真）将其
        // 归入 abort 分支，§4 "never throws" 仍成立——前提不变量失效时本
        // 保障同时失效。
        // 孤儿 tool_use 不在本处处理：下一 turn 起点的 `repairOrphanToolUses`
        // 会从磁盘状态统一修（§7.3），避免与 in-memory / IO 失败纠缠。
        await this.sessionManager.appendMessage(params.sessionKey, {
          role: 'assistant',
          content: llmResult.content,
          abortMeta: { partial: true, stopReason: 'aborted' },   // 需 §6.5
        });
        return this.buildAbortedResult(lastContent, {
          usage: totalUsage,
          toolRounds: totalToolRounds,
        });
      }
      
      // ...现有 stop reason 'error' / 'aborted' 提前返回黑名单
      // （'aborted' 已在上面分支处理，现有 branch 不变）
      
      // ② 工具循环 abort check
      for (const toolUse of toolUseBlocks) {
        if (params.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        // ...现有 tool_use 处理不变...
      }
      // ...现有 tool loop 后的 90% 阈值检查、steering 拉取不变...
    }
    
    // 正常完成
    const text = this.extractText(lastContent);
    return { text, content: lastContent, stopReason: lastStopReason, usage: totalUsage, toolRounds: totalToolRounds };
  } catch (err) {
    if (this.isAbortError(err, params.signal)) {
      // 【fallback 诊断 log】若命中仅因 signal.aborted fallback（非 abort 名字），
      // 写条 warn 使 §7.1 “错误内容在 log 里可见” 的兑现属实。
      this.logIfSwallowedByAbortFallback(err, params.sessionKey);
      // 不在此处修孤儿：下一 turn 起点的 `repairOrphanToolUses` 从磁盘
      // 状态统一修复（§7.3）。本处只专注于“优雅返回 aborted”。
      return this.buildAbortedResult(lastContent, {
        usage: totalUsage,
        toolRounds: totalToolRounds,
      });
    }
    throw err;   // 非 abort（如 ContextOverflowError）控制权还给 run() 外层 retry
  }
}
```

### 7.3 孤儿 tool_use 修复（turn 起点处理，载入边界不变量）

场景：assistant msg 含 tool_use 已写入 session，但 tool_result 未补齐——可能来自：user abort、进程崩溃 / SIGKILL / 断电、未处理的 exception、未来未知路径 Bug。下轮 loadHistory 若不修，Anthropic API 直接拒。

**位置**：`runAttempt` 入口，与 `sanitizeSessionTail` 平级串行调用：

```typescript
private async runAttempt(turnCtx, params, ...) {
  this.sanitizeSessionTail(turnCtx);        // 现有：剪 trailing user
  await this.repairOrphanToolUses(turnCtx); // 新增：闭合 tool_use 孤儿
  // ...现有 preflight / loadHistory / user msg append...
}
```

**为什么放在此位而非 abort 出口**（设计拉锅已记于开发日志）：

1. **结构性不变量**：不仅保障 abort。任何路径造孤儿（崩溃 / kill / bug / 中断的 IO / 未来新错误路径）都会在下轮起点得到修复，而不依赖 abort 代码无缺陷执行到尾。
2. **磁盘为真**：从 `sessionManager.getMessages` 读磁盘回放判定，天然规避 in-memory / 磁盘不一致（例如 partial-assistant 写盘失败——abort 出口修会写出"磁盘无 tool_use 但有悬空 tool_result"的更糟糕孤儿，而本方案自然局外）。
3. **abort 出口自洽**：`runAttempt` 的 abort 路径只需专注"优雅返回 aborted result"，不背负 session 修复职责，跨模块耦合变少。
4. **与 `sanitizeSessionTail` 对称的同层职责**：后者处理 trailing user，前者处理 tool_use 孤儿，都是"入口开干前把上次遗留的磁盘破损拾干净"——两个 helper 职责单一、并列可读。

> **不处理的破损类型**（v1 同 `sanitizeSessionTail` 保持保守）：末尾已是完整 user/toolResult 但 pair 前部已碎、多轮 assistant 无 tool_result 夹层、transcript 非末尾位置存孤儿等——都非本方案目标。孤儿只可能出现在末尾 assistant / user pair（先前 pair 已被上次成功发起 API 认可，必定合法）。

**判定与写入**：

```typescript
/**
 * 对 session 末尾 assistant/user pair 里未被 tool_result 覆盖的 tool_use 补写
 * synthetic tool_result 到 session。仅扫末尾 pair，不扫历史位置。
 *
 * 内容文案**统一一句中性文本**（参考 openclaw `repairToolUseResultPairing.makeMissingToolResult`
 * 用一句通用 "missing tool result in session history"）——不假装区分 abort /
 * crash / kill 成因。磁盘状态无法区分 tool-loop abort 与崩溃遗留（两者产生完全
 * 相同的 assistant + orphan tool_use 形状），宁可诚实也不写得块面不对称。
 *
 * 【event.source 字段另行保留】orphan_tool_results_repaired event 仍 emit
 * `source: 'abort' | 'recovered'`，读 `abortMeta.partial` 依据"本次 repair 面对
 * 的是否 partial-stream abort 遗留"——供 audit / test 断言使用，但**不驱动
 * 写入 content**。想追查是否主动 abort，看 `run_end{stopReason:'aborted'}` event，
 * 那才是权威源（session 磁盘只是尽力保一致，不是 audit 源）。
 *
 * try/catch 整包：写盘失败仅 log warn，不抛。未成功修复时，下一次
 * runAttempt 会再试；实在修不了的情况下，LLM 调用会返回 API 400，属于
 * caller 可见的错误而非隐瞒崩溃。
 */
private async repairOrphanToolUses(turnCtx: TurnContext): Promise<void> {
  try {
    const records = this.sessionManager.getMessages(turnCtx.sessionKey);
    if (records.length === 0) return;

    const last = records[records.length - 1]!.message;
    let orphanIds: string[] = [];
    let hint: { partial?: boolean } | undefined;

    // 情况 A：末尾是 assistant 含 tool_use — 全部都是孤儿
    if (last.role === 'assistant' && Array.isArray(last.content)) {
      orphanIds = last.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map(b => b.id);
      hint = last.abortMeta;
    }
    // 情况 B：末尾是 toolResult，上一条 assistant 的 tool_use 对应不全
    // 【R9】包含 R6' 场景（tool 内部响应 signal 抛 AbortError 被
    // executeTool swallow 为 isError=true tool_result——已写入 tool_result，
    // 下面差集自然排除，不重复补写）
    else if (last.role === 'toolResult' && Array.isArray(last.content) && records.length >= 2) {
      const prev = records[records.length - 2]!.message;
      if (prev.role === 'assistant' && Array.isArray(prev.content)) {
        const useIds = new Set(
          prev.content
            .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
            .map(b => b.id),
        );
        const resultIds = new Set(
          last.content
            .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
            .map(b => b.tool_use_id),
        );
        orphanIds = [...useIds].filter(id => !resultIds.has(id));
        hint = prev.abortMeta;
      }
    }

    if (orphanIds.length === 0) return;

    // 统一中性 synth 文案，不看成因（见上方 “openclaw 对齐” 说明）
    const content = '[tool call interrupted; session recovered]';
    const blocks: ContentBlock[] = orphanIds.map(id => ({
      type: 'tool_result',
      tool_use_id: id,
      content,
    }));

    await this.sessionManager.appendMessage(turnCtx.sessionKey, {
      role: 'toolResult',
      content: blocks,
    });
    // source 只读 abortMeta，供 audit / test 区分“是否来自 partial-stream abort
    // 遗留”——**不驱动 content**。tool-loop abort 和崩溃都落入 'recovered'。
    this.emit(turnCtx, {
      type: 'orphan_tool_results_repaired',
      count: orphanIds.length,
      source: hint?.partial === true ? 'abort' : 'recovered',
    });
  } catch (err) {
    log.warn('repairOrphanToolUses failed; leaving session as-is', {
      sessionKey: turnCtx.sessionKey,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
```

> **不变量**：孤儿检查只负责 completeness，不负责 ordering。Anthropic API 只要每个 tool_use 有对应 tool_use_id 的 tool_result，同一条 user message 里顺序任意。

> **Event `orphan_tool_results_repaired`**：新增到 `RunEvent` union（[my-agent/src/core/runner/types.ts](my-agent/src/core/runner/types.ts)，与 `session_tail_sanitized` 同域），供 transcript / audit / 测试断言使用。字段：`count`（补写块数）+ `source: 'abort' | 'recovered'`（源自 abort 还是其他崩溃恢复）。

### 7.4 工具循环间检查

（已含于 §7.2 的 runAttempt 代码块——“∅ while 顶 abort check” + “② for tool_use abort check”。两处 throw 后都被 runAttempt 自己的 try/catch 接住。）

### 7.5 ToolContext 注入 signal

```typescript
const toolCtx: ToolContext = {
  sessionKey: params.sessionKey,
  turnId: params.turnId,
  toolUseId: toolUse.id,
  signal: params.signal,  // ← 替换原来的 undefined
};
```

> **【R6' 与 executeTool 交互奇思】**：tool 若响应 signal（例如 exec 内部杀子进程后
> 抛 AbortError），会被 `executeTool` 现有的 catch 块 swallow 成
> `ToolResult { isError: true, content: 'Error executing tool ...' }`——不会
> 直接抛到 runAttempt 的 try/catch。因此 abort 不是靠工具抛错检测，而是靠
> **下一个 while iteration 顶部的 `signal?.aborted` 检查**（§7.2 ∅）
> —— tool 跑完后时局回到 while，signal 已置 true → throw AbortError →
> runAttempt catch 接住。
>
> 这也解释为什么 D6 "tool 跑完才退" 可以无需额外代码——现有 catch路径
> 自然归位。

## 8. RuntimeApp 改造

### 8.1 Active controller 注册表

```typescript
export class RuntimeApp {
  // ...existing fields...
  
  /** Per-session active turn AbortController. 
   *  - 写：runTurnInternal 入口（清旧 + 设新）
   *  - 写：runTurnInternal finally（清掉自己）
   *  - 读：abortTurn(sessionKey) 公共 API
   *  - 读：close() shutdown 时遍历 abort 所有 */
  private readonly activeAborts = new Map<string, AbortController>();
}
```

### 8.2 `runTurnInternal` 改造

```typescript
private async runTurnInternal(params: RunTurnParams & { turnId: string }): Promise<RunTurnResult> {
  // 防御性补充：正常流里 finally 保证 cleanup（见本函数末尾），
  // 不会出现 stale entry。仅为防未来意外路径（finally 本身 throw、
  // 或某次重构意外提前 return）留一层兑底。命中则 log warn。
  const stale = this.activeAborts.get(params.sessionKey);
  if (stale) {
    log.warn('stale abort controller cleared (defensive)', { sessionKey: params.sessionKey });
    this.activeAborts.delete(params.sessionKey);
  }
  
  // 注册本 turn 的 controller
  const controller = new AbortController();
  this.activeAborts.set(params.sessionKey, controller);
  
  try {
    await this.resources.sessionManager.resolveSession(params.sessionKey);
    // ...existing...
    
    const result = await this.resources.agentRunner.run({
      ...existing,
      signal: controller.signal,  // ← 注入
    });
    
    return result;
  } finally {
    // 只清自己注册的那一个（防止"另一个 turn 已重置 map"误清）
    if (this.activeAborts.get(params.sessionKey) === controller) {
      this.activeAborts.delete(params.sessionKey);
    }
  }
}
```

### 8.3 公共 API

```typescript
/**
 * Abort the active turn on `sessionKey` AND drop any queued (followup)
 * messages for that session. See §0 D3 — single-step "stop everything
 * for this session" semantics.
 *
 * 返回 `{ aborted, dropped }`（两个字段正交）：
 *  - `aborted`: 是否有 active turn 被 abort（`activeAborts` 命中）
 *  - `dropped`: 从 `messageQueueBySession` 里被清空的消息数（可为 0）
 *
 * `aborted === false && dropped === 0` 时表示无事发生，此时 event 也不 emit。
 * Channel / library caller 可直接用返回值渲染（CLI: "[⚠ aborted 1 turn(s);
 * dropped 3 queued message(s)]"），无需回读 RuntimeApp 内部状态或订阅
 * `messages_dropped` event。
 *
 * Never throws — 包括 EventEmitter emit 抛错（见下面 emit 契约）也会被
 * swallow + log warn。
 *
 * Cascade: 通过 AbortSignal 透传，正在跑的子 subagent 也会自动 abort。
 * `messages_dropped` runtime event 仍照常 emit，供 library 用户 /
 * telemetry 消费；事件字段 `dropped` 与本 API 返回值 `dropped` 同义。
 * Channel 侧走返回值路径以避免 event 订阅顺序敏感问题。
 *
 * 【pending steering 处理】runAttempt 内 abort 命中时未注入的 steering
 * 消息会被丢弃，仅写 `log.info`，**不计入本 API 的 `dropped` 返回值，
 * 也不计入 `messages_dropped` event**。见 §7.2 R5'。
 *
 * 【emit 契约】本 API 声明 "never throws"，但 Node EventEmitter.emit 是
 * 同步调用 subscriber——subscriber 抛错默认会传出。所以 emit 必须包
 * try/catch（下面 `safeEmit`），把 subscriber 错误降级为 log warn。
 * 该契约同样适用于 runtime 里其他"never throws"标注的 API（若有），
 * impl 时应抽出通用 `safeEmit` 工具。
 */
abortTurn(sessionKey: string): { aborted: boolean; dropped: number } {
  const controller = this.activeAborts.get(sessionKey);
  const queue = this.messageQueueBySession.get(sessionKey);
  const dropped = queue?.length ?? 0;
  const aborted = !!controller;

  if (!aborted && dropped === 0) return { aborted: false, dropped: 0 };

  if (controller) controller.abort();
  if (dropped > 0) {
    this.messageQueueBySession.delete(sessionKey);
    this.safeEmit({
      type: 'messages_dropped',
      sessionKey,
      reason: 'abort',
      dropped,   // = messageQueueBySession 丢弃数；pending steering 不计入（§7.2 R5'）
    });
  }
  log.info('turn aborted by user', { sessionKey, aborted, dropped });
  return { aborted, dropped };
}

/** emit 抛错时降级为 warn 而非传出，保证调用方 "never throws" 契约。 */
private safeEmit(event: RuntimeEvent): void {
  try {
    this.emit(event);
  } catch (err) {
    log.warn('RuntimeEvent subscriber threw; swallowed', {
      eventType: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
```

> **NOTE**: steer 模式下 `steeringInboxBySession` 已由 `runTurn` 的 finally
> 自动清，本 API 不需要额外处理。

新增 RuntimeEvent variant（[runtime/types.ts](../../src/runtime/types.ts)）：

```typescript
| {
    type: 'messages_dropped';
    sessionKey: string;
    /** 触发原因。v1 只有 'abort'，预留 'shutdown' 等。 */
    reason: 'abort';
    /**
     * 从 messageQueueBySession 中被丢弃的 queued/followup 消息数。
     * 与 `abortTurn()` 返回值的 `dropped` 字段同义，方便 caller 跨返回值
     * 与 event 两条路径对齐。
     *
     * **不包含以下丢弃源**：
     *  - `runAttempt` 内 `pendingSteeringMessages` 未注入部分（§7.2 R5'）
     *    ——仅写 log，不计入本字段。理由：触发窗口极窄 (count 实际多为 0
     *    或 1)，而且 pending 位于 AgentRunner 局部变量、RuntimeApp 拿不到；
     *    强行传递会引入 turnCtx / finally 合并 emit 等跨模块耦合，代价远高于
     *    信息价值。log 足以满足审计 / 调试需求。
     */
    dropped: number;
  }
```

> **审计完整性**：`dropped === 0` 但 abort 命中了 active turn 时，event
> 可省略不 emit（无 audit 价值）。pending steering 丢弃信息在 log
> 里可 grep，不进该 event。

### 8.4 `runSubagentTurn` signal【M2】

库 API 不需要加 options 参数——`SubagentRunInput.signal?` 已存在（§6.4）。
caller 直接通过 input 传：

```typescript
await app.runSubagentTurn({
  subagentType: 'general-purpose',
  description: 'demo',
  prompt: 'hello',
  trigger: { source: 'library', callerLabel: 'demo' },
  lifecycle: 'blocking',
  signal: myController.signal,   // ← 直接放这里
});
```

`RuntimeApp.runSubagentTurn(input)` 签名保持单参数不变。`runSubagentTurnImpl` 透传
`input.signal` 给 `SubagentRunner.run(req.signal=input.signal)`，再透给子 `RunParams.signal`（§9）。

### 8.5 shutdown 路径（D4 决策）

```typescript
async close(reason?: string): Promise<RuntimeShutdownReport> {
  // ...existing...
  
  // 先 abort 所有 active turn，避免 close 被响应 signal 的慢 turn 卡住
  for (const [sessionKey, controller] of this.activeAborts) {
    log.info('aborting in-flight turn on shutdown', { sessionKey });
    controller.abort();
  }
  // activeAborts 不主动清，让各 runTurnInternal 自己的 finally 清。
  // 【R7 注释】此处遍历同时 in-flight finally 会 `delete` 同一 map：Node
  // 单线程 + `controller.abort()` 只是同步 flip signal + queue microtask
  // emit 'abort' 事件，不会同步 resolve await——所以 runTurnInternal 的
  // finally 不会在本 for 循环内被同步触发，遍历安全。impl 如把 abort
  // 改成同步等 in-flight cleanup 完成，必须先 snapshot entries 再遍历。
  
  // 老实等所有 in-flight Promise 收完——多久都等。
  // 不响应 signal 的 tool（v1 除 exec 外的 builtin / MCP / 第三方）会
  // 使 close 挂到 tool 自然完成为止。runtime 不设内建 timeout，理由
  // 与 caller 应对见下方「shutdown 时长界限」段。
  await Promise.allSettled([...this.inFlightRuns]);
  // ...
}
```

#### shutdown 时长界限（v1 不承诺墙钟上限）

`close()` 走 `Promise.allSettled` 等所有 in-flight turn 收完，**不设内建 timeout**。
若 turn 中有不响应 signal 的 tool，`close()` 会等到该 tool 自然完成——可能任意长。

**为什么不加 timeout**（明示 v1 立场）：
- 强制放弃等待，tool 要么继续后台跑（进程无法退出），要么由 caller `process.exit()` 强杀
  ——后者可能在 tool 事务中途（DB 写 / 文件 rename / partial patch）造成数据损坏
- runtime 无法判断哪些 tool 可安全打断，把决策外包给 caller 也没有普适答案
- timeout 值无普适选择（5s 误伤长编译；30s 已被 K8s SIGKILL）
- 这是 D6（"tool 跑完才退"）的诚实推论：既然承诺 tool 跑完，就不能在 shutdown
  时反悔说 "跑太久不等了"

**caller 侧应对**（按危险度递增）：
1. **首选** — 交互式 shutdown：`abortTurn(sk)` → `await runTurn` 返回
   `stopReason='aborted'` → 确认干净后再 `close()`。runtime 层保证这条路径干净。
2. **部署期** — 审计所用 tool 集合的 signal 响应度；对已知慢工具（`apply_patch`
   大补丁 / `web_fetch` 大文件）主动补 signal 响应（见 §17 D6 follow-up）。
3. **环境层** — K8s `terminationGracePeriodSeconds` / systemd `TimeoutStopSec`
   设为 ≥ 最长 tool 预期时长，让容器管理器给出足够 grace period。
4. **万不得已** — caller 自己包 timeout + 强退：
   ```typescript
   await Promise.race([
     app.close(),
     new Promise(r => setTimeout(r, 30_000)),
   ]);
   process.exit(0);   // 强退——接受可能中断 tool 事务的风险
   ```
   runtime 明确**不**内建该逻辑——语义（"放弃等待 vs 强杀"）由 caller 场景决定。

**v1 `close()` 契约总结**：
1. abort 所有 active turn（signal 立即同步置位）
2. 等到所有 in-flight Promise settle（任意长）
3. 总是 resolve（never rejects），返回 `RuntimeShutdownReport`

**v1 明确不承诺**：
- close 的墙钟上限
- tool 会被强制中断
- 未响应 signal 场景的自动兜底

随 D6 follow-up 逐个补 tool 的 signal 响应，此局限会自然缓解。

**`RuntimeShutdownReport` shape（v1）**：v1 **不**在 Report 里区分 abort-on-shutdown
与正常 close ——Report 结构保持现状，不新增 `abortedOnShutdown` 之类字段。理由：
(a) shutdown 路径下所有 in-flight turn 都被 abort，Report 里区分意义有限；
(b) 各 turn 的 `stopReason='aborted'` 已通过 `run_end` event 独立可观测，audit /
telemetry 场景应订阅 event 而非依赖 Report；(c) 保持 Report 结构最小化，避免 v1
过早定型。若未来 (turn timeout 上线、批量 shutdown audit 需求出现) 需要精细区分，
再按需扩字段——届时不构成破坏性变更。

## 9. SubagentRunner 改造

`SubagentRunRequest.signal` 已有。SubagentRunner.run 把它当作 `RunParams.signal` 透给子 AgentRunner.run 即可（一行）：

```typescript
const runParams: RunParams = {
  sessionKey: childSessionKey,
  // ...existing...
  signal: req.signal,  // ← 新增
};
```

AbortError 不会从子 AgentRunner.run 抛出 —— 它走的是 §7.1 的 catch → 返回 `RunResult.stopReason='aborted'`。所以 SubagentRunner.run 现有 try-catch **不变**，只要改 outcome mapping：

```typescript
// 现有：
const outcome: SubagentRunResult['outcome'] =
  runResult.stopReason === 'max_llm_calls' ? 'max_llm_calls' : 'ok';
// 改为：
const outcome: SubagentRunResult['outcome'] =
  runResult.stopReason === 'aborted' ? 'aborted' :
  runResult.stopReason === 'max_llm_calls' ? 'max_llm_calls' : 'ok';
```

原有 catch 块（捕获未预期 err 转 'error' outcome）逻辑保持，不需要为 abort 单独加分支 — abort 走的是 happy path 的 result mapping。

## 10. task tool 改造

只一行：`ctx.signal` 透给 SubagentRunner — 已经在 [task-tool.ts](my-agent/src/core/tools/builtin/task/task-tool.ts) 里写了：

```typescript
signal: ctx.signal,  // 已存在；之前 ctx.signal === undefined
```

`formatSubagentResult` 的 'aborted' 分支也已经在了（v1 不可达，现在变可达）：

```typescript
case 'aborted':
  return { content: 'Subagent was aborted before completing.', isError: true };
```

## 11. AnthropicClient 改造

只加 signal 透传，不动错误处理路径——SDK 抛 AbortError 后自然传出，后续语义全在上层收拢（§7.2）。

```typescript
async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
  // ...existing...
  const stream = this.client.messages.stream(
    { ...sdkParams },
    params.signal ? { signal: params.signal } : undefined,
  );
  for await (const event of stream) { ... }
  // 原有 try/catch 不动 — SDK 会抛 AbortError，自然传出。
}
```

> **验证点**（impl 时）：从 `@anthropic-ai/sdk` 跳进看 error 类名是 `AbortError` / `APIUserAbortError` / 别的，同步到 `AgentRunner.isAbortError` 的名字列表。

## 12. CliChannel 改造（D1 决策）

```typescript
// 新增常量
const CTRL_C_EXIT_WINDOW_MS = 1000;  // 与 openclaw 对齐

export class CliChannel implements Channel {
  private lastCtrlCAt = 0;
  private abortHooks?: AbortHookBindings;
  /** SIGINT handler 保存为 bound instance field，stop() 时 removeListener。
   *  避免反复 start/stop 时 process.on('SIGINT', arrow) 无法解绑造成泄漏。 */
  private readonly boundSigIntHandler = () => this.handleSigInt();
  
  async start(): Promise<void> {
    // ...existing readline 逻辑...
    
    // 【M1】接管 SIGINT——需先 removeAllListeners('SIGINT')。
    // 原因：readline.Interface 默认在 process 上有个 SIGINT listener
    // （由 Interface 构造函数添加），会额外调用 close() 之类逻辑。
    // 我们要独占控制时机（abort / warn / exit），先清除后装自己的。
    //
    // 【假设：CliChannel 独占进程 SIGINT】`removeAllListeners('SIGINT')`
    // 是刻意的粗暴——它会连带清除宿主进程中其他库（测试框架、外层 embed
    // 场景的 host 等）注册的 listener。此假设对应 CliChannel 的典型用例：
    // interactive CLI 独占前台进程。若未来出现 "CliChannel 被嵌入其他进程"
    // 的场景，需要重新设计——候选方案：
    //   (a) 先 snapshot 现有 listener、在 CliChannel.stop() 里恢复；
    //   (b) 不清除，只叠加自己的 handler，依赖 Node 会调用所有 listener
    //       的行为——但 readline 默认 listener 的 close 逻辑会干扰双击
    //       退出 UX，需要额外协调；
    //   (c) 通过构造参数让 caller 显式选择接管策略。
    // impl 时以 code comment 标注该假设，方便未来 embed 场景 grep。
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', this.boundSigIntHandler);
  }

  async stop(): Promise<void> {
    // 【M1'】卸载自己装的 SIGINT handler，避免：
    //  (a) 宿主进程后续不再希望 CliChannel 拦截 Ctrl+C 时 handler 泄漏
    //  (b) 将来 restart（同一进程内 stop()→start()）双绑
    // 不负责恢复 start() 时被 `removeAllListeners('SIGINT')` 清掉的其他 listener
    // ——与 §12 M1 同源假设（CliChannel 独占进程 SIGINT）。
    process.off('SIGINT', this.boundSigIntHandler);
    // ...existing shutdown 逻辑...
  }
  
  private handleSigInt(): void {
    const now = Date.now();
    const sinceLast = now - this.lastCtrlCAt;
    
    // 双击：1s 内连按 → exit
    if (this.lastCtrlCAt > 0 && sinceLast <= CTRL_C_EXIT_WINDOW_MS) {
      this.output.write(red('\n[exiting]\n'));
      process.exit(130);
    }
    
    this.lastCtrlCAt = now;
    
    // 【R2 与 D3 语义一致】判断"是否有东西可 abort"时必须同时考虑：
    //  (i) 有 active turn（→ 会被 abort）
    //  (ii) 有 queued messages（→ 会被 drop，见 §8.3 D3）
    // 仅当两者都为空时才提示 "press again to exit"；否则统一走
    // abortTurn 路径——否则将出现 "queue 有堆积消息但 Ctrl+C 只提示退出"
    // 的不一致（与 §14.1 CliChannel R2 测例矛盾）。
    const targets = this.abortHooks?.querySessionsNeedingAbort() ?? [];
    if (targets.length === 0) {
      this.output.write(dim('\n[press Ctrl+C again within 1s to exit]\n'));
      return;
    }
    
    // 有 active turn 或 queued messages → abort 所有；abortTurn 返回
    // { aborted, dropped }，一次拿到全部信息后本地直接渲染，避免
    // 依赖 RuntimeEvent 跨层 wiring。
    let totalAborted = 0, totalDropped = 0;
    for (const sk of targets) {
      const r = this.abortHooks!.abortTurn(sk);
      if (r.aborted) totalAborted++;
      totalDropped += r.dropped;
    }
    // 渲染：totalAborted 和 totalDropped 可能各自为 0——只拼非零部分。
    const parts: string[] = [];
    if (totalAborted > 0) parts.push(`aborted ${totalAborted} turn(s)`);
    if (totalDropped > 0) parts.push(`dropped ${totalDropped} queued message(s)`);
    this.output.write(yellow(`\n[⚠ ${parts.join('; ')}]\n`));
  }
  
  // Channel 接口的 optional 方法（见下）
  bindAbortHooks(hooks: AbortHookBindings): void {
    this.abortHooks = hooks;
  }
}
```

### Channel 接口扩展（D1 配套）

`adapters/channel/types.ts` 给 `Channel` 接口加 optional method，避免 RuntimeApp 用 `instanceof CliChannel` 做类型耦合：

```typescript
export interface AbortHookBindings {
  /**
   * 返回当前需要 abort 的 sessionKey 列表 —— 包含：
   *  (i) 有 active turn 的 session (activeAborts 命中)
   *  (ii) 有 queued/followup messages 的 session (messageQueueBySession 非空)
   * 两者 union，去重。为空时 CLI 可安全地仅提示退出，不需要调 abortTurn。
   */
  querySessionsNeedingAbort(): string[];
  /** 触发 abort + drop queue；返回精确数字供 channel 渲染 */
  abortTurn(sessionKey: string): { aborted: boolean; dropped: number };
}

export interface Channel {
  // ...existing fields...
  /**
   * 可选：channel 想自主触发 abort（如 CLI 的 Ctrl+C）时，
   * runtime 通过此方法注入回调。Channel 不需要 import RuntimeApp。
   */
  bindAbortHooks?(hooks: AbortHookBindings): void;
}
```

`RuntimeApp.registerChannel` 配套：

```typescript
registerChannel(channel: Channel): void {
  // ...existing...
  channel.bindAbortHooks?.({
    querySessionsNeedingAbort: () => {
      const set = new Set<string>(this.activeAborts.keys());
      for (const [sk, queue] of this.messageQueueBySession) {
        if (queue.length > 0) set.add(sk);
      }
      return [...set];
    },
    // 直接透传——`RuntimeApp.abortTurn` 返回值形状已与 `AbortHookBindings.abortTurn`
    // 契约一致（§8.3），无需 wrapper 层重算 aborted/dropped。
    abortTurn: (sk) => this.abortTurn(sk),
  });
}
```

> **NOTE**：`abortTurn` API 返回 `{ aborted, dropped }`（§8.3），wrapper 直接透传。
> RuntimeEvent `messages_dropped` 仍照常 emit（library 用户、telemetry 用），
> CLI 渲染走返回值这条独立通路不依赖 event。
>
> **【N2】时序保证**：`RuntimeApp.registerChannel` 在 channel 注册时同步调用 `bindAbortHooks?(...)`；channel 随后在其 `start()` 里注册 SIGINT handler。调用顺序必是 register → start，所以 SIGINT 发生时 hooks 必已 bound，无 race。

### `subagent_end{outcome:'aborted'}` 渲染

PR-7 的 CliChannel switch 已经有 `subagent_end` case；只需在 colorize 决策里把 `'aborted'` 也走 red 分支：

```typescript
const colorize = event.outcome === 'ok' ? cyan : red;  // 已经 OK
```

## 13. WebSocketChannel 改造（D5 决策）

inbound message 加新类型，protocol 文档同步：

```typescript
// WebSocketChannel.handleMessage switch
case 'abort_turn': {
  const sessionKey = readNonEmptyString(message.sessionKey, 'sessionKey');
  // 走 §12 同一套 bindAbortHooks 注入的 abortTurn 回调
  this.abortHooks?.abortTurn(sessionKey);
  // dropped count 通过随后的 RuntimeEvent messages_dropped 推送（library 用户消费）
  // 或前端通过 run_end{stopReason:'aborted'} 感知；本协议不内联 ack
  break;
}
```

WebSocketChannel 实现 `bindAbortHooks?` — 与 CliChannel 共用 §12 的 `AbortHookBindings` 接口，零 RuntimeApp ↔ Channel 类型耦合。

无显式 ack；客户端通过：
- `run_end` event（stopReason='aborted'，已有 fanout 路径自动 forward）
- 如有订阅 RuntimeEvent，可再加 `messages_dropped` 推送（可选）

知晓 abort 完成。

### 13.1 Web client 端（[clients/html/chat.html](../../clients/html/chat.html)）

单文件 demo client 也要跟着改，否则 WS 协议改完 client 用不上：

1. **"Stop" 按钮**：加在 message input 附近，仅在 turn active 期间可点击（可通过接收 `run_end` 后自动隐藏 / `run_start` 后自动显示实现）。
2. **点击行为**：发送 `{type:'abort_turn', sessionKey: currentSessionKey}`。
3. **渲染 aborted**：`onmessage` handler 里已经处理 `run_end`；对 `stopReason === 'aborted'` 特化显示 `⚠ Turn aborted` 或类似图标 / 颜色区分，避免和正常 `end_turn` 混淆。
4. **渲染 dropped**：（可选）若订阅 RuntimeEvent，处理 `messages_dropped{reason:'abort',dropped}` 显示 `Dropped N queued message(s)`。当前 chat.html 主要走 AgentEvent 流，RuntimeEvent 需要额外订阅逻辑——**v1 可省略**，后续需要时补。
5. **UX**：无双击语义（浏览器已无 Ctrl+C 与本 tab 交互，Stop 按钮直接生效）。

关键改动量：~30-50 行 JS + 一个按钮 + 一小段状态 tracking。不需要构建，保持 chat.html 单文件性。

**测试**：`WebSocketChannel.test.ts` 已有 protocol 层测试（inbound abort_turn 触发 handler）；chat.html 手动 smoke test 即可，不写自动化。

## 14. Tests

### 14.1 单元

- AgentRunner.test.ts:
  - abort during LLM stream → stopReason='aborted', partial assistant 写入
  - abort during tool loop → 当前工具跑完，下一工具不启动
  - abort before run starts (`signal.aborted=true` 入口) → 立即返回
  - **【孤儿修复—turn 起点（abort 遗留）】** abort 造孤儿（末尾 assistant 含 tool_use 且 abortMeta.partial=true）→ 下一 turn `repairOrphanToolUses` 写 synthetic tool_result（content=`'[tool call interrupted; session recovered]'`）+ emit `orphan_tool_results_repaired{count,source:'abort'}`。断言：content 与未携 abortMeta 的孤儿修复一致（仅靠 event.source 区分来源）。
  - **【孤儿修复—非-abort 来源】** 预置一个无 abortMeta 的 assistant+tool_use 孤儿到 session（模拟崩溃恢复）→ turn 起点修复，content=`'[tool call interrupted; session recovered]'` + emit source:'recovered'
  - **【孤儿修复—no-op】** 干净 session（末尾非 assistant 或 pair 完整）→ repair 不写盘、不 emit
  - **【孤儿修复—write 失败不 crash】** mock `sessionManager.appendMessage` 在 repair 时抛 → log warn，turn 继续启动（不 rethrow）
  - **【孤儿修复—partial-assistant 写盘失败边角】** mock partial assistant appendMessage 抛 IO error → 磁盘无 assistant → 下轮 getMessages 无孤儿 → repair no-op（验证 “从磁盘为真” 的不一致免疫属性）
  - **【R2 usage 累计】** abort 前跑过 3 轮 tool call，每轮 mock usage `{in:100,out:50}`；abort 命中 partial stream 分支 → 返回 `RunResult.usage = {in:300,out:150}` + `toolRounds:3`（非 0/0）
  - **【R8 partial tool_use 完整性】** stream 到 tool_use.input 半截时 abort → session 里 assistant 消息**不含**残缺 tool_use block（只含完整的 text + 完整的 tool_use）
  - **【R11 isAbortError fallback + 诊断 log】** SDK 抛 `Error` 名字为 `"NetworkError"` 但 `params.signal.aborted === true` → runAttempt 走 abort 分支 **且** `log.warn('non-abort error swallowed by abort fallback', ...)` 被调用（断言 errName === 'NetworkError'）；对照组：`err.name === 'AbortError'` 时不应调用该 warn log
- SubagentRunner.test.ts:
  - parent signal abort → child outcome='aborted'，runner 不抛
- RuntimeApp.test.ts:
  - `abortTurn(sk)` 返回 `{ aborted, dropped }` 4 组组合语义（见下面各 case）
  - **stale controller 防御**：手动 pre-set stale entry 到 activeAborts → 启新 turn → 旧 entry 被清 + emit warn log。（正常流 finally 保证 cleanup，本测试仅验证防御代码行为，未来若删除防御代码本测试也可一并删除。）
  - **D3 队列同时清空**：`messageQueueBySession[sk]` 有 N 条 + 1 个 active turn → abort 后队列 size 变 0 + emit `messages_dropped{dropped:N}` + 返回 `{ aborted: true, dropped: N }`
  - 没有 active turn 但 queue 有 N 条 → 只清 queue + emit `messages_dropped{dropped:N}`；返回 `{ aborted: false, dropped: N }`
  - 有 active turn 但 queue 空 → abort turn + 不 emit（dropped=0）；返回 `{ aborted: true, dropped: 0 }`
  - 无 active + 无 queue → 返回 `{ aborted: false, dropped: 0 }`，不 emit
  - 跨 session 不受影响：abortTurn(sk1) 不动 sk2 的 queue
  - **【pending steering log-only】** runAttempt 内 `pendingSteeringMessages.length > 0` 时命中 abort → log.info('dropped pending steering on abort', {sessionKey, count}) 被调用；`messages_dropped` event **无变化**（`dropped` 仍只反映 queue 丢弃数，不含 steering count）
  - **【R10 safeEmit】** 注册一个抛错的 RuntimeEvent subscriber → 调 abortTurn 触发 emit → subscriber 抛 → API 仍正常返回 `{ aborted, dropped }`（反映真实状态），不 rethrow + log warn
  - shutdown 路径：先 abort active turn 再 close
  - **shutdown timing（响应 signal 路径）**：close() 调用时有 active turn，turn 内是响应 signal 的 mock LLM stream（200ms 后 abort 自然完成）→ close() 在 300ms 内 resolve。**不覆盖** "不响应 signal 的 tool 场景"——那是 v1 明示的已知局限（§8.5），close 会等到 tool 自然完成，由 caller 场景决定是否可接受（跑 30s mock tool 让测试挂 30s 无意义）。
- CliChannel.test.ts (新建):
  - 单 Ctrl+C 触发 `abortHooks.abortTurn`；双 Ctrl+C 在窗口内退出（mock process.exit）
  - hooks 未 bind 时（独立运行）Ctrl+C 退一样工作
  - **【R2 aborted 语义】** active turn 不存在 + queue 有 3 条 → Ctrl+C 后 CLI 输出 `dropped 3 queued message(s)` 但**不**出现 `aborted N turn(s)` 段（`totalAborted === 0`）
- WebSocketChannel.test.ts:
  - inbound `abort_turn` 触发 `abortHooks.abortTurn` 回调
  - `run_end{stopReason:'aborted'}` event 被 fanout 至 WS subscriber（证实客户端通过 run_end 感知 abort完成的接口可用）

### 14.2 集成

`scripts/test-abort-e2e.ts`（mock LLM）+ `scripts/test-abort-live.ts`（真 LLM，模拟用户按 Ctrl+C 1s 后看到 `aborted`）。

## 15. Comparison with openclaw

(原 §15 略写，关键差异：)

| 维度 | openclaw | my-agent v1 (本 spec) |
|---|---|---|
| Controller 存储 | per-session | per-session（同） |
| Signal 组合 | `AbortSignal.any([外部, timeout])` | v1 单 signal；v2 timeout 再加 any |
| Cascade | 通过 signal 透传，零显式代码 | 同 |
| Tool mid-execution | 不传 signal 给 tool，跑完才退 | **传** signal（基础设施就位），但 v1 只 exec 主动响应；MCP / 其他工具 opt-in。契约层面承诺"停 loop 不保证停 in-flight"——比 openclaw 诚实，避免假承诺。 |
| Stop reason 命名 | `state='aborted'` + `stopReason='cancelled'`（双字段）| 单字段 `stopReason='aborted'` |
| Partial 持久化 | abortMeta | 同 |
| **Queue 处理** | `followup` 模式无独立 queue（用 spawn / steer）| **abort 同时清空 messageQueueBySession**，emit `messages_dropped` — 与 openclaw 语义对齐 |
| Double Ctrl+C | 1000ms 窗口 + hasInput 三态 | 1000ms 窗口 + 二态（无 input buffer 概念） |
| Stale controller | 入口必清 | 同（§8.2） |
| **Shutdown wait** | 未追（无对应文档） | 老实 `Promise.allSettled`，无 timeout；强杀由 caller 决定（§8.5） |

## 16. PR breakdown

带每 PR 触碰的文件 + 新增测试。列宽紧凑，等同 impl 文档功能——**不另起 impl 文档**。

| PR | 触碰文件 | 测试增加 | 依赖 |
|---|---|---|---|
| **abort-session-types** | `core/session/types.ts`（MessageRecord.message + abortMeta）<br>`core/session/SessionManager.ts`（appendMessage 签名） | `SessionManager.test.ts`（+2 cases：写 / 读 abortMeta round-trip） | 无 |
| **abort-types** | `core/runner/types.ts`（RunParams.signal）<br>`core/tools/types.ts`（ToolContext.signal 注释）<br>`core/subagent/types.ts`（SubagentRunRequest.signal 注释）<br>`adapters/llm/types.ts`（ChatParams.signal） | 无（纯类型） | abort-session-types |
| **abort-runner** | `core/runner/AgentRunner.ts`（`isAbortError` / `isAbortByName` / `logIfSwallowedByAbortFallback` / `buildAbortedResult` / `repairOrphanToolUses`（turn 起点，与 `sanitizeSessionTail` 平级）/ 循环间 abort check / ToolContext.signal 注入 / runAttempt 内层 try-catch 处理 abort / partial assistant 写入 session 携 abortMeta）<br>`core/runner/types.ts`（RunEvent 加 `orphan_tool_results_repaired`） | `AgentRunner.test.ts`（+11 cases 见 §14.1）| abort-types 且 abort-session-types |
| **abort-llm** | `adapters/llm/AnthropicClient.ts`（chatStream signal 透传，无错误处理改动）| `AnthropicClient.test.ts`（+1 case：signal 已 abort 立即抛 AbortError）| abort-types |
| **abort-runtime** | `runtime/RuntimeApp.ts`（activeAborts + abortTurn + runTurnInternal 注入 + shutdown abort-then-wait + registerChannel 加 bindAbortHooks 调用）<br>`runtime/types.ts`（RuntimeEvent 加 messages_dropped） | `RuntimeApp.test.ts`（+10 cases 见 §14.1）| abort-runner |
| **abort-subagent** | `core/subagent/SubagentRunner.ts`（RunParams.signal 透传 + outcome mapping 加 'aborted'）<br>`core/tools/builtin/task/task-tool.ts`（无改动，`signal: ctx.signal` 已存在）| `SubagentRunner.test.ts`（+1 case：parent signal abort → child outcome='aborted'） | abort-runner |
| **abort-cli** | `adapters/channel/CliChannel.ts`（SIGINT handler + removeAllListeners + double Ctrl+C + `stop()` 里 removeListener + AbortHookBindings + bindAbortHooks）<br>`adapters/channel/types.ts`（Channel 接口加 optional bindAbortHooks + AbortHookBindings 类型） | `CliChannel.test.ts` **新建**（+4 cases 见 §14.1） | abort-runtime |
| **abort-ws** | `adapters/channel/WebSocketChannel.ts`（inbound `abort_turn` case + bindAbortHooks 复用 §12 接口）<br>**`clients/html/chat.html`**（Stop 按钮 + `abort_turn` 发送 + `run_end{aborted}` 特化渲染，§13.1） | `WebSocketChannel.test.ts`（+2 cases：inbound abort_turn 触发 abortHooks.abortTurn / stopReason='aborted' event 被 fanout 至 WS subscriber）| abort-runtime |
| **abort-e2e** | `scripts/test-abort-e2e.ts` **新建**（mock LLM 模拟长 turn + 触发 abort，断言 stopReason / usage / session partial write / orphan 补齐 4 组场景）<br>`scripts/test-abort-live.ts` **新建**（真 LLM，模拟按 Ctrl+C 1s 后看到 aborted） | E2E script 自带断言 | 全部之后 |

**约 9 个 PR**，依赖链：`session-types → types → { runner ∥ llm } → runtime → { subagent ∥ cli ∥ ws } → e2e`。两处 `∥` 是仅有的并行点：runner 和 llm 都只依赖 types，可同时开工；runtime 落地后 subagent / cli / ws 三者相互独立可同时开工。

## 17. Open questions for future versions

- Turn timeout 用户代码 / runtime 层包 abort——本 spec 的 `abortTurn` API + `AbortSignal.any([这个, setTimeout-trigger])` 組合即可实现，不需要额外架构
- abort 时是否要 `before_abort` / `after_abort` hook 给 audit / cleanup
- subagent `abortPolicy: 'cascade' | 'detach'` config — 后台 subagent 出现后再说
- Web channel "stop button" UX 一体化（要 ack 才能精确状态）
- **慢工具 abort 响应**（D6 follow-up）：v1 后若用户抱怨 `web_fetch` / `grep_search` 卡几秒 / 几十秒无法快速 abort，单独按需补：
  - `web_fetch`：一行 `AbortSignal.any([timeoutSignal, ctx.signal])` compose
  - `grep_search` / `file_search`：walker 加 `if (ctx.signal?.aborted)` 检查
  - `apply_patch`：hunk 间 check（参考 openclaw）
  - 每条改动独立、可增量上 — 不需要重构架构
