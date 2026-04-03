# Tools 模块设计文档

> 创建日期：2026-04-03  
> 参考：OpenClaw 的工具系统（详见 [openclaw-tool-system-analysis.md](./openclaw-tool-system-analysis.md)）

---

## 1. 概述

Tools 模块负责工具的定义、执行和内置工具的提供。

**职责**：
- 定义 `Tool` 接口（name + description + inputSchema + execute）
- 定义 `ToolResult` 和 `ToolExecutor` 类型（生产方拥有）
- 提供 `createToolExecutor(tools)` 工具函数
- 提供内置工具（exec）

**不属于 Tools 模块的职责**：
- 工具循环（tool use loop）— 属于 agent-runner
- 工具策略/权限过滤 — 暂不需要
- beforeToolCall / afterToolCall hook — 暂不需要
- 安全性检测（危险命令等）— 留给 system prompt / AGENTS.md 约束

### 与 OpenClaw 的对比

| | OpenClaw / pi-agent-core | 我们 |
|---|---|---|
| 工具定义 | `AgentTool`（name + description + parameters(TypeBox) + execute + label） | `Tool`（name + description + inputSchema(JSON Schema) + execute） |
| 参数 schema | TypeBox（`@sinclair/typebox`） | 普通 JSON Schema 对象 |
| execute 签名 | `(toolCallId, params, signal?, onUpdate?)` | `(params, context?)` |
| 工具集合 | 数组，直接传给 Agent | 数组，通过 `createToolExecutor` 转为回调 |
| 工具注册 | 工厂函数 + 插件 registerTool | 直接构造 Tool 对象 |
| 内置工具 | 30+（文件、命令、浏览器、网络、会话等） | exec（先实现基础版） |
| 策略过滤 | 多层策略管道 | 不需要 |
| 安全检测 | 审批流程（elevated） | 不在工具层做，留给 prompt 约束 |
| 执行模式 | sequential / parallel | sequential |

---

## 2. 目录结构

```
src/
└── tools/
    ├── index.ts          # 公共入口
    ├── types.ts          # Tool, ToolResult, ToolExecutor, ToolContext, ToolDefinition
    ├── executor.ts       # createToolExecutor() + getToolDefinitions()
    └── builtin/
        ├── index.ts      # 导出所有内置工具
        └── exec.ts       # exec 工具（shell 命令执行）
```

---

## 3. 类型系统

```typescript
// tools/types.ts

/** 工具执行上下文（可选，用于传递 signal 等） */
export interface ToolContext {
  signal?: AbortSignal;
}

/** 工具执行结果 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** 工具执行回调（agent-runner 引用此类型） */
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolResult>;

/** 工具定义 */
export interface Tool {
  /** 工具名称（唯一标识，传给 LLM） */
  name: string;
  /** 工具描述（传给 LLM，让它知道何时使用） */
  description: string;
  /** 参数的 JSON Schema（传给 LLM，让它知道怎么调用） */
  inputSchema: Record<string, unknown>;
  /** 执行函数 */
  execute: (
    params: Record<string, unknown>,
    context?: ToolContext,
  ) => Promise<ToolResult>;
}

/** 传给 LLM 的工具定义（不含 execute） */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
```

### 类型归属

| 类型 | 归属 | 消费方 |
|------|------|--------|
| `Tool` | tools | 调用方（定义工具时使用） |
| `ToolResult` | tools | agent-runner（接收执行结果） |
| `ToolExecutor` | tools | agent-runner（构造参数类型） |
| `ToolContext` | tools | 工具实现者（可选使用） |
| `ToolDefinition` | tools | agent-runner（传给 LLM） |

---

## 4. createToolExecutor

将 `Tool[]` 转换为 `ToolExecutor` 回调，供 agent-runner 使用：

```typescript
function createToolExecutor(tools: Tool[]): ToolExecutor {
  return async (toolName, input) => {
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      return { content: `Tool "${toolName}" not found`, isError: true };
    }
    try {
      return await tool.execute(input);
    } catch (err) {
      return {
        content: `Error executing tool "${toolName}": ${err.message}`,
        isError: true,
      };
    }
  };
}
```

