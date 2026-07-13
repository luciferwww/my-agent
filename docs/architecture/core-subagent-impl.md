# Subagent 实现文档

> 关联 spec：`docs/architecture/core-subagent-spec.md`
> 文档日期：2026-06-29

---

## 0. 前提确认与代码现状盘点

写代码前需知道的现状（与 spec 措辞对齐）：

| 事项 | 现状 | 影响 |
|---|---|---|
| `SessionManager.deleteSession(key)` | **已存在**（`session/SessionManager.ts:156`），同时删除 JSONL + Store 条目 | PR-3 直接调用；spec §决策 11 已对齐"复用现有接口"，无需新增 |
| `applyDenyFilter(tools, deny)` | **已存在**（`tool-registry.ts:37`） | PR-4 / PR-6 直接复用 |
| `resolvedConfig.tools.deny` | bootstrap.ts 已在主 agent 工具组装时传入 | subagent 工具组装复用同函数，参数拼接不同 |
| `AgentEvent` union | `core/runner/types.ts:64`，**11 个 variant** | PR-2 末尾追加 2 个；不改现有 |
| `RuntimeResourceSet` | `runtime/types.ts:20`，无 subagent 相关字段 | PR-6 新增 `subagentProfiles` 和 `subagentRunner` |
| `SystemPromptBuilder` | **6 个 active section**（`tool-definitions` slot 代码保留但已停用） | PR-5 新增第 7 个 workspace、第 8 个 available-subagents |
| `ToolContext` | 仅 `signal?: AbortSignal` 字段；**没有** `sessionKey / turnId / toolUseId` | **G1 gap**：PR-(-1) 必须先扩字段 |
| `ToolExecutor` 签名 | `(toolName, input) => Promise<ToolResult>`，**不传 ctx** | **G2 gap**：PR-(-1) 必须扩签名 + AgentRunner 透传 |
| `AgentRunner.run` | **不消费** `RunParams.signal`（字段存在但内部不读） | spec §决策 1 已对齐：v1 abort 通路全断；保留接口预留给将来 abort 子系统 |
| `RunResult.stopReason` 实际值 | `'end_turn' / 'max_llm_calls' / 'error'`；**`'aborted'` 是死分支**，Anthropic API 不产生（核 `AgentRunner.runAttempt` 的 stopReason 赋值点 [AgentRunner.ts:303 / 314 / 344 / 354](../../src/core/runner/AgentRunner.ts#L303)） | impl 内 outcome 推断逻辑只覆盖前三种 |
| `loadContextFiles(workspaceDir, opts)` | 固定读 `<workspaceDir>/.agent/<name>` | **I2 gap**：PR-(-1) 或 PR-3 内必须扩 loader 加 `loadContextFilesFromDir(absDir)` 底层 API，避免双 `.agent/` 拼接 |
| `RuntimeApp.routeContextByTurn` | `Map<turnId, MessageRouteContext>` 已存在（`RuntimeApp.ts:65`） | PR-6 的 `SubagentHostBindings` 实现内部通过此 map 做 parentTurnId → originChannel 查询，不暴露 channel 类型给 core/subagent |

### 先决条件 PR 必要性总结

impl 与 spec 对齐后识别出三组先决条件：

- **G1 / G2**（ToolContext / ToolExecutor 扩展）：`task` 工具的 `parentToolUseId` 依赖 `ctx.toolUseId`，没有这个扩展 PR-4 无法实现。**必须在 PR-4 之前完成**。
- **I2**（loader 底层 API）：SubagentRunner.run 需要按绝对路径加载子 agentDir 的 contextFiles，当前 `loadContextFiles` 不支持。**必须在 PR-3 之前完成**。
- **G3**（child turnId 路由清理）：`SubagentHostBindings.releaseTurnContext` 必须在 SubagentRunner.run() 的 finally 块里调用，否则 routeContextByTurn 泄漏。已在 spec §8.5 接口设计中体现，PR-3 实现时必须遵守。

为此引入 **PR-(-1)** 章节，集中先于 PR-0 落地这些 cross-cutting 变更。

---

## PR-(-1)：先决条件代码（ToolContext / ToolExecutor 扩展 + loader 底层 API）

### 目标

为 subagent feature 做好"接口基础"——单 PR 合并，**不引入 subagent 概念**，只对 cross-cutting 公共契约做扩展。`task` 工具 / SubagentRunner 在后续 PR 中依赖这些扩展。

### 文件

| 操作 | 路径 |
|---|---|
| 修改 | `src/core/tools/types.ts` |
| 修改 | `src/core/tools/executor.ts` |
| 修改 | `src/core/runner/AgentRunner.ts` |
| 修改 | `src/core/runner/types.ts`（仅扩 `ToolExecutor` 签名） |
| 修改 | `src/core/workspace/loader.ts` |
| 修改 | `src/core/tools/executor.test.ts`（覆盖新签名） |
| 修改 | `src/core/workspace/loader.test.ts`（覆盖 from-dir 模式） |

### `tools/types.ts` 扩展

```typescript
export interface ToolContext {
  /** 工具运行期归属的 sessionKey；用于审批 hook / 路由 / 日志 */
  sessionKey: string;
  /** 工具运行期归属的 turnId；同上 */
  turnId: string;
  /**
   * 触发本次工具调用的 LLM `tool_use` block 的 id。
   * 由 task tool 在构造 SubagentRunInput.trigger 时透传给 parentToolUseId（§spec 8.2）。
   */
  toolUseId: string;
  /** 预留，为未来 abort 子系统接入；v1 不消费（§spec 决策 1） */
  signal?: AbortSignal;
}

// ToolExecutor 必须能透传 ctx
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,    // ← 新增 required 参数
) => Promise<ToolResult>;

// Tool.execute 签名同步扩展
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    params: Record<string, unknown>,
    context: ToolContext,    // ← 由 optional 改为 required，统一传 ctx
  ) => Promise<ToolResult>;
}
```

### `tools/executor.ts` 透传

```typescript
export function createToolExecutor(tools: Tool[]): ToolExecutor {
  return async (toolName, input, ctx): Promise<ToolResult> => {
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      return { content: `Tool "${toolName}" not found`, isError: true };
    }
    try {
      return await tool.execute(input, ctx);   // ← 透传 ctx
    } catch (err) {
      return {
        content: `Error executing tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  };
}
```

### `AgentRunner.ts` 改动

在工具调用循环中，构造 `ToolContext` 并传给 `toolExecutor`。当前调用点 search `this.toolExecutor(` 找到一处（约在 `dispatchToolCalls` 里），加上 ctx：

```typescript
// 伪代码示意
const ctx: ToolContext = {
  sessionKey: params.sessionKey,
  turnId: params.turnId,
  toolUseId: block.id,    // 来自 ChatContentBlock { type: 'tool_use', id, ... }
  signal: undefined,       // v1 不消费；abort 子系统未来填充
};
const toolResult = await this.toolExecutor(block.name, block.input, ctx);
```

### `workspace/loader.ts` 扩底层 API

新增导出函数（不动现有 `loadContextFiles(workspaceDir, opts)` 行为）：

```typescript
/**
 * 按**绝对目录**加载 contextFiles。文件白名单与 `loadContextFiles` 共享同一个 `ALL_FILES` 常量
 * （当前为 `IDENTITY.md / SOUL.md / AGENTS.md / TOOLS.md`，见 [loader.ts:9](../../src/core/workspace/loader.ts#L9)）——
 * **不**读白名单之外的文件。与 `loadContextFiles(workspaceDir, opts)` 的区别：
 *  - 不在路径上 append `.agent/`，直接读 `<absDir>/<filename>`
 *  - 调用方负责传完整路径（例如 SubagentRunner 传 `<ws>/.agent/subagents/<id>/`）
 */
export async function loadContextFilesFromDir(
  absDir: string,
  opts?: LoadContextFilesOptions,
): Promise<ContextFile[]> {
  // 复用 readContextFile + budget 限制逻辑
  // 内部实现：把 loadContextFiles 现有循环抽出来，参数化 baseDir
}
```

实现要点：把 `loadContextFiles` 现有"按 ALL_FILES / MINIMAL_FILES 循环 + 字符预算控制"逻辑抽到下面这个 private helper，`loadContextFiles` 调它时传 `<ws>/.agent/`，`loadContextFilesFromDir` 调它时传 `absDir` 原样：

```typescript
// loader.ts 内部实现 helper（不导出）
async function loadFilesFromBaseDir(
  baseDir: string,
  fileList: readonly string[],
  opts: {
    maxFileChars: number;
    maxTotalChars: number;
    warn: (msg: string) => void;
  },
): Promise<ContextFile[]> {
  // 将现 `loadContextFiles` 函数体中的 for-loop + 截断/预算逻辑原样搬过来，
  // 唯一差别：baseDir 参数化，不再 join `.agent`。
}

// 现有 loadContextFiles 变为薄壳
export async function loadContextFiles(
  workspaceDir: string,
  opts?: LoadContextFilesOptions,
): Promise<ContextFile[]> {
  const baseDir = join(workspaceDir, '.agent');
  return loadFilesFromBaseDir(
    baseDir,
    opts?.mode === 'minimal' ? MINIMAL_FILES : ALL_FILES,
    {
      maxFileChars: opts?.maxFileChars ?? DEFAULT_MAX_FILE_CHARS,
      maxTotalChars: opts?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS,
      warn: opts?.warn ?? console.warn,
    },
  );
}
```

`loadContextFilesFromDir` 双块同样法，传 `absDir` 不拼 `.agent/`。两个公开函数都是 helper 的薄 wrapper。

### 测试要求（PR-(-1)）

**`executor.test.ts`**：
- 所有现有 `createToolExecutor` 测试 case 加 `ctx` 参数（mock value）；
- 新增 case：ctx 被透传给 `tool.execute`（spy 验证）。

**`AgentRunner.test.ts`**：
- 现有 tool_use 路径测试不破坏（断言 toolExecutor 接收到 sessionKey/turnId/toolUseId）。

**`loader.test.ts`**：
- 新增 `loadContextFilesFromDir` case：传绝对路径读到文件；不存在文件跳过；超 budget 截断；不在路径上 append `.agent/`。

### 不变量

- [ ] 现有所有调用 `tool.execute(input)` 的 call site 都改为 `tool.execute(input, ctx)`，**无遗漏**（grep `\.execute\(` 全扫）。
- [ ] `loadContextFiles` 行为零变化（主 agent contextFiles 加载路径不变）。
- [ ] **`ctx.signal` 在 PR-(-1) 后始终为 `undefined`**：AgentRunner 构造 ctx 时明示设 `signal: undefined`。现有唯一读 `ctx.signal` 的内置工具是 `exec.ts`（`exec.ts:239 / 253` 把 `context?.signal` 透传给 `runCommand` / `startManagedCommand`）——拿到 undefined 后退化为无 abort 行为，与当前表现完全一致。未来 abort 子系统落地时由 AgentRunner 填入真实 signal，无需改动 `exec.ts`。
- [ ] 除 `exec.ts` 外无其他内置工具读取 `ctx.signal`（grep `context\?\.signal\|context\.signal\|ctx\.signal` 全扫确认）。如未来新增的工具读 signal，需同步验证是否能接受 undefined fallback。

---

## PR-0：类型层 + sessionKey 工具 + capabilities

### 文件

| 操作 | 路径 |
|---|---|
| 新建 | `src/core/subagent/types.ts` |
| 新建 | `src/core/subagent/session-key.ts` |
| 新建 | `src/core/subagent/capabilities.ts` |
| 新建 | `src/core/subagent/index.ts` |
| 新建 | `src/core/subagent/session-key.test.ts` |
| 新建 | `src/core/subagent/capabilities.test.ts` |

### `types.ts`

```typescript
import type { TokenUsage } from '../../adapters/llm/types.js';
import type { ContextFile } from '../workspace/types.js';
import type { AgentRunner } from '../runner/index.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { AgentEvent } from '../runner/types.js';
import type { SystemPromptBuilder } from '../prompt/SystemPromptBuilder.js';

export interface SubagentProfile {
  id: string;
  description: string;
  /**
   * 角色个性 md 目录的**绝对路径**，由 config-loader 按
   * <workspaceDir>/.agent/subagents/<id>/ 派生写入；用户不可配置。
   * 目录是否实际存在由 SubagentRunner 运行时探测（决定匿名 / 具名行为）。
   */
  agentDir: string;
  model?: string;              // 'inherit'（默认）或具体 model id
  tools?: {
    allow?: string[];          // 替换语义
    deny?: string[];           // 叠加语义
  };
  /** 子 Agent 的 LLM 调用上限，对齐主 agent RunParams.maxLlmCalls；不写沿用父 */
  maxLlmCalls?: number;
}

export type RunTrigger =
  | {
      source: 'llm-tool';
      parentSessionKey: string;
      parentTurnId: string;
      parentToolUseId: string;
    }
  | {
      source: 'library';
      callerLabel?: string;
    };

export type RunLifecycle = 'blocking';

/**
 * 外部入口类型：LLM `task` 工具 input 与库 API `RuntimeApp.runSubagentTurn(input)` 共用。
 * 进入 SubagentRunner 前会被两个入口点各自解析为 SubagentRunRequest（profile 已 resolved）。
 */
export interface SubagentRunInput {
  subagentType: string;        // 'general-purpose' | profile.id；LLM/caller 原始输入
  description: string;
  prompt: string;
  trigger: RunTrigger;
  lifecycle: RunLifecycle;
  /** 预留，为未来 abort 子系统接入；v1 未消费（§spec 决策 1） */
  signal?: AbortSignal;
}

export interface SubagentRunResult {
  runId: string;
  sessionKey: string;
  turnId: string;
  text: string;
  /** 'aborted' v1 不产生，预留接口；详 §spec 决策 1 */
  outcome: 'ok' | 'error' | 'aborted' | 'max_llm_calls';
  reason?: string;
  /** 自身 + 所有子孙累计；详 §spec 决策 6 */
  usage: TokenUsage;
  durationMs: number;
}

export type SubagentRole = 'main' | 'orchestrator' | 'leaf';

export interface SubagentCapabilities {
  depth: number;
  role: SubagentRole;
  canSpawn: boolean;
}

// ── SubagentRunner 接口契约（§spec 8.5）─────────────────────

/**
 * Runtime 把"路由 + 配置 + parent contextFiles getter"打包给 SubagentRunner。
 * 实现住在 runtime/subagent-orchestration.ts；core/subagent/ 只看接口。
 */
export interface SubagentHostBindings {
  registerTurnContext(childTurnId: string, parentTurnId: string): void;
  releaseTurnContext(childTurnId: string): void;
  getParentContextFiles(): ContextFile[];
  readonly mainAgentTools: { allow: readonly string[]; deny: readonly string[] };
  readonly llmDefaults: { model: string; maxTokens: number; contextWindowTokens: number };
  readonly maxDepth: number;
  readonly workspaceDir: string;                                       // 供 SystemPromptBuilder `# Workspace` section
  readonly promptSafetyLevel: 'relaxed' | 'normal' | 'strict';         // 供 SystemPromptBuilder `# Safety` section
}

/** SubagentRunner 构造期 deps（一次性注入） */
export interface SubagentRunnerDeps {
  agentRunner: AgentRunner;
  sessionManager: SessionManager;
  /**
   * 复用主 agent 的 SystemPromptBuilder。SubagentRunner 调 `build({ mode: 'minimal', ... })`
   * 拿到 datetime / safety / project-context / workspace section（§spec §11 minimal 表），
   * 末尾手动追加 behavioralAddendum。不手拼 contextFiles。
   */
  systemPromptBuilder: SystemPromptBuilder;
  onEvent: (event: AgentEvent) => void;
  host: SubagentHostBindings;
  loadContextFilesFromDir: (absDir: string) => Promise<ContextFile[]>;
  // logger 可选：实际由 Logger.get('SubagentRunner') 在内部创建；构造期不强制传
}

/** SubagentRunner.run 单次调用的入参——所有字段平铺，不嵌套 SubagentRunInput */
export interface SubagentRunRequest {
  profile: SubagentProfile;
  description: string;
  prompt: string;
  trigger: RunTrigger;
  lifecycle: RunLifecycle;
  /** 预留，为未来 abort 子系统接入；v1 未消费 */
  signal?: AbortSignal;
  parentSessionKey: string;
  parentTurnId: string;        // 替代裸 channel/clientId
}
```

### `session-key.ts`

```typescript
export interface ParsedSubagentKey {
  rootLabel: string;
  runId: string;
  depth: number;
  isSynthetic: boolean;   // true = rootLabel 不指向真实 session（library 入口）
}

// 格式：<rootLabel>:subagent:<runId>:<depth>
export function formatSubagentSessionKey(opts: {
  rootLabel: string;
  runId: string;
  depth: number;
}): string {
  return `${opts.rootLabel}:subagent:${opts.runId}:${opts.depth}`;
}

export function isSubagentSessionKey(key: string): boolean {
  return key.includes(':subagent:');
}

export function getSubagentDepth(key: string): number {
  return (key.match(/:subagent:/g) ?? []).length;
}

export function parseSubagentSessionKey(key: string): ParsedSubagentKey {
  // 取第一段 :subagent: 之前的内容作为 rootLabel，
  // 取最后一段 :subagent:<runId>:<depth>
  const parts = key.split(':subagent:');
  const rootLabel = parts[0];
  const lastSegment = parts[parts.length - 1];   // "<runId>:<depth>"
  const colonIdx = lastSegment.lastIndexOf(':');
  const runId = lastSegment.slice(0, colonIdx);
  const depth = parseInt(lastSegment.slice(colonIdx + 1), 10);
  // 合成标签：不以已知前缀开头时；v1 简单判断：library 或无真实 session 即为 synthetic
  // 调用方必要时可按业务规则覆盖此逻辑
  const isSynthetic = rootLabel === 'library' || rootLabel.startsWith('library:');
  return { rootLabel, runId, depth, isSynthetic };
}
```

实现要点：
- `getSubagentDepth` 用 `(key.match(/:subagent:/g) ?? []).length` 数次数，O(n) 可接受。
- `parseSubagentSessionKey` 应在 `isSubagentSessionKey(key) === true` 的前提下调用；否则 `depth` 可能为 `NaN`，调用方需自行检查。

### `capabilities.ts`

```typescript
import { getSubagentDepth } from './session-key.js';
import type { SubagentCapabilities, SubagentRole } from './types.js';

export function resolveSubagentCapabilities(
  sessionKey: string,
  maxDepth: number,
): SubagentCapabilities {
  const depth = getSubagentDepth(sessionKey);
  let role: SubagentRole;
  if (depth === 0) {
    role = 'main';
  } else if (depth < maxDepth) {
    role = 'orchestrator';
  } else {
    role = 'leaf';
  }
  return { depth, role, canSpawn: role !== 'leaf' };
}
```

### 测试要求（PR-0）

**session-key.test.ts**
- `formatSubagentSessionKey` 拼出正确格式
- `getSubagentDepth` 对 `'main'` 返回 0，对 `'main:subagent:abc:1'` 返回 1，对嵌套 2 层的 key 返回 2
- `isSubagentSessionKey` 正确区分父 / 子 key
- `parseSubagentSessionKey` round-trip 与 `format` 互逆

**capabilities.test.ts**
- `maxDepth=1`：depth=0 → main, depth=1 → leaf, canSpawn=false
- `maxDepth=2`：depth=1 → orchestrator, canSpawn=true; depth=2 → leaf
- `maxDepth=0`：depth=0 即为 leaf

---

## PR-1：config-loader + profile-tools

### 文件

| 操作 | 路径 |
|---|---|
| 新建 | `src/core/subagent/config-loader.ts` |
| 新建 | `src/core/subagent/profile-tools.ts` |
| 新建 | `src/core/subagent/config-loader.test.ts` |
| 新建 | `src/core/subagent/profile-tools.test.ts` |

### `config-loader.ts`

config 类型 `SubagentConfigEntry` 在 spec §12 已定义，对应 `src/platform/config/types.ts:184` 里的现有定义。**字段名以 `maxLlmCalls` 为准**（对齐主 agent `RunParams.maxLlmCalls` + §core-subagent-spec.md §9.2；§platform-config-restructure-spec.md §7.4 已同步更新）。代码侧 `src/platform/config/types.ts:192` 当前仍为 `maxTurns?: number`，本 PR 同步改名为 `maxLlmCalls?`。

```typescript
import { join } from 'node:path';
import type { SubagentConfigEntry } from '../../platform/config/types.js';
import type { SubagentProfile } from './types.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_IDS = new Set(['general-purpose']);
const SUBAGENT_DIR_SEGMENTS = ['.agent', 'subagents'] as const;

function deriveAgentDir(workspaceDir: string, id: string): string {
  return join(workspaceDir, ...SUBAGENT_DIR_SEGMENTS, id);
}

export function loadSubagentProfiles(
  list: SubagentConfigEntry[],
  workspaceDir: string,
  registeredToolNames: ReadonlySet<string>,
): SubagentProfile[] {
  const seen = new Set<string>();
  return list.map((entry) => {
    // 校验
    if (!entry.id || !ID_PATTERN.test(entry.id)) {
      throw new Error(`subagents.list[]: invalid id "${entry.id}"`);
    }
    if (!entry.description) {
      throw new Error(`subagents.list["${entry.id}"]: description is required`);
    }
    if (RESERVED_IDS.has(entry.id)) {
      throw new Error(`subagents.list["${entry.id}"]: reserved id, cannot be used`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`subagents.list: duplicate id "${entry.id}"`);
    }
    if (entry.tools?.allow?.includes('task')) {
      throw new Error(`subagents.list["${entry.id}"]: allow cannot contain "task" in v1`);
    }
    if (entry.tools?.allow) {
      for (const name of entry.tools.allow) {
        // glob 检测：`*` 或 `?` 均是通配符，跳过精确名校验
        // （glob-match.ts 同时支持两者，只检 `*` 会误判 `?` glob）
        if (!registeredToolNames.has(name) && !/[*?]/.test(name)) {
          throw new Error(
            `subagents.list["${entry.id}"]: allow references unknown tool "${name}"`,
          );
        }
      }
    }
    seen.add(entry.id);

    return {
      id: entry.id,
      description: entry.description,
      agentDir: deriveAgentDir(workspaceDir, entry.id),    // 必填，总派生
      model: entry.model,
      tools: entry.tools,
      maxLlmCalls: entry.maxLlmCalls,
    };
  });
}

/**
 * general-purpose 是内置匿名 subagent。
 * agentDir 仍按规则派生（保持类型 invariant：`agentDir: string`）。
 * 但该目录通常不存在 → SubagentRunner 运行时探测到目录缺失即用父 contextFiles，
 * 等价于 spec §决策 10 描述的"匿名 subagent"行为。
 */
export function buildGeneralPurposeProfile(workspaceDir: string): SubagentProfile {
  return {
    id: 'general-purpose',
    description: '通用任务执行助手。当任务不匹配任何具名 subagent 时使用。',
    agentDir: deriveAgentDir(workspaceDir, 'general-purpose'),
    // model / tools / maxLlmCalls 均未设置 → 运行时全继承父
  };
}
```

实现要点：
- `agentDir` 必填且总派生（spec §8.1）：`<workspaceDir>/.agent/subagents/<id>/`，统一格式让运行时探测逻辑只有一种 case。
- `buildGeneralPurposeProfile` 改为接受 `workspaceDir` 参数（PR-6 装配时需要传入）；匿名行为通过"目录通常不存在"自然实现，不再用 `agentDir: undefined` 表达匿名。
- **`entry.maxLlmCalls`**：`platform/config/types.ts` 的 `SubagentConfigEntry` 字段名现代码仍是 `maxTurns?: number`——本 PR 同步改名为 `maxLlmCalls?`（与 `platform-config-restructure-spec.md §7.4` / `core-subagent-spec.md §9.2` 对齐）。该重命名作为本 PR 的一部分，不拆独立 PR（字段迁移面很窄：只有 SubagentConfigEntry 一处）。
- `allow` 中 glob 表达式（含 `*` 或 `?`）跳过精确名校验；glob-match.ts 同时支持两种通配符。
- 所有校验错误统一 `throw Error`；调用方（bootstrap.ts）捕获后转为 fatal 启动失败。

### `profile-tools.ts`

```typescript
import type { SubagentProfile } from './types.js';

export interface ResolvedSubagentTools {
  allow: string[];   // 子 allow 写了则替换；没写则用 parentAllow
  deny: string[];    // 子 deny 写了则叠加到 parentDeny；没写则直接用 parentDeny
}

export function resolveSubagentTools(
  profile: SubagentProfile,
  parentAllow: readonly string[],
  parentDeny: readonly string[],
): ResolvedSubagentTools {
  const allow = profile.tools?.allow !== undefined
    ? [...profile.tools.allow]     // 替换
    : [...parentAllow];            // fallback

  const deny = profile.tools?.deny !== undefined
    ? [...parentDeny, ...profile.tools.deny]   // 叠加
    : [...parentDeny];                          // fallback

  return { allow, deny };
}
```

实现要点：
- **不再做 "deny 优先从 allow 中剔除" 的二次过滤**。理由：spec §决策 5 明确"工具在注册时已被 `applyDenyFilter` 过滤，运行时 allow hook 永远不会为它触发"——allow 即便残留 deny 中的名字也不会被 `resolveToolPolicy` 命中（deny 优先于 allow 在 `tool-approval-policy.ts:25` 已实现）。重复过滤是冗余、且让本函数产生 invariant 责任。
- glob 表达式（`*`）一律保留原样，过滤交给 `applyDenyFilter`（注册时）和 `resolveToolPolicy`（运行时）两层 glob-aware 函数。

### 测试要求（PR-1）

**config-loader.test.ts**
- id 格式校验：非法字符 / 超长 / 空 → 抛错
- `general-purpose` id → 抛错
- 重复 id → 抛错
- `allow` 含 `task` → 抛错
- `allow` 含未注册精确名 → 抛错；含 glob `*` 跳过检查
- description 缺失 → 抛错
- 合法入参返回正确 `SubagentProfile[]`，`agentDir` 路径由 workspaceDir 拼出

**profile-tools.test.ts**
- 子不写 allow → fallback parentAllow（深拷贝，不共享引用）
- 子写了 allow → 替换，parentAllow 被丢弃
- 子不写 deny → fallback parentDeny
- 子写了 deny → 叠加到 parentDeny
- 子 allow 与 deny 同名时：**不做剔除**——deny 优先由注册层 / hook 层保证（参见实现要点）

---

## PR-2：AgentEvent union 扩展

### 文件

| 操作 | 路径 |
|---|---|
| 修改 | `src/core/runner/types.ts` |

在 `AgentEvent` union 末尾追加（`src/core/runner/types.ts:121` 之后）：

```typescript
  // FIXME(arch-debt, v2): 这里 `core/runner/types.ts` 反向 import `core/subagent/types.js`，
  // 违反 spec §6.4 "core/runner/ 不依赖 core/subagent/" 约束。
  //
  // 为什么暂时接受：把 subagent_start/end 拆成独立的 SubagentEvent union 需要同步改
  // RuntimeApp.fanout / Channel.send / channel adapters 的事件类型 from AgentEvent 到
  // AgentEvent | SubagentEvent，ripple 较大。v1 选择保留违规以缩 PR 体积。
  //
  // v2 修复方向（任选其一）：
  //   (a) 把 subagent_start/end 拆到 `core/subagent/types.ts` 的 SubagentEvent union；
  //       fanout / channel 改吃 AgentEvent | SubagentEvent；
  //   (b) 把 RunTrigger 类型上提到 core/runner/types.ts，subagent re-export；
  //       本文件不 import subagent。
  // 倾向 (a)（架构最干净），但需评估 channel adapters 现有代码影响。

  | {
      type: 'subagent_start';
      runId: string;
      sessionKey: string;         // 子的 sessionKey
      turnId: string;             // 子第一个 turn 的 id（与 run_start.turnId 相同）
      depth: number;
      subagentType: string;       // 'general-purpose' | profile.id
      lifecycle: 'blocking';
      trigger: import('../subagent/types.js').RunTrigger;
    }
  | {
      type: 'subagent_end';
      runId: string;
      sessionKey: string;
      turnId: string;
      depth: number;
      subagentType: string;
      lifecycle: 'blocking';
      trigger: import('../subagent/types.js').RunTrigger;
      outcome: 'ok' | 'error' | 'aborted' | 'max_llm_calls';
      reason?: string;
      usage: TokenUsage;
      durationMs: number;
    }
```

实现要点：
- 只改类型，零逻辑。`AgentRunner` 内部**不**产生这两条 variant。
- **已知架构债**：本 PR 在 `core/runner/` import `core/subagent/`，与 spec §6.4 依赖方向冲突；用上面的 FIXME 注释显式登记，留待 v2 修。请 PR review 时确认 FIXME 不被吞掉。
- `tsc --noEmit` 不报错即可视为通过。
- 需检查现有 `AgentEvent` 消费端（channel 的 switch/dispatch 等）是否有穷举 union 的地方，若有需加 case 或 exhaustive check。用 `grep -r 'subagent_start\|subagent_end\|AgentEvent'` 确认范围。

### 测试要求（PR-2）

仅 `tsc` 编译通过 + 不破坏现有测试即可。

---

## PR-3：SubagentRunner + behavioral-addendum + available-subagents

### 文件

| 操作 | 路径 |
|---|---|
| 新建 | `src/core/subagent/behavioral-addendum.ts` |
| 新建 | `src/core/subagent/available-subagents.ts` |
| 新建 | `src/core/subagent/SubagentRunner.ts` |
| 新建 | `src/core/subagent/behavioral-addendum.test.ts` |
| 新建 | `src/core/subagent/SubagentRunner.test.ts` |

### `behavioral-addendum.ts`

```typescript
export interface BehavioralAddendumOpts {
  taskDescription: string;   // 来自 SubagentRunRequest.description
  depth: number;
  canSpawn: boolean;
}

export function buildSubagentBehavioralAddendum(opts: BehavioralAddendumOpts): string {
  const lines: string[] = [
    '# Subagent Instructions',
    '',
    'You are a subagent running in an isolated context.',
    `Task: ${opts.taskDescription}`,
    `Depth: ${opts.depth}`,
    '',
    'Guidelines:',
    '- Focus only on the task above. Do not pretend to be the parent agent.',
    '- Return a clear, complete answer as your final response.',
    '- Do not include internal tool call details in your final response unless asked.',
  ];
  if (!opts.canSpawn) {
    lines.push('- You cannot spawn subagents (task tool is not available).');
  }
  lines.push('');
  return lines.join('\n');
}
```

实现要点：
- **不接受 `sessionKey` / `prompt`**：spec PR-3 测试要求 (d) "addendum 含 task/depth 上下文"——sessionKey 是内部标识，给 LLM 看没意义；prompt 已经作为 user message 进 turn，addendum 里不需要重复。
- 函数纯字符串拼装，零副作用，单测直接 snapshot 即可。

### `available-subagents.ts`

```typescript
import type { SubagentProfile } from './types.js';

export interface AvailableSubagentEntry {
  id: string;
  description: string;
}

export function collectAvailableSubagents(
  profiles: ReadonlyMap<string, SubagentProfile>,
): AvailableSubagentEntry[] {
  return [...profiles.values()].map(({ id, description }) => ({ id, description }));
}

export function renderAvailableSubagentsSection(
  entries: AvailableSubagentEntry[],
): string {
  if (entries.length === 0) return '';
  const lines = [
    '<available-subagents>',
    'You can delegate independent subtasks to specialized subagents using the `task` tool.',
    '',
    'Available subagent types:',
    ...entries.map(({ id, description }) => `- ${id}: ${description}`),
    '',
    'Guidelines:',
    '- Use `task` for independent work, especially when it would otherwise read many files into your context.',
    '- Subagents run in isolated context; pass all necessary information in the `prompt` parameter.',
    '- A subagent returns only its final text; intermediate tool calls are not visible to you.',
    '- Each `task` call is blocking.',
    '</available-subagents>',
  ];
  return lines.join('\n');
}
```

### `SubagentRunner.ts`

```typescript
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Logger } from '../../platform/logger/index.js';
import type { ContextFile } from '../workspace/types.js';
import type { RunParams } from '../runner/types.js';
import { formatSubagentSessionKey, getSubagentDepth } from './session-key.js';
import { resolveSubagentCapabilities } from './capabilities.js';
import { buildSubagentBehavioralAddendum } from './behavioral-addendum.js';
import type {
  SubagentProfile,
  SubagentRunResult,
  SubagentRunRequest,
  SubagentRunnerDeps,
} from './types.js';
// SystemPromptBuilder 从 prompt 层 import。该依赖合法：core/subagent 是上层，从下层 import。
import type { SystemPromptBuilder } from '../prompt/SystemPromptBuilder.js';

const log = Logger.get('SubagentRunner');

export class SubagentRunner {
  constructor(private readonly deps: SubagentRunnerDeps) {}

  async run(req: SubagentRunRequest): Promise<SubagentRunResult> {
    const { profile, description, prompt, trigger, parentSessionKey, parentTurnId } = req;
    const startedAt = Date.now();
    const runId = randomUUID();
    const childTurnId = randomUUID();

    // 1) 子 sessionKey（§spec 决策 3）
    const parentDepth = getSubagentDepth(parentSessionKey);
    const childDepth = parentDepth + 1;
    const rootLabel =
      trigger.source === 'llm-tool'
        ? trigger.parentSessionKey
        : (trigger.callerLabel ?? 'library');
    const childSessionKey = formatSubagentSessionKey({ rootLabel, runId, depth: childDepth });

    // 2) capabilities / depth 兜底（task tool 已检查过一次；此处是 belt + suspenders）
    const capabilities = resolveSubagentCapabilities(childSessionKey, this.deps.host.maxDepth);

    // 3) host routing 注册（host 内部把 parentTurnId → originChannel 转给 childTurnId）
    this.deps.host.registerTurnContext(childTurnId, parentTurnId);

    // 4) 子 system prompt：per-file merge contextFiles（§spec 决策 2 / §9.3）
    //    + SystemPromptBuilder 渲染 minimal（§spec §11）+ 末尾追加 addendum
    const childFiles = await this.loadChildContextFiles(profile);
    const parentFiles = this.deps.host.getParentContextFiles();
    const mergedFiles = mergeContextFilesByName(childFiles, parentFiles);
    const addendum = buildSubagentBehavioralAddendum({
      taskDescription: description,
      depth: childDepth,
      canSpawn: capabilities.canSpawn,
    });
    // 调 SystemPromptBuilder 拿到 minimal 渲染后的基础 prompt：
    //  - datetime、safety、project-context（含 `# Project Context` header + SOUL.md 特殊提示）、workspace
    //  - 不含 identity / behavior-rules / memory / available-subagents（被 minimal 模式跳过）
    const basePrompt = this.deps.systemPromptBuilder.build({
      mode: 'minimal',
      contextFiles: mergedFiles,
      workspaceDir: this.deps.host.workspaceDir,
      safetyLevel: this.deps.host.promptSafetyLevel,
      // 不传 availableSubagents（minimal 不渲染 + 子默认无 task 工具）
      // 不传 tools（tool-definitions slot 本来就停用了）
    });
    const systemPrompt = basePrompt + (basePrompt ? '\n\n' : '') + addendum;

    // 5) model 解析（profile.model='inherit' / undefined → host.llmDefaults.model）
    const model =
      profile.model && profile.model !== 'inherit'
        ? profile.model
        : this.deps.host.llmDefaults.model;

    // 6) 装 RunParams（注意：tools 在此 PR 不传，工具 registry 在 PR-5 / PR-6 完成；
    //    PR-3 单测里 mock AgentRunner.run，断言 sessionKey/turnId/systemPrompt/promptMode 即可）
    const runParams: RunParams = {
      sessionKey: childSessionKey,
      message: prompt,
      model,
      systemPrompt,
      turnId: childTurnId,
      // tools: ...     // PR-5 / PR-6 装配；构造 RunParams 时由 host 提供 toolBundle 切片
      maxTokens: this.deps.host.llmDefaults.maxTokens,
      maxLlmCalls: profile.maxLlmCalls,    // undefined → AgentRunner 用默认值
      contextWindowTokens: this.deps.host.llmDefaults.contextWindowTokens,
    };

    // 7) try/catch/finally —— §spec §6.2 / §10.1 alt 分支 / §13.2 usage 来源表
    this.deps.onEvent({
      type: 'subagent_start',
      runId,
      sessionKey: childSessionKey,
      turnId: childTurnId,
      depth: childDepth,
      subagentType: profile.id,
      lifecycle: 'blocking',
      trigger,
    });

    let result: SubagentRunResult;
    try {
      const runResult = await this.deps.agentRunner.run(runParams);
      const outcome: SubagentRunResult['outcome'] =
        runResult.stopReason === 'max_llm_calls' ? 'max_llm_calls' : 'ok';
      // 注意：'aborted' 在 v1 不可达（Anthropic API 不产生该 stopReason；
      // §spec 决策 1 已声明）。'error' 路径走下面 catch 分支。
      result = {
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        text: runResult.text,
        outcome,
        usage: runResult.usage,
        durationMs: Date.now() - startedAt,
      };
      this.deps.onEvent({
        type: 'subagent_end',
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        depth: childDepth,
        subagentType: profile.id,
        lifecycle: 'blocking',
        trigger,
        outcome,
        usage: runResult.usage,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result = {
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        text: '',
        outcome: 'error',
        reason,
        usage: { inputTokens: 0, outputTokens: 0 },   // §spec §13.2 usage 来源表：catch 路径 usage = {0, 0}
        durationMs: Date.now() - startedAt,
      };
      this.deps.onEvent({
        type: 'subagent_end',
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        depth: childDepth,
        subagentType: profile.id,
        lifecycle: 'blocking',
        trigger,
        outcome: 'error',
        reason,
        usage: result.usage,
        durationMs: result.durationMs,
      });
      // **不向外抛**——转 SubagentRunResult 由 task.execute 按 §spec §13.2 失败矩阵处理
    } finally {
      this.deps.host.releaseTurnContext(childTurnId);
      await this.cleanup(childSessionKey);
    }

    return result;
  }

  /**
   * 加载子目录 contextFiles。
   * 目录不存在或为空 → 返回 []；调用方与父 contextFiles 做 per-file merge。
   */
  private async loadChildContextFiles(profile: SubagentProfile): Promise<ContextFile[]> {
    if (!existsSync(profile.agentDir)) return [];
    return await this.deps.loadContextFilesFromDir(profile.agentDir);
  }

  private async cleanup(sessionKey: string): Promise<void> {
    try {
      await this.deps.sessionManager.deleteSession(sessionKey);
    } catch (err) {
      log.warn('cleanup failed', {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
      // 不向外抛——子 session 删除失败不影响父 turn 结果（§spec 决策 11）
    }
  }
}

/**
 * 按文件名 merge：子目录有的文件优先，缺失的从父 contextFiles 补齐。
 * 文件名取 ContextFile.path 的 basename（loader 返回的 path 已是相对名，如 "IDENTITY.md"）。
 *
 * **严格按父顺序 walk**：loader 只读 ALL_FILES 白名单（IDENTITY/SOUL/AGENTS/TOOLS），
 * 子目录不可能出现白名单之外的文件，所以不需要 "追加额外 child 文件" 的分支。
 * 未来如果放宽 loader 可读任意 .md，本函数需同步扩展。
 */
function mergeContextFilesByName(
  childFiles: ReadonlyArray<ContextFile>,
  parentFiles: ReadonlyArray<ContextFile>,
): ContextFile[] {
  const childByName = new Map<string, ContextFile>();
  for (const f of childFiles) childByName.set(f.path, f);
  return parentFiles.map((parent) => childByName.get(parent.path) ?? parent);
}
```

实现要点：
- **mirror 主 agent `AgentRunner` 风格**：构造期注入 deps，run 期单 options object。
- **`SubagentHostBindings` 收拢 runtime 依赖**：core/subagent 不接触 `Channel` / `MessageRouteContext` 等 runtime 类型，依赖倒置（§spec §6.4 / §8.5）。
- **per-file merge** 而非 directory-level all-or-nothing：子目录有什么用什么，缺什么从父补什么（§spec §9.3）。
- **`outcome: 'aborted'` 在 v1 不可达**：catch 路径只产生 `'error'`；happy path 只产生 `'ok'` / `'max_llm_calls'`。'aborted' 保留在 union 里给将来 abort 子系统。
- **错误不向外抛**：catch 分支构造 `outcome: 'error'` 的 `SubagentRunResult` 返回；task tool 按 §spec §13.2 失败矩阵处理。
- **`tools` 字段在本 PR 不传给 `AgentRunner.run`**：subagent 工具集合并需要 `applyDenyFilter` + `resolveSubagentTools`，这些在 PR-6 装配时通过 host 暴露给 task tool（task tool 已通过 ToolExecutor 透传 ctx 区分主/子 sessionKey）。本 PR 单测可以直接 mock AgentRunner.run，断言 runParams 关键字段即可。
- 实际 logger 用 `Logger.get('SubagentRunner').warn(...)`（与 RuntimeApp 同一日志栈）。

### 测试要求（PR-3）

mock `AgentRunner` / `SessionManager` / `SubagentHostBindings` / `loadContextFilesFromDir` / `SystemPromptBuilder`（用 spy / 真实实例都行；SystemPromptBuilder 是纯函数风格，**真实实例 + mock 输入更简单**），不跑真实 LLM。

**SubagentRunner.test.ts 必覆盖 case：**
- **(a)** systemPrompt 通过 `systemPromptBuilder.build({ mode: 'minimal', ... })` 渲染：含 `# Current Date & Time` / `# Safety` / `# Project Context` / `# Workspace` 4 个 section（spec §11 minimal 表），**不**含 identity / behavior-rules / memory / available-subagents
- **(b)** systemPrompt 末尾 `\n\n` 之后追加 `buildSubagentBehavioralAddendum(...)` 的输出
- **(c)** 子目录所有文件齐全时 `# Project Context` 下含子目录 contextFiles 内容
- **(d)** 子目录部分文件缺失时 `# Project Context` 含子目录存在文件 + 父对应缺失文件名（per-file merge）
- **(e)** 子目录整个不存在时 `# Project Context` 含父 contextFiles
- **(f)** addendum 含 task description / depth；`canSpawn=false` 时含 "cannot spawn" 提示
- **(g)** `host.registerTurnContext` 在 AgentRunner.run 之前调用，`host.releaseTurnContext` 在 finally 块执行（含 catch 路径）
- **(h)** `profile.model === 'inherit'` 时 `RunParams.model === host.llmDefaults.model`；`profile.model` 是具体 id 时直接采用
- `subagent_start` 在 AgentRunner.run 之前 emit；`subagent_end` 在之后
- `subagent_start` 和 `subagent_end` 携带相同 `runId`
- `AgentRunner.run` 抛错时：emit `subagent_end`（outcome='error', usage={0,0}）+ 返回 `SubagentRunResult({ outcome: 'error' })`（**不向外抛**）
- 正常 / 异常路径都调 `deleteSession` 和 `releaseTurnContext`（cleanup 在 finally）
- `deleteSession` 失败时：log warn，SubagentRunner.run 仍返回正常 result（不向外抛）

**behavioral-addendum.test.ts**：
- 基础渲染：含 task description / depth
- `canSpawn=true` 不含 "cannot spawn"；`canSpawn=false` 含

**available-subagents.test.ts**：
- `entries=[]` → 返回空串
- 多条 entries → 渲染顺序与输入一致；含所有 id / description

---

## PR-4：task 工具

### 文件

| 操作 | 路径 |
|---|---|
| 新建 | `src/core/tools/builtin/task/task-tool.ts` |
| 新建 | `src/core/tools/builtin/task/index.ts` |
| 新建 | `src/core/tools/builtin/task/task-tool.test.ts` |

### `task-tool.ts`

```typescript
import { Logger } from '../../../../platform/logger/index.js';
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import type { SubagentRunner } from '../../../subagent/SubagentRunner.js';
import type {
  SubagentProfile,
  SubagentCapabilities,
  SubagentRunResult,
} from '../../../subagent/types.js';

const log = Logger.get('task');

export interface TaskToolDeps {
  subagentRunner: SubagentRunner;
  profileRegistry: ReadonlyMap<string, SubagentProfile>;
  getCapabilities: (sessionKey: string) => SubagentCapabilities;
  maxDepth: number;
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'Short label for this subtask (shown in events).',
    },
    prompt: {
      type: 'string',
      description: 'The full instructions for the subagent. Include all context it needs.',
    },
    subagent_type: {
      type: 'string',
      description: 'Subagent profile id. Omit or use "general-purpose" for the default assistant.',
    },
  },
  required: ['description', 'prompt'],
} as const;

export function createTaskTool(deps: TaskToolDeps): Tool {
  return {
    name: 'task',
    description:
      'Delegate an independent subtask to a subagent running in an isolated context. ' +
      'The subagent returns only its final text response. ' +
      'Pass all context the subagent needs in the prompt — it cannot see your conversation history.',
    inputSchema: INPUT_SCHEMA,

    async execute(
      input: { description: string; prompt: string; subagent_type?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      // v1 abort 通路未接通；signal?.aborted 永远 false（§spec 决策 1）
      // 此处不做 signal 检查——abort 子系统未来落地时统一加

      const subagentType = input.subagent_type ?? 'general-purpose';

      // profile 解析：LLM 工具入口未命中 → 降级 general-purpose + warn log（§spec 决策 10）
      let profile = deps.profileRegistry.get(subagentType);
      if (!profile) {
        log.warn('unknown subagent_type, falling back to general-purpose', { subagentType });
        profile = deps.profileRegistry.get('general-purpose')!;
      }

      // depth / canSpawn 兜底检查（双保险；§spec 决策 3 第二层防护）
      const caps = deps.getCapabilities(ctx.sessionKey);
      if (!caps.canSpawn) {
        return {
          content: `Cannot spawn subagent: depth limit (maxDepth=${deps.maxDepth}) reached.`,
          isError: true,
        };
      }

      try {
        const result = await deps.subagentRunner.run({
          profile,
          description: input.description,
          prompt: input.prompt,
          trigger: {
            source: 'llm-tool',
            parentSessionKey: ctx.sessionKey,
            parentTurnId: ctx.turnId,
            parentToolUseId: ctx.toolUseId,    // ← 依赖 PR-(-1) 扩 ToolContext
          },
          lifecycle: 'blocking',
          signal: ctx.signal,                  // 预留；v1 SubagentRunner 不消费
          parentSessionKey: ctx.sessionKey,
          parentTurnId: ctx.turnId,
        });

        return formatSubagentResult(result);
      } catch (err) {
        // ContextOverflowError 单独处理
        if (isContextOverflowError(err)) {
          return {
            content:
              'Subagent context overflow: the task was too large for the subagent\'s context window ' +
              'even after compaction. Consider breaking the task into smaller pieces, simplifying ' +
              'the prompt, or providing less background.',
            isError: true,
          };
        }
        // 其他意外错误：SubagentRunner 内部 catch 应已 emit subagent_end 并返回 outcome='error'，
        // 不会到这里。若仍走到，交给 createToolExecutor 的通用 isError 兜底。
        throw err;
      }
    },
  };
}

function formatSubagentResult(result: SubagentRunResult): ToolResult {
  switch (result.outcome) {
    case 'ok':
      return { content: result.text };
    case 'max_llm_calls':
      return {
        content: `Subagent stopped after reaching the LLM call limit before completing. Partial output:\n${result.text}`,
        isError: true,
      };
    case 'aborted':
      // v1 不可达（§spec 决策 1）；保留分支为将来 abort 子系统接入做准备
      return { content: 'Subagent was aborted before completing.', isError: true };
    case 'error':
      return { content: `Subagent failed: ${result.reason ?? 'unknown error'}`, isError: true };
  }
}

function isContextOverflowError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.constructor.name === 'ContextOverflowError' || err.message.includes('context overflow'))
  );
}
```

实现要点：
- **依赖 PR-(-1)**：`ctx.toolUseId / ctx.sessionKey / ctx.turnId` 必须先扩到 `ToolContext`，PR-4 才能写出 `parentToolUseId: ctx.toolUseId`。
- **`TaskToolDeps` 大幅瘦身**：原来 11 个字段全 runtime 依赖（mainAgentAllow / mainAgentDeny / model / maxTokens / ... ）现在全部装进 `SubagentHostBindings`，task tool 只关心 `subagentRunner / profileRegistry / getCapabilities / maxDepth` 四项。这反映了 spec §8.5 的依赖收拢。
- **`signal.aborted` 入口检查删掉**：v1 abort 不通，检查无意义。abort 子系统未来落地时在公共位置一次性加。
- **profile 解析在 task tool 内完成**：LLM 入口未命中 → fallback general-purpose（与 §spec 决策 10 LLM 路径一致）。库 API 路径在 `runSubagentTurn` 里另外做"未命中报错"。
- **`subagentRunner.run` 新签名**：单 options object，profile 已 resolved，4 个 cross-cutting 字段（parentSessionKey / parentTurnId）作为顶层入参。

### 测试要求（PR-4）

mock `SubagentRunner.run`（spy/stub），不跑真实 subagent。

**task-tool.test.ts 必覆盖 case：**
- **(a)** `parentToolUseId` 从 `ctx.toolUseId` 正确传入 trigger
- **(b)** `subagent_type` 未命中时：降级 general-purpose + warn log + 仍调 `SubagentRunner.run`
- **(c)** depth 超 `maxDepth` 时：返回 `isError: true` 且**不调** `SubagentRunner.run`
- **(d)** §spec §13.2 失败矩阵每行 outcome 映射：
  - `outcome: 'ok'` → `ToolResult.content` = subagent 文本，`isError` 不存在
  - `outcome: 'max_llm_calls'` → `isError: true` + 含 partial text
  - `outcome: 'error'` → `isError: true` + content 含 reason
  - `outcome: 'aborted'` 路径有分支但 v1 不会触发（spec 注释，测试 mock 可强行喂 'aborted' 验证分支）
- `ContextOverflowError` 被 catch → 返回指定 isError 文本

---

## PR-5：runtime 装配（tool-registry + prompt-factory + SystemPromptBuilder）

### 文件

| 操作 | 路径 |
|---|---|
| 修改 | `src/runtime/tool-registry.ts` |
| 修改 | `src/runtime/prompt-factory.ts` |
| 修改 | `src/core/prompt/SystemPromptBuilder.ts` |
| 修改 | `src/core/prompt/types.ts`（`SystemPromptBuildParams` 新增字段） |

### `tool-registry.ts` 新增

在文件末尾新增小 helper（不改现有函数）。task tool 的实际 deps 已在 PR-4 收拢到 `TaskToolDeps` 4 字段（其余 runtime 关注点都在 `SubagentHostBindings` 里），所以本 helper 只需在 `TaskToolDeps` 之上加一个 `enabled` 开关：

```typescript
import { createTaskTool, type TaskToolDeps } from '../core/tools/builtin/task/index.js';
import type { Tool } from '../core/tools/types.js';

export interface BuildTaskToolParams extends TaskToolDeps {
  enabled: boolean;
}

export function buildTaskToolIfEnabled(params: BuildTaskToolParams): Tool | null {
  if (!params.enabled) return null;
  const { enabled: _ignored, ...deps } = params;
  return createTaskTool(deps);
}
```

实现要点：
- **完全复用 PR-4 的 `TaskToolDeps`**：避免类型重复声明 + 自动跟随 PR-4 字段演化。
- **只多一个 `enabled` 开关**：让 `subagents.enabled === false` 时直接返回 null，调用方不再判 if。
- PR-6 `RuntimeApp.create` 当前直接 `createTaskTool({...})` + inline 判 enabled，可选择是否切换到这个 helper。两种写法等价；保留 helper 仅为概念清晰（"enabled 是 cross-cutting 配置"）。

### `prompt-factory.ts` 修改

1. `BuildSystemPromptParamsInput` 新增字段：
```typescript
availableSubagents?: import('../core/subagent/available-subagents.js').AvailableSubagentEntry[];
```

2. `buildSystemPromptParams` 透传：
```typescript
availableSubagents: input.availableSubagents,
```

3. `SystemPromptBuildParams`（在 `core/prompt/types.ts`）同步新增：
```typescript
availableSubagents?: AvailableSubagentEntry[];
```

### `SystemPromptBuilder.ts` 修改

`build()` 方法重写 minimal 跳过逻辑，并新增两个 section（Section 7 workspace、Section 8 available-subagents）。编号与 spec §11 对齐：**跳过已停用的 tool-definitions slot，对 active section 重新连续编号 1–6**，新增 7–8。

```typescript
build(params: SystemPromptBuildParams = {}): string {
  const mode = params.mode ?? 'full';
  if (mode === 'none') return '';

  const isMinimal = mode === 'minimal';
  const lines: string[] = [];

  if (!isMinimal) this.buildIdentitySection(lines);           // 1. identity
  this.buildDatetimeSection(lines);                           // 2. datetime
  if (!isMinimal) this.buildBehaviorRulesSection(lines);      // 3. behavior-rules
  this.buildSafetySection(lines, params);                     // 4. safety
  if (!isMinimal) this.buildMemorySection(lines, params);     // 5. memory-instructions
  this.buildProjectContextSection(lines, params);             // 6. project-context
  this.buildWorkspaceSection(lines, params);                  // 7. workspace（full + minimal 都注入；mode==='none' 已在顶部 return）
  if (!isMinimal) this.buildAvailableSubagentsSection(lines, params); // 8. available-subagents

  return lines.join('\n');
}
```

新增两个 private 方法：

```typescript
// Section 7: workspace
private buildWorkspaceSection(
  lines: string[],
  params: SystemPromptBuildParams,
): void {
  if (!params.workspaceDir) return;
  lines.push('# Workspace');
  lines.push(`Your working directory is: ${params.workspaceDir}`);
  lines.push('');
}

// Section 8: available-subagents
private buildAvailableSubagentsSection(
  lines: string[],
  params: SystemPromptBuildParams,
): void {
  const entries = params.availableSubagents;
  if (!entries?.length) return;
  const section = renderAvailableSubagentsSection(entries);
  if (section) {
    lines.push(section);
    lines.push('');
  }
}
```

`SystemPromptBuildParams`（`core/prompt/types.ts`）新增两个字段：

```typescript
workspaceDir?: string;
availableSubagents?: AvailableSubagentEntry[];
```

`prompt-factory.ts` 的 `buildSystemPromptParams` 对应透传。

实现要点：
- `renderAvailableSubagentsSection` 只 import 类型和纯函数，`SystemPromptBuilder` 不直接依赖 `SubagentRunner`。
- `workspaceDir` 在 bootstrap 时已知，由 `prompt-factory.ts` 注入。

### 测试要求（PR-5）

**tool-registry 单测：**
- `buildTaskToolIfEnabled({ enabled: false })` 返回 null
- `buildTaskToolIfEnabled({ enabled: true })` 返回一个 name='task' 的 Tool

**SystemPromptBuilder 测试（新增/更新 case）：**
- `mode='full'`：output 含 identity、behavior-rules、memory（有工具时）、workspace（有 workspaceDir 时）、available-subagents（有条目时）
- `mode='minimal'`：output **不含** identity、behavior-rules、memory、available-subagents；**含** datetime、safety、project-context、workspace
- `mode='none'`：output 为空字符串
- `workspaceDir` 有值时 output 含 `Your working directory is:` 行
- `availableSubagents` 有值时 output 含 `<available-subagents>` 段

> **NOTE**：v1 中注入条件是 `!isMinimal`，subagent 统一传 `minimal` 故一律不注入。若未来支持嵌套，需改为依据"是否持有 `task` 工具"决定是否注入，届时需同步修改 `buildAvailableSubagentsSection` 的判断逻辑。

---

## PR-6：runtime 整体装配（subagent-orchestration + RuntimeApp + bootstrap）

### 文件

| 操作 | 路径 |
|---|---|
| 新建 | `src/runtime/subagent-orchestration.ts` |
| 修改 | `src/runtime/types.ts` |
| 修改 | `src/runtime/RuntimeApp.ts` |
| 修改 | `src/runtime/bootstrap.ts` |
| 新建 | `src/runtime/subagent-orchestration.test.ts` |

### `types.ts` 修改

**不**往 `RuntimeResourceSet` 里加 subagent 字段。理由：
- `subagentRunner` 依赖 `RuntimeApp.routeContextByTurn`，根本不是 bootstrap 的输出；装进 `RuntimeResourceSet` 会制造 "bootstrap 返回后还能被填充" 的奇怪语义，以及 `as any` 赋值。
- `subagentProfiles` 虽然是纯静态数据，但只被 `RuntimeApp.runSubagentTurn` 读取，不应被其他 resources 消费者看到。

所以两字段都住在 `RuntimeApp` 自己的 private field。只在 `RuntimeApp.ts` 加两个声明（用 `!` definite assignment assertion——比 `as any` 范围更小，意图更显）：

```typescript
// runtime/RuntimeApp.ts 类体内部
export class RuntimeApp {
  // ... 现有字段 ...

  /** 含 general-purpose；由 `create()` 在 `new RuntimeApp(...)` 后填入 */
  private subagentProfiles!: ReadonlyMap<string, SubagentProfile>;
  /** 依赖 `routeContextByTurn`，只能在 `create()` 里 app 实例存在后构造 */
  private subagentRunner!: SubagentRunner;
}
```

`RuntimeResourceSet` 本身不变。

### `subagent-orchestration.ts`

包含两件事：(A) `SubagentHostBindings` 实现工厂，(B) 库 API `runSubagentTurn(input)` 实现。

```typescript
import type { Channel } from '../adapters/channel/types.js';
import type { AgentDefaults, ToolsConfig } from '../platform/config/types.js';
import type { ContextFile } from '../core/workspace/types.js';
import type { TokenUsage } from '../adapters/llm/types.js';
import type { SubagentRunner } from '../core/subagent/SubagentRunner.js';
import type {
  SubagentProfile,
  SubagentRunInput,
  SubagentRunResult,
  SubagentHostBindings,
} from '../core/subagent/types.js';
import { Logger } from '../platform/logger/index.js';
import type { MessageRouteContext } from './queue-types.js';

const log = Logger.get('subagent-orchestration');

// ────────────────────────────────────────────────────────────────
// (A) SubagentHostBindings 实现工厂
// ────────────────────────────────────────────────────────────────

export interface CreateSubagentHostBindingsParams {
  /** 共享同一引用，RuntimeApp 内部更新 contextFiles 时此 host 看到最新值（getter 语义） */
  getParentContextFiles: () => ContextFile[];
  /** RuntimeApp 的 routeContextByTurn map（共享引用） */
  routeContextByTurn: Map<string, MessageRouteContext>;
  /** resolvedConfig 快照——v1 启动后不变，hot-reload 时 RuntimeApp 须重建 host 实例（§spec §8.5） */
  resolvedConfig: AgentDefaults;
  /** 工作区绝对路径，来源 RuntimeAppOptions.workspaceDir */
  workspaceDir: string;
}

export function createSubagentHostBindings(
  params: CreateSubagentHostBindingsParams,
): SubagentHostBindings {
  const tools: ToolsConfig | undefined = params.resolvedConfig.tools;
  const llm = params.resolvedConfig.llm;
  const subagents = params.resolvedConfig.subagents;
  const prompt = params.resolvedConfig.prompt;

  return {
    registerTurnContext(childTurnId, parentTurnId) {
      const parentCtx = params.routeContextByTurn.get(parentTurnId);
      if (parentCtx) {
        params.routeContextByTurn.set(childTurnId, parentCtx);
      }
      // 父 ctx 不存在（库 API 入口或 routing 未登记）→ 不登记；下游 hook 查不到 → fail-closed
    },
    releaseTurnContext(childTurnId) {
      params.routeContextByTurn.delete(childTurnId);
    },
    getParentContextFiles: params.getParentContextFiles,
    mainAgentTools: {
      allow: tools?.allow ?? [],
      deny: tools?.deny ?? [],
    },
    llmDefaults: {
      model: llm.model ?? '',
      maxTokens: llm.maxTokens ?? 4096,
      contextWindowTokens: llm.contextWindowTokens ?? 200_000,
    },
    maxDepth: subagents?.maxDepth ?? 1,
    workspaceDir: params.workspaceDir,
    promptSafetyLevel: prompt?.safetyLevel ?? 'normal',
  };
}

// ────────────────────────────────────────────────────────────────
// (B) 库 API: runSubagentTurn(input)
// ────────────────────────────────────────────────────────────────

export interface RunSubagentTurnDeps {
  subagentRunner: SubagentRunner;
  profileRegistry: ReadonlyMap<string, SubagentProfile>;
}

export async function runSubagentTurn(
  input: SubagentRunInput,
  deps: RunSubagentTurnDeps,
): Promise<SubagentRunResult> {
  // §spec 决策 10：库 API 入口未命中 → fail-fast 报错（与 LLM 入口的"降级"不同）
  const profile = deps.profileRegistry.get(input.subagentType);
  if (!profile) {
    throw new Error(
      `Unknown subagent type: "${input.subagentType}". ` +
      `Library API requires a registered profile id (LLM tool can fallback to general-purpose, but library API does not).`,
    );
  }

  // library 入口无父 turn：parentSessionKey / parentTurnId 用合成标签
  const parentSessionKey =
    input.trigger.source === 'library'
      ? (input.trigger.callerLabel ?? 'library')
      : input.trigger.parentSessionKey;
  const parentTurnId =
    input.trigger.source === 'library'
      ? `library-synthetic-${input.trigger.callerLabel ?? 'caller'}`
      : input.trigger.parentTurnId;

  return deps.subagentRunner.run({
    profile,
    description: input.description,
    prompt: input.prompt,
    trigger: input.trigger,
    lifecycle: input.lifecycle,
    signal: input.signal,
    parentSessionKey,
    parentTurnId,
  });
}

// ────────────────────────────────────────────────────────────────
// (C) usage 累加 helper（可选；用于 PR-6 测试）
// ────────────────────────────────────────────────────────────────

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
```

### `RuntimeApp.ts` 修改

新增 public method（位置：在 `runTurn` 之后，`close` 之前）：

```typescript
import type { SubagentRunInput, SubagentRunResult } from '../core/subagent/types.js';
import { runSubagentTurn as runSubagentTurnImpl } from './subagent-orchestration.js';

async runSubagentTurn(input: SubagentRunInput): Promise<SubagentRunResult> {
  return runSubagentTurnImpl(input, {
    subagentRunner: this.subagentRunner,       // private field，§types.ts 修改
    profileRegistry: this.subagentProfiles,    // private field，§types.ts 修改
  });
}
```

### `bootstrap.ts` 修改

`bootstrap.ts` 是装配中心，需要做两件事：
1. 装配 `subagentProfiles` registry + `SubagentRunner`
2. 在 `RuntimeApp.create()` 内部（**不是 bootstrap 内部**）完成 task 工具的注入——因为 task 工具依赖 `routeContextByTurn` 这个 RuntimeApp 实例字段

```typescript
// runtime/bootstrap.ts
import {
  loadSubagentProfiles,
  buildGeneralPurposeProfile,
} from '../core/subagent/config-loader.js';
import type { SubagentProfile } from '../core/subagent/types.js';
// 注：SubagentRunner / loadContextFilesFromDir / createSubagentHostBindings
// 的 import 在 RuntimeApp.ts 而非 bootstrap.ts——bootstrap 只负责造
// profileRegistry，runner 装配延后到 RuntimeApp.create()（见下文）。

// ... 在 createDefaultRuntimeDependencies / bootstrapRuntime 内的 agentRunner 创建之后：

// 1) 装配 subagent profiles
const registeredToolNames = new Set(toolBundle.tools.map((t) => t.name));
const userProfiles = loadSubagentProfiles(
  resolvedConfig.subagents?.list ?? [],
  options.workspaceDir,
  registeredToolNames,
);
const generalPurpose = buildGeneralPurposeProfile(options.workspaceDir);
const subagentProfilesMap = new Map<string, SubagentProfile>([
  [generalPurpose.id, generalPurpose],
  ...userProfiles.map((p): [string, SubagentProfile] => [p.id, p]),
]);
const subagentProfiles: ReadonlyMap<string, SubagentProfile> = subagentProfilesMap;

// 2) 装配 SubagentRunner——但 host 还没法在 bootstrap 期完整造（缺 routeContextByTurn 引用）
//    解决方案：把 host 的"路由部分"延后到 RuntimeApp.create() 内补注；contextFiles 部分用 getter
//    captured by closure over `resources.contextFiles`（重载后 host 自动看到最新值）。
//
//    bootstrap 内只造 placeholder host —— 真实 host 由 RuntimeApp.create() 在 new RuntimeApp 后注入。
//    或者更简单：把整个 SubagentRunner 构造也延迟到 RuntimeApp.create() —— 见下面 RuntimeApp 改造。
```

**实际装配位置：** 把 SubagentRunner + host bindings 的构造**整体移到 `RuntimeApp.create()` 内部**（在 `bootstrapRuntime` 返回 resources 之后），原因：
- `host.routeContextByTurn` 必须共享 RuntimeApp 的字段引用
- `host.getParentContextFiles` 必须能动态读 `resources.contextFiles`（被 `reloadContextFiles()` 替换）
- task 工具依赖 SubagentRunner + host

`RuntimeApp.ts` 顶部新增的 imports（**与上面 `runSubagentTurn` 那段的 imports 合并到同一处**；与现有文件 imports 合并）：

```typescript
// runtime/RuntimeApp.ts —— 新增 imports（粘贴到现有 import 块）
import { SubagentRunner } from '../core/subagent/SubagentRunner.js';
import { resolveSubagentCapabilities } from '../core/subagent/capabilities.js';
import { createTaskTool } from '../core/tools/builtin/task/index.js';
import {
  applyDenyFilter,
  createToolExecutor,
  toLlmToolDefinitions,
  toPromptToolDefinitions,
} from './tool-registry.js';
import {
  createSubagentHostBindings,
  runSubagentTurn as runSubagentTurnImpl,
} from './subagent-orchestration.js';
import { loadContextFilesFromDir } from '../core/workspace/index.js';
import type { SubagentRunInput, SubagentRunResult } from '../core/subagent/types.js';
// (Channel / AgentEvent / RuntimeApp 等已在原文件中 import)
```

```typescript
// runtime/RuntimeApp.ts
static async create(options: RuntimeAppOptions): Promise<RuntimeApp> {
  const channels: Channel[] = [];
  const userObserver = options.onAgentEvent;
  const fanout = (event: AgentEvent) => { /* ... 不变 ... */ };

  const { resources, state } = await bootstrapRuntime({
    ...options,
    onAgentEvent: fanout,
  });

  const app = new RuntimeApp(resources, state, channels, options.onEvent);

  // ── subagent 后置装配（需要 app.routeContextByTurn）─────────────
  const host = createSubagentHostBindings({
    getParentContextFiles: () => resources.contextFiles,
    // dot 访问合法：static 方法属于 RuntimeApp 类，TS 类级私有允许访问自家实例的 private 字段
    routeContextByTurn: app.routeContextByTurn,
    resolvedConfig: resources.resolvedConfig,
    workspaceDir: options.workspaceDir,                              // 新增：供 host.workspaceDir
  });

  const subagentRunner = new SubagentRunner({
    agentRunner: resources.agentRunner,
    sessionManager: resources.sessionManager,
    systemPromptBuilder: resources.systemPromptBuilder,              // 新增：subagent 复用主 builder
    onEvent: fanout,
    host,
    loadContextFilesFromDir: (absDir) => loadContextFilesFromDir(absDir, {
      maxFileChars: resources.resolvedConfig.workspace.maxFileChars,
      maxTotalChars: resources.resolvedConfig.workspace.maxTotalChars,
    }),
  });

  // 把 task 工具追加到 toolBundle（应用 applyDenyFilter）
  if (resources.resolvedConfig.subagents?.enabled !== false) {
    const taskTool = createTaskTool({
      subagentRunner,
      profileRegistry: subagentProfiles,
      getCapabilities: (sessionKey) =>
        resolveSubagentCapabilities(sessionKey, host.maxDepth),
      maxDepth: host.maxDepth,
    });
    // 注入并重新过滤 deny
    const newTools = applyDenyFilter(
      [...resources.toolBundle.tools, taskTool],
      resources.resolvedConfig.tools?.deny ?? [],
    );
    resources.toolBundle = {
      tools: newTools,
      executor: createToolExecutor(newTools),
      llmDefinitions: toLlmToolDefinitions(newTools),
      promptDefinitions: toPromptToolDefinitions(newTools),
    };
  }

  // 填入 RuntimeApp 的 private field（§types.ts 修改里声明为 `!`）
  app.subagentProfiles = subagentProfiles;
  app.subagentRunner = subagentRunner;

  return app;
}
```

实现要点：
- **`createSubagentHostBindings` 用闭包共享 routeContextByTurn 引用**：host.registerTurnContext / releaseTurnContext 操作的是 RuntimeApp 的 map，hook 一查就能命中。
- **`getParentContextFiles: () => resources.contextFiles`**：reload 后 RuntimeApp 把 `resources.contextFiles` 替换为新数组，host 通过 getter 自动看到。
- **task 工具在 RuntimeApp.create 内构造**：因为它依赖 SubagentRunner + host，这两者又依赖 RuntimeApp 实例。bootstrap 阶段只造 profileRegistry（纯静态）。
- **`applyDenyFilter` 在 task 追加后再跑一次**：确保 config 把 `task` 加进 deny 时也能被过滤掉（虽然 task 列入 deny 是反模式，但防御性处理）。
- **`app.routeContextByTurn` 访问**：在 `static create()` 内部用 dot 访问自家实例的 private 字段——TypeScript 类级私有允许此操作（private 是"类外不可见"，static 方法属于类内）。**不需要**改 `private` → `protected` / `public readonly`，也不需要加 internal getter。无 hack 味道，TS 标准用法。

### 测试要求（PR-6）

**subagent-orchestration.test.ts 必覆盖 case：**
- end-to-end with mock LLM（参考 `AgentRunner` 现有 e2e mock 测试）
- **(a)** 父 + 子 usage 树形累加正确（父 `RunResult.usage` = 父自身 + 子 `SubagentRunResult.usage`）
- **(b)** 子 `outcome='error'` 时父 `RunResult.usage` **不被污染**（subagent_end 事件 usage={0,0}，父累加 0 仍是父自身值；§spec §13.2 usage 来源表）
- **(c)** `runSubagentTurn(input)` 未命中 profile → 抛 Error（库 API 入口 fail-fast；§spec 决策 10）
- **(d)** `createSubagentHostBindings.registerTurnContext` 在父 routeContextByTurn 存在条目时正确复制；在不存在时不抛错（fail-closed by silently not registering）
- **(e)** `releaseTurnContext(childTurnId)` 后 routeContextByTurn 不再有该 turnId 条目
- **(f)** `getParentContextFiles()` 返回最新 `resources.contextFiles`（reload 后看到新数组）

---

## PR-7（可选）：CLI / Channel 端适配

若有 CLI 或 WebSocket channel 实现，需处理 `subagent_start / subagent_end` 事件：

- `subagent_start`：UI 开新嵌套层（缩进 / 折叠面板）
- `subagent_end`：关闭嵌套层 + 展示 `outcome / durationMs / usage`
- `trigger.source` 区分显示方式（`'llm-tool'` → 嵌套在父 turn 里；`'library'` → 独立任务条目）

具体实现待 channel 决策后补充，本 impl 文档不展开。

---

## 附：关键不变量 checklist

每个 PR 合并前验证：

- [ ] `core/subagent/` 不 import `runtime/` 任何模块（依赖倒置：通过 `SubagentHostBindings` 接口）
- [ ] **`core/runner/types.ts` 的 `subagent_*` event variants 反向 import `core/subagent/types.js` 是已知 v1 违规**，必须保留 FIXME 注释；v2 拆 `SubagentEvent` 时一并解决（详 spec §6.4 / impl §PR-2）
- [ ] `task` 工具是唯一依赖 `core/subagent/` 的内置工具
- [ ] `SystemPromptBuilder` 只 import `AvailableSubagentEntry` 类型和 `renderAvailableSubagentsSection` 纯函数
- [ ] `SubagentRunner` 不调 `loadConfig()`；所有 runtime 配置通过 `SubagentHostBindings` 注入
- [ ] `SubagentRunner.run` 签名 = 构造期 deps + 单 options object（mirror AgentRunner.run 风格）
- [ ] 子 `promptMode` 始终为 `'minimal'`
- [ ] `cleanup`（`deleteSession`）+ `host.releaseTurnContext` 在 `finally` 块里，无论 outcome 均执行
- [ ] `SubagentRunner.run` 异常路径 **不向外抛**——catch 块构造 `outcome: 'error'` 的 `SubagentRunResult` 返回
- [ ] `subagent_start` 在 `AgentRunner.run` 之前 emit；`subagent_end` 在之后（**含 catch 路径**）
- [ ] 异常路径 `subagent_end.usage = { inputTokens: 0, outputTokens: 0 }`（不污染父 RunResult.usage）
- [ ] `ToolResult.content` 只含子的 `text`，不含 `usage / runId / outcome`
- [ ] contextFiles 加载用 **per-file merge**（子目录文件优先，缺失从父补齐），不是 directory-level all-or-nothing
- [ ] `profile.agentDir` 必填（loader 派生），不是 optional
- [ ] `outcome: 'aborted'` 分支在 v1 不可达，但保留 union（接口预留给将来 abort 子系统）
- [ ] `signal?` 字段在所有类型中保留为占位，v1 任何代码不读取
