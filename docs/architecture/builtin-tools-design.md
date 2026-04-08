# Builtin Tools 设计文档

> 创建日期：2026-04-06  
> 参考：OpenClaw 的 coding tools / `apply_patch` / `web_fetch`，以及本项目现有的 [tools-design.md](./tools-design.md)

> 当前状态：截至 2026-04-06，本文所列的非 memory builtin tools 已全部落地到 `src/tools/builtin/`，包括 `read_file`、`list_dir`、`file_search`、`grep_search`、`apply_patch`、`write_file`、`edit_file`、`web_fetch`、`exec`、`process`。当前剩余未实现的只有延后到独立 memory 模块阶段的 `memory_search` / `memory_get`。

> 相关文档：如果想看 Tools 模块的公共类型、executor、当前 `exec + process` 运行时边界，请回到 [tools-design.md](./tools-design.md)。

---

## 1. 概述

本文只讨论 **builtin tools 本身** 的设计，不讨论整个 Tools 模块的公共类型、executor 机制或当前已实现的 `exec + process` 运行时细节。

换句话说：

- [tools-design.md](./tools-design.md) 负责说明 Tools 模块整体边界
- 本文负责说明 **我们最终需要哪些 builtin tools、这些工具的最小输入输出 schema 是什么、以及应如何分阶段落地**

### 1.1 设计目标

我们需要的不是一个只有 `exec/process` 的最小工具壳子，而是一套足以支撑 coding agent 完整工作流的 builtin tool surface。

这个工作流至少包括：

1. 发现文件和目录
2. 读取局部文件内容
3. 搜索文件路径和文本
4. 精确修改文件
5. 在必要时新建或重写文件
6. 运行命令并管理长任务
7. 在需要时获取工作区外部内容

### 1.2 当前范围

本文当前明确纳入 builtin tool 设计范围的工具如下：

| 分组 | 工具 |
|------|------|
| 文件读取与发现 | `read_file`、`list_dir`、`file_search`、`grep_search` |
| 文件修改 | `apply_patch`、`write_file`、`edit_file` |
| 命令与进程 | `exec`、`process` |
| 外部信息获取 | `web_fetch` |
| 记忆检索（预留） | `memory_search`、`memory_get` |

### 1.3 暂不展开详细设计的范围

以下内容在本轮不展开：

1. memory 管理模块设计
2. web search 设计
3. 多用户权限、策略过滤、审批流
4. 浏览器自动化
5. plugin tool 系统
6. PTY / 交互式终端控制

原因很简单：这些能力要么还没有迫切需求，要么其设计复杂度明显高于当前收益。

其中 memory 相关要特别说明：

1. `memory_search` / `memory_get` 仍然属于 builtin tool surface 的候选成员
2. 但它们不应直接在 tools 层各自实现完整逻辑
3. 更合理的做法是后续先设计独立的 `memory/` 管理模块，再由 builtin tools 对其做一层薄封装

---

## 2. 当前设计范围

builtin tools 当前只服务于本地 coding agent 的核心工作流，不追求一次性覆盖所有可能的工具类别。

本文采用的策略是：

1. 让 coding workflow 直接需要的高价值工具先稳定下来
2. 维持本项目自己的命名和简化边界
3. 只为当前阶段真正需要的 builtin tools 定义最小 schema

当前的重点是把下面几类工具打磨清楚：

- 文件读取与修改
- 命令执行与后台进程管理
- 必要的外部获取能力
- 通过薄封装接入 memory 能力

---

## 3. 设计原则

### 3.1 命名约定

统一使用 snake_case，并保持职责直接可见：

- 读取文件：`read_file`
- 搜索文件内容：`grep_search`
- 搜索文件路径：`file_search`
- 应用补丁：`apply_patch`

这样做比沿用 OpenClaw 的 `read` / `write` / `edit` 更适合当前项目，因为当前项目的文档和 prompt 设计里本来就倾向使用更直白的工具名。

### 3.2 参数命名约定

尽量统一下面这些字段：

