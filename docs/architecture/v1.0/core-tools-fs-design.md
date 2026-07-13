# core/tools fs 路径策略设计（v1.0）

> 版本：v1.0
> 创建日期：2026-05-26
> 变更说明：[core-tools-fs-changes.md](./core-tools-fs-changes.md)
> 旧文档：[../core-tools-builtin-design.md](../core-tools-builtin-design.md)

---

## 1. 概述

v1.0 对内置 fs / search 工具的路径策略做三项改动：

1. **工厂函数化**：所有 fs / search 工具从模块级 singleton 改为工厂函数；`workspaceDir` 在工具创建时显式传入，不再回退到 `process.cwd()`。
2. **`tools.fs.workspaceOnly` 开关**：在 `ToolsConfig` 新增 `fs.workspaceOnly`（默认 `true`）；当设为 `false` 时允许路径越过工作区边界（供专用 agent 使用）。
3. **`WorkspacePathError`**：用结构化错误类型替换 `resolveWorkspacePath` 中的通用 `Error`，让调用方可以精确识别路径越界。

---

## 2. 设计动机

### 2.1 `process.cwd()` 问题

现有工具在 `resolveWorkspacePath(params.path)` 中省略第二参数，隐式回退到 `process.cwd()`。
`getDefaultBuiltinTools(options)` 已经接收 `workspaceDir`，但没有将其传入任何工具实例。

后果：

- 工具的 workspace root 与 `RuntimeApp` 持有的 `workspaceDir` 不一致，除非二者恰好相同。
- 测试必须 `process.chdir(tmpDir)` 来"模拟"工作区，副作用污染进程全局状态。
- 工具实例无法复用于不同工作区（例如 multi-workspace 场景）。

### 2.2 结构化错误类型

`resolveWorkspacePath` 当前抛 `new Error('Path is outside the workspace: ...')`。调用方
只能靠 `message.includes(...)` 字符串匹配来区分越界错误与其他 IO 错误——脆弱且不可靠。

`WorkspacePathError` 提供 `instanceof` 检测，并携带 `inputPath` / `workspaceRoot` 两个字段供日志和调试使用。

### 2.3 `workspaceOnly` 开关

部分专用 agent（如系统管理、跨仓库操作）需要访问工作区外的路径。
将边界检查提升为可配置项，而不是硬编码，让框架本身保持通用。

---

## 3. 类型定义

### 3.1 `WorkspacePathError`

```typescript
// src/core/tools/builtin/common/path-policy.ts

export class WorkspacePathError extends Error {
  readonly inputPath: string;
  readonly workspaceRoot: string;

  constructor(inputPath: string, workspaceRoot: string) {
    super(`Path is outside the workspace: ${inputPath}`);
    this.name = 'WorkspacePathError';
    this.inputPath = inputPath;
    this.workspaceRoot = workspaceRoot;
  }
}
```

### 3.2 `resolveWorkspacePath` 签名

```typescript
// workspaceRoot 变为必填（移除 = process.cwd() 默认值）
// workspaceOnly 新增，默认 true
export function resolveWorkspacePath(
  path: unknown,
  workspaceRoot: string,
  workspaceOnly = true,
): {
  workspaceRoot: string;
  resolvedPath: string;
  displayPath: string;
}
```

当 `workspaceOnly = false` 时，跳过边界检查；`resolvedPath` 和 `displayPath` 仍然正常返回。
`displayPath`：若路径在工作区内则返回相对路径，否则返回平台归一化的绝对路径。

### 3.3 `ToolsConfig` 新增 `fs` 子对象

```typescript
// src/platform/config/types.ts

export interface FsToolsConfig {
  /** 是否强制路径必须在工作区内；默认 true。
   *  设为 false 后 fs 工具允许访问工作区外的路径（需自行评估安全影响）。 */
  workspaceOnly: boolean;
}

export interface ToolsConfig {
  execTimeout: number;
  readMaxLines: number;
  webFetchTimeout: number;
  webFetchMaxChars: number;
  approval: ToolApprovalConfig;
  /** fs 工具路径策略配置 */
  fs: FsToolsConfig;
}
```

