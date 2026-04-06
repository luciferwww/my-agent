# Prompt Builder 系统设计文档

> 创建日期：2026-03-31  
> 参考：OpenClaw prompt 构建系统（深度分析见 [openclaw-prompt-system-deep-dive.md](../analysis/openclaw/openclaw-prompt-system-deep-dive.md)）

---

## 1. 设计目标

**Prompt Builder 的职责边界**：只负责把参数组装成字符串。
- `SystemPromptBuilder` → 生成 system prompt 字符串
- `UserPromptBuilder` → 生成 user prompt 字符串

对话历史管理、Session 持久化、上下文窗口裁剪均**不属于** Prompt Builder 的职责，留给未来的 Agent 执行引擎处理（与 OpenClaw 的分层一致）。

相比 OpenClaw 的改进点：

| OpenClaw 的现状 | 我们的改进 |
|----------------|-----------|
| System Prompt 的 25 个 Section 硬编码，但混杂了大量多渠道网关专有逻辑 | 精简为 7 个 Section，只保留个人 Agent 真正需要的部分 |
| User Prompt 构建逻辑散落在多个文件中（attempt.ts / body.ts / inbound-text.ts），无统一抽象 | 统一的 `UserPromptBuilder` 类，清晰可复用 |

**关于 RAG**：采用 **Tool Use 模式**（与 OpenClaw 一致），由 LLM 自主决定何时调用 `search_memory` 等检索工具。不在 Prompt Builder 层做手动注入，RAG 工具定义放在未来的 Agent 执行引擎中。

**关于 Section 注册表**：采用与 OpenClaw 相同的**硬编码方式**。对个人项目而言，动态注册表的设计成本超过收益；直接硬编码 7 个 Section 更简单可靠，且与 Tool Use 理念一致（能力扩展靠工具，而不是靠堆 Section）。

**关于对话历史管理**：不属于 Prompt Builder 职责，从本模块移除。OpenClaw 中历史裁剪（`history.ts`）、上下文窗口计算（`context-window-guard.ts`）、Session 持久化（`config/sessions/`）都是独立于 Prompt Builder 的系统，我们也应遵循同样的分层。

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                     Prompt Builder                       │
├─────────────────────────┬────────────────────────────────┤
│   SystemPromptBuilder   │      UserPromptBuilder         │
│                         │                                │
│  硬编码 7 个 Section：   │  ┌──────────────────────────┐ │
│  1. agent-identity      │  │ ContextPrepender         │ │
│  2. agent-datetime      │  │  - context hook 注册      │ │
│  3. tool-definitions    │  │  - 按注册顺序执行          │ │
│  4. behavior-rules      │  │  - 前置文本收集           │ │
│  5. safety-constraints  │  └──────────────────────────┘ │
│  6. memory-instructions │                                │
│  7. project-context     │                                │
│                         │                                │
│  三种模式：             │                                │
│  full / minimal / none  │                                │
├─────────────────────────┴────────────────────────────────┤
│                   类型系统 (types/)                        │
│    PromptMode | SystemPromptBuildParams | ContextHook    │
│    ContextFile (共享) | MediaAttachment | BuiltUserPrompt │
├──────────────────────────────────────────────────────────┤
│                   工具层 (utils/)                          │
│                      tokenCounter                        │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 项目目录结构

```
src/
├── prompt-builder/
│   ├── index.ts                      # 公共入口，统一导出
│   │
│   ├── types/                        # prompt-builder 专用类型定义
│   │   ├── core.ts                   # PromptMode
│   │   ├── hook.ts                   # ContextHook, ContextHookMetadata
│   │   ├── media.ts                  # MediaAttachment, ImageAttachment, FileAttachment
│   │   ├── builder.ts                # SystemPromptBuildParams, ToolDefinition,
│   │   │                             # UserPromptInput, BuiltUserPrompt（re-export ContextFile from workspace）
│   │   └── index.ts                  # re-export all types
│   │
│   ├── system/
│   │   └── SystemPromptBuilder.ts    # 主类，硬编码 7 个 Section
│   │
│   ├── user/
│   │   ├── UserPromptBuilder.ts      # 主类
│   │   └── ContextPrepender.ts       # 前置上下文 + hook 机制
│   │
│   └── utils/
│       └── tokenCounter.ts           # token 估算（length / 3.5）
│
└── workspace/
    ├── index.ts                      # 公共入口
    ├── types.ts                      # ContextFile 类型定义（由 workspace 生产）
    ├── init.ts                       # 工作区初始化（模板 seed）
    └── loader.ts                     # 上下文文件加载
```