- 路径统一使用 `path`
- 搜索词统一使用 `query`
- 行范围统一使用 `startLine` / `endLine`
- 最大数量统一使用 `maxResults`
- 长文本截断统一使用 `maxChars`

### 3.3 输出约定

当前 `ToolResult` 仍然是：

```typescript
interface ToolResult {
  content: string;
  isError?: boolean;
}
```

因此 builtin tool 的实现建议分成两层：

1. **内部语义结果**：工具内部先构造结构化结果对象
2. **对外返回结果**：最后再格式化成 `ToolResult.content`

这样即使未来 `ToolResult` 升级为结构化返回，工具内部逻辑也不需要重写。

### 3.4 路径边界

文件类 builtin tools 默认都应以 workspace 为边界。

最小版先遵循以下规则：

1. 接受 workspace-relative path
2. 可选接受 absolute path，但必须解析后仍位于 workspace 内
3. 越界路径直接返回错误

`apply_patch` 也应遵循同样原则。

### 3.5 搜索与读取分离

搜索工具和读取工具不应混合：

1. `file_search` 只找路径
2. `grep_search` 只找文本命中
3. `read_file` 负责精确读取

这样 agent 的调用链会更清晰：

```text
list_dir / file_search / grep_search
  -> read_file
  -> apply_patch / edit_file / write_file
  -> exec / process
```

---

## 4. 目录结构

### 4.1 当前结构

```
src/
└── tools/
    ├── index.ts
    ├── types.ts
    ├── executor.ts
    ├── executor.test.ts
    └── builtin/
        ├── index.ts
        ├── common/
        │   ├── path-policy.ts
        │   └── workspace-walk.ts
        ├── read-file.ts
        ├── list-dir.ts
        ├── file-search.ts
        ├── grep-search.ts
        ├── apply-patch.ts
        ├── apply-patch-update.ts
        ├── write-file.ts
        ├── edit-file.ts
        ├── web-fetch.ts
        ├── exec.ts
        ├── process.ts
        ├── exec-types.ts
        ├── run-command.ts
        ├── process-registry.ts
        ├── resolve-command-invocation.ts
        ├── kill-process-tree.ts
        └── *.test.ts
```

### 4.2 当前实现说明

当前代码已经具备下面两类公共 helper：

1. `common/path-policy.ts`：统一处理 workspace 路径归一化和越界拦截
2. `common/workspace-walk.ts`：统一处理递归遍历和路径匹配

因此这里不再是“只有 exec/process 的起步结构”，而是已经形成了一套完整的非 memory builtin tools 目录骨架。

### 4.3 可继续演进的结构

在 builtin tools 逐步补齐后，建议演进为：

```
src/
└── tools/
    ├── index.ts
    ├── types.ts
    ├── executor.ts
    ├── executor.test.ts
    └── builtin/
        ├── index.ts
        ├── common/
        │   ├── path-policy.ts        # workspace 路径校验与归一化
        │   ├── text-format.ts        # 文本结果格式化 helper
        │   └── search-format.ts      # 搜索结果格式化 helper
        ├── read-file.ts
        ├── list-dir.ts
        ├── file-search.ts
        ├── grep-search.ts
        ├── apply-patch.ts
        ├── write-file.ts
        ├── edit-file.ts
        ├── web-fetch.ts
        ├── exec.ts
        ├── process.ts
        └── ...tests
```

这里的 `common/` 不是必须一次到位，但路径约束和结果格式化逻辑迟早需要抽出来，否则每个工具都会各自复制一遍。

---

## 5. 工具分组与优先级

### 5.1 Baseline：命令与进程（已落地）

包含工具：

1. `exec`
2. `process`

这部分已经落地，详细设计见：

1. [tools-design.md](./tools-design.md)
2. [exec-process-flow-design.md](./exec-process-flow-design.md)
3. [exec-process-platform-runtime-design.md](./exec-process-platform-runtime-design.md)

后续 builtin tools 的 milestone 默认都建立在这组基线上。

### 5.2 Milestone 1：读取与精确修改闭环（已完成）

目标：补齐最小 coding loop。

