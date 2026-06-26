# Subagent 实现文档

> 关联 spec：`docs/architecture/core-subagent-spec.md`
> 文档日期：2026-06-26

---

## 0. 前提确认

写代码前需知道的现状：

| 事项 | 现状 | 影响 |
|---|---|---|
| `SessionManager.deleteSession(key)` | **已存在**（`session/SessionManager.ts:156`），已同时删除 JSONL + Store 条目 | PR-3 直接调用，无需新增方法；spec §7 决策 11 说"需新增 delete"是误判 |
| `applyDenyFilter(tools, deny)` | **已存在**（`tool-registry.ts:37`） | PR-4 / PR-6 可直接复用 |
| `resolvedConfig.tools.deny` | bootstrap.ts 已在主 agent 工具组装时传入 | subagent 工具组装需复用同一函数，参数拼接不同 |
| `AgentEvent` union | `core/runner/types.ts:64`，目前 11 个 variant | PR-2 在末尾追加 2 个；不改现有 variant |
| `RuntimeResourceSet` | `runtime/types.ts:20`，无 subagent 相关字段 | PR-6 新增 `subagentProfiles` 和 `subagentRunner` |
| `SystemPromptBuilder` | 7 个 section，`promptMode='minimal'` 不注入 memory section | PR-5 新增第 8 个 section，注入条件与 memory section 相同 |

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

export interface SubagentProfile {
  id: string;
  description: string;
  agentDir?: string;           // 由 loader 从 <workspaceDir>/.agent/subagents/<id>/ 派生
  model?: string;              // 'inherit'（默认）或具体 model id
  tools?: {
    allow?: string[];          // 替换语义
    deny?: string[];           // 叠加语义
  };
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

export interface RunRequest {
  subagentType: string;
  description: string;
  prompt: string;
  trigger: RunTrigger;
  lifecycle: RunLifecycle;
  signal?: AbortSignal;
}

export interface SubagentRunResult {
  runId: string;
  sessionKey: string;
  turnId: string;
  text: string;
  outcome: 'ok' | 'error' | 'aborted' | 'max_llm_calls';
  reason?: string;
  usage: TokenUsage;
  durationMs: number;
}

export type SubagentRole = 'main' | 'orchestrator' | 'leaf';

export interface SubagentCapabilities {
  depth: number;
  role: SubagentRole;
  canSpawn: boolean;
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

config 类型 `SubagentConfigEntry` 在 spec §12 已定义，对应 `src/platform/config/types.ts` 里的扩展（待 platform-config PR 落地）。本 PR 临时 inline 或 import。

```typescript
import { join } from 'node:path';
import type { SubagentConfigEntry } from '../../platform/config/types.js';  // 待 platform-config PR
import type { SubagentProfile } from './types.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_IDS = new Set(['general-purpose']);

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
        if (!registeredToolNames.has(name) && !name.includes('*')) {
          throw new Error(
            `subagents.list["${entry.id}"]: allow references unknown tool "${name}"`,
          );
        }
      }
    }
    seen.add(entry.id);

    const agentDir = join(workspaceDir, '.agent', 'subagents', entry.id);
    return {
      id: entry.id,
      description: entry.description,
      agentDir,
      model: entry.model,
      tools: entry.tools,
      maxLlmCalls: entry.maxTurns,
    };
  });
}

export function buildGeneralPurposeProfile(): SubagentProfile {
  return {
    id: 'general-purpose',
    description: '通用任务执行助手。当任务不匹配任何具名 subagent 时使用。',
    // agentDir 不设置 → 匿名 subagent（用父 contextFiles + addendum）
  };
}
```

实现要点：
- `agentDir` 始终派生（不从 config 读），路径是否存在由 `SubagentRunner` 运行时按需判断。
- `allow` 中 glob 表达式（含 `*`）跳过精确名校验，只检查精确名。
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
    ? profile.tools.allow          // 替换
    : [...parentAllow];            // fallback

