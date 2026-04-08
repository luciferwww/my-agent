# Tools 模块设计文档

> 创建日期：2026-04-03  
> 参考：相关工具系统分析（详见 [openclaw-tool-system-analysis.md](../analysis/openclaw/openclaw-tool-system-analysis.md)）

> 当前状态：截至 2026-04-06，Tools 模块已经落地完整的非 memory builtin tools 集合：`list_dir`、`read_file`、`file_search`、`grep_search`、`apply_patch`、`write_file`、`edit_file`、`web_fetch`、`exec`、`process`。其中 `exec + process` 仍然是运行时最复杂的一组，相关 helper 包括 `run-command.ts`、`process-registry.ts`、`resolve-command-invocation.ts`、`kill-process-tree.ts`。本文按当前实现同步，后文若出现“后续可扩展”，指的是在现有最小版 `v2` 之上的继续增强，而不是这些能力尚未存在。

> 相关文档：如果只想看 builtin tools 的工具面、最小 schema 和分阶段落地顺序，请直接看 [builtin-tools-design.md](./builtin-tools-design.md)。

---

## 1. 概述

Tools 模块负责工具的定义、执行和内置工具的提供。

**职责**：
- 定义 `Tool` 接口（name + description + inputSchema + execute）
- 定义 `ToolResult` 和 `ToolExecutor` 类型（生产方拥有）
- 提供 `createToolExecutor(tools)` 工具函数
- 提供内置工具，并按阶段扩展内置工具面
- 承载 `exec + process` 运行时 helper 的模块边界

**不属于 Tools 模块的职责**：
- 工具循环（tool use loop）— 属于 agent-runner
- 工具策略/权限过滤 — 暂不需要
- beforeToolCall / afterToolCall hook — 暂不需要
- 安全性检测（危险命令等）— 留给 system prompt / AGENTS.md 约束
- 配置加载与解析（应由 runtime 层完成后显式传入）

### 配置边界

Tools 模块负责“如何定义和执行工具”，不负责“从哪里读取全局配置”。

因此，Tools 模块原则上不应直接访问 config：

- 不应直接调用 `loadConfig()` 或 `resolveAgentConfig()`；
- 不应通过 `process.env` 自行读取关键运行配置；
- 不应依赖完整 `AgentDefaults` 作为常规输入。

推荐的边界是：

- Runtime 层先完成配置解析；
- Runtime 根据配置决定实际暴露哪些工具；
- Tools 模块通过显式参数或局部 options 接收自己真正需要的最小配置子集。

这样 Tools 才能保持为稳定、可复用的能力层，而不是隐式耦合全局配置的应用层。

> Note：Tools 模块当前追求的是清晰、可测试的最小能力面：普通 JSON Schema、显式 `Tool[]` 集合、顺序执行、无策略管道、无审批和沙箱。复杂的平台化工具治理不在本阶段引入。

### 命名原则

Tools 模块中的工具名统一使用 snake_case，但不强求所有工具都采用同一种语序。

当前采用的是“分类统一”规则：

- 资源操作类优先使用 `verb_resource`：如 `read_file`、`write_file`、`edit_file`、`list_dir`
- 检索 / 抓取类优先使用 `resource_action`：如 `file_search`、`memory_search`、`web_fetch`
- 同一子系统内保持统一前缀：如 `memory_search`、`memory_get`、`memory_write`
- 极少数运行控制工具可保留短名：如 `exec`、`process`

按这个规则，`grep_search` 当前也保留不改：它虽然偏工程术语，但能准确表达“按文本 / 正则逐行匹配”的 grep-like 语义，并与 `file_search` 形成清晰分工。

---

## 2. 目录结构

