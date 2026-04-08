# OpenClaw Tool 系统分析（最新版源码）

> 分析日期：2026-04-05  
> 参考项目：C:\dev\my-agent\openclaw  
> 依赖版本：`@mariozechner/pi-ai` / `@mariozechner/pi-agent-core` / `@mariozechner/pi-coding-agent` = `0.65.0`

---

## 1. 先说结论

旧文档《openclaw-tool-system-analysis.md》作为**高层理解**基本成立，但如果把它当成**当前 OpenClaw 最新代码的精确实现说明**，有 3 个关键偏差：

1. 当前运行时不是“三层”，而更接近**四层**：`pi-ai` → `pi-agent-core` → `pi-coding-agent` → `OpenClaw`。
2. OpenClaw 当前并不是把 `AgentTool[]` 直接丢给 `pi-agent-core AgentLoopConfig` 执行，而是先适配成 `ToolDefinition[]`，再交给 `pi-coding-agent` 的 `createAgentSession()`。
3. OpenClaw 的 `before_tool_call` / `after_tool_call` 虽然概念上对应 `pi-agent-core` 的 hook，但在当前实现里主要是 **OpenClaw 自己桥接**：
   - `before_tool_call`：在工具 wrapper / adapter 中触发
   - `after_tool_call`：在 tool execution end 订阅处理器中触发

所以，旧文档对 **类型层** 和 **能力层** 的理解大体正确，但对 **OpenClaw 当前接线方式** 仍然过于简化。

---

## 2. 当前真实架构

```text
pi-ai（底层）
  └── Tool / ToolCall / ToolResultMessage / Message / Context

pi-agent-core（Agent Loop 层）
  └── AgentTool / AgentLoopConfig / beforeToolCall / afterToolCall / toolExecution

pi-coding-agent（Session / ToolDefinition 层）
  └── createAgentSession()
  └── ToolDefinition
  └── codingTools / readTool 等基础工具

OpenClaw（应用层）
  └── createOpenClawTools()：业务/会话/消息类工具
  └── createOpenClawCodingTools()：读写文件/exec/process/apply_patch 等编码工具
  └── 工具策略、ownerOnly、provider/message 过滤
  └── before_tool_call / after_tool_call 的插件桥接
```

和旧文档相比，新增且必须强调的一层是：**pi-coding-agent**。

---

## 3. 核心类型定义

### 3.1 pi-ai：Tool

最新版 `pi-ai` 中，`Tool` 结构仍然与旧文档一致：

```typescript
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

同时，`ToolResultMessage` 也是当前 Agent Loop 最终回到 LLM 的标准消息：

```typescript
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}
```

### 3.2 pi-agent-core：AgentTool

最新版 `pi-agent-core` 中，`AgentTool` 仍然是 `Tool` 的扩展：

```typescript
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any>
  extends Tool<TParameters> {
  label: string;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}