  const deny = profile.tools?.deny !== undefined
    ? [...parentDeny, ...profile.tools.deny]   // 叠加
    : [...parentDeny];                          // fallback

  // deny 优先：从 allow 中剔除出现在 deny 里的精确名（glob 版在注册层 applyDenyFilter 处理）
  const denySet = new Set(deny);
  const filteredAllow = allow.filter((name) => !denySet.has(name));

  return { allow: filteredAllow, deny };
}
```

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
- 子不写 allow → fallback parentAllow
- 子写了 allow → 替换，parentAllow 被丢弃
- 子不写 deny → fallback parentDeny
- 子写了 deny → 叠加到 parentDeny
- 同时出现在 deny 和 allow 的工具被从 filteredAllow 剔除

---

## PR-2：AgentEvent union 扩展

### 文件

| 操作 | 路径 |
|---|---|
| 修改 | `src/core/runner/types.ts` |

在 `AgentEvent` union 末尾追加（`src/core/runner/types.ts:121` 之后）：

```typescript
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
  taskDescription: string;   // 来自 RunRequest.description
  prompt: string;            // 来自 RunRequest.prompt（子的 user message）
  depth: number;
  sessionKey: string;        // 子的 sessionKey
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
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import type { AgentRunner } from '../runner/index.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { ContextFile } from '../workspace/types.js';
import { loadContextFiles } from '../workspace/index.js';
import type { AgentEvent } from '../runner/types.js';
import { formatSubagentSessionKey, getSubagentDepth } from './session-key.js';
import { resolveSubagentCapabilities } from './capabilities.js';
import { buildSubagentBehavioralAddendum } from './behavioral-addendum.js';
import type { SubagentProfile, RunRequest, SubagentRunResult } from './types.js';

export interface SubagentRunnerDeps {
  agentRunner: AgentRunner;
  sessionManager: SessionManager;
  onEvent: (event: AgentEvent) => void;
  workspaceDir: string;
  maxFileChars: number;
  maxTotalChars: number;
}

export class SubagentRunner {
  constructor(private readonly deps: SubagentRunnerDeps) {}

  async run(
    profile: SubagentProfile,
    req: RunRequest,
    parentSessionKey: string,
    parentContextFiles: ContextFile[],
    mainAgentAllow: string[],
    mainAgentDeny: string[],
    maxDepth: number,
    // routeContextByTurn 注册函数，由 RuntimeApp 传入
    registerTurnContext: (turnId: string, ctx: { originChannel: unknown; originClientId: string | null }) => void,
    parentOriginChannel: unknown,
    parentOriginClientId: string | null,
    model: string,
    maxTokens: number,
    contextWindowTokens: number,
  ): Promise<SubagentRunResult> {
    const startedAt = Date.now();
    const runId = randomUUID();
    const childTurnId = randomUUID();

    // 子 sessionKey
    const parentDepth = getSubagentDepth(parentSessionKey);
    const childDepth = parentDepth + 1;
    const rootLabel = req.trigger.source === 'llm-tool'
      ? req.trigger.parentSessionKey
      : (req.trigger.callerLabel ?? 'library');
    const childSessionKey = formatSubagentSessionKey({ rootLabel, runId, depth: childDepth });

    const capabilities = resolveSubagentCapabilities(childSessionKey, maxDepth);

    // 注册父 channel 到 routeContextByTurn
    registerTurnContext(childTurnId, {
      originChannel: parentOriginChannel,
      originClientId: parentOriginClientId,
    });

    // 加载子 contextFiles
    const contextFiles = await this.loadChildContextFiles(
      profile,
      parentContextFiles,
    );

    // 组装 system prompt
    const addendum = buildSubagentBehavioralAddendum({
      taskDescription: req.description,
      prompt: req.prompt,
      depth: childDepth,
      sessionKey: childSessionKey,
      canSpawn: capabilities.canSpawn,
    });
    const systemPrompt = contextFiles
      .map((f) => `## ${f.path}\n\n${f.content}`)
      .join('\n\n')
      + '\n\n' + addendum;

    this.deps.onEvent({
      type: 'subagent_start',
      runId,
      sessionKey: childSessionKey,
      turnId: childTurnId,
      depth: childDepth,
      subagentType: profile.id,
      lifecycle: 'blocking',
      trigger: req.trigger,
    });

    let runResult;
    try {
      runResult = await this.deps.agentRunner.run({
        sessionKey: childSessionKey,
        message: req.prompt,
        model,
        systemPrompt,
        turnId: childTurnId,
        maxTokens,
        maxLlmCalls: profile.maxLlmCalls,
        contextWindowTokens,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const result: SubagentRunResult = {
        runId,
        sessionKey: childSessionKey,
        turnId: childTurnId,
        text: '',
        outcome: 'error',
        reason,
        usage: { inputTokens: 0, outputTokens: 0 },
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
        trigger: req.trigger,
        outcome: 'error',
        reason,
        usage: result.usage,
        durationMs: result.durationMs,
      });
      // finally 里清理
      throw err;
    } finally {
      await this.cleanup(childSessionKey);
    }

    // outcome 推断
    const outcome = runResult.stopReason === 'max_iterations'
      ? 'max_llm_calls'
      : runResult.stopReason === 'abort'
        ? 'aborted'
        : 'ok';

    const result: SubagentRunResult = {
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
      trigger: req.trigger,
      outcome,
      usage: runResult.usage,
      durationMs: result.durationMs,
    });

    return result;
  }