```
src/
└── tools/
  ├── index.ts                         # 公共入口
  ├── types.ts                         # Tool, ToolResult, ToolExecutor, ToolContext, ToolDefinition
  ├── executor.ts                      # createToolExecutor() + getToolDefinitions()
  ├── executor.test.ts                 # executor 的单元测试
    └── builtin/
    ├── index.ts                        # 导出 builtin tools
    ├── common/
    │   ├── path-policy.ts              # workspace 路径约束
    │   └── workspace-walk.ts           # 工作区遍历与路径匹配
    ├── list-dir.ts                     # list_dir
    ├── read-file.ts                    # read_file
    ├── file-search.ts                  # file_search
    ├── grep-search.ts                  # grep_search
    ├── apply-patch.ts                  # apply_patch
    ├── apply-patch-update.ts           # apply_patch update hunk helper
    ├── write-file.ts                   # write_file
    ├── edit-file.ts                    # edit_file
    ├── web-fetch.ts                    # web_fetch
    ├── exec.ts                         # exec 工具
    ├── process.ts                      # process 工具
    ├── exec-types.ts                   # exec / process 共享类型
    ├── run-command.ts                  # 命令启动与前台完成态聚合
    ├── process-registry.ts             # 后台任务 registry
    ├── resolve-command-invocation.ts   # 显式平台 shell wrapper
    ├── kill-process-tree.ts            # 跨平台树状终止
    ├── list-dir.test.ts
    ├── read-file.test.ts
    ├── file-search.test.ts
    ├── grep-search.test.ts
    ├── apply-patch.test.ts
    ├── write-file.test.ts
    ├── edit-file.test.ts
    ├── web-fetch.test.ts
        ├── exec.test.ts
        ├── process.test.ts
        ├── run-command.test.ts
        ├── process-registry.test.ts
        ├── resolve-command-invocation.test.ts
        └── kill-process-tree.test.ts
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

## 5. 目标内置工具面

这里需要明确区分两件事：

1. **当前已实现的内置工具**：代码里已经落地完整的非 memory builtin tools 集合。
2. **我们实际仍保留的后续工具面**：memory 相关工具仍未实现，继续保留为独立 memory 模块阶段的后续项。

如果不把这两个层次拆开，文档会给人一种错误印象，好像 Tools 模块的 builtin 设计天然只有命令执行这一条线。

### 5.1 建议的分层

建议把内置工具按职责至少分成下面几组。

| 分组 | 作用 | 典型工具 |
|------|------|----------|
| 文件读取与发现 | 让 agent 能理解工作区内容 | `read_file`、`list_dir`、`file_search`、`grep_search` |
| 文件修改 | 让 agent 能落地代码和文档变更 | `write_file`、`edit_file`、`apply_patch` |
| 命令与进程 | 让 agent 能运行命令并管理长任务 | `exec`、`process` |
| 记忆与检索 | 让 agent 能查历史决策、知识和上下文 | `memory_search` 或等价 memory tool |
| 外部信息获取 | 让 agent 能按需获取工作区外部信息 | `web_search`、`web_fetch` 一类工具 |

这几个分组里，`exec/process` 只是第三组，不应该代表整个 builtin tool 设计。

### 5.2 对我们当前项目的最小目标集合

如果只看当前这个 `my-agent` 项目的近期需求，一个更合理的 builtin tool 目标集合至少应覆盖：

- 文件读取与发现：`read_file`、`list_dir`、`file_search`、`grep_search`
- 文件修改：`write_file`、`edit_file`、`apply_patch`
- 命令与进程：`exec`、`process`
- 记忆检索：`memory_search` 或同类 memory tool

原因很直接：

- 没有读取类工具，agent 很难先理解代码再行动。
- 没有修改类工具，agent 只能通过 shell 间接改文件，边界不清晰也不稳。
- 没有 `exec/process`，就缺少命令执行和长任务管理能力。
- 没有 memory tool，prompt-builder 里预留的 memory instruction 也缺少真实落点。

### 5.3 当前实现与目标集合的关系

当前已落地：

- `list_dir`
- `read_file`
- `file_search`
- `grep_search`
- `apply_patch`
- `write_file`
- `edit_file`
- `web_fetch`
- `exec`
- `process`
- 以及它们依赖的 helper：`common/path-policy.ts`、`common/workspace-walk.ts`、`run-command.ts`、`process-registry.ts`、`resolve-command-invocation.ts`、`kill-process-tree.ts`

当前尚未落地但仍应纳入 builtin tool 设计范围：

- `memory_search`
- `memory_get`

因此，后文的 `exec + process` 应理解为：

- 这是 **当前已实现的内置工具章节**
- 不是 **整个内置工具设计的完整范围**

### 5.4 建议实施顺序（与 builtin-tools-design 对齐）

为了避免和 builtin tools 专项文档的顺序表述漂移，这里明确记录同一套推进顺序：

1. **Baseline（已完成）**：`exec`、`process`
2. **Milestone 1（已完成）**：`read_file`、`list_dir`、`file_search`、`grep_search`、`apply_patch`
3. **Milestone 2（已完成）**：`write_file`、`edit_file`
4. **Milestone 3（已完成）**：`web_fetch`
5. **Milestone 4（延后）**：`memory_search`、`memory_get` 或等价 memory tools

这个顺序的含义是：

- `exec/process` 是已经落地的命令基线
- 本地 coding 闭环所需的文件读取、搜索和精确修改已经补齐
- 完整文件写入能力已经作为 `apply_patch` 的补充能力落地
- 当前剩余未完成的只有 memory 检索这一组

---

## 6. 当前已实现的内置工具

截至 2026-04-06，Tools 模块中的 builtin tools 已经不是单独的 `exec + process` 小节，而是下面这组完整的非 memory 工具面：

- 文件读取与发现：`list_dir`、`read_file`、`file_search`、`grep_search`
- 文件修改：`apply_patch`、`write_file`、`edit_file`
- 外部信息获取：`web_fetch`
- 命令与进程：`exec`、`process`

其中 `exec + process` 仍然是运行时最复杂、最值得单独展开的一组，所以本节后半部分继续聚焦它们的运行时设计。

### 6.1 文件与外部 builtin tools 的当前实现边界

当前这些工具的实现边界如下：

- `list_dir`：只列当前层目录项，不递归
- `read_file`：支持 1-based 行区间读取，默认窗口读取
- `file_search`：按路径子串或 glob-like 模式找文件
- `grep_search`：按文本或正则找命中行
- `apply_patch`：支持 `*** Begin Patch` / `*** End Patch` 格式的 add/update/delete
- `write_file`：创建或整体覆写文件
- `edit_file`：要求 `oldText` 精确命中一次
- `web_fetch`：支持 HTTP(S) GET、基础可读文本提取和截断

这些工具默认都受 workspace 边界约束，底层共用 `common/path-policy.ts` 和 `common/workspace-walk.ts`。

### 6.2 当前 `exec + process` 的能力边界

当前这组能力的边界如下：

- `exec` 支持 `command / cwd / timeout / env / yieldMs / background`；
- `process` 支持 `list / status / log / kill`；
- 支持后台执行、显式平台 shell wrapper 和最小版 kill-tree；
- 不做 PTY、stdin 交互、审批、沙箱、多宿主路由。

### 6.3 `exec` 参数

| 参数 | 类型 | 必填？ | 说明 |
|------|------|:------:|------|
| `command` | string | ✅ | Shell 命令 |
| `timeout` | number | 可选 | 超时秒数，默认 30 |
| `cwd` | string | 可选 | 工作目录，默认当前进程工作目录（通常是启动时的工作区目录） |
| `env` | Record<string, string> | 可选 | 额外环境变量 |
| `yieldMs` | number | 可选 | 先前台运行一小段时间，仍未结束则切到后台 |
| `background` | boolean | 可选 | 立即后台启动并返回 runId |

当前语义：

- 未提供 `yieldMs/background` 时，走 foreground。
- 提供 `yieldMs` 时，走 yield continuation。
- `background === true` 时，直接走 immediate background，并忽略 `yieldMs`。

### 6.4 `exec` 返回值

stdout 和 stderr 通过 spawn 分别监听，按到达时间顺序合并到一个 output 字符串（与 OpenClaw 一致，不使用 `2>&1`）：

```typescript
// 成功（exitCode === 0）
{ content: "合并后的 stdout + stderr 输出" }

