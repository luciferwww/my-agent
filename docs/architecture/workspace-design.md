# Workspace 模块设计文档

> 创建日期：2026-03-31  
> 参考：相关 workspace / bootstrap 分析

---

## 1. 概述

Workspace 模块负责管理 Agent 的工作区，是 Agent 运行的基础环境。

**当前职责**：
- 工作区初始化（首次运行时从模板创建上下文文件）
- 上下文文件加载（读取 Markdown 文件，转换为 `ContextFile[]`，供 Prompt Builder 使用）

**未来可能扩展的职责**：
- 工作区配置管理
- 工作区状态管理
- 文件监听/变更检测
- 缓存管理

> 注意：当前项目把工作区初始化、上下文文件读取和预算控制整合在一个独立的 `workspace/` 模块里，避免这些职责散落在运行时装配层。

### 上下文文件存放位置

上下文文件存放在工作区的 `.agent/` 隐藏目录下，不污染项目根目录：

```
<workspaceDir>/
└── .agent/
    ├── IDENTITY.md
    ├── SOUL.md
    ├── AGENTS.md
    └── TOOLS.md
```

> 我们选择 `.agent/` 隐藏子目录，是为了避免把 agent 上下文文件平铺到项目根目录。

---

## 2. 目录结构

### 源代码结构

```
src/
└── workspace/
    ├── index.ts          # 公共入口，导出 ensureWorkspace / loadContextFiles / ContextFile
    ├── types.ts          # ContextFile 类型定义（由 workspace 生产，prompt-builder 消费）
    ├── init.ts           # 工作区初始化（模板 seed）
    └── loader.ts         # 上下文文件加载
```

### 运行时工作区结构

```
<workspaceDir>/
└── .agent/
    ├── IDENTITY.md       # 身份定义（名字、角色、特征）
    ├── SOUL.md           # 人格/风格定义
    ├── AGENTS.md         # 行为指导（任务执行规范）
    └── TOOLS.md          # 工具使用说明（用户自定义补充）
```

---

## 3. 工作区初始化

### 3.1 说明

首次运行时，自动在工作目录的 `.agent/` 子目录下创建模板文件，给用户一个起点。文件已存在则跳过，不覆盖用户已编辑的内容。

### 3.2 当前设计取舍

`ensureWorkspace()` 当前只做最小初始化动作：

- 文件统一放在 `<workspaceDir>/.agent/`；
- 只初始化 `IDENTITY.md`、`SOUL.md`、`AGENTS.md`、`TOOLS.md` 四个核心文件；
- 模板内容直接内置在代码中；
- 使用 `flag: "wx"`，确保已有文件不被覆盖；
- 不做工作区状态追踪，也不自动初始化 Git 仓库。

### 3.3 流程

```
ensureWorkspace(workspaceDir)
  │
  ├─ <workspaceDir>/.agent/ 目录不存在 → mkdir -p 创建
  │
  ├─ .agent/IDENTITY.md 不存在 → 写入模板（flag: "wx"）
  ├─ .agent/SOUL.md 不存在 → 写入模板（flag: "wx"）
  ├─ .agent/AGENTS.md 不存在 → 写入模板（flag: "wx"）
  └─ .agent/TOOLS.md 不存在 → 写入模板（flag: "wx"）

后续运行：
  ├─ 文件已存在 → flag: "wx" 导致写入跳过，不覆盖
  └─ 用户编辑了文件 → 使用用户编辑后的版本
```

### 3.4 API

```typescript
// workspace/init.ts

/** 确保工作区 .agent/ 目录和模板文件存在。文件已存在则跳过，不覆盖。 */
export async function ensureWorkspace(workspaceDir: string): Promise<void>;
```

### 3.5 内置模板

模板内容直接内置在代码中（不需要外部 templates 目录）：

```typescript
const TEMPLATES: Record<string, string> = {
  'IDENTITY.md': `# Identity

