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
| D3 | session 消息队列里**未处理**的 turn，abort 时怎样？ | **同时清空** — `abortTurn(sk)` 既 abort 当前 turn 也 `messageQueueBySession.delete(sk)`。CLI 单次 Ctrl+C 干净。理由：与 openclaw 行为一致；用户按 Ctrl+C 时通常想"我不要 agent 继续了"，而不是"只停这个，下条还要跑"。`followup` 队列里的消息只是字符串副本，user 知道发过什么，必要时再敲一次成本低。被 drop 的消息数会写 log + emit `messages_dropped` runtime event，避免静默丢失。 | `✓` |
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

- 用户 Ctrl+C 后 ≤200ms 内停止 LLM streaming + 正在跑的 exec 进程
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

`SubagentRunRequest.signal?` 已存在 — 删除"v1 未消费"注释，注明语义。

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

private isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (!(err instanceof Error)) return false;
  // 主判据：错误名字匹配。
  // 标准 DOMException + Node native fetch: name === 'AbortError'
  // Anthropic SDK 可能招 `APIUserAbortError` 或 `AbortError` — 实现时
  // 需 manual verify（跳进 @anthropic-ai/sdk 看），必要时补加名字
  if (
    err.name === 'AbortError' ||
    err.name === 'APIUserAbortError' ||
    (err as { code?: string }).code === 'ABORT_ERR'
  ) {
    return true;
  }
  // Fallback：SDK 升级或第三方 wrapper 可能吞掉 err.name。若调用方能提供
  // 关联 signal 且 signal.aborted === true，倾向按 abort 处理，避免 abort
  // 语义悄悄退化成 'error' 停止原因。调用点凡是拿得到 signal 都应传入。
  if (signal?.aborted) return true;
  return false;
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
**不** rethrow 到 `run()`。理由：`run()` 的 catch scope 拿不到 `runAttempt` 的
in-memory `messages` 数组（局部变量），而 §7.3 helper 需要它。让 `runAttempt`
自己负责 abort 的完整语义闭环，`run()` 层面 abort 与正常 turn 完成外观完全一致
（返回 stopReason='aborted' 的 RunResult）。

### 7.2 Partial assistant + runAttempt 内部 abort 处理（D2 + R1 决策）

两个 abort 触发点都在 `runAttempt` 内处理（不 rethrow到 `run()`）：

**（1）callLLMStream 拿到 AbortError（partial stream）**：

```typescript
// callLLMStream catch 分支——返回类型保持现状，仅用 stopReason 区分
// （M3：不加 aborted: true 字段，避免 inline 返回类型满天飞 bool flag）
catch (err) {
  if (this.isAbortError(err, params.signal)) {
    // flush 已 buffered 的 currentText 到 contentBlocks
    if (currentText) contentBlocks.push({ type: 'text', text: currentText });
    // 【R8】过滤未闭合的 tool_use：Anthropic streaming 的 tool_use.input
    // 是由 input_json_delta 增量组装，abort 命中时可能是 `'{"path": "foo/ba'`
    // 这种残缺 JSON。若直接把残缺 block 写进 session，下一 turn LLM 看到
    // input=null 或半截 JSON 的 assistant 消息可能触发奇怪重试。所以只保留
    // impl 层标记为"完整"的 tool_use（例如 SDK 已 emit content_block_stop
    // 事件或本地已 JSON.parse 成功）。impl 侧维护该 completeness 标记；
    // spec 层的不变量：flush 出去的 contentBlocks 里每个 tool_use.input
    // 必须是可 parse 的完整对象。
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
      // 【R6 报告】丢弃数量作为 `messages_dropped` event 的 `steering` 字段
      // 上报（与 `queued` 队列丢弃解耦，见 §8.3 event schema）。由于此路径
      // 在 runAttempt 内、runTimeApp.abortTurn 之外，具体上报机制：runAttempt
      // 抛 AbortError 前记录 count 到 turnCtx，runTurnInternal 的 finally
      // 读取后与 RuntimeApp.abortTurn 的 queued count 合并 emit。impl 时
      // 若发现该 wiring 过重，可折中改为 runAttempt 独立 emit
      // `{steering: N, queued: 0}` 而 RuntimeApp emit `{steering: 0, queued: M}`
      // ——channel 侧无差别聚合渲染即可。
      if (params.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      // ...pendingSteering 注入 / llm_call emit / callLLMStream...
      
      lastContent = llmResult.content;
      
      // ⑰ Partial stream 分支：callLLMStream 优雅返回 stopReason='aborted'
      if (llmResult.stopReason === 'aborted') {
        messages.push({ role: 'assistant', content: llmResult.content });
        await this.sessionManager.appendMessage(params.sessionKey, {
          role: 'assistant',
          content: llmResult.content,
          abortMeta: { partial: true, stopReason: 'aborted' },   // 需 §6.5
        });
        // M4 孤儿防护路径 (1)
        // NOTE（R4）: helper by-design 会 mutate messages——追加 synthetic
        // tool_result block 。下面 buildAbortedResult 看到的 lastContent
        // 仍是 partial assistant（不受 mutation 影响，因为 lastContent 是
        // llmResult.content 引用，不在 messages 数组里被 mutate）。
        // 【R4b】helper 内部已包 try/catch（见 §7.3），session write 失败
        // 只 log warn，不逃逸——保证 §4 "abort 永远不抛错" 契约。
        await this.appendOrphanToolResultsIfAny(params, messages);
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
    // M4 孤儿防护路径 (2)：工具循环中途 throw 时，assistant msg 可能
    // 已写入 session（含 tool_use），但部分 tool_result 未补齐。扫 in-memory
    // messages 补。
    if (this.isAbortError(err, params.signal)) {
      // R4b：helper 内部 try/catch，不会抛回来
      await this.appendOrphanToolResultsIfAny(params, messages);
      return this.buildAbortedResult(lastContent, {
        usage: totalUsage,
        toolRounds: totalToolRounds,
      });
    }
    throw err;   // 非 abort（如 ContextOverflowError）控制权还给 run() 外层 retry
  }
}
```