> `ContextFile` 类型定义在 `workspace/types.ts`（生产方拥有），prompt-builder 从 workspace 引用。
> `workspace/` 模块详见 [workspace-design.md](./workspace-design.md)。

---

## 4. 类型系统

### 4.1 核心类型

```typescript
// types/core.ts

/** Prompt 构建模式 */
export type PromptMode = 'full' | 'minimal' | 'none';
```

### 4.2 构建参数接口

```typescript
// types/builder.ts

// ContextFile 从 workspace 模块引用（生产方拥有）
export type { ContextFile } from '../../workspace/types.js';

export interface SystemPromptBuildParams {
  mode?: PromptMode;                   // 默认 'full'
  tools?: ToolDefinition[];            // 可用工具列表，不传或空数组则跳过工具相关 Section
  safetyLevel?: 'strict' | 'normal' | 'relaxed';  // 默认 'normal'，'relaxed' 跳过安全 Section
  contextFiles?: ContextFile[];        // 注入的上下文文件（IDENTITY.md、SOUL.md 等）
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface UserPromptInput {
  text: string;
  attachments?: MediaAttachment[];
  metadata?: Record<string, unknown>;
}

export interface BuiltUserPrompt {
  text: string;
  attachments: MediaAttachment[];
  _debug?: { rawInput: string; prependedChunks: string[] };
}
```

### 4.3 Hook 接口

```typescript
// types/hook.ts

export interface ContextHook {
  id: string;
  provider: (rawInput: string, metadata: ContextHookMetadata) => string | null | Promise<string | null>;
}

export interface ContextHookMetadata {
  rawInput: string;
  turnIndex: number;
  [key: string]: unknown;
}
```

---

## 5. System Prompt Builder

### 5.1 七个内置 Section

| # | ID | modes | 条件 | 用途 |
|---|----|-------|------|------|
| 1 | `agent-identity` | full, minimal | 总是 | 固定基础身份声明（与 OpenClaw 一致），具体名字/角色/人格通过 contextFiles 注入 |
| 2 | `agent-datetime` | full, minimal | 总是 | 当前日期时间 |
| 3 | `tool-definitions` | full, minimal | 有工具时 | 可用工具列表（含描述） |
| 4 | `behavior-rules` | full, minimal | 总是 | 行为准则，含工具使用规范（对应 OpenClaw 的 Tool Call Style） |
| 5 | `safety-constraints` | full, minimal | safetyLevel ≠ 'relaxed' | 安全约束 |
| 6 | `memory-instructions` | full | tools 中有 memory 相关工具时 | memory tool 使用说明 |
| 7 | `project-context` | full, minimal | 有 contextFiles 时 | 注入外部文件内容（SOUL.md、AGENTS.md 等） |

> Section 顺序即代码执行顺序，硬编码固定，不需要 priority 排序机制。

**说明**：
- `project-context` 放在最后，与 OpenClaw 一致——项目上下文在 system prompt 末尾注入。
- 身份（IDENTITY.md）、人格（SOUL.md）、行为指导（AGENTS.md）等均通过 `contextFiles` 注入（与 OpenClaw 一致）。
- 文件读取不在 Prompt Builder 里做，Builder 只接收 `{ path, content }` 数组。

### 5.2 三种 Prompt 模式

