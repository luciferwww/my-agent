# Prompt Builder 系统设计文档

> 创建日期：2026-03-31  
> 参考：OpenClaw prompt 构建系统（深度分析见 openclaw-prompt-system-deep-dive.md）

---

## 1. 设计目标

**Prompt Builder 的职责边界**：只负责把参数组装成字符串。
- `SystemPromptBuilder` → 生成 system prompt 字符串
- `UserPromptBuilder` → 生成 user prompt 字符串

对话历史管理、Session 持久化、上下文窗口裁剪均**不属于** Prompt Builder 的职责，留给未来的 Agent 执行引擎处理（与 OpenClaw 的分层一致）。

相比 OpenClaw 的改进点：

| OpenClaw 的现状 | 我们的改进 |
|----------------|-----------|
| System Prompt 的 25 个 Section 硬编码，但混杂了大量多渠道网关专有逻辑 | 精简为 8 个 Section，只保留个人 Agent 真正需要的部分 |
| User Prompt 构建逻辑散落在多个文件中（attempt.ts / body.ts / inbound-text.ts），无统一抽象 | 统一的 `UserPromptBuilder` 类，清晰可复用 |

**关于 RAG**：采用 **Tool Use 模式**（与 OpenClaw 一致），由 LLM 自主决定何时调用 `search_memory` 等检索工具。不在 Prompt Builder 层做手动注入，RAG 工具定义放在未来的 Agent 执行引擎中。

**关于 Section 注册表**：采用与 OpenClaw 相同的**硬编码方式**。对个人项目而言，动态注册表的设计成本超过收益；直接硬编码 8 个 Section 更简单可靠，且与 Tool Use 理念一致（能力扩展靠工具，而不是靠堆 Section）。

**关于对话历史管理**：不属于 Prompt Builder 职责，从本模块移除。OpenClaw 中历史裁剪（`history.ts`）、上下文窗口计算（`context-window-guard.ts`）、Session 持久化（`config/sessions/`）都是独立于 Prompt Builder 的系统，我们也应遵循同样的分层。

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                     Prompt Builder                       │
├─────────────────────────┬────────────────────────────────┤
│   SystemPromptBuilder   │      UserPromptBuilder         │
│                         │                                │
│  硬编码 8 个 Section：   │  ┌──────────────────────────┐ │
│  1. agent-identity      │  │ ContextPrepender         │ │
│  2. agent-datetime      │  │  - context hook 注册      │ │
│  3. tool-definitions    │  │  - priority 排序          │ │
│  4. behavior-rules      │  │  - 前置文本收集           │ │
│  5. safety-constraints  │  └──────────────────────────┘ │
│  6. memory-instructions │                                │
│  7. output-format       │                                │
│  8. project-context     │                                │
│                         │                                │
│  三种模式：             │                                │
│  full / minimal / none  │                                │
├─────────────────────────┴────────────────────────────────┤
│                   类型系统 (types/)                        │
│    PromptMode | SystemPromptBuildParams | ContextHook    │
│    MediaAttachment | UserPromptInput | BuiltUserPrompt   │
├──────────────────────────────────────────────────────────┤
│                   工具层 (utils/)                          │
│                      tokenCounter                        │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 项目目录结构

```
src/
├── types/
│   ├── context-file.ts               # ContextFile（workspace 和 prompt-builder 共享）
│   └── index.ts                      # re-export
│
├── prompt-builder/
│   ├── index.ts                      # 公共入口，统一导出
│   │
│   ├── types/                        # prompt-builder 专用类型定义
│   │   ├── core.ts                   # PromptMode
│   │   ├── hook.ts                   # ContextHook, ContextHookMetadata
│   │   ├── media.ts                  # MediaAttachment, ImageAttachment, FileAttachment
│   │   ├── builder.ts                # SystemPromptBuildParams, ToolDefinition,
│   │   │                             # UserPromptInput, BuiltUserPrompt（re-export ContextFile）
│   │   └── index.ts                  # re-export all types
│   │
│   ├── system/
│   │   └── SystemPromptBuilder.ts    # 主类，硬编码 8 个 Section
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
    ├── init.ts                       # 工作区初始化（模板 seed）
    └── loader.ts                     # 上下文文件加载
```

> `ContextFile` 类型定义在 `src/types/context-file.ts`，被 workspace 和 prompt-builder 共享引用，避免模块间反向依赖。
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

/** 注入到 project-context Section 的文件 */
export interface ContextFile {
  path: string;      // 文件路径/名称（如 'SOUL.md'），用作 Section 标题
  content: string;   // 文件内容
}

export interface SystemPromptBuildParams {
  mode?: PromptMode;                   // 默认 'full'
  tools?: ToolDefinition[];            // 可用工具列表，不传或空数组则跳过工具相关 Section
  safetyLevel?: 'strict' | 'normal' | 'relaxed';  // 默认 'normal'，'relaxed' 跳过安全 Section
  outputLanguage?: string;             // 输出语言，如 '中文'、'English'
  outputFormat?: 'plain' | 'markdown'; // 默认 'markdown'
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
  priority?: number;   // 数值越小越靠近消息开头，默认 50
}