包含工具：

1. `read_file`
2. `list_dir`
3. `file_search`
4. `grep_search`
5. `apply_patch`

完成后，agent 应能完成：

```text
发现路径 -> 读文件 -> 搜索定位 -> 精确修改 -> 运行命令验证
```

当前实现状态：`read_file`、`list_dir`、`file_search`、`grep_search`、`apply_patch` 均已落地，并已补单测、smoke 和 executor 级集成验证。

### 5.3 Milestone 2：完整文件编辑能力（已完成）

包含工具：

1. `write_file`
2. `edit_file`

完成后，agent 在文件修改上将具备三种互补手段：

1. `apply_patch`：复杂或多文件 patch
2. `edit_file`：简单文本替换
3. `write_file`：创建或整体覆写文件

当前实现状态：`write_file` 与 `edit_file` 已落地，当前非 memory 文件编辑闭环已经完整。

### 5.4 Milestone 3：工作区外信息获取（已完成）

包含工具：

1. `web_fetch`

先只做 fetch，不在本轮引入 `web_search`。

当前实现状态：`web_fetch` 已落地，支持 HTTP(S) GET、基础可读文本提取和长度截断。

### 5.5 Milestone 4：记忆检索（延后）

包含工具：

1. `memory_search`
2. `memory_get`

这一阶段只保留结论，不展开实现细节：

1. `memory_search` 用于检索相关记忆片段
2. `memory_get` 用于按路径或范围读取具体记忆内容
3. 两者都应依赖未来独立的 `memory/` 管理模块，而不是直接把索引、检索、文件读取逻辑堆在 tools 层

---

## 6. 各工具最小 schema

本节定义的是 builtin tools 的 **最小可实现 schema**，而不是最终一步到位的全量能力。

### 6.1 `read_file`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
    startLine: { type: 'number', description: '1-based start line.' },
    endLine: { type: 'number', description: '1-based end line, inclusive.' },
  },
  required: ['path'],
}
```

#### 语义输出

```typescript
{
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  truncated?: boolean;
}
```

#### 最小语义

1. 不传 `startLine/endLine` 时，读取一个默认窗口
2. 路径必须解析到 workspace 内
3. 读取失败时返回错误，不自动回退到 shell

### 6.2 `list_dir`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Directory path.' },
  },
  required: ['path'],
}
```

#### 语义输出

```typescript
{
  path: string;
  entries: Array<{
    name: string;
    type: 'file' | 'dir';
  }>;
}
```

#### 最小语义

1. 只列当前层，不递归
2. 结果顺序保持稳定，便于测试
3. 目录不存在时直接报错

### 6.3 `file_search`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Glob or path pattern to search for files.' },
    maxResults: { type: 'number', description: 'Maximum number of matches.' },
  },
  required: ['query'],
}
```

#### 语义输出

```typescript
{
  query: string;
  matches: string[];
}
```

#### 最小语义

1. 只解决文件路径发现问题
2. 不负责文件内容搜索
3. 没有匹配时返回空结果，不算错误

### 6.4 `grep_search`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Text or regex to search for.' },
    isRegexp: { type: 'boolean', description: 'Whether query is a regex.' },
    includePattern: { type: 'string', description: 'Optional file glob filter.' },
    maxResults: { type: 'number', description: 'Maximum number of matches.' },
  },
  required: ['query', 'isRegexp'],
}
```

#### 语义输出

```typescript
{
  query: string;
  isRegexp: boolean;
  matches: Array<{
    path: string;
    lineNumber: number;
    line: string;
  }>;
}
```

#### 最小语义

1. 返回命中的单行与行号
2. 不返回大段上下文
3. 没有命中时返回空结果，不算错误

### 6.5 `apply_patch`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description: 'Full patch text including *** Begin Patch and *** End Patch.',
    },
  },
  required: ['input'],
}
```

#### 语义输出

```typescript
{
  summary: {
    added: string[];
    modified: string[];
    deleted: string[];
  };
  text: string;
}
```

#### 最小语义

1. 直接采用 `*** Begin Patch` / `*** End Patch` 格式
2. 支持 add / update / delete
3. 默认限制在 workspace 内

### 6.6 `write_file`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Target file path.' },
    content: { type: 'string', description: 'Full file content to write.' },
  },
  required: ['path', 'content'],
}
```

