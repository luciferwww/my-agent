# core/tools fs 路径策略变更说明（当前 → v1.0）

> 版本：v1.0
> 创建日期：2026-05-26
> 标准设计文档：[core-tools-fs-design.md](./core-tools-fs-design.md)
> 旧文档：[../core-tools-builtin-design.md](../core-tools-builtin-design.md)

本文档描述内置 fs / search 工具路径策略从当前状态升级到 v1.0 的所有变更。
仅作升级参考；canonical 设计见同目录 [core-tools-fs-design.md](./core-tools-fs-design.md)。

---

## 1. 变更速览

| 维度 | 当前 | v1.0 |
|---|---|---|
| `workspaceDir` 来源 | `process.cwd()`（隐式回退） | 工厂参数（runtime 显式传入） |
| 工具导出形式 | 模块级 `const` singleton | 工厂函数 `createXxxTool(workspaceDir, ...)` |
| 越界路径错误类型 | 通用 `Error` | `WorkspacePathError`（可 `instanceof` 检测） |
| 越界检查开关 | 无（始终强制） | `tools.fs.workspaceOnly`（默认 `true`） |
| `resolveWorkspacePath` 第二参数 | `= process.cwd()`（可选） | 必填 `string` |
| search 工具 workspaceDir | `process.cwd()`（硬编码） | 工厂参数 |
| 测试 setup | `process.chdir(tmpDir)` | `createXxxTool(tmpDir)` 直接传入 |

---

## 2. 类型变更

### 2.1 新增 `WorkspacePathError`

```diff
+export class WorkspacePathError extends Error {
+  readonly inputPath: string;
+  readonly workspaceRoot: string;
+  constructor(inputPath: string, workspaceRoot: string) {
+    super(`Path is outside the workspace: ${inputPath}`);
+    this.name = 'WorkspacePathError';
+    this.inputPath = inputPath;
+    this.workspaceRoot = workspaceRoot;
+  }
+}
```

`resolveWorkspacePath` 内的 `throw new Error(...)` 替换为 `throw new WorkspacePathError(...)`。

### 2.2 `resolveWorkspacePath` 签名变更

```diff
 export function resolveWorkspacePath(
   path: unknown,
-  workspaceRoot = process.cwd(),
+  workspaceRoot: string,
+  workspaceOnly = true,
 ): { workspaceRoot: string; resolvedPath: string; displayPath: string }
```

**影响**：所有直接调用 `resolveWorkspacePath(path)` 的代码（fs 工具内部）必须补充第二参数。
工厂函数通过闭包自动提供，调用方不需要手动处理。

### 2.3 `ToolsConfig` 新增 `fs` 子对象

```diff
+export interface FsToolsConfig {
+  workspaceOnly: boolean;
+}

 export interface ToolsConfig {
   execTimeout: number;
   readMaxLines: number;
   webFetchTimeout: number;
   webFetchMaxChars: number;
   approval: ToolApprovalConfig;
+  fs: FsToolsConfig;
 }
```

默认值（`defaults.ts`）：

```diff
 tools: {
   execTimeout: 30,
   readMaxLines: 200,
   webFetchTimeout: 30_000,
   webFetchMaxChars: 50_000,
   approval: { allow: [], deny: [] },
+  fs: { workspaceOnly: true },
 },
```

### 2.4 工具导出形式

每个 fs / search 工具的 named export 从 singleton 改为工厂函数：

```diff
-export const readFileTool: Tool = { ... };
+export function createReadFileTool(workspaceDir: string, workspaceOnly?: boolean): Tool { ... }

-export const writeFileTool: Tool = { ... };
+export function createWriteFileTool(workspaceDir: string, workspaceOnly?: boolean): Tool { ... }

-export const editFileTool: Tool = { ... };
+export function createEditFileTool(workspaceDir: string, workspaceOnly?: boolean): Tool { ... }

-export const listDirTool: Tool = { ... };
+export function createListDirTool(workspaceDir: string, workspaceOnly?: boolean): Tool { ... }

-export const applyPatchTool: Tool = { ... };
+export function createApplyPatchTool(workspaceDir: string, workspaceOnly?: boolean): Tool { ... }

-export const fileSearchTool: Tool = { ... };
+export function createFileSearchTool(workspaceDir: string): Tool { ... }

-export const grepSearchTool: Tool = { ... };
+export function createGrepSearchTool(workspaceDir: string): Tool { ... }
```

### 2.5 `RuntimeBuiltinToolOptions` 新增 `fsWorkspaceOnly`

```diff
 export interface RuntimeBuiltinToolOptions {
   workspaceDir: string;
   webFetchEnabled?: boolean;
   execEnabled?: boolean;
   processEnabled?: boolean;
+  fsWorkspaceOnly?: boolean;
 }
```