```

执行结果仍然是：

```typescript
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
}
```

这一部分和旧文档是一致的。

---

## 4. pi-agent-core 的 Hook 和执行模型

最新版 `pi-agent-core` 依然提供：

```typescript
toolExecution?: "sequential" | "parallel";
beforeToolCall?: (context, signal) => Promise<BeforeToolCallResult | undefined>;
afterToolCall?: (context, signal) => Promise<AfterToolCallResult | undefined>;
```

而且语义也与旧文档一致：

- `beforeToolCall`：参数校验后、工具真正执行前触发，可阻止执行
- `afterToolCall`：工具执行后、最终结果发出前触发，可改写 `content` / `details` / `isError`
- `toolExecution` 默认仍是 `parallel`

最新版里还有一个细节变化值得记录：`getSteeringMessages()` 的行为说明更明确了。当前语义是：

- 它在**当前 assistant turn 的工具调用全部完成后**才生效
- 不会中断当前 assistant message 已经产生的剩余工具调用

这和一些人对“中途插入 steering 会跳过剩余工具”的直觉不同。

---

## 5. OpenClaw 当前的两类工具入口

旧文档把 OpenClaw 写成统一的“工具工厂函数集合”，这个方向没错，但最新版源码最好区分成两大类：

### 5.1 `createOpenClawTools()`

这组偏“业务/会话/通道”能力，包括：

- `canvas`
- `nodes`
- `cron`
- `message`
- `tts`
- `gateway`
- `agents_list`
- `sessions_*`
- `subagents`
- `session_status`
- `web_search`
- `web_fetch`
- `image`
- `pdf`
- 插件工具

### 5.2 `createOpenClawCodingTools()`

这组偏“编码/文件/exec”能力，来源包括：

- `pi-coding-agent` 自带的 `codingTools`
- OpenClaw 自己包装的 `read` / `write` / `edit`
- `exec`
- `process`
- `apply_patch`
- channel-owned tools
- `createOpenClawTools()` 返回的业务工具

也就是说，**当前真正给 agent 用的完整工具集，是在 `createOpenClawCodingTools()` 里合成出来的**，而不是只有 `createOpenClawTools()`。

---

## 6. OpenClaw 当前真实执行链路

这一段是新版文档最需要修正的地方。

### 6.1 工具创建

1. 先创建 OpenClaw 业务工具：`createOpenClawTools()`
2. 再合并 pi-coding-agent 的编码工具、OpenClaw 文件工具、`exec` / `process` / `apply_patch`
3. 得到完整的 `AnyAgentTool[]`

### 6.2 工具过滤与包装

在 `createOpenClawCodingTools()` 里，工具还会继续经过：

1. message-provider 过滤
2. model-provider 过滤
3. `ownerOnly` 过滤
4. 工具策略管线过滤
5. schema 归一化
6. `before_tool_call` wrapper 包装
7. abort-signal 包装

所以 OpenClaw 当前的工具执行前处理，比旧文档写的“策略过滤”要复杂得多。

### 6.3 适配到 `pi-coding-agent`

这是旧文档没有写出来的关键一层。

当前 OpenClaw 会先做：

```typescript
const { builtInTools, customTools } = splitSdkTools({ tools: effectiveTools, ... })
```

而 `splitSdkTools()` 当前实现实际上是：

```typescript
return {
  builtInTools: [],
  customTools: toToolDefinitions(tools),
}
```

也就是说：

- OpenClaw 自己的工具**不会直接作为 `AgentTool[]` 跑在 pi-agent-core 里**
- 它们会先被适配成 `ToolDefinition[]`
- 然后交给 `pi-coding-agent` 的 `createAgentSession()`：

```typescript
createAgentSession({
  tools: builtInTools,
  customTools: allCustomTools,
  ...
})
```

这就是为什么“四层架构”比旧文档里的“三层架构”更准确。

---

## 7. `before_tool_call` / `after_tool_call` 在 OpenClaw 的真实落点

### 7.1 `before_tool_call`

概念上，它对应 `pi-agent-core.beforeToolCall`。

但在 OpenClaw 当前实现里，它主要通过以下两条路径桥接：

1. `wrapToolWithBeforeToolCallHook()`
2. `toToolDefinitions()` 中对未包装工具的兜底调用

也就是：

```typescript
if (!beforeHookWrapped) {
  const hookOutcome = await runBeforeToolCallHook(...)
}
```

所以 `before_tool_call` 在 OpenClaw 里并不是简单“把函数塞进 AgentLoopConfig”，而是显式包装到工具调用入口。

### 7.2 `after_tool_call`

这一点更容易误判。

当前 OpenClaw 的测试已经明确写死：

> `after_tool_call` 不从 adapter 触发，而是由 subscription handler 负责，避免重复触发。

实际落点是在 `handleToolExecutionEnd()` 中：

```typescript
hookRunnerAfter.runAfterToolCall(hookEvent, ctx)
```

所以最新版里：

- `before_tool_call`：更像“执行入口 wrapper hook”
- `after_tool_call`：更像“tool execution end 事件 hook”

这和旧文档中“都归属于 pi-agent-core AgentLoopConfig 原生 hook”相比，需要补上 OpenClaw 的桥接实现层。

---

## 8. 插件工具注册

这一部分旧文档基本正确，最新版仍然支持：

### 8.1 直接注册工具实例

```typescript
registerTool(tool)
```

### 8.2 注册工厂函数

```typescript
registerTool((ctx) => toolOrNull)
```

当前 `registerTool()` 还支持额外元数据：

- `name`
- `names`
- `optional`

并且内部会记录插件来源、tool names、是否 optional 等信息。

所以“插件工具注册”这个判断没问题，但最新版已经不是一个极简的 `registerTool` 壳子，而是带元数据归档和诊断能力的注册表。

---

## 9. 工具策略与权限：比旧文档更复杂

旧文档把这一层总结为：

```text
Profile → Global → Agent → Sandbox → Subagent
```

这个总结不算错，但最新版实际上还多了几层维度：

- profile policy
- provider profile policy
- global policy
- global provider policy
- agent policy
- agent provider policy
- group policy
- sandbox policy
- subagent policy
- plugin tool allowlist / plugin group expansion
- owner-only authorization
- message-provider / model-provider 特殊过滤

所以如果是“理解概念”，旧文档够用；如果要“按代码还原策略链”，旧文档明显不够。

另外，`ownerOnly` 的行为也比旧文档写得更强：

- 非 owner 不仅可能在执行时被拦截
- 还可能在工具列表阶段就被过滤掉

---

## 10. 默认工具清单：哪些是 OpenClaw 当前真正给 agent 的工具

这里有一个很容易混淆的点：

- `pi-coding-agent` SDK 自己导出了 `builtIn tools`
- 但 OpenClaw 当前接线里，`splitSdkTools()` 实际返回的是 `builtInTools: []`
- OpenClaw 会把自己的完整工具集统一转成 `customTools`

所以从 OpenClaw 角度看，更准确的说法不是“内建工具数组有哪些”，而是“默认随 session 暴露给 agent 的工具集有哪些”。

### 10.1 SDK 原始工具

`pi-coding-agent` 文档里，默认 `codingTools` 是：

- `read`
- `bash`
- `edit`
- `write`

另外它还单独导出了：

- `grep`
- `find`
- `ls`

但 OpenClaw 当前这里并没有直接把 `readOnlyTools` 或 `grep/find/ls` 这一组一起接进默认工具集。

### 10.2 OpenClaw 如何重组这批工具

在 `createOpenClawCodingTools()` 里，OpenClaw 对 SDK 工具做了几件事：

1. 保留并重新包装 `read`
2. 保留并重新包装 `write`
3. 保留并重新包装 `edit`
4. 去掉 SDK 自带的 `bash`
5. 用 OpenClaw 自己的 `exec` 替换命令执行能力
6. 再额外注入 `process`、`apply_patch`、channel tools、业务工具和插件工具

所以从“编码工具”视角看，OpenClaw 当前默认暴露的大致是：

- `read`
- `write`
- `edit`
- `apply_patch`
- `exec`
- `process`

### 10.3 OpenClaw 默认工具分组

按职责划分，当前默认工具集可以整理成下面几组。

#### A. 编码 / 工作区工具

- `read`
- `write`
- `edit`
- `apply_patch`
- `exec`
- `process`

#### B. 会话 / 编排工具

- `agents_list`
- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_yield`
- `sessions_spawn`
- `subagents`
- `session_status`