#### 语义输出

```typescript
{
  path: string;
  created: boolean;
  bytesWritten: number;
}
```

#### 最小语义

1. 不存在则创建
2. 已存在则整体覆写
3. 不承担局部替换语义

### 6.7 `edit_file`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Target file path.' },
    oldText: { type: 'string', description: 'Exact text to replace.' },
    newText: { type: 'string', description: 'Replacement text.' },
  },
  required: ['path', 'oldText', 'newText'],
}
```

#### 语义输出

```typescript
{
  path: string;
  replacements: number;
}
```

#### 最小语义

1. 要求 `oldText` 恰好命中一次
2. 0 次命中报错
3. 多次命中也报错

### 6.8 `exec`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    command: { type: 'string' },
    timeout: { type: 'number' },
    cwd: { type: 'string' },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    yieldMs: { type: 'number' },
    background: { type: 'boolean' },
  },
  required: ['command'],
}
```

#### 语义输出

```typescript
{
  status: 'completed' | 'failed' | 'timed_out' | 'aborted' | 'background';
  output: string;
  runId?: string;
  exitCode?: number;
  signal?: string;
}
```

#### 最小语义

1. 前台执行
2. `yieldMs` 前台短跑后转后台
3. `background: true` 直接后台启动

### 6.9 `process`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'status', 'log', 'kill'],
    },
    runId: { type: 'string' },
    tailLines: { type: 'number' },
  },
  required: ['action'],
}
```

#### 语义输出

```typescript
// list
{
  processes: Array<{
    runId: string;
    status: string;
    command: string;
  }>;
}

// status
{
  runId: string;
  status: string;
  command: string;
  pid?: number;
  startedAt?: number;
  endedAt?: number;
  yielded?: boolean;
  summary: string;
}

// log
{
  runId: string;
  output: string;
}

// kill
{
  runId: string;
  status: string;
  summary: string;
}
```

#### 最小语义

1. `list` 只看 background 可见任务
2. `status` 返回最小状态摘要
3. `log` 支持 tailLines
4. `kill` 保持幂等

### 6.10 `web_fetch`

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    url: { type: 'string', description: 'HTTP or HTTPS URL.' },
    extractMode: {
      type: 'string',
      enum: ['markdown', 'text'],
      description: 'Readable extraction format.',
    },
    maxChars: { type: 'number', description: 'Maximum output characters.' },
  },
  required: ['url'],
}
```

#### 语义输出

```typescript
{
  url: string;
  finalUrl?: string;
  extractMode: 'markdown' | 'text';
  content: string;
  truncated?: boolean;
}
```

#### 最小语义

1. 只支持 HTTP GET
2. 只做可读文本提取，不执行 JavaScript
3. 对超长结果做截断

