# Hook System — Phase 1 设计文档

> 状态：Phase 1 已实现
> 范围：Phase 1（`before_tool_call` + `after_tool_call`）
> 参考：OpenClaw hook 实现（pi-tools.before-tool-call.ts / pi-embedded-subscribe.handlers.tools.ts）

---

## 1. 背景与目标

### 问题

`AgentRunner.executeTool()` 是纯 dispatch，无拦截点。想在 tool 执行前做 approval / block / 参数修改，只能入侵 executor 或每个 tool，扩展性差。

### 目标

建立轻量 hook 系统，以**非侵入式**的方式支持：

- `before_tool_call` — 执行前拦截（approval、block、参数修改）
- `after_tool_call` — 执行后观察（日志、审计）

### 不在 Phase 1 范围内

- `llm_input` / `llm_output` / `session_start` / `before_message_write` 等其余 hook
- `AgentEvent` 迁移（破坏性变更，Phase 2 单独评估）

---

## 2. 核心概念

两类 hook，执行语义不同：

| 类型 | 执行方式 | 能否修改数据 | 典型用途 |
|------|----------|------------|---------|
| **Interceptor** | sequential，逐个 await | 是（modify / deny） | `before_tool_call` |
| **Observer** | parallel，fire-and-forget | 否 | `after_tool_call` |

---

## 3. 类型定义（`src/agent-runner/hooks/types.ts`）

```typescript
import type { ToolResult } from '../../tools/types.js';

// ── before_tool_call ─────────────────────────────────────────

export interface BeforeToolCallPayload {
  toolName: string;
  input: Record<string, unknown>;
}

export type BeforeToolCallResult =
  | { action: 'allow' }
  | { action: 'allow'; input: Record<string, unknown> }  // 修改后的 input
  | { action: 'deny'; reason: string };

export type BeforeToolCallHook = (
  payload: BeforeToolCallPayload,
) => BeforeToolCallResult | Promise<BeforeToolCallResult>;

// ── after_tool_call ──────────────────────────────────────────

export interface AfterToolCallPayload {
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
}

export type AfterToolCallHook = (
  payload: AfterToolCallPayload,
) => void | Promise<void>;
```

### 设计说明

**Approval 怎么做？**

hook 本身是 async 函数。需要 approval 的 hook 直接在函数体内 await 用户决策（例如 await 一个 readline prompt 或 IPC 消息）。`HookRunner` 不需要内置 approval 状态机，approval 逻辑由 hook 实现者自己控制。

这使 Phase 1 保持简单——只有 allow / deny / modify 三种语义，无需引入额外的 approval 生命周期类型。如果将来需要 UI 侧的标准化 approval 协议，可以在 Phase 2 扩展 `BeforeToolCallResult`。

---

## 4. 注册 API（`runner.on()` 方法）

`AgentRunnerConfig` 不包含 hook 字段。Hook 通过 `AgentRunner` 实例的 `on()` 方法注册，支持链式调用：

```typescript
const runner = new AgentRunner(config);

runner
  .on('before_tool_call', approvalHook, { priority: 10, name: 'approval' })
  .on('before_tool_call', loggingHook, { name: 'logger' })
  .on('after_tool_call', auditHook);
```

`on()` 签名（`src/agent-runner/AgentRunner.ts`）：

```typescript
on<K extends HookName>(
  hookName: K,
  handler: HookHandlerMap[K],
  options?: { priority?: number; name?: string },
): this
```

`HookName` 和 `HookHandlerMap` 定义在 `src/agent-runner/hooks/types.ts`：

```typescript
export type HookName = 'before_tool_call' | 'after_tool_call';

export type HookHandlerMap = {
  before_tool_call: BeforeToolCallHook;
  after_tool_call: AfterToolCallHook;
};

export interface HookRegistration<K extends HookName = HookName> {
  hookName: K;
  handler: HookHandlerMap[K];
  priority: number;
  name?: string;
}
```

### 设计说明

**为什么用 `on()` 而非 `AgentRunnerConfig` 数组？**

`on()` 将 hook 注册从构造参数分离，使 `AgentRunnerConfig` 保持干净（只含 `llmClient`、`sessionManager`、`toolExecutor?`、`onEvent?`）。随着 Phase 2 增加到 8–10 个 hook 类型，`on()` 比在 Config 接口上堆可选字段更易扩展。链式调用也更易读。

**priority**：整数，高值优先执行；默认 `0`。`getHooks()` 在调用时按 priority 降序排序（同 OpenClaw）。

**name**：可选字符串，用于 warn log 标记（`[hook:name]`），便于多 hook 场景下定位问题。

---

## 5. 执行引擎（`src/agent-runner/hooks/runner.ts`）

runner 接收 `{ handler, name? }[]`（由 `AgentRunner.getHooks()` 提供），`name` 用于 warn log 标记。