#### C. 消息 / 通道工具

- `message`
- `gateway`
- `tts`

#### D. 内容 / 自动化工具

- `canvas`
- `nodes`
- `cron`
- `image_generate`
- `web_search`
- `web_fetch`
- `image`
- `pdf`

#### E. 动态扩展工具

- channel-defined tools
- plugin tools

### 10.4 哪些工具会直接和 `exec` 配合

这里最重要的结论是：**直接和 `exec` 配合的核心工具是 `process`**。

`exec` 在 OpenClaw 里的职责是：

- 启动命令
- 决定前台执行还是 background / yield 模式
- 注册进程 session
- 返回前台结果，或者返回一个后续可追踪的 session

`process` 的职责是接管后续生命周期管理，包括：

- `list`
- `poll`
- `log`
- `write`
- `send-keys`
- `submit`
- `paste`
- `kill`
- `clear`
- `remove`

也就是说：

- `exec` 负责“开始运行”
- `process` 负责“继续观察和交互”

### 10.5 其他和 `exec` 相关、但不是直接控制关系的工具

- `cron`：用于定时或后续提醒，不负责活跃进程交互
- `sessions_yield`：用于会话层让出控制，不负责进程 stdin/stdout 管理
- `read` / `write` / `edit` / `apply_patch`：常与 `exec` 配合完成文件查看和修改，但不管理进程生命周期
- `nodes` / `subagents` / `sessions_spawn`：可能在更高层 orchestration 中间接配合 `exec`，但不是它的直接控制面