| Section | `full` | `minimal` | `none` |
|---------|:------:|:---------:|:------:|
| agent-identity | ✅ | ✅ | ❌ |
| agent-datetime | ✅ | ✅ | ❌ |
| tool-definitions | ✅ | ✅ | ❌ |
| behavior-rules | ✅ | ✅ | ❌ |
| safety-constraints | ✅ | ✅ | ❌ |
| memory-instructions | ✅ | ❌ | ❌ |
| project-context | ✅ | ✅ | ❌ |

> `none` 模式返回空字符串，预留用于特殊扩展场景。`minimal` 适合子 Agent。

### 5.3 构建流程

```
SystemPromptBuilder.build(params)
  │
  ├─ mode = params.mode ?? 'full'
  │
  ├─ mode === 'none'? ──→ return ''
  │
  ├─ isMinimal = (mode === 'minimal')
  │
  ├─ [1] agent-identity        ← 总是输出，固定身份声明
  │
  ├─ [2] agent-datetime        ← 总是输出，当前日期时间
  │
  ├─ [3] tool-definitions      ← tools 为空? → 跳过
  │                                否则列出工具名 + 描述
  │
  ├─ [4] behavior-rules        ← 总是输出，行为准则 + 工具使用规范
  │
  ├─ [5] safety-constraints    ← safetyLevel === 'relaxed'? → 跳过
  │                                'strict': 严格约束
  │                                'normal': 普通约束
  │
  ├─ [6] memory-instructions   ← isMinimal? → 跳过
  │                                tools 中无 memory 工具? → 跳过
  │                                否则输出 memory tool 使用说明
  │
  ├─ [7] project-context       ← contextFiles 为空? → 跳过
  │                                检测 SOUL.md → 加特殊说明
  │                                逐个注入文件内容
  │
  └─ lines.join('\n') ──→ return 最终 prompt 字符串
```

### 5.4 实现方式

与 OpenClaw 相同，`lines[]` 数组拼接，最后 `join('\n')`：

```typescript
class SystemPromptBuilder {
  build(params: SystemPromptBuildParams = {}): string {
    const mode = params.mode ?? 'full';
    if (mode === 'none') return '';
    const isMinimal = mode === 'minimal';
    const lines: string[] = [];

    this.buildIdentitySection(lines, params);
    this.buildDatetimeSection(lines);
    this.buildToolDefinitionsSection(lines, params);
    this.buildBehaviorRulesSection(lines, params);
    this.buildSafetySection(lines, params);
    if (!isMinimal) this.buildMemorySection(lines, params);  // 自动检查 tools 中是否有 memory 工具
    this.buildProjectContextSection(lines, params);  // 末尾注入文件内容

    return lines.join('\n');
  }
}
```

`project-context` Section 的实现（参考 OpenClaw）：

