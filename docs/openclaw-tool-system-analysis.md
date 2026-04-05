# OpenClaw Tool 系统分析

> 分析日期：2026-04-03  
> 参考项目：C:\dev\my-agent\openclaw

> 注：这份文档保留为第一次分析时的“简化版结论”。如果要看基于最新源码的接线方式、`pi-coding-agent` 适配层、以及 `before_tool_call` / `after_tool_call` 的真实落点，请优先参考 `openclaw-tool-system-analysis-current.md`。

---

## 1. 三层架构

```
pi-ai（底层）
  └── Tool 类型定义：name + description + parameters（TypeBox schema）

pi-agent-core（中间层）
  └── AgentTool 扩展：Tool + label + execute() 方法
  └── Agent Loop 中的工具执行：beforeToolCall → execute → afterToolCall

openclaw（应用层）
  └── 工具工厂函数（createExecTool 等）
  └── 插件工具注册（registerTool）
  └── 工具策略/权限过滤
```

---

## 2. 核心类型定义

### pi-ai：Tool

```typescript
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;    // TypeBox schema
}
```

### pi-agent-core：AgentTool

```typescript
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> 
    extends Tool<TParameters> {
  label: string;

  execute: (
    toolCallId: string,
    params: Static<TParameters>,     // 类型化的参数
    signal?: AbortSignal,            // 取消信号
    onUpdate?: AgentToolUpdateCallback<TDetails>,  // 流式更新回调
  ) => Promise<AgentToolResult<TDetails>>;
}
```

### 执行结果

```typescript
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];   // 返回给 LLM 的内容
  details: T;                                 // 机器处理用的元数据
}
```

---

## 3. 工具执行的 Hook 系统

pi-agent-core 的 AgentLoopConfig 提供两个 hook：

| Hook | 时机 | 用途 |
|------|------|------|
| `beforeToolCall` | 执行前 | 参数验证、循环检测、阻止执行 |
| `afterToolCall` | 执行后 | 结果转换、错误恢复、增强 |

```typescript
// beforeToolCall 可以阻止执行
beforeToolCall: async (context, signal) => {
  if (isLoopDetected(context.toolCall)) {
    return { block: true, reason: "Tool loop detected" };
  }
}

// afterToolCall 可以修改结果
afterToolCall: async (context, signal) => {
  return {
    content: transformedContent,   // 替换内容
    isError: false,                // 改变错误状态
  };
}
```

---

## 4. 工具执行模式

```typescript
toolExecution: "sequential" | "parallel"   // 默认 parallel
```

**Sequential**：工具依次执行
**Parallel**：工具准备阶段依次进行，执行阶段并发

---

## 5. OpenClaw 的工具注册方式

### 内置工具

通过工厂函数创建：

```typescript
// 示例：exec 工具
function createExecTool(options): AgentTool {
  return {
    name: "exec",
    label: "Execute",
    description: "Run shell commands",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command" }),
      timeout: Type.Optional(Type.Number()),
    }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await runExecProcess({ command: params.command, signal });
      return {
        content: [{ type: "text", text: result.output }],
        details: { exitCode: result.exitCode },
      };
    },
  };
}
```

### 插件工具

通过 `registerTool` API 注册：

```typescript
// 方式 1：直接注册工具实例
api.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "...",
  parameters: Type.Object({ input: Type.String() }),
  execute: async (toolCallId, params) => ({
    content: [{ type: "text", text: "result" }],
    details: {},
  }),
});

// 方式 2：工厂函数（推荐，支持动态配置）
api.registerTool((ctx) => {
  if (!ctx.agentDir) return null;  // 条件性禁用
  return { name: "my_tool", ... };
});
```

---

## 6. 工具策略和权限

OpenClaw 有多层策略过滤（我们不需要这么复杂）：

```
Profile 策略 → Global 策略 → Agent 策略 → Sandbox 策略 → Subagent 策略
```

还有 owner-only 工具：

```typescript
// 标记为 ownerOnly 的工具，非 owner 调用时返回错误
{ name: "exec", ownerOnly: true, ... }
```

---

## 7. 完整执行流程

```
1. 工具创建
   ├─ 内置工具（工厂函数）
   ├─ 插件工具（registerTool）
   └─ 合并所有工具

2. 策略过滤
   └─ 根据配置决定哪些工具可用

3. Agent Loop 中
   ├─ LLM 返回 tool_use block
   ├─ beforeToolCall hook → 可阻止
   ├─ tool.execute(toolCallId, params, signal, onUpdate)
   ├─ afterToolCall hook → 可修改结果
   └─ ToolResultMessage 返回给 LLM

4. 错误处理
   ├─ execute 抛出异常 → 自动标记 isError: true
   └─ beforeToolCall 返回 block → 返回错误消息给 LLM
```

---

## 8. 对我们设计的启示

### 可以借鉴的
- **Tool 定义结构**：name + description + parameters（JSON Schema）+ execute 函数
- **执行结果格式**：`{ content, isError }` — 我们已经在 agent-runner 中用了类似的 `ToolResult`
- **工具注册表**：集中管理所有工具
- **execute 签名**：`(toolCallId, params, signal?) => Promise<result>`

### 不需要的
- TypeBox schema（我们用普通 JSON Schema 即可）
- 多层策略过滤（个人项目不需要）
- owner-only 权限（无多用户）
- 插件系统（暂不需要）
- beforeToolCall / afterToolCall hook（暂不需要）
- parallel 执行模式（先用 sequential）

---

## 9. 关键文件索引

| 文件 | 内容 |
|------|------|
| `node_modules/@mariozechner/pi-ai/dist/types.d.ts` | Tool / ToolCall / ToolResultMessage 类型 |
| `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts` | AgentTool / AgentLoopConfig / beforeToolCall / afterToolCall |
| `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js` | 工具执行循环 |
| `src/agents/pi-tools.ts` | 工具组合和策略应用 |
| `src/agents/openclaw-tools.ts` | 内置工具工厂函数 |
| `src/agents/bash-tools.exec.ts` | exec 工具实现 |
| `src/agents/tools/common.ts` | 工具通用类型和工具函数 |
| `src/plugins/types.ts` | 插件 registerTool API |
| `src/plugins/tools.ts` | 插件工具解析 |