默认值（`src/platform/config/defaults.ts`）：

```typescript
tools: {
  // ...existing fields unchanged...
  fs: {
    workspaceOnly: true,
  },
},
```

### 3.4 工厂函数

每个 fs / search 工具导出改为工厂函数，命名为 `create<ToolName>Tool`：

```typescript
// fs 工具（read_file / write_file / edit_file / list_dir / apply_patch）
export function createReadFileTool(workspaceDir: string, workspaceOnly?: boolean): Tool
export function createWriteFileTool(workspaceDir: string, workspaceOnly?: boolean): Tool
export function createEditFileTool(workspaceDir: string, workspaceOnly?: boolean): Tool
export function createListDirTool(workspaceDir: string, workspaceOnly?: boolean): Tool
export function createApplyPatchTool(workspaceDir: string, workspaceOnly?: boolean): Tool

// search 工具（workspaceOnly 不适用：列举本身就限定在工作区内）
export function createFileSearchTool(workspaceDir: string): Tool
export function createGrepSearchTool(workspaceDir: string): Tool
```

`workspaceOnly` 省略时默认 `true`，与配置默认值一致。

---

## 4. `getDefaultBuiltinTools` 更新

```typescript
// src/runtime/tool-registry.ts

export interface RuntimeBuiltinToolOptions {
  workspaceDir: string;
  webFetchEnabled?: boolean;
  execEnabled?: boolean;
  processEnabled?: boolean;
  fsWorkspaceOnly?: boolean;   // 新增；默认 true
}

export function getDefaultBuiltinTools(options: RuntimeBuiltinToolOptions): Tool[] {
  const { workspaceDir, fsWorkspaceOnly = true } = options;

  const tools: Tool[] = [
    createListDirTool(workspaceDir, fsWorkspaceOnly),
    createReadFileTool(workspaceDir, fsWorkspaceOnly),
    createFileSearchTool(workspaceDir),
    createGrepSearchTool(workspaceDir),
    createApplyPatchTool(workspaceDir, fsWorkspaceOnly),
    createWriteFileTool(workspaceDir, fsWorkspaceOnly),
    createEditFileTool(workspaceDir, fsWorkspaceOnly),
  ];

  // webFetch / exec / process 逻辑不变
  ...
}
```

`RuntimeApp` 在调用 `getDefaultBuiltinTools` 时从 `resolvedConfig.tools.fs.workspaceOnly` 读取值传入：

```typescript
getDefaultBuiltinTools({
  workspaceDir: this.workspaceDir,
  fsWorkspaceOnly: resolvedConfig.tools.fs.workspaceOnly,
  webFetchEnabled: ...,
  ...
})
```

---

## 5. `displayPath` 越界情形

当 `workspaceOnly = false` 且路径在工作区外时，`displayPath` 返回平台归一化的绝对路径
（正斜杠），而非相对路径。这样工具错误消息中路径仍然可读，不会出现 `../../../../..` 这样的相对路径。

---

## 6. 测试策略

测试不再需要 `process.chdir(tmpDir)`：工具实例通过工厂函数在 `beforeEach` 创建，直接传入临时目录：

```typescript
// 新写法（以 read-file.test.ts 为例）
let workspaceDir: string;
let readFileTool: Tool;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'read-file-tool-'));
  readFileTool = createReadFileTool(workspaceDir);
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});
```

越界测试直接传相对路径 `..` 或绝对路径，不依赖 cwd。

---

## 7. 不变的部分

- `Tool` 接口结构（`name` / `description` / `inputSchema` / `execute`）；
- 各工具的输入 schema 和输出格式；
- `resolveWorkspacePath` 的返回结构（`workspaceRoot` / `resolvedPath` / `displayPath`）；
- `listWorkspaceFiles` 的 API（search 工具内部调用）；
- 工具 `execute` 中 try/catch → `isError` 的错误包装模式；
- `getDefaultBuiltinTools` 中 webFetch / exec / process 工具的条件注册逻辑。
