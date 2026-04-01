# OpenClaw Context Files 加载与 Prompt 构建流程

> 参考代码位置，供设计参照

---

## 1. 完整流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                          执行引擎 (attempt.ts)                       │
│                                                                     │
│  触发：用户发送消息 / sub agent spawn / cron 任务                      │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 1: 读取磁盘文件                                                │
│  workspace.ts → loadWorkspaceBootstrapFiles(workspaceDir)           │
│                                                                     │
│  workspace/                                                         │
│  ├── AGENTS.md     ──→  { name: "AGENTS.md",   content: "..." }    │
│  ├── SOUL.md       ──→  { name: "SOUL.md",     content: "..." }    │
│  ├── TOOLS.md      ──→  { name: "TOOLS.md",    content: "..." }    │
│  ├── IDENTITY.md   ──→  { name: "IDENTITY.md", content: "..." }    │
│  ├── USER.md       ──→  { name: "USER.md",     content: "..." }    │
│  ├── HEARTBEAT.md  ──→  { name: "HEARTBEAT.md",content: "..." }    │
│  ├── BOOTSTRAP.md  ──→  { name: "BOOTSTRAP.md",content: "..." }    │
│  └── MEMORY.md     ──→  { name: "MEMORY.md",   content: "..." }    │
│                                                                     │
│  规则：文件不存在 → missing: true（仍保留在列表中）                     │
│  返回：WorkspaceBootstrapFile[]                                      │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 2: Session 过滤                                                │
│  workspace.ts → filterBootstrapFilesForSession(files, sessionKey)    │
│                                                                     │
│  if (主 Agent session)                                               │
│    → 保留全部 9 个文件                                                │
│                                                                     │
│  if (sub agent 或 cron session)                                      │
│    → 只保留 MINIMAL_BOOTSTRAP_ALLOWLIST 中的 5 个：                    │
│      AGENTS.md, TOOLS.md, SOUL.md, IDENTITY.md, USER.md             │
│    → 过滤掉：HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md                   │
│                                                                     │
│  返回：过滤后的 WorkspaceBootstrapFile[]                               │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 3: Hook 覆盖（可选）                                           │
│  bootstrap-hooks.ts → applyBootstrapHookOverrides(files)             │
│                                                                     │
│  插件可以：                                                          │
│  - 替换文件内容                                                       │
│  - 修改文件路径                                                       │
│  - 添加新文件                                                        │
│                                                                     │
│  返回：覆盖后的 WorkspaceBootstrapFile[]                               │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 4: 转换为 EmbeddedContextFile + 字符预算控制                     │
│  bootstrap.ts → buildBootstrapContextFiles(files, opts)              │
│                                                                     │
│  WorkspaceBootstrapFile[]  →  EmbeddedContextFile[]                  │
│  { name, path, content, missing }  →  { path, content }             │
│                                                                     │
│  预算控制：                                                          │
│  - maxChars: 单文件最大字符数（默认 ~50K）                              │
│  - totalMaxChars: 所有文件总最大字符数（默认 ~200K）                     │
│  - 超出预算 → 截断内容，打印警告                                       │
│  - 文件 missing → 注入 "[MISSING] Expected at: /path/to/file"        │
│                                                                     │
│  返回：EmbeddedContextFile[] = { path: string; content: string }[]   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 5: 传入 Prompt Builder                                        │
│  system-prompt.ts → buildAgentSystemPrompt({ contextFiles, ... })    │
│                                                                     │
│  Prompt Builder 接收 contextFiles 参数（只是一个数组，不关心来源）       │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Step 6: 注入到 System Prompt                                        │
│  system-prompt.ts（第 604-626 行）                                    │
│                                                                     │
│  生成的 prompt 结构：                                                 │
│                                                                     │
│  ┌───────────────────────────────────────────────────┐              │
│  │ You are a personal assistant...      ← 身份       │              │
│  │ ## Tooling                           ← 工具列表    │              │
│  │ ## Tool Call Style                   ← 工具规范    │              │
│  │ ## Safety                            ← 安全        │              │
│  │ ## Skills                            ← 技能        │              │
│  │ ... 其他 Section ...                               │              │
│  │                                                    │              │
│  │ # Project Context                   ← 在这里注入   │              │
│  │                                                    │              │
│  │ The following project context files have been      │              │
│  │ loaded:                                            │              │
│  │ If SOUL.md is present, embody its persona...       │  ← 特殊说明  │
│  │                                                    │              │
│  │ ## AGENTS.md                                       │              │
│  │ （AGENTS.md 文件内容）                               │              │
│  │                                                    │              │
│  │ ## SOUL.md                                         │              │
│  │ （SOUL.md 文件内容）                                 │              │
│  │                                                    │              │
│  │ ## TOOLS.md                                        │              │
│  │ （TOOLS.md 文件内容）                                │              │
│  │                                                    │              │
│  │ ## IDENTITY.md                                     │              │
│  │ （IDENTITY.md 文件内容）                              │              │
│  │                                                    │              │
│  │ ## Silent Replies                   ← 后续 Section │              │
│  │ ## Heartbeats                                      │              │
│  │ Runtime: ...                                       │              │
│  └───────────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 代码调用链