- **Name:** _(your agent's name)_
- **Role:** _(what it does)_
- **Emoji:** _(signature emoji)_
`,
  'SOUL.md': `# Soul

Be genuinely helpful, not performatively helpful.
Have opinions. Be concise when needed, thorough when it matters.
`,
  'AGENTS.md': `# Agents

_(Define task execution rules and workflows here)_
`,
  'TOOLS.md': `# Tools - Local Notes

_(Add environment-specific tool usage notes here)_
`,
};
```

---

## 4. 上下文文件加载

### 4.1 说明

从工作目录的 `.agent/` 子目录读取预定义的 Markdown 文件，转换为 `ContextFile[]` 数组，供 `SystemPromptBuilder` 的 `contextFiles` 参数使用。

在 Prompt Builder 中，这些文件的内容被注入到 System Prompt 末尾的 `# Project Context` Section。

### 4.2 支持的文件

| 文件名 | 用途 |
|--------|------|
| `IDENTITY.md` | 身份定义（名字、角色、特征、emoji） |
| `SOUL.md` | 人格/风格（对话语气、行为偏好） |
| `AGENTS.md` | 行为指导（任务执行规范、工作流程） |
| `TOOLS.md` | 工具使用备忘（用户环境特定的工具用法说明，不控制工具可用性） |

当前只支持这 4 个核心文件，其它候选文件等有明确需求时再增加。

### 4.3 当前加载边界

`loadContextFiles()` 采用一条刻意保持简单的链路：

```
loadContextFiles()                  ← workspace/loader.ts（读磁盘 + 过滤 + 字符预算）
  → contextFiles 参数传入            ← SystemPromptBuilder.build()（注入 Prompt）
```

当前边界如下：

- 文件统一从 `<workspaceDir>/.agent/` 读取；
- 缺失文件直接跳过，不注入占位内容；
- 通过 `opts.mode` 控制 full / minimal；
- 支持单文件与总量字符预算；
- 不支持插件覆盖，不做内存缓存。

### 4.4 加载流程

```
loadContextFiles(workspaceDir, opts?)
  │
  ├─ 确定文件列表（从 <workspaceDir>/.agent/ 读取）
  │   mode='full':    [IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md]
  │   mode='minimal': [IDENTITY.md, SOUL.md]
  │
  ├─ 逐文件读取
  │   ├─ 文件不存在 → 跳过
  │   ├─ 文件为空（trim 后） → 跳过
  │   ├─ 剩余总预算 < 64 字符 → 停止读取后续文件 + warn
  │   ├─ 文件超出 maxFileChars → 截断（保留前 70% + 后 20%，插入截断标记）+ warn
  │   └─ 累计超出 maxTotalChars → 截断当前文件 + warn
  │
  └─ 返回 ContextFile[]
      │
      ▼
  SystemPromptBuilder.build({ contextFiles })
      │
      ▼
  注入到 System Prompt 末尾的 # Project Context Section
```

### 4.5 minimal 模式过滤

| 文件 | `full` | `minimal` |
|------|:------:|:---------:|
| IDENTITY.md | ✅ | ✅ |
| SOUL.md | ✅ | ✅ |
| AGENTS.md | ✅ | ❌ |
| TOOLS.md | ✅ | ❌ |

> 当前 minimal 模式只加载 `IDENTITY.md` 和 `SOUL.md`。`mode` 参数仍然保留扩展空间，未来新增文件（如 USER.md、MEMORY.md）时，可以继续细化不同模式下的加载集合。

### 4.6 API

```typescript
// workspace/loader.ts

/** 从工作目录的 .agent/ 子目录读取上下文文件，返回 ContextFile[] */
export async function loadContextFiles(
  workspaceDir: string,
  opts?: {
    mode?: 'full' | 'minimal';      // 默认 'full'
    maxFileChars?: number;           // 单文件最大字符数，默认 20000
    maxTotalChars?: number;          // 所有文件总最大字符数，默认 150000
    warn?: (message: string) => void;  // 警告回调，默认 console.warn
  },
): Promise<ContextFile[]>;
```

### 4.7 类型定义

`ContextFile` 定义在 `workspace/types.ts`（生产方拥有）：

```typescript
// workspace/types.ts
export interface ContextFile {
  path: string;      // 文件名，如 'SOUL.md'
  content: string;   // 文件内容
}
```

> prompt-builder 从 workspace 引用 ContextFile 类型（消费方依赖生产方）。

---

## 5. 使用示例

### 完整流程

```typescript
import { ensureWorkspace, loadContextFiles } from './workspace';
import { SystemPromptBuilder } from './prompt-builder';

// 1. 首次运行：确保 .agent/ 目录和模板文件存在
await ensureWorkspace('./my-project');

// 2. 加载上下文文件（从 ./my-project/.agent/ 读取）
const contextFiles = await loadContextFiles('./my-project');

// 3. 构建 System Prompt
const prompt = new SystemPromptBuilder().build({
  tools: [
    { name: 'memory_search', description: '搜索本地知识库' },
    { name: 'read_file', description: '读取文件内容' },
  ],
  outputLanguage: '中文',
  contextFiles,
});
// memory-instructions 自动显示（因为 tools 中有 memory_search）
```

### Sub Agent（minimal 模式）

```typescript
const minimalFiles = await loadContextFiles('./my-project', { mode: 'minimal' });
const prompt = new SystemPromptBuilder().build({
  mode: 'minimal',
  tools: [{ name: 'read_file', description: '读取文件内容' }],
  contextFiles: minimalFiles,
});
```

### 工作目录结构示例

```
my-project/                         ← workspaceDir
├── src/                            ← 项目代码（不受影响）
├── package.json
└── .agent/                         ← 上下文文件（隐藏目录）
    ├── IDENTITY.md
    │     # Identity
    │     - **Name:** Aria
    │     - **Role:** 个人助手
    │     - **Emoji:** ✨
    │
    ├── SOUL.md
    │     # Soul
    │     简洁、准确。避免废话，直接给出答案。
    │     匹配用户语气：随意对随意，技术对技术。
    │
    ├── AGENTS.md
    │     # Agents
    │     当用户要求写代码时，先理解需求再动手。
    │     复杂任务分步执行，每步确认后再继续。
    │
    └── TOOLS.md
          # Tools - Local Notes
          memory_search 工具适合查找历史对话和决策。
          read_file 工具读取前先确认文件路径。
```

---

## 6. 实施步骤

### Step 1 · workspace/init.ts
- [ ] `ensureWorkspace()` 实现
- [ ] 内置模板定义（TEMPLATES 常量）
- [ ] `writeFileIfMissing()`（flag: "wx"）

### Step 2 · workspace/loader.ts
- [ ] `loadContextFiles()` 实现
- [ ] mode 过滤逻辑（full / minimal 文件列表）
- [ ] 字符预算控制（maxFileChars / maxTotalChars）
- [ ] 截断策略（前 70% + 后 20% + 截断标记）
- [ ] 最小预算检查（< 64 字符跳过）
- [ ] warn 回调（默认 console.warn）

### Step 3 · workspace/index.ts
- [ ] 公共入口，导出 `ensureWorkspace` / `loadContextFiles`

---

## 7. 测试计划

### 7.1 workspace/init.ts 测试

| 测试用例 | 预期行为 |
|---------|---------|
| 目录不存在 | 创建 `.agent/` 目录 + 写入 4 个模板文件 |
| 目录已存在，文件不存在 | 只写入缺失的文件 |
| 文件已存在 | 不覆盖（flag: "wx" 跳过） |
| 部分文件存在 | 只创建缺失的，不影响已有文件 |

### 7.2 workspace/loader.ts 测试

**基本加载**：

| 测试用例 | 预期行为 |
|---------|---------|
| 全部 4 个文件存在 | 返回 4 个 ContextFile，顺序：IDENTITY → SOUL → AGENTS → TOOLS |
| 部分文件缺失 | 跳过缺失文件，不报错，返回存在的文件 |
| 全部文件缺失 | 返回空数组 |
| 文件内容为空（或只有空白） | 跳过该文件 |

**mode 过滤**：

| 测试用例 | 预期行为 |
|---------|---------|
| `mode: 'full'`（默认） | 加载全部 4 个文件 |
| `mode: 'minimal'` | 当前与 full 行为一致（4 个文件），预留未来扩展 |

**字符预算 — 单文件截断**：

| 测试用例 | 预期行为 |
|---------|---------|
| 文件 ≤ maxFileChars | 完整返回，不截断 |
| 文件 > maxFileChars | 截断为前 70% + 截断标记 + 后 20%，调用 warn |
| 截断标记内容 | 包含 `[...truncated, read <filename> for full content...]` |

**字符预算 — 总量控制**：

| 测试用例 | 预期行为 |
|---------|---------|
| 所有文件总量 ≤ maxTotalChars | 全部返回 |
| 前 N 个文件用完总预算 | 后续文件被跳过，调用 warn |
| 剩余预算 < 64 字符 | 跳过后续文件，调用 warn |

**warn 回调**：

| 测试用例 | 预期行为 |
|---------|---------|
| 不传 warn | 使用 console.warn |
| 传入自定义 warn | 截断/跳过时调用自定义 warn，不调用 console.warn |

---

## 8. 后续可优化方向

当需求变复杂时，可以逐步添加（参考 OpenClaw）：

| 能力 | 触发条件 | 参考 |
|------|---------|------|
| 缓存 | 变成长期运行的守护进程后，多 Session 频繁读取同样文件 | OpenClaw `bootstrap-cache.ts`（按 sessionKey 的 Map 缓存，约 30 行） |
| Hook 覆盖 | 引入插件系统后，插件需要替换文件内容 | OpenClaw `bootstrap-hooks.ts` |
| 额外文件支持 | 需要 USER.md / MEMORY.md 等 | OpenClaw `workspace.ts` 中的文件列表 |
| 自定义文件名 | 用户想用非固定文件名 | 配置化文件列表 |
| 工作区状态追踪 | 需要记录初始化时间、setup 完成状态等 | OpenClaw `.openclaw/workspace-state.json` |