### 7.3 孤儿 tool_use 防护（重要，覆盖 2 条路径）

场景：assistant msg 含 tool_use 已写入 messages / session，但 tool_result 还没补齐全部就 abort。下次 turn LLM 调用时 messages 数组里有孤儿 tool_use 没对应 tool_result，Anthropic API 会拒绝。

**两条触发路径**：

1. **Partial stream 路径**（§7.2）：stream 中途 abort → partial assistant 含 tool_use 但 zero tool_result。`runAttempt` 看到 stopReason='aborted' 之后调 helper。
2. **工具循环路径**（§7.4 + §7.1 顶层 catch）：LLM 已 emit 多个 tool_use，部分 tool 跑完，下一个启动前 signal.aborted 检查抛。Catch 路径扫 in-memory `messages` 数组补齐。

**共用 helper**（AgentRunner 私有方法）：

```typescript
/**
 * 扫描 in-memory messages，对未被 tool_result 覆盖的 tool_use补写
 * synthetic tool_result 到 messages 和 session。
 *
 * 使用现有 tool_result block 形状 (type/tool_use_id/content)，不加
 * `is_error` 字段——当前 AgentRunner 写 tool_result 的形状不含该字段，
 * 错误状态写进 content 文本，LLM 能看到。
 *
 * 只扫最后一条 assistant + 下一条 user/toolResult 的 pair——
 * 孤儿只可能出现在这个位置（之前的 pair 在上一 turn 已被验证过）。
 */
private async appendOrphanToolResultsIfAny(
  params: RunParams,
  messages: ChatMessage[],
): Promise<void> {
  // 【R4b】整个 helper 包 try/catch：session write（磁盘满 / IO 异常）
  // 不能逃逸到调用方，否则会违反 §4 "abort 永远不抛错给调用方" 契约
  // ——abort 语义优先于 session 完整性。写不进去只 log warn，下一 turn
  // 起来后 loadHistory 若发现孤儿，会有二次机会补齐或 caller 感知。
  try {
    if (messages.length === 0) return;
    const last = messages[messages.length - 1]!;
    // 情况 A：末尾是 assistant 含 tool_use — 全部都是孤儿
    if (last.role === 'assistant' && Array.isArray(last.content)) {
      const orphanIds = last.content
        .filter((b): b is Extract<ChatContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map(b => b.id);
      if (orphanIds.length > 0) {
        await this.writeSyntheticToolResults(params.sessionKey, messages, orphanIds);
      }
      return;
    }
    // 情况 B：末尾是 user/toolResult，检查上一条 assistant 是否 tool_use 个数
    // 大于 tool_result 个数——那些差额是孤儿。
    // 【R9 显式声明】此路径同样处理 R6' 场景：tool 内部响应 signal 抛
    // AbortError 被 executeTool swallow 为 isError=true 的 tool_result（已
    // 写进 in-memory messages + session）。该 result 会被下面的 resultIds
    // set 覆盖到，orphanIds 差集自然排除，不会重复写 synthetic result。
    if (last.role === 'user' && Array.isArray(last.content) && messages.length >= 2) {
      const prev = messages[messages.length - 2]!;
      if (prev.role === 'assistant' && Array.isArray(prev.content)) {
        // R3：用 predicate 形式让 TS narrow 到具体 variant，不依赖 as-cast
        const useIds = new Set(
          prev.content
            .filter((b): b is Extract<ChatContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
            .map(b => b.id),
        );
        const resultIds = new Set(
          last.content
            .filter((b): b is Extract<ChatContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
            .map(b => b.tool_use_id),
        );
        const orphanIds = [...useIds].filter(id => !resultIds.has(id));
        if (orphanIds.length > 0) {
          await this.writeSyntheticToolResults(params.sessionKey, messages, orphanIds);
        }
      }
    }
  } catch (err) {
    log.warn('orphan tool_result write failed; skipping (abort semantics preferred)', {
      sessionKey: params.sessionKey,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

private async writeSyntheticToolResults(
  sessionKey: string,
  messages: ChatMessage[],
  toolUseIds: string[],
): Promise<void> {
  // 不变量（R4'）：本 helper 仅 mutate messages 数组结构 (push) +
  // 最后一条 user 消息的 content 字段。**不 mutate 任何 assistant 消息的
  // content** — 保证调用方持有的 `lastContent`（指向 assistant content）
  // 引用仍安全（§7.2 依赖此不变量）。未来如需 mutate assistant，必须
  // 同步更新 §7.2 的 lastContent 处理。
  const blocks: ChatContentBlock[] = toolUseIds.map(id => ({
    type: 'tool_result',
    tool_use_id: id,
    content: '[tool execution aborted by user]',
  }));
  // 合并进紧挨 in-memory messages：若末尾已是 user/toolResult，追加 block；
  // 否则新 push。
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content)) {
    last.content = [...last.content, ...blocks];
  } else {
    messages.push({ role: 'user', content: blocks });
  }
  await this.sessionManager.appendMessage(sessionKey, {
    role: 'toolResult',
    content: blocks,
  });
}
```