### 6.11 `memory_search`（预留）

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Query used to search memory snippets.' },
    maxResults: { type: 'number', description: 'Maximum number of returned hits.' },
  },
  required: ['query'],
}
```

#### 语义输出

```typescript
{
  query: string;
  matches: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    snippet: string;
    score?: number;
  }>;
}
```

#### 当前约束

1. 这里只保留最小接口形状，不定义具体索引方案
2. 未来实现应依赖独立 `memory/` 模块
3. `memory_search` 只负责返回候选片段，不负责返回整篇内容

### 6.12 `memory_get`（预留）

#### 输入 schema

```typescript
{
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Memory file path.' },
    startLine: { type: 'number', description: '1-based start line.' },
    endLine: { type: 'number', description: '1-based end line, inclusive.' },
  },
  required: ['path'],
}
```

#### 语义输出

```typescript
{
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}
```

#### 当前约束

1. 这里只保留最小读取接口，不定义 memory 文件布局细节
2. 路径边界和允许范围应由未来 `memory/` 管理模块负责
3. `memory_get` 与 `memory_search` 应组成“先搜片段、再读原文”的闭环

---

## 7. 工具职责边界

文件相关工具的职责必须分清：

| 工具 | 职责 |
|------|------|
| `list_dir` | 看目录结构 |
| `file_search` | 按路径模式找文件 |
| `grep_search` | 按文本内容找命中位置 |
| `read_file` | 精确读取文件内容或片段 |
| `edit_file` | 简单文本替换 |
| `write_file` | 创建或整体覆写文件 |
| `apply_patch` | 复杂、多文件、结构化 patch |

如果职责不清，agent 很容易在多个工具之间来回试错，导致调用成本和失败率都升高。

---

## 8. 推荐实现顺序

### Phase 0

1. `exec`
2. `process`

这组能力已经落地，是后续 builtin tools 扩展的默认基线。

### Phase A

1. `list_dir`
2. `read_file`

先把最基础的工作区读取能力补齐。

### Phase B

1. `file_search`
2. `grep_search`

让 agent 具备定位文件和文本的能力。

### Phase C

1. `apply_patch`

先补最通用、最适合 coding 任务的精确修改工具。

### Phase D

1. `write_file`
2. `edit_file`

补齐完整文件写入和简单替换语义。

### Phase E

1. `web_fetch`

最后补工作区外部读取能力。

### Phase F

1. `memory_search`
2. `memory_get`

这组能力保留在后续独立 memory 模块阶段再细化。

### 8.1 当前完成状态

截至 2026-04-06，Phase 0 到 Phase E 均已完成；当前仅剩 Phase F 的 memory tools 仍保持预留状态。

---

## 9. 测试建议

### 9.1 通用测试点

所有 builtin tools 都至少应覆盖：

1. 正常输入
2. 缺少必填参数
3. 参数类型错误
4. workspace 越界
5. 失败返回 `isError: true`

### 9.2 文件读取与搜索类

重点覆盖：

1. 路径不存在
2. 空目录 / 空文件
3. 无匹配结果
4. 结果数量截断

### 9.3 文件修改类

重点覆盖：

1. 新建文件
2. 覆写已有文件
3. patch 应用失败
4. `edit_file` 0 次命中
5. `edit_file` 多次命中

### 9.4 命令与进程类

这一部分以现有 `exec/process` 测试为基线继续扩展。

### 9.5 外部获取类

重点覆盖：

1. 非法 URL
2. 超时
3. 重定向
4. 非文本响应
5. 超长内容截断

### 9.6 当前验证口径

截至 2026-04-06，非 memory builtin tools 当前采用三层验证：

1. 单元测试：`src/tools/builtin/*.test.ts`
2. 直接 smoke：`scripts/test-builtin-tools.ts`
3. executor 级集成：`scripts/test-builtin-tools-integration.ts`

另外，Vitest 运行环境已经恢复正常，不再存在此前 Windows 主机上错误安装 `@esbuild/linux-x64` 导致的假失败问题。当前 builtin tools 目录的 Vitest 已可作为有效验收信号。

---

## 10. 当前结论

当前阶段，builtin tools 的核心目标不是追平 OpenClaw 的全部工具面，而是建立一个足够稳定的 coding tool surface。

这个 surface 的最小闭环应当是：

1. `list_dir`
2. `read_file`
3. `file_search`
4. `grep_search`
5. `apply_patch`
6. `write_file`
7. `edit_file`
8. `exec`
9. `process`
10. `web_fetch`

其中：

1. `exec/process` 已经落地
2. 文件读取、搜索和精确修改已经落地，coding 闭环已打通
3. `write_file` / `edit_file` 已作为 `apply_patch` 的补充手段落地
4. `web_fetch` 已落地，作为本地 coding 闭环之外的补充能力
5. `memory_search` / `memory_get` 仍应在 builtin tools 设计中保留位置，但详细设计延后到独立 memory 模块阶段

这也是 builtin tools 独立成文档的原因：

它比 Tools 模块总设计更聚焦，也更适合后续按 milestone 持续推进。