  private async loadChildContextFiles(
    profile: SubagentProfile,
    parentContextFiles: ContextFile[],
  ): Promise<ContextFile[]> {
    if (profile.agentDir && existsSync(profile.agentDir)) {
      const files = await loadContextFiles(profile.agentDir, {
        mode: 'full',
        maxFileChars: this.deps.maxFileChars,
        maxTotalChars: this.deps.maxTotalChars,
      });
      if (files.length > 0) return files;
    }
    return parentContextFiles;
  }

  private async cleanup(sessionKey: string): Promise<void> {
    try {
      await this.deps.sessionManager.deleteSession(sessionKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // log warn only, do not rethrow
      console.warn(`[SubagentRunner] cleanup failed for session "${sessionKey}": ${msg}`);
    }
  }
}
```

实现要点：
- `cleanup` 在 `try/catch` 的 `finally` 块里执行，无论 outcome 如何都清理。
- `finally` 写法：`try { runResult = await ... } catch(err) { ... throw err; } finally { await cleanup(...) }`——确保抛错路径也走 cleanup。
- 实际 logger 应改用 `Logger.get('SubagentRunner').warn(...)`，此处 `console.warn` 仅示意。
- `registerTurnContext` / `parentOriginChannel` 等参数的类型需与 `RuntimeApp.ts` 里的 `routeContextByTurn` 接口对齐，当前签名使用 `unknown` 占位，PR-6 落地后细化。
- `model` / `maxTokens` / `contextWindowTokens` 由调用方（RuntimeApp）从 `resolvedConfig` 传入，SubagentRunner 不调 `loadConfig`。
- `AgentRunner.run` 的 `stopReason` 枚举需与 `RunResult.stopReason` 的实际值对齐——PR-3 完成后需跑一次集成测试确认。

### 测试要求（PR-3）

mock `AgentRunner` / `SessionManager`（用 spy），不跑真实 LLM。

**SubagentRunner.test.ts 必覆盖 case：**
- 约定目录存在时：`RunParams.systemPrompt` 包含子目录 contextFiles 内容
- 目录不存在时：`RunParams.systemPrompt` 包含父 contextFiles 内容
- addendum 含 task description / depth / "cannot spawn" 提示
- `subagent_start` 在 AgentRunner.run 之前 emit，`subagent_end` 在之后
- `subagent_start` 和 `subagent_end` 携带相同 `runId`
- `AgentRunner.run` 抛错时：emit `subagent_end`（outcome='error'）且调 `deleteSession`
- `AgentRunner.run` 正常返回时：也调 `deleteSession`（cleanup 在 finally）
- `deleteSession` 失败时：不向外抛（SubagentRunner.run 仍正常返回）

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
import type { Tool, ToolContext, ToolResult } from '../../types.js';
import type { SubagentRunner } from '../../../subagent/SubagentRunner.js';
import type { SubagentProfile, SubagentCapabilities } from '../../../subagent/types.js';
import { resolveSubagentCapabilities } from '../../../subagent/capabilities.js';

export interface TaskToolDeps {
  subagentRunner: SubagentRunner;
  profileRegistry: ReadonlyMap<string, SubagentProfile>;
  getCapabilities: (sessionKey: string) => SubagentCapabilities;
  maxDepth: number;
  // 父 origin channel 上下文获取，由 RuntimeApp 注入
  getOriginContext: (turnId: string) => { originChannel: unknown; originClientId: string | null } | null;
  registerTurnContext: (turnId: string, ctx: { originChannel: unknown; originClientId: string | null }) => void;
  parentContextFiles: import('../../../../core/workspace/types.js').ContextFile[];
  mainAgentAllow: string[];
  mainAgentDeny: string[];
  model: string;
  maxTokens: number;
  contextWindowTokens: number;
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
      // v1 最小 abort 检查
      if (ctx.signal?.aborted) {
        return { content: 'Subagent was aborted before starting.', isError: true };
      }

      const subagentType = input.subagent_type ?? 'general-purpose';

      // profile 解析：未命中 → 降级 general-purpose + warn
      let profile = deps.profileRegistry.get(subagentType);
      if (!profile) {
        // log warn（实际实现用 Logger）
        console.warn(`[task] unknown subagent_type "${subagentType}", falling back to general-purpose`);
        profile = deps.profileRegistry.get('general-purpose')!;
      }

      // depth / canSpawn 兜底检查
      const caps = deps.getCapabilities(ctx.sessionKey);
      if (!caps.canSpawn) {
        return {
          content: `Cannot spawn subagent: depth limit (maxDepth=${deps.maxDepth}) reached.`,
          isError: true,
        };
      }

      // 取父 turn 的 originChannel
      const originCtx = deps.getOriginContext(ctx.turnId);

      const trigger =
        ctx.toolUseId !== undefined
          ? {
              source: 'llm-tool' as const,
              parentSessionKey: ctx.sessionKey,
              parentTurnId: ctx.turnId,
              parentToolUseId: ctx.toolUseId,
            }
          : { source: 'library' as const };

      try {
        const result = await deps.subagentRunner.run(
          profile,
          {
            subagentType,
            description: input.description,
            prompt: input.prompt,
            trigger,
            lifecycle: 'blocking',
            signal: ctx.signal,
          },
          ctx.sessionKey,
          deps.parentContextFiles,
          deps.mainAgentAllow,
          deps.mainAgentDeny,
          deps.maxDepth,
          deps.registerTurnContext,
          originCtx?.originChannel ?? null,
          originCtx?.originClientId ?? null,
          deps.model,
          deps.maxTokens,
          deps.contextWindowTokens,
        );

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
        // 其他意外错误交给 createToolExecutor 的通用兜底
        throw err;
      }
    },
  };
}

function formatSubagentResult(result: import('../../../subagent/types.js').SubagentRunResult): ToolResult {
  switch (result.outcome) {
    case 'ok':
      return { content: result.text };
    case 'max_llm_calls':
      return {
        content: `Subagent stopped after reaching the LLM call limit before completing. Partial output:\n${result.text}`,
        isError: true,
      };
    case 'aborted':
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
- `ctx.toolUseId` 需要在 `ToolContext` 类型里存在（当前 `core/tools/types.ts` 需确认是否已有此字段，若无需在该 PR 补充）。
- `ctx.sessionKey` / `ctx.turnId` 在现有 `ToolContext` 里需确认字段名，按实际调整。
- `deps.getCapabilities` 的实现来自 `resolveSubagentCapabilities(ctx.sessionKey, deps.maxDepth)`，可在 PR-6 装配时内联。

### 测试要求（PR-4）

mock `SubagentRunner.run`（spy/stub），不跑真实 subagent。

**task-tool.test.ts 必覆盖 case：**
- `parentToolUseId` 从 `ctx.toolUseId` 正确传入 trigger
- `subagent_type` 未命中时：降级 general-purpose + warn log + 仍调 `SubagentRunner.run`
- depth 超 `maxDepth` 时：返回 `isError: true` 且**不调** `SubagentRunner.run`
- `signal.aborted` 为 true 时：直接返回 isError，不调 SubagentRunner
- `outcome: 'ok'` → `ToolResult.content` = subagent 文本，`isError` 不存在
- `outcome: 'max_llm_calls'` → `isError: true` + 含 partial text
- `outcome: 'aborted'` → `isError: true`
- `outcome: 'error'` → `isError: true` + reason 在 content 里
- ContextOverflowError 被 catch → 返回指定 isError 文本

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

在文件末尾新增函数（不改现有函数）：

```typescript
import type { SubagentRunner } from '../core/subagent/SubagentRunner.js';
import type { SubagentProfile } from '../core/subagent/types.js';
import { createTaskTool } from '../core/tools/builtin/task/index.js';

export interface BuildTaskToolParams {
  enabled: boolean;
  subagentRunner: SubagentRunner;
  profileRegistry: ReadonlyMap<string, SubagentProfile>;
  maxDepth: number;
  // 透传给 TaskToolDeps 的其他字段
  getCapabilities: TaskToolDeps['getCapabilities'];
  getOriginContext: TaskToolDeps['getOriginContext'];
  registerTurnContext: TaskToolDeps['registerTurnContext'];
  parentContextFiles: TaskToolDeps['parentContextFiles'];
  mainAgentAllow: string[];
  mainAgentDeny: string[];
  model: string;
  maxTokens: number;
  contextWindowTokens: number;
}

export function buildTaskToolIfEnabled(params: BuildTaskToolParams): Tool | null {
  if (!params.enabled) return null;
  return createTaskTool({
    subagentRunner: params.subagentRunner,
    profileRegistry: params.profileRegistry,
    maxDepth: params.maxDepth,
    getCapabilities: params.getCapabilities,
    getOriginContext: params.getOriginContext,
    registerTurnContext: params.registerTurnContext,
    parentContextFiles: params.parentContextFiles,
    mainAgentAllow: params.mainAgentAllow,
    mainAgentDeny: params.mainAgentDeny,
    model: params.model,
    maxTokens: params.maxTokens,
    contextWindowTokens: params.contextWindowTokens,
  });
}
```

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

`build()` 方法重写 minimal 跳过逻辑，并新增两个 section（Section 8 workspace、Section 9 available-subagents）：

```typescript
build(params: SystemPromptBuildParams = {}): string {
  const mode = params.mode ?? 'full';
  if (mode === 'none') return '';

  const isMinimal = mode === 'minimal';
  const lines: string[] = [];

  if (!isMinimal) this.buildIdentitySection(lines);           // Section 1：跳过 minimal
  this.buildDatetimeSection(lines);                           // Section 2：始终
  if (!isMinimal) this.buildBehaviorRulesSection(lines);      // Section 4：跳过 minimal
  this.buildSafetySection(lines, params);                     // Section 5：始终
  if (!isMinimal) this.buildMemorySection(lines, params);     // Section 6：跳过 minimal
  this.buildProjectContextSection(lines, params);             // Section 7：始终
  if (mode !== 'none') this.buildWorkspaceSection(lines, params); // Section 8：始终（none 已在顶部 return）
  if (!isMinimal) this.buildAvailableSubagentsSection(lines, params); // Section 9：跳过 minimal

  return lines.join('\n');
}
```

新增两个 private 方法：

```typescript
// Section 8
private buildWorkspaceSection(
  lines: string[],
  params: SystemPromptBuildParams,
): void {
  if (!params.workspaceDir) return;
  lines.push('# Workspace');
  lines.push(`Your working directory is: ${params.workspaceDir}`);
  lines.push('');
}

// Section 9
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

`RuntimeResourceSet` 新增两个字段：

```typescript
subagentProfiles: ReadonlyMap<string, SubagentProfile>;  // 含 general-purpose
subagentRunner: SubagentRunner;
```

### `subagent-orchestration.ts`

```typescript
import type { SubagentRunner } from '../core/subagent/SubagentRunner.js';
import type { SubagentProfile, RunRequest, SubagentRunResult } from '../core/subagent/types.js';
import type { ContextFile } from '../core/workspace/types.js';

export interface SubagentOrchestrationDeps {
  subagentRunner: SubagentRunner;
  profileRegistry: ReadonlyMap<string, SubagentProfile>;
  parentContextFiles: ContextFile[];
  mainAgentAllow: string[];
  mainAgentDeny: string[];
  maxDepth: number;
  registerTurnContext: (turnId: string, ctx: { originChannel: unknown; originClientId: string | null }) => void;
  model: string;
  maxTokens: number;
  contextWindowTokens: number;
}

export async function runSubagentTurn(
  req: RunRequest,
  deps: SubagentOrchestrationDeps,
): Promise<SubagentRunResult> {
  const subagentType = req.subagentType;
  const profile = deps.profileRegistry.get(subagentType);
  if (!profile) {
    throw new Error(`Unknown subagent type: "${subagentType}"`);
  }

  // library 入口无父 turn，rootLabel = callerLabel || 'library'
  const parentSessionKey =
    req.trigger.source === 'library'
      ? (req.trigger.callerLabel ?? 'library')
      : req.trigger.parentSessionKey;

  return deps.subagentRunner.run(
    profile,
    req,
    parentSessionKey,
    deps.parentContextFiles,
    deps.mainAgentAllow,
    deps.mainAgentDeny,
    deps.maxDepth,
    deps.registerTurnContext,
    null,   // library 入口无 originChannel
    null,
    deps.model,
    deps.maxTokens,
    deps.contextWindowTokens,
  );
}
```

### `RuntimeApp.ts` 修改

新增 public method（位置：在 `runTurn` 之后，`close` 之前）：

```typescript
async runSubagentTurn(req: RunRequest): Promise<SubagentRunResult> {
  return runSubagentTurn(req, {
    subagentRunner: this.resources.subagentRunner,
    profileRegistry: this.resources.subagentProfiles,
    parentContextFiles: this.resources.contextFiles,
    mainAgentAllow: this.resources.resolvedConfig.tools?.allow ?? [],
    mainAgentDeny: this.resources.resolvedConfig.tools?.deny ?? [],
    maxDepth: this.resources.resolvedConfig.subagents?.maxDepth ?? 1,
    registerTurnContext: (turnId, ctx) => this.routeContextByTurn.set(turnId, ctx),
    model: this.resources.resolvedConfig.llm.model ?? '',
    maxTokens: this.resources.resolvedConfig.llm.maxTokens ?? 4096,
    contextWindowTokens: this.resources.resolvedConfig.llm.contextWindowTokens ?? 200_000,
  });
}
```

### `bootstrap.ts` 修改

在 `agentRunner` 创建之后，`return` 之前，增加 subagent 装配段：

```typescript
import { loadSubagentProfiles, buildGeneralPurposeProfile } from '../core/subagent/config-loader.js';
import { SubagentRunner } from '../core/subagent/SubagentRunner.js';
import type { SubagentProfile } from '../core/subagent/types.js';

// --- 装配 subagent profiles ---
const subagentList = resolvedConfig.subagents?.list ?? [];
const registeredToolNames = new Set(toolBundle.tools.map((t) => t.name));

const userProfiles = loadSubagentProfiles(
  subagentList,
  options.workspaceDir,
  registeredToolNames,
);

const generalPurpose = buildGeneralPurposeProfile();
const subagentProfilesMap = new Map<string, SubagentProfile>();
subagentProfilesMap.set(generalPurpose.id, generalPurpose);
for (const p of userProfiles) {
  subagentProfilesMap.set(p.id, p);
}
const subagentProfiles: ReadonlyMap<string, SubagentProfile> = subagentProfilesMap;

const subagentRunner = new SubagentRunner({
  agentRunner,
  sessionManager,
  onEvent: options.onAgentEvent ?? (() => {}),
  workspaceDir: options.workspaceDir,
  maxFileChars: resolvedConfig.workspace.maxFileChars,
  maxTotalChars: resolvedConfig.workspace.maxTotalChars,
});
```

在 `resources` 对象里新增两个字段：
```typescript
subagentProfiles,
subagentRunner,
```

同时，若 `resolvedConfig.subagents?.enabled !== false`，把 task 工具注入 `toolBundle`（**在** `assembleRuntimeTools` 之后追加，并重新过滤 deny）：

```typescript
if (resolvedConfig.subagents?.enabled !== false) {
  const taskTool = buildTaskToolIfEnabled({
    enabled: true,
    subagentRunner,
    profileRegistry: subagentProfiles,
    maxDepth: resolvedConfig.subagents?.maxDepth ?? 1,
    // getCapabilities / getOriginContext / registerTurnContext 需要 RuntimeApp 的闭包
    // bootstrap 不持有这些，因此 task 工具的这部分依赖需要在 RuntimeApp 构造后二次注入
    // 方案：createTaskTool 接受懒求值函数，或在 RuntimeApp.create() 里补注
    ...
  });
}
```

> **注**：`task` 工具依赖 `getOriginContext` 和 `registerTurnContext`，这两个来自 `RuntimeApp` 的内部状态（`routeContextByTurn`），bootstrap 阶段尚不存在。推荐方案：在 `RuntimeApp.create()` 内部调用 `bootstrapRuntime` 后，将 task 工具的这两个依赖补注进 `SubagentRunner` 或直接在 `RuntimeApp.runTurn` 闭包里构造 `task` 工具——细节在 PR-6 review 时与 RuntimeApp.ts 实现对齐。

### `aggregateUsageDuring` helper（可选，放在 `subagent-orchestration.ts` 末尾）

```typescript
import type { TokenUsage } from '../adapters/llm/types.js';

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
```

### 测试要求（PR-6）

**subagent-orchestration.test.ts 必覆盖 case：**
- end-to-end with mock LLM（参考 `AgentRunner` 现有的 e2e mock 测试）
- 父 + 子 usage 树形累加正确（父 `RunResult.usage` = 父自身 + 子返回的 `usage`）
- 子 `outcome='error'` 时，父 `RunResult.usage` 不被污染（子 usage 仍正确累加入 subagent_end 事件）
- `runSubagentTurn` 未命中 profile → 抛 Error

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

- [ ] `core/subagent/` 不 import `runtime/` 任何模块
- [ ] `task` 工具是唯一依赖 `core/subagent/` 的内置工具
- [ ] `SystemPromptBuilder` 只 import `AvailableSubagentEntry` 类型和 `renderAvailableSubagentsSection` 纯函数
- [ ] `SubagentRunner` 不调 `loadConfig()`
- [ ] 子 `promptMode` 始终为 `'minimal'`
- [ ] `cleanup`（`deleteSession`）在 `finally` 块里，无论 outcome 均执行
- [ ] `subagent_start` 在 `AgentRunner.run` 之前 emit，`subagent_end` 在之后
- [ ] `ToolResult.content` 只含子的 `text`，不含 `usage / runId / outcome`