```typescript
import type {
  BeforeToolCallHook, BeforeToolCallPayload, BeforeToolCallResult,
  AfterToolCallHook, AfterToolCallPayload,
} from './types.js';

type NamedHandler<T> = { handler: T; name?: string };

/**
 * 顺序执行所有 before_tool_call hooks。
 *
 * - 遇到 deny → 立即返回，后续 hook 不再执行，同时 warn log
 * - 遇到 modify（action: 'allow' + input 字段）→ 更新 input，继续执行后续 hook
 * - 所有 hook 通过 → 返回最终 { action: 'allow', input }
 */
export async function runBeforeToolCall(
  hooks: NamedHandler<BeforeToolCallHook>[],
  payload: BeforeToolCallPayload,
): Promise<BeforeToolCallResult & { input: Record<string, unknown> }> {
  let currentInput = payload.input;

  for (const { handler, name } of hooks) {
    const result = await handler({ toolName: payload.toolName, input: currentInput });
    if (result.action === 'deny') {
      const tag = name ? `:${name}` : '';
      console.warn(`[hook${tag}] before_tool_call denied: tool=${payload.toolName} reason=${result.reason}`);
      return { action: 'deny', reason: result.reason, input: currentInput };
    }
    if ('input' in result) {
      currentInput = result.input;
    }
  }

  return { action: 'allow', input: currentInput };
}

/**
 * 并发执行所有 after_tool_call hooks（fire-and-forget）。
 * 任意 hook 抛出的错误只记录 warn log，不影响主流程。
 */
export function runAfterToolCall(
  hooks: NamedHandler<AfterToolCallHook>[],
  payload: AfterToolCallPayload,
): void {
  for (const { handler, name } of hooks) {
    Promise.resolve(handler(payload)).catch((err) => {
      const tag = name ? `:${name}` : '';
      console.warn(`[hook${tag}] after_tool_call failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
```

---

## 6. AgentRunner 接入点

改动集中在 `AgentRunner.ts` 的三处：

### 6.1 注册存储与 `on()` 方法

```typescript
private hookRegistrations: HookRegistration[] = [];

on<K extends HookName>(
  hookName: K,
  handler: HookHandlerMap[K],
  options?: { priority?: number; name?: string },
): this {
  this.hookRegistrations.push({
    hookName,
    handler,
    priority: options?.priority ?? 0,
    name: options?.name,
  } as HookRegistration);
  return this;
}

private getHooks<K extends HookName>(hookName: K): Array<{ handler: HookHandlerMap[K]; name?: string }> {
  return this.hookRegistrations
    .filter((r): r is HookRegistration<K> => r.hookName === hookName)
    .sort((a, b) => b.priority - a.priority)
    .map((r) => ({ handler: r.handler as HookHandlerMap[K], name: r.name }));
}
```

### 6.2 `executeTool()` 包装

当前 `executeTool()` 在 `runAttempt()` 的 tool loop 中被调用（[AgentRunner.ts:275](../../src/agent-runner/AgentRunner.ts#L275)）：

```typescript
this.emit({ type: 'tool_use', name: toolUse.name, input: toolUse.input });
const result = await this.executeTool(toolUse.name, toolUse.input);
this.emit({ type: 'tool_result', name: toolUse.name, result });
```

改为：

```typescript
// tool_use 事件发原始 input（hook 运行之前，对齐 OpenClaw）
this.emit({ type: 'tool_use', name: toolUse.name, input: toolUse.input });

// before_tool_call hooks（sequential，priority 降序）
let effectiveInput = toolUse.input;
const beforeHooks = this.getHooks('before_tool_call');
if (beforeHooks.length > 0) {
  const beforeResult = await runBeforeToolCall(beforeHooks, {
    toolName: toolUse.name,
    input: toolUse.input,
  });
  if (beforeResult.action === 'deny') {
    // deny → 直接构造 error ToolResult，不 throw（hook 在 executeTool 外部，throw 会逃逸到外层 retry 循环）
    const blocked: ToolResult = { content: `Tool blocked: ${beforeResult.reason}`, isError: true };
    this.emit({ type: 'tool_result', name: toolUse.name, result: blocked });
    toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: blocked.content });
    continue;
  }
  effectiveInput = beforeResult.input;
}

// 执行工具
const startTime = Date.now();
const result = await this.executeTool(toolUse.name, effectiveInput);
const durationMs = Date.now() - startTime;

this.emit({ type: 'tool_result', name: toolUse.name, result });