```typescript
private buildProjectContextSection(lines: string[], params: SystemPromptBuildParams): void {
  const files = params.contextFiles?.filter(f => f.path.trim() && f.content.trim());
  if (!files?.length) return;

  lines.push('# Project Context', '');

  // 检测 SOUL.md，加特殊说明（与 OpenClaw 一致）
  const hasSoulFile = files.some(f =>
    f.path.split('/').pop()?.toLowerCase() === 'soul.md'
  );
  if (hasSoulFile) {
    lines.push(
      'If SOUL.md is present, embody its persona and tone. ' +
      'Avoid stiff, generic replies; follow its guidance.'
    );
    lines.push('');
  }

  for (const file of files) {
    lines.push(`## ${file.path}`, '', file.content, '');
  }
}
```

---

## 6. User Prompt Builder

### 6.1 与 OpenClaw 的对比

OpenClaw 的 User Prompt 构建没有独立类，逻辑散落在执行引擎的多个文件中（`attempt.ts`、`body.ts`、`agent-command.ts`）。我们将其统一为 `UserPromptBuilder` 类。

| 能力 | OpenClaw | 我们 |
|------|---------|------|
| 统一抽象 | ❌ 无独立类，散落在 attempt.ts / body.ts / agent-command.ts | ✅ `UserPromptBuilder` 类 |
| 前置上下文 | `prependContext`（插件 hook 返回） | `ContextPrepender`（hook 注册，相同机制） |
| 内部事件注入 | `prependInternalEventContext()` — sub agent 完成通知 | ❌ 暂不需要（可通过 ContextHook 实现） |
| 中止提示 | `applySessionHints()` — 上次运行被中止时提醒 | ❌ 暂不需要（可通过 ContextHook 实现） |
| Bootstrap 警告 | `prependBootstrapPromptWarning()` | ❌ 暂不需要（可通过 ContextHook 实现） |
| 图像处理 | `detectAndLoadPromptImages()` — 从文本自动检测图像路径并加载（执行引擎层，非 Prompt Builder） | `attachments` 参数直接传入 |
| 媒体分离 | ✅ `{ images }` 单独传入 LLM API | ✅ `attachments` 单独返回 |

**关键设计决策**：OpenClaw 有 4 种前置内容（内部事件、中止提示、bootstrap 警告、插件 hook），各自硬编码。我们用一个 `ContextHook` 机制统一处理——如果将来需要中止提示或事件通知，注册一个 hook 即可，不需要修改 Builder 核心代码。

### 6.2 拼接顺序

参考 OpenClaw 的 prepend 模式，原始消息永远在最后：

```
前置上下文 chunk 1（按注册顺序，先注册的在前）
前置上下文 chunk 2
...
用户原始消息（永远在最后）
```

OpenClaw 的拼接顺序：
```
内部事件（prependInternalEventContext）
中止提示（applySessionHints）
Bootstrap 警告（prependBootstrapPromptWarning）
Hook 上下文（hookResult.prependContext）
用户原始消息
```

我们的设计：
```
ContextHook chunks（按注册顺序）
用户原始消息
```

### 6.3 核心类

**ContextPrepender**

管理 context hook 的注册和执行：

```typescript
class ContextPrepender {
  private hooks: ContextHook[] = [];
  private turnIndex = 0;

  /** 注册 hook */
  register(hook: ContextHook): this;

  /** 注销 hook */
  unregister(id: string): this;

  /**
   * 执行所有 hooks，按注册顺序，收集非 null 结果。
   * 每次调用 turnIndex 自增。
   */
  async prepend(rawInput: string, metadata?: Record<string, unknown>): Promise<string[]>;
}
```

**UserPromptBuilder**

```typescript
class UserPromptBuilder {
  private prepender = new ContextPrepender();

  /** 注册 context hook（链式） */
  useContextHook(hook: ContextHook): this;

  /** 注销 context hook（链式） */
  removeContextHook(id: string): this;

  /** 构建 User Prompt */
  async build(input: UserPromptInput): Promise<BuiltUserPrompt>;
}
```

`build()` 内部流程：

```
build(input)
  │
  ├─ 执行 ContextPrepender.prepend(input.text, input.metadata)
  │   └─ 按注册顺序 → 逐个调用 hook.provider → 收集非 null 结果
  │
  ├─ 拼接：[...chunks, input.text].join('\n\n')
  │
  └─ 返回 { text, attachments, _debug }
      └─ attachments 从 input 直传，不嵌入文本
```

### 6.4 类型定义

```typescript
export interface UserPromptInput {
  text: string;                        // 用户原始文本输入
  attachments?: MediaAttachment[];     // 媒体附件，单独返回供 LLM API 处理
  metadata?: Record<string, unknown>;  // 传给 context hook 的额外数据
}

export interface BuiltUserPrompt {
  text: string;                    // 最终拼接文本（chunks + 原始输入）
  attachments: MediaAttachment[];  // 分离的媒体附件
  _debug?: {
    rawInput: string;
    prependedChunks: string[];
  };
}

export interface ContextHook {
  id: string;
  provider: (rawInput: string, metadata: ContextHookMetadata) => string | null | Promise<string | null>;
}