```
attempt.ts                              ← 执行引擎入口
  │
  ├─ resolveBootstrapContextForRun()    ← bootstrap-files.ts（编排函数）
  │    │
  │    ├─ loadWorkspaceBootstrapFiles()  ← workspace.ts（读磁盘）
  │    │    └─ readWorkspaceFileWithGuards()  ← 逐文件读取
  │    │
  │    ├─ filterBootstrapFilesForSession() ← workspace.ts（Session 过滤）
  │    │    └─ MINIMAL_BOOTSTRAP_ALLOWLIST  ← sub agent 只保留 5 个
  │    │
  │    ├─ applyBootstrapHookOverrides()  ← bootstrap-hooks.ts（插件覆盖）
  │    │
  │    └─ buildBootstrapContextFiles()   ← bootstrap.ts（转换 + 字符预算）
  │         └─ EmbeddedContextFile[]     ← { path, content }
  │
  ├─ buildAgentSystemPrompt({           ← system-prompt.ts（Prompt Builder）
  │    contextFiles,                     ← 传入数组
  │    toolNames,
  │    ...其他 20+ 参数
  │  })
  │    └─ # Project Context              ← 注入到 prompt 末尾
  │         ## AGENTS.md
  │         ## SOUL.md
  │         ## TOOLS.md
  │         ## IDENTITY.md
  │
  └─ session.prompt(effectivePrompt)     ← 发送给 LLM
```

---

## 3. 关键文件索引

| 步骤 | 文件 | 核心函数 |
|------|------|---------|
| 读取磁盘 | `src/agents/workspace.ts` | `loadWorkspaceBootstrapFiles()` |
| Session 过滤 | `src/agents/workspace.ts` | `filterBootstrapFilesForSession()` |
| Hook 覆盖 | `src/agents/bootstrap-hooks.ts` | `applyBootstrapHookOverrides()` |
| 编排入口 | `src/agents/bootstrap-files.ts` | `resolveBootstrapContextForRun()` |
| 转换 + 预算 | `src/agents/pi-embedded-helpers/bootstrap.ts` | `buildBootstrapContextFiles()` |
| 缓存 | `src/agents/bootstrap-cache.ts` | `getOrLoadBootstrapFiles()` |
| 类型定义 | `src/agents/pi-embedded-helpers/types.ts` | `EmbeddedContextFile` |
| 注入 Prompt | `src/agents/system-prompt.ts`（604-626 行） | `buildAgentSystemPrompt()` |

---

## 4. 我们的简化版

```
loadContextFiles(workspaceDir)           ← bootstrap/loader.ts
  │
  ├─ 读取 IDENTITY.md / SOUL.md / AGENTS.md / TOOLS.md
  ├─ 文件不存在 → 跳过
  ├─ 文件为空 → 跳过
  └─ 返回 ContextFile[]
  │
  ▼
SystemPromptBuilder.build({ contextFiles }) ← prompt-builder
  │
  └─ # Project Context
       ## IDENTITY.md
       ## SOUL.md
       ...
```

OpenClaw 的 6 步（读取 → Session 过滤 → Hook 覆盖 → 转换 → 预算控制 → 注入），我们简化为 2 步（读取 → 注入）。等需求变复杂时再逐步添加中间层。