// 失败（exitCode !== 0 或超时）
{ content: "合并后的输出\n\nProcess exited with code 1", isError: true }

// 超时
{ content: "合并后的部分输出\n\nProcess timed out after 30 seconds", isError: true }

// yield / background
{ content: "Process started in background.\nrunId: proc_xxx\nUse the process tool to check status, read logs, or kill it." }
```

### 6.5 `process` 参数与动作

| 参数 | 类型 | 必填？ | 说明 |
|------|------|:------:|------|
| `action` | string | ✅ | `list` / `status` / `log` / `kill` |
| `runId` | string | 部分必填 | `status` / `log` / `kill` 时必填 |
| `tailLines` | number | 可选 | `log` 时只返回最后 N 行 |

当前动作语义：

- `list`：只展示已经进入 `background` 可见性的记录。
- `status`：返回 `runId / status / command / pid / startedAt / endedAt / yielded / summary`。
- `log`：返回累计日志；无输出时固定返回 `No output has been produced yet.`。
- `kill`：对运行中任务复用 kill-tree；对已结束任务保持幂等，直接返回当前终态摘要。

### 6.6 实现方式

```typescript
exec.ts
  -> normalizeExecRequest()
  -> run-command.ts
       -> resolve-command-invocation.ts
       -> process-registry.ts
       -> kill-process-tree.ts