// after_tool_call hooks（fire-and-forget，修改后的 input）
const afterHooks = this.getHooks('after_tool_call');
if (afterHooks.length > 0) {
  runAfterToolCall(afterHooks, {
    toolName: toolUse.name,
    input: effectiveInput,
    result,
    durationMs,
  });
}
```

**注意**：deny 时不 throw，原因是 before hook 运行在 `executeTool()` 调用之前，此处 throw 会穿透 tool loop、`runAttempt`，最终被外层 compaction retry 循环误判为 `ContextOverflowError`。直接构造 error ToolResult + `continue` 是正确路径——LLM 收到错误 tool result 后自行决定后续行为，run 不中断。

---

## 7. 文件结构

hook 文件放在 `src/agent-runner/hooks/` 子目录下。理由：Phase 1 的唯一消费方是 `AgentRunner`，模块边界不变；随着 Phase 2 增加到 8-10 个 hook，子目录避免 `src/agent-runner/` 根目录变得嘈杂。my-agent 没有 plugin 系统，不需要独立顶层 `src/hooks/` 模块。

```
src/agent-runner/
  hooks/
    types.ts    # BeforeToolCallHook / AfterToolCallHook、HookName / HookHandlerMap / HookRegistration
    runner.ts   # runBeforeToolCall / runAfterToolCall 执行引擎
    index.ts    # 导出
  types.ts      # AgentRunnerConfig（无 hook 字段）
  AgentRunner.ts  # hookRegistrations 字段 + on() 方法 + getHooks() + tool loop 调用点
```

---

## 8. 向后兼容

- `AgentRunnerConfig` 不新增任何字段，现有构造调用无需修改
- Hook 通过 `runner.on()` 注册，未注册时行为与现有完全一致（零开销）
- `onEvent` / `AgentEvent` 不受影响

---

## 9. 设计决策记录（对齐 OpenClaw）

以下三个问题已通过参考 OpenClaw 实现确认：

| 问题 | 决策 | 依据 |
|------|------|------|
| `after_tool_call` 错误处理 | 静默忽略，仅 warn log，不暴露 `hook_error` 事件 | OpenClaw：`.catch(err => log.warn(...))` fire-and-forget |
| `deny` 时的行为 | 直接构造 `isError: true` ToolResult + `continue`，run 不中断 | hook 在 `executeTool` 外部，throw 会逃逸到外层 retry 循环；OpenClaw 的 throw 能工作是因为其 hook 在 tool adapter 的 try/catch 内 |
| `tool_use` 事件的 input | 发原始 input；`after_tool_call` payload 里用修改后的 `effectiveInput` | OpenClaw：start 事件用原始 args，after hook 从 map 取调整后的 args |

---

## 10. Phase 2 预留

以下 hook 待 Phase 1 稳定后单独评估，按优先级排序。

### 10.1 当前 AgentEvent 应迁移为 hook 的项目

对照 OpenClaw，以下 AgentEvent 被 emit 实现，但其语义更适合 Observer hook：

| 当前 AgentEvent | 对应 OpenClaw hook | 类型 | 说明 |
|---|---|---|---|
| `compaction_start` | `before_compaction` | Observer | 当初为省事直接 emit，应改为 hook |
| `compaction_end` | `after_compaction` | Observer | 同上 |
| `run_end` | `agent_end` | Observer | run 结束通知，OpenClaw 是 hook |
| `llm_call` | `llm_input` | Observer | OpenClaw 的 `llm_input` 携带完整 LLM payload，比 `llm_call` 更丰富 |

迁移是破坏性变更（影响所有 `onEvent` 消费方），需独立设计文档，不在 Phase 1 范围。

### 10.2 新增 hook（无对应 AgentEvent）

| Hook | 类型 | 说明 | 接入点 |
|---|---|---|---|
| `llm_output` | Observer | 观察 LLM 完整输出 payload | `callLLMStream()` 返回后 |
| `before_message_write` | **同步** Interceptor | 任意消息写入 session JSONL 前拦截/修改/block | `sessionManager.appendMessage()` |
| `tool_result_persist` | **同步** Interceptor | tool result 写入 JSONL 前拦截（比 `after_tool_call` 更精细，控制持久化层） | `appendMessage('toolResult', ...)` |
| `session_start` / `session_end` | Observer | session 生命周期通知 | `SessionManager.createSession()` |

**注意同步 hook**：`before_message_write` 和 `tool_result_persist` 在 OpenClaw 中是**同步**的，因为它们运行在 session 写入热路径上。my-agent 的 `appendMessage` 虽然是 async，但引入这两个 hook 时需要明确决定是否保持同步。

### 10.3 不适用项

| OpenClaw hook | 原因 |
|---|---|
| `before_prompt_build` | my-agent prompt-builder 已有 `ContextHook`，功能重叠 |
| `before_model_resolve` | model 作为 `RunParams.model` 显式传入，无需 hook 拦截 |
| `message_*` / `subagent_*` / `gateway_*` | OpenClaw 消息渠道/多租户架构专用，my-agent 无对应概念 |
| `before_reset` | my-agent 目前无 /reset 命令 |