> **不变量**：孤儿检查只负责“completeness”，不负责 ordering。Anthropic API 只要求每个 tool_use 有对应 tool_use_id 的 tool_result，顺序在同一条 user message 里以任意顺序都可。

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
 * Returns true if anything was aborted/dropped, false if neither active
 * turn nor queued messages existed. Never throws — 包括 EventEmitter emit
 * 抛错（见下面 emit 契约）也会被 swallow + log warn。
 *
 * Cascade: 通过 AbortSignal 透传，正在跑的子 subagent 也会自动 abort。
 * 被丢弃的 queue 长度会通过 `messages_dropped` runtime event 上报，
 * channel 据此渲染（CLI: "[⚠ aborted; dropped N queued message(s)]"）。
 *
 * 【emit 契约】本 API 声明 "never throws"，但 Node EventEmitter.emit 是
 * 同步调用 subscriber——subscriber 抛错默认会传出。所以 emit 必须包
 * try/catch（下面 `safeEmit`），把 subscriber 错误降级为 log warn。
 * 该契约同样适用于 runtime 里其他"never throws"标注的 API（若有），
 * impl 时应抽出通用 `safeEmit` 工具。
 */
abortTurn(sessionKey: string): boolean {
  const controller = this.activeAborts.get(sessionKey);
  const queue = this.messageQueueBySession.get(sessionKey);
  const droppedCount = queue?.length ?? 0;

  if (!controller && droppedCount === 0) return false;

  if (controller) controller.abort();
  if (droppedCount > 0) {
    this.messageQueueBySession.delete(sessionKey);
    this.safeEmit({
      type: 'messages_dropped',
      sessionKey,
      reason: 'abort',
      queued: droppedCount,
      steering: 0,   // steering 丢弃由 runAttempt 侧独立 emit，见 §7.2 R6
    });
  }
  log.info('turn aborted by user', {
    sessionKey,
    abortedActive: !!controller,
    droppedQueued: droppedCount,
  });
  return true;
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
    /** messageQueueBySession 里被丢弃的 queued/followup 消息数。 */
    queued: number;
    /**
     * runAttempt 内 pendingSteeringMessages 已 drain 但未注入的 steering
     * 数（§7.2 R5'/R6）。与 `queued` 正交——两者可分别为 0。Channel 侧
     * 通常 `queued + steering` 聚合渲染即可。
     */
    steering: number;
  }
