# OpenClaw Tool Hook & Approval 机制调研摘要

> 调研日期：2026-04-20
> 目的：为 my-agent 设计通用 tool authorization 机制及 hook 系统提供参考

---

## 1. 背景

讨论起因：`chat.ts` CLI 中 agent 拒绝访问 workspace 外的文件。

- `path-policy.ts` 在工具层**硬性拦截**越界路径（非 AGENTS.md 软约束）
- 设计文档 `builtin-tools-design.md` §3.4 明确规定文件类 tool 以 workspace 为边界
- 需求演变为：做一个**通用 approval 机制**，不把 approval 逻辑耦合进每个 tool

---

## 2. OpenClaw 实现概览

### 2.1 Hook 核心文件

| 文件 | 作用 |
|------|------|
| `src/plugins/hooks.ts` | 所有 hook 类型定义 + HookRunner 执行引擎（29 个 hook） |
| `src/plugins/types.ts` | Plugin 接口、hook 参数/返回值类型 |
| `src/agents/pi-tools.before-tool-call.ts` | `before_tool_call` 拦截逻辑、approval 等待 |
| `src/infra/exec-approvals.ts` | exec 命令 approval 类型和 policy |
| `src/gateway/exec-approval-manager.ts` | approval 生命周期（注册/等待/决议） |

### 2.2 两套 Approval 系统

**1. Exec Approval**（针对系统命令）

- 基于 policy：`ask: "always" | "on-miss" | "off"` + `security: "deny" | "allowlist" | "full"`
- bash tool 执行前检查 policy 决定是否触发审批

**2. Plugin Approval**（通用）

Approval 不声明在 Tool 接口上，通过 `before_tool_call` hook 动态返回：

```typescript
interface PluginHookBeforeToolCallResult {
  requireApproval?: {
    title: string;
    description: string;
    severity?: 'info' | 'warning' | 'critical';
    timeoutMs?: number;
    timeoutBehavior?: 'allow' | 'deny';
    onResolution?: (decision) => void;
  }
}
```

### 2.3 `before_tool_call` hook 的四个用途

1. **Approval** — 执行前请求用户审批（allow-once / allow-always / deny）
2. **参数修改** — 改写 tool input 再执行
3. **Block** — 直接拦截，返回自定义错误
4. **Tool loop 检测** — 检测重复调用同一 tool，防死循环

### 2.4 两阶段执行流程（防竞态）

```
Tool 调用
  → before_tool_call hook → 返回 requireApproval?
    → Phase 1: 注册 approval（生成 ID，推给 UI）
    → Phase 2: 等待用户决策（await decision）
    → allow → 继续执行 tool
    → deny  → 返回错误，不执行
```

### 2.5 完整 Hook 家族（29 个）

| 分组 | Hook 名称 | 执行模式 |
|------|-----------|----------|
| Tool | `before_tool_call` | sequential |
| Tool | `after_tool_call` | parallel |
| Tool | `tool_result_persist` | sync-only |
| Agent | `before_prompt_build`、`before_agent_reply`、`llm_input`、`llm_output`、`agent_end` | 混合 |
| Session | `session_start`、`session_end`、`before_compaction`、`after_compaction` | — |
| Message | `message_received`、`before_dispatch`、`message_sending`、`message_sent` 等 | 混合 |
| Gateway | `gateway_start`、`gateway_stop` | — |

---

## 3. 对 my-agent 的结论

### 3.1 方向：建立轻量 Hook 系统

经讨论，单独做 approval 机制视野太窄。更合理的方向是**建立一套轻量 hook 系统**，approval 只是其中一个应用场景。

OpenClaw 的 29 个 hook 由其多租户/多 channel/subagent 架构驱动，my-agent 不需要全部照搬。以下是对 my-agent 有实际价值的 hook 子集：

| Hook | 类型 | 用途 |
|------|------|------|
| `before_tool_call` | Interceptor | approval、参数修改、block |
| `after_tool_call` | Observer | 日志、审计 |
| `llm_input` | Observer | 观察发给 LLM 的完整 payload |
| `llm_output` | Observer | 观察 LLM 返回结果 |
| `before_compaction` | Interceptor | 压缩前干预 |
| `after_compaction` | Observer | 压缩后通知 |
| `session_start` | Observer | session 初始化通知 |
| `before_message_write` | Interceptor | 写入 JSONL 前修改/拦截消息 |

### 3.2 Hook 系统设计原则

两类 hook，执行语义不同：

| 类型 | 执行方式 | 能否修改数据 | 例子 |
|------|----------|------------|------|
| **Observer** | parallel，fire-and-forget | 否 | `llm_input`、`after_tool_call`、`session_start` |
| **Interceptor** | sequential，await result | 是（可修改或 deny） | `before_tool_call`、`before_message_write` |

### 3.3 与现有 AgentEvent 的关系

my-agent 已有 `AgentEvent`（`text_delta`、`tool_use`、`tool_result`、`compaction_start` 等），本质上是**只读 Observer hook**。

迁移思路：
- `AgentEvent` 并入新 hook 系统，作为 Observer 类型 hook
- 现有 `onEvent` 回调变为 hook 注册的一种形式
- 新增 Interceptor hook 覆盖拦截/修改场景

**注意**：`onEvent` 迁移是破坏性变更，影响 `AgentRunner` 构造函数和 `chat.ts`，需兼容过渡或一次性改掉。

### 3.4 当前 my-agent 现状

```typescript
// src/tools/types.ts — 无任何 hook 相关字段
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params, context?) => Promise<ToolResult>;
}

// src/agent-runner/types.ts — AgentEvent 为只读观察者，无拦截能力
type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'compaction_start'; trigger: string; tokensBefore: number }
  | { type: 'compaction_end'; tokensBefore: number; tokensAfter: number; droppedMessages: number }
  | { type: 'run_start' }
  | { type: 'run_end'; result: RunResult }
  | { type: 'error'; error: Error }
  // ...
```

### 3.5 建议下一步

1. 起草 hook 系统设计文档，明确：hook 名称、类型（Observer/Interceptor）、参数/返回值、注册方式、执行引擎
2. 将 `AgentEvent` 迁移纳入设计范围，统一成一套机制
3. 先实现框架，再逐步将 `before_tool_call` 作为第一个 Interceptor hook 落地

---

## 4. 方案演进过程

| 阶段 | 方案 | 结论 |
|------|------|------|
| 初始 | 修改 `path-policy.ts` 加 approver callback | 仅解决路径问题，太局限 |
| 演进 1 | `approvalCheck` 方法加在 Tool 接口上 | approval 逻辑耦合进 tool，不符合需求 |
| 演进 2 | `beforeToolCall` hook 加在 `createToolExecutor` 上 | approval 与 tool 解耦，但仍是单点 |
| 最终 | 建立轻量 hook 系统，`AgentEvent` 迁移统一 | 灵活性最高，一套机制覆盖所有场景 |