---

## 3. 行为变更

### 3.1 `workspaceDir` 绑定时机

当前：工具 `execute` 每次调用时隐式读 `process.cwd()`。

v1.0：`workspaceDir` 在 `createXxxTool(workspaceDir)` 调用时通过闭包绑定，之后不再读进程状态。

### 3.2 `workspaceOnly = false` 时的路径行为

当前：越界路径始终抛错，无例外。

v1.0：`workspaceOnly = false` 时：
- `resolveWorkspacePath` 跳过 `isInsideWorkspace` 检查；
- 绝对路径和相对路径均被接受（相对路径相对 `workspaceDir` 解析）；
- `displayPath` 对工作区外的路径返回归一化的绝对路径（正斜杠），而非相对路径。

search 工具（`file_search` / `grep_search`）不受 `workspaceOnly` 影响——`listWorkspaceFiles` 本身只枚举工作区内文件，边界由枚举控制。

### 3.3 错误识别

当前：调用方需 `error.message.includes('outside the workspace')` 区分越界与 IO 错误。

v1.0：调用方可以 `error instanceof WorkspacePathError`，并通过 `error.inputPath` / `error.workspaceRoot` 获取结构化信息。

---

## 4. 受影响的文件

| 文件 | 变更内容 |
|---|---|
| `src/core/tools/builtin/common/path-policy.ts` | 新增 `WorkspacePathError`；`resolveWorkspacePath` 签名更新 |
| `src/core/tools/builtin/fs/read-file.ts` | singleton → `createReadFileTool` |
| `src/core/tools/builtin/fs/write-file.ts` | singleton → `createWriteFileTool` |
| `src/core/tools/builtin/fs/edit-file.ts` | singleton → `createEditFileTool` |
| `src/core/tools/builtin/fs/list-dir.ts` | singleton → `createListDirTool` |
| `src/core/tools/builtin/fs/apply-patch.ts` | singleton → `createApplyPatchTool` |
| `src/core/tools/builtin/search/file-search.ts` | singleton → `createFileSearchTool` |
| `src/core/tools/builtin/search/grep-search.ts` | singleton → `createGrepSearchTool` |
| `src/core/tools/index.ts` | 更新 re-export（旧 singleton 名 → 工厂函数名） |
| `src/runtime/tool-registry.ts` | `getDefaultBuiltinTools` 使用工厂函数；新增 `fsWorkspaceOnly` |
| `src/runtime/RuntimeApp.ts` | 传入 `fsWorkspaceOnly: resolvedConfig.tools.fs.workspaceOnly` |
| `src/platform/config/types.ts` | 新增 `FsToolsConfig`；`ToolsConfig.fs` |
| `src/platform/config/defaults.ts` | `tools.fs.workspaceOnly: true` |
| `src/platform/config/wizard/fields.ts` | 新增 `tools.fs.workspaceOnly` 问项 |
| `src/core/tools/builtin/fs/*.test.ts` | 移除 `process.chdir`；改用工厂函数创建工具实例 |
| `src/core/tools/builtin/search/*.test.ts` | 同上 |

---

## 5. 升级 checklist

如果你直接使用内置工具实例或调用 `resolveWorkspacePath`：

1. **直接导入 singleton 的代码**（如 `import { readFileTool } from '...'`）改为调用工厂函数：
   `const readFileTool = createReadFileTool(workspaceDir)`；
2. **测试**：移除 `process.chdir(workspaceDir)` / `process.chdir(originalCwd)` 的 setup/teardown；改为在 `beforeEach` 中用 `createXxxTool(tmpDir)` 绑定工具实例；
3. **`resolveWorkspacePath` 直接调用**：补充第二参数 `workspaceRoot`（之前省略会编译报错）；
4. **越界错误捕获**：若 catch 块靠字符串匹配识别越界错误，改用 `instanceof WorkspacePathError`；
5. **`tools.fs.workspaceOnly`**：默认 `true`，行为与旧版一致；只有需要工作区外访问的 agent 才需要设为 `false`（评估安全影响后手动配置）；
6. **config file**：`config.json` 中新增 `tools.fs.workspaceOnly: false` 才能放开边界限制；省略则沿用默认值 `true`。

---

## 6. 不变的部分

- `Tool` 接口（`name` / `description` / `inputSchema` / `execute`）；
- 各工具的输入 schema 字段和名称；
- 各工具 `execute` 的输出格式；
- 工具 `execute` 内的 try/catch → `{ isError: true }` 包装模式（`WorkspacePathError` 与其他错误均被同一 catch 块格式化为工具错误消息）；
- `listWorkspaceFiles` 的 API；
- `getDefaultBuiltinTools` 中 webFetch / exec / process 的条件注册逻辑；
- `assembleRuntimeTools` 的 API。