```

> **审计完整性**：`queued + steering` 是本次 abort 丢弃的总消息数。若两者
> 都为 0 但 abort 命中了 active turn，event 可省略不 emit（无 audit 价值）。

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
  
  // 先 abort 所有 active turn，避免 close 被慢 turn 卡住
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
  
  // 然后照旧等所有 in-flight Promise 收完
  await Promise.allSettled([...this.inFlightRuns]);
  // ...
}
```

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

只加 signal 透传，不动错误处理路径 — SDK 招出 AbortError 后走现有的 `case 'error': throw event.error` 分支，被 callLLMStream 重抠，AgentRunner.run 的 outer catch 通过 isAbortError 识别为 abort（§7.1）。

```typescript
async *chatStream(params: ChatParams): AsyncIterable<StreamEvent> {
  // ...existing...
  const stream = this.client.messages.stream(
    { ...sdkParams },
    params.signal ? { signal: params.signal } : undefined,
  );
  for await (const event of stream) { ... }
  // 原有 try/catch 不动 — SDK 会招 AbortError，自然传出。
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
  
  async start(): Promise<void> {
    // ...existing readline 逻辑...
    
    // 【M1】接管 SIGINT——需先 removeAllListeners('SIGINT')。
    // 原因：readline.Interface 默认在 process 上有个 SIGINT listener
    // （由 Interface 构造函数添加），会额外调用 close() 之类逻辑。
    // 我们要独占控制时机（abort / warn / exit），先清除后装自己的。
    process.removeAllListeners('SIGINT');
    process.on('SIGINT', () => this.handleSigInt());
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
    
    // 当前是否有 active turn？通过外部回调查询（由 RuntimeApp 注入）
    const activeSessions = this.abortHooks?.queryActiveTurns() ?? [];
    if (activeSessions.length === 0) {
      this.output.write(dim('\n[press Ctrl+C again within 1s to exit]\n'));
      return;
    }
    
    // 有 active turn → abort 所有；abortTurn 返回 { aborted, dropped }，
    // 一次拿到全部信息后本地直接渲染，避免依赖 RuntimeEvent 跨层 wiring。
    let totalAborted = 0, totalDropped = 0;
    for (const sk of activeSessions) {
      const r = this.abortHooks!.abortTurn(sk);
      if (r.aborted) totalAborted++;
      totalDropped += r.dropped;
    }
    this.output.write(yellow(`\n[⚠ aborted ${totalAborted} turn(s)`));
    if (totalDropped > 0) {
      this.output.write(yellow(`; dropped ${totalDropped} queued message(s)`));
    }
    this.output.write(yellow(']\n'));
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
  /** 返回当前所有 active turn 的 sessionKey 列表 */
  queryActiveTurns(): string[];
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
    queryActiveTurns: () => [...this.activeAborts.keys()],
    abortTurn: (sk) => {
      // 【R2 修正】RuntimeApp.abortTurn 的 boolean 语义是 "有任何东西被
      // abort 或 drop"（active turn ∪ queue drop 的联合），channel 侧
      // 需要"active-turn-aborted" 与 "queue-dropped" 两个正交信号才能
      // 正确渲染（否则只有 queue 被清也会显示 "aborted 1 turn"，假信息）。
      // 所以在 wrapper 内独立读 activeAborts 判断 aborted，别复用外层
      // abortTurn() 的 boolean。
      const abortedActive = this.activeAborts.has(sk);
      const queue = this.messageQueueBySession.get(sk);
      const dropped = queue?.length ?? 0;
      this.abortTurn(sk);   // 副作用：真正触发 abort + drop
      return { aborted: abortedActive, dropped };
    },
  });
}
```

> **NOTE**：`abortTurn` API 返回 `boolean`（"有任何事发生"），wrapper 层独立
> 通过 `activeAborts.has(sk)` 与 `queue?.length` 计算两个正交字段供 channel
> 渲染——都必须在 `this.abortTurn` 调用**前**读，否则 map/queue 已被清空。
> RuntimeEvent `messages_dropped` 仍照常 emit（library 用户、telemetry 用），
> CLI 渲染走这条独立通路不依赖它。
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
4. **渲染 dropped**：（可选）若订阅 RuntimeEvent，处理 `messages_dropped{reason:'abort',count}` 显示 `Dropped N queued message(s)`。当前 chat.html 主要走 AgentEvent 流，RuntimeEvent 需要额外订阅逻辑——**v1 可省略**，后续需要时补。
5. **UX**：无双击语义（浏览器已无 Ctrl+C 与本 tab 交互，Stop 按钮直接生效）。

关键改动量：~30-50 行 JS + 一个按钮 + 一小段状态 tracking。不需要构建，保持 chat.html 单文件性。

**测试**：`WebSocketChannel.test.ts` 已有 protocol 层测试（inbound abort_turn 触发 handler）；chat.html 手动 smoke test 即可，不写自动化。

## 14. Tests

### 14.1 单元

- AgentRunner.test.ts:
  - abort during LLM stream → stopReason='aborted', partial assistant 写入
  - abort during tool loop → 当前工具跑完，下一工具不启动
  - abort with orphan tool_use → synthetic tool_result 写入
  - abort before run starts (`signal.aborted=true` 入口) → 立即返回
  - **【R2 usage 累计】** abort 前跑过 3 轮 tool call，每轮 mock usage `{in:100,out:50}`；abort 命中 partial stream 分支 → 返回 `RunResult.usage = {in:300,out:150}` + `toolRounds:3`（非 0/0）
  - **【R4b orphan helper 抛错】** mock `sessionManager.appendMessage` 在 `writeSyntheticToolResults` 调用时抛 → runAttempt 仍返回 `stopReason='aborted'`（不 rethrow）+ log warn
  - **【R8 partial tool_use 完整性】** stream 到 tool_use.input 半截时 abort → session 里 assistant 消息**不含**残缺 tool_use block（只含完整的 text + 完整的 tool_use）
  - **【R11 isAbortError fallback】** SDK 抛 `Error` 名字为 `"NetworkError"` 但 `params.signal.aborted === true` → runAttempt 走 abort 分支
- SubagentRunner.test.ts:
  - parent signal abort → child outcome='aborted'，runner 不抛
- RuntimeApp.test.ts:
  - `abortTurn(sk)` 返回 true / false 语义
  - **stale controller 防御**：手动 pre-set stale entry 到 activeAborts → 启新 turn → 旧 entry 被清 + emit warn log。（正常流 finally 保证 cleanup，本测试仅验证防御代码行为，未来若删除防御代码本测试也可一并删除。）
  - **D3 队列同时清空**：`messageQueueBySession[sk]` 有 N 条 + 1 个 active turn → abort 后队列 size 变 0 + emit `messages_dropped{queued:N, steering:0}`
  - 没有 active turn 但 queue 有 → 只清 queue + emit；返回 true
  - 无 active + 无 queue → 返回 false，不 emit
  - 跨 session 不受影响：abortTurn(sk1) 不动 sk2 的 queue
  - **【R10 safeEmit】** 注册一个抛错的 RuntimeEvent subscriber → 调 abortTurn 触发 emit → subscriber 抛 → API 仍返回 true，不 rethrow + log warn
  - shutdown 路径：先 abort active turn 再 close
  - **shutdown timing**：close() 调用时有 active turn → close() 完成时该 turn 已 abort 并从 inFlightRuns 移除（mock LLM 跑 200ms 模拟慢 turn，断言 close 不阻塞超 300ms）
- CliChannel.test.ts (新建):
  - 单 Ctrl+C 触发 `abortHooks.abortTurn`；双 Ctrl+C 在窗口内退出（mock process.exit）
  - hooks 未 bind 时（独立运行）Ctrl+C 退一样工作
  - **【R2 aborted 语义】** active turn 不存在 + queue 有 3 条 → Ctrl+C 后 CLI 输出 `dropped 3 queued message(s)` 但**不**出现 `aborted N turn(s)` 段（`totalAborted === 0`）
- WebSocketChannel.test.ts:
  - inbound `abort_turn` 触发 handler

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

## 16. PR breakdown

带每 PR 触碰的文件 + 新增测试。列宽紧凑，等同 impl 文档功能——**不另起 impl 文档**。

| PR | 触碰文件 | 测试增加 | 依赖 |
|---|---|---|---|
| **abort-session-types** | `core/session/types.ts`（MessageRecord.message + abortMeta）<br>`core/session/SessionManager.ts`（appendMessage 签名） | `SessionManager.test.ts`（+2 cases：写 / 读 abortMeta round-trip） | 无 |
| **abort-types** | `core/runner/types.ts`（RunParams.signal）<br>`core/tools/types.ts`（ToolContext.signal 注释）<br>`core/subagent/types.ts`（SubagentRunRequest.signal 注释）<br>`adapters/llm/types.ts`（ChatParams.signal） | 无（纯类型） | abort-session-types |
| **abort-runner** | `core/runner/AgentRunner.ts`（`isAbortError` / `buildAbortedResult` / `appendOrphanToolResultsIfAny` / `writeSyntheticToolResults` / 循环间 abort check / ToolContext.signal 注入 / runAttempt 内层 try-catch 处理 abort / partial assistant 写入 session 携 abortMeta（依赖 abort-session-types PR））| `AgentRunner.test.ts`（+4 cases 见 §14.1）| abort-types 且 abort-session-types |
| **abort-llm** | `adapters/llm/AnthropicClient.ts`（chatStream signal 透传，无错误处理改动）| `AnthropicClient.test.ts`（+1 case：signal 已 abort 立即抛 AbortError）| abort-types |
| **abort-runtime** | `runtime/RuntimeApp.ts`（activeAborts + abortTurn + runTurnInternal 注入 + shutdown abort-then-wait + registerChannel 加 bindAbortHooks 调用）<br>`runtime/types.ts`（RuntimeEvent 加 messages_dropped） | `RuntimeApp.test.ts`（+7 cases 见 §14.1）| abort-runner |
| **abort-subagent** | `core/subagent/SubagentRunner.ts`（RunParams.signal 透传 + outcome mapping 加 'aborted'）<br>`core/tools/builtin/task/task-tool.ts`（无改动，`signal: ctx.signal` 已存在）| `SubagentRunner.test.ts`（+1 case：parent signal abort → child outcome='aborted'） | abort-runner |
| **abort-cli** | `adapters/channel/CliChannel.ts`（SIGINT handler + removeAllListeners + double Ctrl+C + AbortHookBindings + bindAbortHooks）<br>`adapters/channel/types.ts`（Channel 接口加 optional bindAbortHooks + AbortHookBindings 类型） | `CliChannel.test.ts` **新建**（+3 cases：单 Ctrl+C 触发 abort / 双 Ctrl+C 退出 / hooks 未 bind 时优雅降级） | abort-runtime |
| **abort-ws** | `adapters/channel/WebSocketChannel.ts`（inbound `abort_turn` case + bindAbortHooks 复用 §12 接口）<br>**`clients/html/chat.html`**（Stop 按钮 + `abort_turn` 发送 + `run_end{aborted}` 特化渲染，§13.1） | `WebSocketChannel.test.ts`（+2 cases：inbound abort_turn 触发 abortHooks.abortTurn / stopReason='aborted' event 被 forward 到 subscriber）| abort-runtime |
| **abort-e2e** | `scripts/test-abort-e2e.ts` **新建**（mock LLM 模拟长 turn + 触发 abort，断言 stopReason / usage / session partial write / orphan 补齐 4 组场景）<br>`scripts/test-abort-live.ts` **新建**（真 LLM，模拟按 Ctrl+C 1s 后看到 aborted） | E2E script 自带断言 | 全部之后 |

**约 9 个 PR**，前 4 个可并行（session-types / types 落地后 runner + llm 独立），runtime → cli/subagent/ws 三方独立，e2e 收尾。

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