### 辅助函数

```typescript
/** 从 Tool[] 提取传给 LLM 的工具定义数组 */
function getToolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
```

---

## 5. 内置工具：exec

### 5.1 与 OpenClaw 的对比

| | OpenClaw `exec` | pi-coding-agent `bash` | 我们的 `exec` |
|---|---|---|---|
| 参数 | command + workdir + env + timeout + background + yieldMs + pty + elevated | command + timeout | command + cwd + timeout + env |
| 后台执行 | ✅（配合 process 工具） | ❌ | ❌（后续扩展） |
| PTY 支持 | ✅ | ❌ | ❌（后续扩展） |
| 权限提升 | ✅（审批流程） | ❌ | ❌ |
| 沙箱隔离 | ✅（Docker） | ❌ | ❌ |
| 输出处理 | spawn 分别监听 stdout/stderr，内存中按时间合并 | 类似 | spawn 分别监听，按时间合并 |
| 安全检测 | 审批流程 | ❌ | ❌（留给 prompt 约束） |

### 5.2 参数

| 参数 | 类型 | 必填？ | 说明 |
|------|------|:------:|------|
| `command` | string | ✅ | Shell 命令 |
| `timeout` | number | 可选 | 超时秒数，默认 30 |
| `cwd` | string | 可选 | 工作目录，默认工作区根目录 |
| `env` | Record<string, string> | 可选 | 额外环境变量 |

> 后续可扩展：`background`、`pty`、`elevated`（配合 process 工具）

### 5.3 返回值

stdout 和 stderr 通过 spawn 分别监听，按到达时间顺序合并到一个 output 字符串（与 OpenClaw 一致，不使用 `2>&1`）：

```typescript
// 成功（exitCode === 0）
{ content: "合并后的 stdout + stderr 输出" }

// 失败（exitCode !== 0 或超时）
{ content: "合并后的输出\n\nProcess exited with code 1", isError: true }

// 超时
{ content: "合并后的部分输出\n\nProcess timed out after 30 seconds", isError: true }
```

### 5.4 实现方式

```typescript
// 使用 child_process.spawn
const child = spawn('sh', ['-c', command], {
  cwd: params.cwd ?? defaultCwd,
  env: { ...process.env, ...params.env },
});

// 分别监听，按时间合并
let output = '';
child.stdout.on('data', (data) => { output += data.toString(); });
child.stderr.on('data', (data) => { output += data.toString(); });

// 超时控制
const timer = setTimeout(() => child.kill(), timeout * 1000);
```

### 5.5 使用示例

```typescript
import { execTool } from './tools/builtin';

// 直接使用
const result = await execTool.execute({ command: 'ls -la' });

// 和其他工具一起传给 AgentRunner
import { createToolExecutor, getToolDefinitions } from './tools';

const tools = [execTool, ...otherTools];
const runner = new AgentRunner({
  llmClient,
  sessionManager,
  toolExecutor: createToolExecutor(tools),
});

runner.run({
  tools: getToolDefinitions(tools),
  ...
});
```

---

## 6. agent-runner 的调整

tools 模块实现后，agent-runner 需要调整：

| 当前 | 调整后 |
|------|--------|
| `ToolResult` 在 agent-runner/types.ts 定义 | 从 tools 模块引用 |
| `ToolExecutor` 在 agent-runner/types.ts 定义 | 从 tools 模块引用 |

agent-runner 的 `AgentRunnerConfig.toolExecutor` 类型改为引用 `tools/types.ts` 的 `ToolExecutor`。

---

## 7. 实施步骤

### Step 1 · types.ts ✅
- [x] Tool 接口
- [x] ToolResult 接口
- [x] ToolExecutor 类型
- [x] ToolContext 接口
- [x] ToolDefinition 接口

### Step 2 · executor.ts ✅
- [x] `createToolExecutor(tools)` — 按 name 查找 + 执行 + 错误处理
- [x] `getToolDefinitions(tools)` — 提取 LLM 工具定义