### 10.6 对我们设计的直接启示

如果我们只想借鉴 OpenClaw 的 `exec` 设计，最该看的一对不是“`exec` + 所有业务工具”，而是：

- `exec`
- `process`

因为 OpenClaw 的后台执行能力，本质上是这两个工具共同完成的，而不是单个 `exec` 工具独立完成的。

---

## 11. 对旧文档逐条结论

### 10.1 一致的部分

- `Tool` / `AgentTool` / `AgentToolResult` 的核心定义仍然成立
- `beforeToolCall` / `afterToolCall` / `toolExecution` 这些能力在 pi-agent-core 中仍然存在
- OpenClaw 确实有工厂函数式内置工具
- OpenClaw 确实支持插件工具注册
- OpenClaw 确实有策略过滤和 owner-only 权限

### 10.2 需要修正的部分

- “三层架构”应修正为“四层架构”，把 `pi-coding-agent` 单独列出
- “OpenClaw 直接使用 pi-agent-core AgentTool 执行”不准确，当前会先适配成 `ToolDefinition[]`
- “beforeToolCall / afterToolCall 就是 OpenClaw 当前的直接执行 hook”不准确，当前主要是 OpenClaw 自己桥接
- “工具策略不复杂”不成立，当前源码里的策略层已经明显复杂化
- 旧文档里举例用 `exec` 代表 OpenClaw 全部工具系统，会弱化 `createOpenClawTools()` 与 `createOpenClawCodingTools()` 的区别

---

## 12. 对我们设计的启示

如果我们要参考 OpenClaw 来设计自己的工具系统，可以分成“值得借鉴”和“可暂时省略”两部分。

### 12.1 值得借鉴的

- `Tool` / `AgentTool` 这种稳定的工具描述结构
- 工具结果统一为 `{ content, details }`
- 工具注册表 + 工厂函数注册方式
- 在工具入口做统一包装：授权、参数归一化、hook、abort
- 把工具策略过滤做成独立 pipeline
- 区分“业务工具”和“编码工具”两大类入口

### 12.2 可以暂时不做的

- 复杂的 provider / group / subagent 多层策略
- 插件可选工具 allowlist 展开
- approval / gateway / node 这些分布式执行能力
- tool execution end 事件桥接出的完整插件 hook 系统
- `pi-coding-agent` 这一整层适配，除非我们也要复用它的 session/runtime

---

## 13. 最新版关键文件索引

| 文件 | 内容 |
|------|------|
| `package.json` | 当前依赖版本（0.65.0） |
| `package-lock.json` | 当前安装的锁定版本（已同步到 0.65.0） |
| `node_modules/@mariozechner/pi-ai/dist/types.d.ts` | `Tool` / `ToolCall` / `ToolResultMessage` |
| `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts` | `AgentTool` / `AgentLoopConfig` / hook 类型 |
| `src/agents/openclaw-tools.ts` | OpenClaw 业务工具集合 |
| `src/agents/pi-tools.ts` | 编码工具集合、策略过滤、hook wrapper |
| `src/agents/bash-tools.exec.ts` | `exec` 工具实现 |
| `src/agents/pi-tool-definition-adapter.ts` | `AgentTool -> ToolDefinition` 适配层 |
| `src/agents/pi-embedded-runner/tool-split.ts` | `builtInTools/customTools` 拆分 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | `createAgentSession()` 接线主路径 |
| `src/agents/pi-tools.before-tool-call.ts` | `before_tool_call` 桥接实现 |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts` | `after_tool_call` 桥接实现 |
| `src/plugins/registry.ts` | 插件注册表与 `registerTool()` |
| `src/plugins/types.ts` | 插件 API 类型 |

---

## 14. 一句话总结

旧文档对“Pi 工具抽象”理解基本对，但对“OpenClaw 当前如何真正把工具接进运行时”简化过头了。最新版源码最准确的描述是：

> OpenClaw 先构造并过滤 `AgentTool[]`，再把它们适配成 `ToolDefinition[]` 交给 `pi-coding-agent` session；`before_tool_call` 和 `after_tool_call` 虽然概念上对应 pi-agent-core hook，但在当前实现里主要由 OpenClaw 自己桥接。