export interface ContextHookMetadata {
  rawInput: string;
  turnIndex: number;
  [key: string]: unknown;
}
```

---

## 5. System Prompt Builder

### 5.1 八个内置 Section

| # | ID | Priority | modes | 条件 | 用途 |
|---|----|----------|-------|------|------|
| 1 | `agent-identity` | 100 | full, minimal | 总是 | 固定基础身份声明（与 OpenClaw 一致），具体名字/角色/人格通过 contextFiles 注入 |
| 2 | `agent-datetime` | 150 | full, minimal | 总是 | 当前日期时间 |
| 3 | `tool-definitions` | 200 | full, minimal | 有工具时 | 可用工具列表（含描述） |
| 4 | `behavior-rules` | 300 | full, minimal | 总是 | 行为准则，含工具使用规范（对应 OpenClaw 的 Tool Call Style） |
| 5 | `safety-constraints` | 350 | full, minimal | safetyLevel ≠ 'relaxed' | 安全约束 |
| 6 | `memory-instructions` | 400 | full | tools 中有 memory 相关工具时 | memory tool 使用说明 |
| 7 | `output-format` | 500 | full, minimal | 总是 | 输出语言和格式 |
| 8 | `project-context` | 900 | full, minimal | 有 contextFiles 时 | 注入外部文件内容（SOUL.md、AGENTS.md 等） |

**说明**：
- `project-context` 放在最后（priority 900），与 OpenClaw 一致——项目上下文在 system prompt 末尾注入。
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
| output-format | ✅ | ✅ | ❌ |
| project-context | ✅ | ✅ | ❌ |

> `none` 模式返回空字符串，预留用于特殊扩展场景。`minimal` 适合子 Agent。

### 5.3 实现方式

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
    this.buildOutputFormatSection(lines, params);
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

### 6.1 拼接顺序（参考 OpenClaw prepend 模式）

```
前置上下文 chunk 1（priority 最小，最靠前）
前置上下文 chunk 2
...
用户原始消息（永远在最后）
```

### 6.2 核心类

**ContextPrepender**：管理 context hook 的注册和执行，按 priority 收集前置文本块，拼接到用户消息之前。

---

## 7. 核心 API 示例

### 场景 1：构建 System Prompt

```typescript
import { SystemPromptBuilder } from './prompt-builder';

const prompt = new SystemPromptBuilder().build({
  tools: [
    { name: 'search_web', description: '搜索互联网获取最新信息' },
    { name: 'search_memory', description: '搜索本地知识库和历史记忆' },
    { name: 'read_file', description: '读取本地文件内容' },
  ],
  outputLanguage: '中文',
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
//       + safety-constraints + output-format + project-context
// 跳过：memory-instructions
```

### 场景 3：User Prompt + Context Hook（自动记忆召回）

```typescript
import { UserPromptBuilder } from './prompt-builder';

const userBuilder = new UserPromptBuilder()
  .useContextHook({
    id: 'memory-recall',
    priority: 10,
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

## 8. 实现步骤

### Phase 1 · 地基
- [ ] package.json、tsconfig.json
- [ ] types/ 全部类型文件（core.ts / hook.ts / media.ts / builder.ts / index.ts）
- [ ] utils/tokenCounter.ts

### Phase 2 · System Prompt Builder
- [ ] SystemPromptBuilder.ts（硬编码 8 个 Section）

### Phase 3 · User Prompt Builder
- [ ] ContextPrepender.ts
- [ ] UserPromptBuilder.ts

### Phase 4 · 完善
- [ ] 公共入口 index.ts

> Workspace 模块的实施步骤见 [workspace-design.md](./workspace-design.md)。

---

## 9. 设计决策说明

| 决策 | 原因 |
|------|------|
| 硬编码 Section，不用注册表 | 个人项目需求固定，注册表的设计成本超过收益；与 Tool Use 理念一致（能力扩展靠工具） |
| 8 个 Section，不学 OpenClaw 的 25 个 | OpenClaw 25 个里有 9 个是多渠道网关专有，个人 Agent 完全不需要 |
| 身份/人格通过 contextFiles 注入 | 与 OpenClaw 一致（IDENTITY.md 定义名字角色，SOUL.md 定义人格风格），不需要独立参数 |
| tool-usage-rules 合并进 behavior-rules | 工具规范本就是行为准则的一部分，与 OpenClaw 的 Tool Call Style 思路一致 |
| project-context 放在 prompt 末尾 | 与 OpenClaw 一致，项目上下文在最后注入；LLM 倾向于遵从更接近末尾的具体描述 |
| 保留 none 模式 | 预留以备未来扩展；实现成本极低（一行 return ''） |
| RAG 用 Tool Use 而非文本注入 | LLM 自主判断何时检索，实现更简单，不需要在 Prompt Builder 层处理 |
| memory-instructions 有 memory 工具才显示 | 自动检查 tools 中是否有 search_memory 等工具，无需额外的 memoryEnabled 参数（与 OpenClaw 一致） |
| 参数精简为 6 个 | 去掉了 disableTools（不传 tools 即可）、customRules / disableDefaultRules（通过 AGENTS.md 实现）、memoryEnabled（自动检查 tools）、[key: string]（硬编码方式不需要透传） |
| 不在 Prompt Builder 里做对话历史管理 | 职责分离，与 OpenClaw 分层一致；历史管理属于 Agent 执行引擎的职责 |
| attachments 不嵌入文本，单独返回 | 图像需单独传入 LLM API（与 OpenClaw 一致） |
| UserPrompt 拼接：hooks → 原始输入 | 原始输入永远在最后，最接近用户意图（参考 OpenClaw prepend 模式） |
| 文件读取不在 Builder 里做 | Builder 只接收 { path, content } 数组，文件 I/O 是上层的职责（与 OpenClaw 分层一致） |