### Step 3 · index.ts ✅
- [x] 公共入口

### Step 4 · 调整 agent-runner ✅
- [x] agent-runner/types.ts 删除 ToolResult 和 ToolExecutor，改为从 tools 引用

### Step 5 · builtin/exec.ts
- [ ] exec 工具实现
- [ ] spawn + stdout/stderr 分别监听 + 按时间合并
- [ ] 超时控制
- [ ] cwd / env 参数支持

### Step 6 · builtin/index.ts
- [ ] 导出内置工具

---

## 8. 测试计划

### 8.1 单元测试（createToolExecutor，mock，不调用 LLM）

| 测试用例 | 预期行为 |
|---------|---------|
| 调用已注册的工具 | 正确执行，返回 ToolResult |
| 调用不存在的工具 | 返回 `{ content: 'Tool "xxx" not found', isError: true }` |
| 工具 execute 抛出异常 | 捕获异常，返回 `{ content: 'Error...', isError: true }` |
| 多个工具注册 | 按 name 正确查找 |

### 8.2 单元测试（getToolDefinitions）

| 测试用例 | 预期行为 |
|---------|---------|
| 转换 Tool[] 为 LLM 定义 | 包含 name, description, input_schema |
| 空数组 | 返回空数组 |

### 8.3 单元测试（exec 工具）

| 测试用例 | 预期行为 |
|---------|---------|
| 简单命令（echo hello） | 返回 stdout |
| 命令失败（exit 1） | isError: true，包含 exit code |
| 超时 | isError: true，包含超时信息 |
| 自定义 cwd | 在指定目录执行 |
| 自定义 env | 环境变量传入命令 |
| stdout + stderr 合并 | 按时间顺序合并输出 |

### 8.4 集成测试（真实 LLM 调用，验证参数推理能力）

需要真实 LLM，通过脚本手动运行。

**工具定义**：

| 工具 | 参数 | 说明 |
|------|------|------|
| `get_current_time` | 无参数 | 返回当前时间 |
| `get_date` | `offset: number`（必填） | 返回相对今天偏移 N 天的日期 |
| `get_weather` | `city: string`（必填）, `date?: string`（可选） | 返回天气 |
| `get_user_location` | 无参数 | 返回用户所在城市 |

**测试场景**：

| 用户消息 | 预期行为 | 验证点 |
|---------|---------|--------|
| "What day is yesterday?" | 调用 `get_date({ offset: -1 })` | LLM 能将自然语言转为参数 |
| "What's the weather like tomorrow in Shanghai?" | 调用 `get_weather({ city: "Shanghai", date: "tomorrow" })` | 多参数推理 |
| "What's the weather like tomorrow in my city?" | 先调 `get_user_location()`，再调 `get_weather({ city: 结果, date: "tomorrow" })` | 多步工具调用 |

---

## 9. 后续可优化方向

| 能力 | 触发条件 | 参考 |
|------|---------|------|
| process 工具 | 需要后台执行和长命令管理 | OpenClaw `bash-tools.process.ts`（list/poll/log/write/send-keys/kill） |
| exec 后台模式 | 需要 background + yieldMs 参数 | OpenClaw `exec` 的 background/yieldMs |
| exec PTY 支持 | 需要交互式终端命令 | OpenClaw `exec` 的 `pty: true` |
| 更多内置工具 | read_file / write_file / grep / find / ls | pi-coding-agent 内置工具 |
| parallel 执行模式 | 多个工具同时调用时 | pi-agent-core `toolExecution: "parallel"` |
| beforeToolCall / afterToolCall hook | 需要参数验证、循环检测、结果转换 | pi-agent-core hook 系统 |
| 工具策略过滤 | 不同场景需要不同工具集 | OpenClaw `tool-policy.ts` |
| onUpdate 流式回调 | 长时间工具执行需要进度推送 | pi-agent-core `AgentToolUpdateCallback` |
| 安全检测 | 需要在工具层拦截危险命令 | proj1 `security.ts`（危险命令/路径检测） |