process.ts
  -> process-registry.ts
  -> kill-process-tree.ts
```

当前实现的关键点：

- 不再依赖 Node 的隐式 `shell: true`，而是显式走 Windows `cmd.exe /d /s /c` 与 Unix `/bin/sh -c`。
- foreground / yield / background 三条路径共用同一套 `runCommand()`。
- timeout、AbortSignal、manual kill 复用同一套 kill-tree 终止语义。
- background / yield 任务由 `process-registry.ts` 维护 `internal` 与 `background` 两种可见性。
- Unix 当前默认以独立 process group 启动 shell wrapper，这样 timeout / abort 能收敛整棵树。

### 6.7 使用示例

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

```typescript
import { createToolExecutor, execTool, processTool } from './tools';

const toolExecutor = createToolExecutor([execTool, processTool]);

const started = await toolExecutor('exec', {
  command: 'npm run dev',
  background: true,
});

const runId = /runId:\s*(\S+)/.exec(started.content)?.[1];
const status = await toolExecutor('process', { action: 'status', runId });
const log = await toolExecutor('process', { action: 'log', runId, tailLines: 50 });
```

### 6.8 当前结论：`exec + process` 的边界

当前实现已经具备最小版 `exec + process` 组合，但仍是“任务管理器式 process”，不做 PTY、stdin 交互、多宿主路由和审批体系。

因此，这里不追求扩展为完整命令会话平台，而是按实际需求逐步增强。

### 6.9 最值得继续吸收的点

- **更完整的 Windows shim / wrapper resolver**：当前我们只显式化 shell wrapper，还没有吸收 `npm/npx/pnpm/yarn` 那套更细的兼容处理。
- **更完整的 Unix shebang / host-aware resolution**：当前也还没进入 ACPX runtime 那种完整 resolution pipeline。
- **更丰富的 process 会话动作**：如果未来出现真实交互式进程需求，再考虑 `write` / `submit` / `send-keys`。
- **更细的流式进度接口**：当前 helper 已有 `onStdout/onStderr/onSpawn/onExit`，未来如需 UI 级实时反馈，可以继续在这层增强。

### 6.10 暂不建议引入的能力

- 审批流、allowlist、durable approval
- sandbox / gateway / node 多宿主路由
- PTY 与交互式终端控制
- 工具层危险命令分析

这些能力对当前这个“最小版 `exec + process` + 本地工作区”模型来说，复杂度明显高于收益。

### 6.11 推荐演进顺序

如果后续继续增强，建议按下面顺序推进：

1. 继续补强 resolver / shim / shebang 这一层平台运行时细节。
2. 再视需求增强后台任务的状态摘要和清理策略。
3. 只有当确实出现交互式进程需求时，再进入会话控制台能力。

更细的分阶段实施说明见 [exec-evolution-roadmap.md](../roadmap/exec-evolution-roadmap.md)。
`exec + process` 的详细运行与交互流程见 [exec-process-flow-design.md](./exec-process-flow-design.md)。

---

## 7. agent-runner 的调整

tools 模块实现后，agent-runner 需要调整：

| 当前 | 调整后 |
|------|--------|
| `ToolResult` 在 agent-runner/types.ts 定义 | 从 tools 模块引用 |
| `ToolExecutor` 在 agent-runner/types.ts 定义 | 从 tools 模块引用 |

agent-runner 的 `AgentRunnerConfig.toolExecutor` 类型改为引用 `tools/types.ts` 的 `ToolExecutor`。

---

## 8. 实施步骤

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
- [x] exec 工具实现
- [x] foreground / yield / background 三种模式
- [x] cwd / env / timeout / yieldMs / background 参数支持
- [x] 前台完成态与后台 runId 返回文案

### Step 6 · builtin/process.ts
- [x] process 工具实现
- [x] list / status / log / kill 四个动作
- [x] kill 幂等与终态摘要

### Step 7 · 文件与外部 builtin tools
- [x] list-dir.ts
- [x] read-file.ts
- [x] file-search.ts
- [x] grep-search.ts
- [x] apply-patch.ts
- [x] write-file.ts
- [x] edit-file.ts
- [x] web-fetch.ts
- [x] common/path-policy.ts
- [x] common/workspace-walk.ts

### Step 8 · 运行时 helper
- [x] run-command.ts
- [x] process-registry.ts
- [x] resolve-command-invocation.ts
- [x] kill-process-tree.ts

### Step 9 · builtin/index.ts
- [x] 导出内置工具

---

## 9. 测试计划

### 9.1 单元测试（createToolExecutor，mock，不调用 LLM）

| 测试用例 | 预期行为 |
|---------|---------|
| 调用已注册的工具 | 正确执行，返回 ToolResult |
| 调用不存在的工具 | 返回 `{ content: 'Tool "xxx" not found', isError: true }` |
| 工具 execute 抛出异常 | 捕获异常，返回 `{ content: 'Error...', isError: true }` |
| 多个工具注册 | 按 name 正确查找 |

### 9.2 单元测试（getToolDefinitions）

| 测试用例 | 预期行为 |
|---------|---------|
| 转换 Tool[] 为 LLM 定义 | 包含 name, description, input_schema |
| 空数组 | 返回空数组 |

### 9.3 单元测试（exec 工具）

| 测试用例 | 预期行为 |
|---------|---------|
| 简单命令（echo hello） | 返回 stdout |
| 命令失败（exit 1） | isError: true，包含 exit code |
| 超时 | isError: true，包含超时信息 |
| 自定义 cwd | 在指定目录执行 |
| 自定义 env | 环境变量传入命令 |
| stdout + stderr 合并 | 按时间顺序合并输出 |

当前已覆盖：简单命令、失败退出、超时、自定义 cwd、自定义 env、stdout/stderr 合并。

### 9.4 单元测试（process 与运行时 helper）

| 测试用例 | 预期行为 |
|---------|---------|
| `process.list` 可见性 | 不泄露 internal record |
| `process.kill` 幂等 | 已完成任务不会被改写为 aborted |
| Windows / Unix invocation resolver | 显式 wrapper 正确 |
| kill-tree | Windows `taskkill` 与 Unix process-group 路径正确 |
| run-command abort / timeout | 终态映射正确 |

当前已覆盖：

- `executor.test.ts`
- `builtin/exec.test.ts`
- `builtin/process.test.ts`
- `builtin/process-registry.test.ts`
- `builtin/run-command.test.ts`
- `builtin/resolve-command-invocation.test.ts`
- `builtin/kill-process-tree.test.ts`

### 9.5 单元测试（文件与外部 builtin tools）

当前已覆盖：

- `builtin/list-dir.test.ts`
- `builtin/read-file.test.ts`
- `builtin/file-search.test.ts`
- `builtin/grep-search.test.ts`
- `builtin/apply-patch.test.ts`
- `builtin/write-file.test.ts`
- `builtin/edit-file.test.ts`
- `builtin/web-fetch.test.ts`

### 9.6 集成测试（脚本回归）

当前与完整 non-memory builtin tool surface 直接相关的脚本回归包括：

- `scripts/test-builtin-tools.ts`
- `scripts/test-builtin-tools-integration.ts`

其中：

- `test-builtin-tools.ts` 覆盖 direct smoke 路径
- `test-builtin-tools-integration.ts` 覆盖单个 `ToolExecutor` 下的真实调用链

当前与 `exec + process` 直接相关的脚本回归还包括：

- `scripts/test-exec-list-cwd.ts`
- `scripts/test-exec-platform-shell.ts`
- `scripts/test-exec-background.ts`
- `scripts/test-exec-yield.ts`
- `scripts/test-exec-timeout-tree.ts`
- `scripts/test-exec-abort-tree.ts`
- `scripts/test-process-kill.ts`
- `scripts/test-process-kill-no-output.ts`
- `scripts/test-process-kill-after-exit.ts`
- `scripts/test-process-kill-race.ts`
- `scripts/test-process-kill-tree.ts`
- `scripts/test-process-kill-yield-tree.ts`
- `scripts/test-process-list-lifecycle.ts`

完整命令矩阵见 [exec-process-platform-regression-checklist.md](../roadmap/exec-process-platform-regression-checklist.md)。

### 9.7 当前验收状态

截至 2026-04-06，Vitest 已恢复为有效验收路径，不再存在此前因 Windows 主机安装了错误 esbuild 平台包而导致的环境性假失败。当前：

- `src/tools/builtin` 目录下的 Vitest 可直接作为 builtin tools 单元验收
- `scripts/test-builtin-tools.ts` 与 `scripts/test-builtin-tools-integration.ts` 可作为 smoke / 集成验收
- 全仓 `npm test` 也已通过

### 9.8 集成测试（真实 LLM 调用，验证参数推理能力）

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

## 10. 后续可优化方向

| 能力 | 触发条件 | 参考 |
|------|---------|------|
| 更完整的 process 会话动作 | 需要交互式进程管理 | OpenClaw `bash-tools.process.ts`（list/poll/log/write/send-keys/kill） |
| 更完整的 Windows shim resolver | 需要贴近真实 CLI wrapper 行为 | OpenClaw `exec.ts` + `windows-command.ts` |
| exec PTY 支持 | 需要交互式终端命令 | OpenClaw `exec` 的 `pty: true` |
| 更多内置工具 | read_file / write_file / grep / find / ls | pi-coding-agent 内置工具 |
| parallel 执行模式 | 多个工具同时调用时 | pi-agent-core `toolExecution: "parallel"` |
| beforeToolCall / afterToolCall hook | 需要参数验证、循环检测、结果转换 | pi-agent-core hook 系统 |
| 工具策略过滤 | 不同场景需要不同工具集 | OpenClaw `tool-policy.ts` |
| onUpdate 流式回调 | 长时间工具执行需要进度推送 | pi-agent-core `AgentToolUpdateCallback` |
| 安全检测 | 需要在工具层拦截危险命令 | proj1 `security.ts`（危险命令/路径检测） |