export interface ContextHookMetadata {
  rawInput: string;
  turnIndex: number;
  [key: string]: unknown;
}
```

### 6.5 使用示例

**基本用法**：

```typescript
const userBuilder = new UserPromptBuilder();
const prompt = await userBuilder.build({ text: '你好' });
// prompt.text: '你好'
```

**带 Context Hook（自动记忆召回）**：

```typescript
const userBuilder = new UserPromptBuilder()
  .useContextHook({
    id: 'memory-recall',
    provider: async (rawInput) => {
      const memories = await searchMemory(rawInput);
      if (!memories.length) return null;
      return `<relevant_memories>\n${memories.join('\n')}\n</relevant_memories>`;
    },
  });

const prompt = await userBuilder.build({
  text: '上次我们讨论的项目进度怎么样了？',
});
// prompt.text:
// <relevant_memories>
// ...
// </relevant_memories>
//
// 上次我们讨论的项目进度怎么样了？
```

**带媒体附件**：

```typescript
const prompt = await userBuilder.build({
  text: '帮我分析这张截图',
  attachments: [{ type: 'image', data: 'base64...', mimeType: 'image/png' }],
});
// prompt.text: '帮我分析这张截图'
// prompt.attachments: [{ type: 'image', ... }]  ← 单独传入 LLM API
```

**模拟 OpenClaw 的中止提示（通过 Hook）**：

```typescript
userBuilder.useContextHook({
  id: 'abort-warning',
  provider: () => {
    if (!wasLastRunAborted()) return null;
    clearAbortFlag();
    return 'Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification.';
  },
});
```

---

## 7. 整体使用流程

展示 Workspace 模块和 Prompt Builder 如何配合，从初始化到发送给 LLM 的完整链路：

```
┌─────────────────────────────────────────────────────────────────┐
│                        调用方（执行引擎）                         │
│                                                                 │
│  1. 初始化工作区                                                 │
│     ensureWorkspace(workspaceDir)                               │
│     └─ 创建 .agent/ 目录 + 模板文件（首次运行）                   │
│                                                                 │
│  2. 加载上下文文件                                               │
│     contextFiles = loadContextFiles(workspaceDir)               │
│     └─ 从 .agent/ 读取 IDENTITY.md / SOUL.md / AGENTS.md / ... │
│                                                                 │
│  3. 构建 System Prompt                                          │
│     systemPrompt = SystemPromptBuilder.build({                  │
│       tools, safetyLevel, contextFiles                          │
│     })                                                          │
│     └─ 7 个 Section 硬编码拼接 → 字符串                          │
│                                                                 │
│  4. 构建 User Prompt                                            │
│     userPrompt = UserPromptBuilder.build({                      │
│       text: '用户消息', attachments                              │
│     })                                                          │
│     └─ hooks → 原始消息 → { text, attachments }                 │
│                                                                 │
│  5. 发送给 LLM API                                              │
│     callLLM({                                                   │
│       system: systemPrompt,                                     │
│       messages: [...history, { role: 'user', content: text }],  │
│       images: attachments                                       │
│     })                                                          │
└─────────────────────────────────────────────────────────────────┘
```

> Workspace 模块负责步骤 1-2（文件 I/O），Prompt Builder 负责步骤 3-4（字符串拼接），步骤 5 由调用方（未来的执行引擎）负责。三者职责分离，互不依赖。

---

## 8. 核心 API 示例

### 场景 1：构建 System Prompt

```typescript
import { SystemPromptBuilder } from './prompt-builder';

