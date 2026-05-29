# Core Tools 框架设计文档

> 文档日期：2026-05-29
> 关联文档：`runtime.md` · `core_tools_builtin.md`

---

## 1. 概述

`src/core/tools/` 定义**工具框架**：统一的 `Tool` 接口、执行器工厂、以及 LLM 工具定义格式。所有内置工具和 memory 工具都实现这个接口；工具注册与组装由 `runtime/tool-registry.ts` 完成。

---

## 2. 目录结构

```
src/core/tools/
├── types.ts             # Tool / ToolExecutor / ToolResult / ToolDefinition / ToolContext
├── executor.ts          # createToolExecutor / getToolDefinitions
├── index.ts             # 公共导出
└── builtin/             # 内置工具实现（见 core_tools_builtin.md）
```

---

## 3. 类型定义

```
Tool {
  name: string                  // LLM 看到的唯一标识符
  description: string           // 帮助 LLM 决定何时调用
  inputSchema: Record<string, unknown>   // JSON Schema（字段名 inputSchema）
  execute(params, context?): Promise<ToolResult>
}

ToolResult {
  content: string
  isError?: boolean
}

ToolContext {
  signal?: AbortSignal          // 预留，当前工具执行未消费
}

// 发送给 LLM API 的定义格式（字段名改为 input_schema）
ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>   // 注意：Anthropic API 要求此字段名
}

// AgentRunner 构造依赖
ToolExecutor = (toolName: string, input: Record<string, unknown>) => Promise<ToolResult>
```

**`inputSchema` vs `input_schema` 区别**：
- `Tool.inputSchema`：框架内部字段名，驼峰
- `ToolDefinition.input_schema`：LLM API 要求的字段名，下划线
- 转换由 `runtime/tool-registry.ts` 的 `toLlmToolDefinitions` / `toPromptToolDefinitions` 统一完成，其他地方不做重复转换

---

## 4. 核心函数

### 4.1 createToolExecutor

```
createToolExecutor(tools: Tool[]): ToolExecutor

// 行为：
按 toolName 在 tools[] 中查找
  找不到 → ToolResult { isError: true, content: 'Tool "X" not found' }
  找到   → tool.execute(input)
  执行抛错 → catch → ToolResult { isError: true, content: '...' }
```

异常被转为 `isError: true` 的 `ToolResult`，不向外抛出。这让 AgentRunner 能把工具错误作为正常 tool_result 送给 LLM，让 LLM 自行决定如何应对。

### 4.2 getToolDefinitions

```
getToolDefinitions(tools: Tool[]): ToolDefinition[]

// 行为：
tools.map(t => ({ name, description, input_schema: t.inputSchema }))
```

从 `Tool[]` 提取 LLM API 所需的定义格式，丢弃 `execute` 函数。

---

## 5. 工具注册流程

工具框架本身不管理注册——注册和组装在 `runtime/tool-registry.ts` 完成：

```
assembleRuntimeTools(builtinTools, memoryManager):
  tools = [...builtinTools]
  if memoryManager: tools.push(...createMemoryTools(memoryManager))
  return {
    tools,
    executor: createToolExecutor(tools),
    llmDefinitions: toLlmToolDefinitions(tools),    // input_schema
    promptDefinitions: toPromptToolDefinitions(tools) // parameters
  }
```

`executor`、`llmDefinitions`、`promptDefinitions` 永远对应同一份 `tools[]`，一致性由此保证。