const prompt = new SystemPromptBuilder().build({
  tools: [
    { name: 'search_web', description: '搜索互联网获取最新信息' },
    { name: 'search_memory', description: '搜索本地知识库和历史记忆' },
    { name: 'read_file', description: '读取本地文件内容' },
  ],
  contextFiles: [
    { path: 'IDENTITY.md', content: '- **Name:** Aria\n- **Role:** 个人助手' },
    { path: 'SOUL.md', content: '简洁、准确。避免废话，直接给出答案。匹配用户语气。' },
  ],
});
// memory-instructions 自动显示（因为 tools 中有 search_memory）
```

### 场景 2：minimal 模式（子 Agent）

```typescript
const prompt = new SystemPromptBuilder().build({
  mode: 'minimal',
  tools: [
    { name: 'read_file', description: '读取文件内容' },
    { name: 'write_file', description: '写入文件内容' },
  ],
  contextFiles: [
    { path: 'IDENTITY.md', content: '- **Name:** SubAgent\n- **Role:** 文件处理助手' },
  ],
});
// 包含：identity + datetime + tool-definitions + behavior-rules
//       + safety-constraints + project-context
// 跳过：memory-instructions
```

### 场景 3：User Prompt + Context Hook（自动记忆召回）

```typescript
import { UserPromptBuilder } from './prompt-builder';

const userBuilder = new UserPromptBuilder()
  .useContextHook({
    id: 'memory-recall',
    provider: async (rawInput) => {
      const memories = await searchMemory(rawInput);
      if (!memories.length) return null;
      return `<relevant_memories>\n${memories.join('\n')}\n</relevant_memories>`;
    },
  });

const prompt = await userBuilder.build({
  text: '上次我们讨论的项目进度怎么样了？',
});

// prompt.text:
// <relevant_memories>
// ...相关记忆...
// </relevant_memories>
//
// 上次我们讨论的项目进度怎么样了？
```

---

## 9. 实施步骤

### Step 1 · 地基
- [ ] package.json、tsconfig.json
- [ ] `src/types/context-file.ts`（共享 ContextFile 类型）

### Step 2 · prompt-builder/types/
- [ ] `core.ts` — PromptMode
- [ ] `hook.ts` — ContextHook, ContextHookMetadata
- [ ] `media.ts` — MediaAttachment, ImageAttachment, FileAttachment
- [ ] `builder.ts` — SystemPromptBuildParams, ToolDefinition, UserPromptInput, BuiltUserPrompt（re-export ContextFile）
- [ ] `index.ts` — re-export all types

### Step 3 · prompt-builder/utils/
- [ ] `tokenCounter.ts` — `estimateTokens()`（`Math.ceil(text.length / 3.5)`）

### Step 4 · SystemPromptBuilder
- [ ] `SystemPromptBuilder.ts` — `build()` 方法
- [ ] `buildIdentitySection()` — 固定身份声明
- [ ] `buildDatetimeSection()` — 当前日期时间
- [ ] `buildToolDefinitionsSection()` — 工具列表（含描述）
- [ ] `buildBehaviorRulesSection()` — 行为准则 + 工具使用规范
- [ ] `buildSafetySection()` — 安全约束（safetyLevel 控制）
- [ ] `buildMemorySection()` — memory tool 使用说明（自动检查 tools）
- [ ] `buildProjectContextSection()` — contextFiles 注入（检测 SOUL.md 加特殊说明）

### Step 5 · UserPromptBuilder
- [ ] `ContextPrepender.ts` — hook 注册 / 注销 / 按注册顺序执行
- [ ] `UserPromptBuilder.ts` — `build()` 方法（chunks + 原始消息 + attachments 分离）

### Step 6 · 完善
- [ ] `prompt-builder/index.ts` — 公共入口

> Workspace 模块的实施步骤见 [workspace-design.md](./workspace-design.md)。

---

## 10. 测试计划

### 9.1 SystemPromptBuilder 测试

**模式控制**：

| 测试用例 | 预期行为 |
|---------|---------|
| 默认参数（无参数） | 返回包含 identity + datetime + behavior-rules + safety 的完整 prompt |
| `mode: 'full'` | 与默认相同 |
| `mode: 'minimal'` | 跳过 memory-instructions，其余 Section 保留 |
| `mode: 'none'` | 返回空字符串 |

**各 Section**：

| 测试用例 | 预期行为 |
|---------|---------|
| agent-identity | 包含固定身份声明 |
| agent-datetime | 包含当前日期时间 |
| tool-definitions — 有 tools | 列出工具名和描述 |
| tool-definitions — 无 tools | 跳过此 Section |
| behavior-rules | 包含行为准则和工具使用规范 |
| safety-constraints — `'strict'` | 包含严格安全约束 |
| safety-constraints — `'normal'`（默认） | 包含普通安全约束 |
| safety-constraints — `'relaxed'` | 跳过此 Section |
| memory-instructions — tools 中有 `search_memory` | 显示 memory 使用说明 |
| memory-instructions — tools 中无 memory 工具 | 跳过此 Section |
| project-context — 有 contextFiles | 注入文件内容，包含 `# Project Context` 标题 |
| project-context — 无 contextFiles | 跳过此 Section |
| project-context — 包含 SOUL.md | 额外添加 persona 说明 |

### 9.2 ContextPrepender 测试

| 测试用例 | 预期行为 |
|---------|---------|
| 无 hook | 返回空数组 |
| 单个 hook 返回文本 | 返回包含该文本的数组 |
| 单个 hook 返回 null | 返回空数组（跳过 null） |
| 多个 hook | 按注册顺序收集结果 |
| 注销 hook | 注销后不再执行 |
| turnIndex | 每次 prepend 调用后自增 |
| async hook | 正确等待异步 provider |

### 9.3 UserPromptBuilder 测试

| 测试用例 | 预期行为 |
|---------|---------|
| 纯文本，无 hook | `text` 等于原始输入 |
| 有 hook + 文本 | `text` = chunks + `\n\n` + 原始输入 |
| 有 attachments | `attachments` 直传，不嵌入 `text` |
| 无 attachments | `attachments` 为空数组 |
| `_debug` 字段 | 包含 rawInput 和 prependedChunks |
| 链式 API | `useContextHook()` / `removeContextHook()` 返回 this |

---

## 11. 设计决策说明

| 决策 | 原因 |
|------|------|
| 硬编码 Section，不用注册表 | 个人项目需求固定，注册表的设计成本超过收益；与 Tool Use 理念一致（能力扩展靠工具） |
| 7 个 Section，不学 OpenClaw 的 25 个 | OpenClaw 25 个里有 9 个是多渠道网关专有，个人 Agent 完全不需要 |
| 身份/人格通过 contextFiles 注入 | 与 OpenClaw 一致（IDENTITY.md 定义名字角色，SOUL.md 定义人格风格），不需要独立参数 |
| tool-usage-rules 合并进 behavior-rules | 工具规范本就是行为准则的一部分，与 OpenClaw 的 Tool Call Style 思路一致 |
| project-context 放在 prompt 末尾 | 与 OpenClaw 一致，项目上下文在最后注入；LLM 倾向于遵从更接近末尾的具体描述 |
| 保留 none 模式 | 预留以备未来扩展；实现成本极低（一行 return ''） |
| RAG 用 Tool Use 而非文本注入 | LLM 自主判断何时检索，实现更简单，不需要在 Prompt Builder 层处理 |
| memory-instructions 有 memory 工具才显示 | 自动检查 tools 中是否有 search_memory 等工具，无需额外的 memoryEnabled 参数（与 OpenClaw 一致） |
| 参数精简为 4 个 | 去掉了 disableTools（不传 tools 即可）、customRules / disableDefaultRules（通过 AGENTS.md 实现）、memoryEnabled（自动检查 tools）、outputLanguage / outputFormat（通过 SOUL.md 实现）、[key: string]（硬编码方式不需要透传） |
| 不在 Prompt Builder 里做对话历史管理 | 职责分离，与 OpenClaw 分层一致；历史管理属于 Agent 执行引擎的职责 |
| attachments 不嵌入文本，单独返回 | 图像需单独传入 LLM API（与 OpenClaw 一致） |
| UserPrompt 拼接：hooks → 原始输入 | 原始输入永远在最后，最接近用户意图（参考 OpenClaw prepend 模式） |
| 文件读取不在 Builder 里做 | Builder 只接收 { path, content } 数组，文件 I/O 是上层的职责（与 OpenClaw 分层一致） |
