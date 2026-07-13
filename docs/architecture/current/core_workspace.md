# Core Workspace 模块设计文档

> 文档日期：2026-05-29
> 关联文档：`platform_config.md` · `core_prompt.md` · `runtime.md`

---

## 1. 概述

`src/core/workspace/` 负责两件事：

1. **工作区初始化**（`ensureWorkspace`）：在 `workspaceDir/.agent/` 下创建必要的目录结构和模板文件
2. **上下文文件加载**（`loadContextFiles`）：读取 `IDENTITY.md`、`SOUL.md` 等文件并注入 system prompt 的 `project-context` section

---

## 2. 目录结构

```
src/core/workspace/
├── types.ts          # ContextFile { path, content }
├── init.ts           # ensureWorkspace()
├── loader.ts         # loadContextFiles()
├── index.ts
└── templates/        # 首次初始化时写入的默认文件
    ├── IDENTITY.md
    ├── SOUL.md
    ├── AGENTS.md
    └── TOOLS.md
```

---

## 3. 工作区初始化（ensureWorkspace）

```
ensureWorkspace(workspaceDir):

  创建目录（如不存在）：
    <workspaceDir>/.agent/
    <workspaceDir>/.agent/sessions/
    <workspaceDir>/.agent/memory/

  写入模板文件（仅当文件不存在时）：
    <workspaceDir>/.agent/IDENTITY.md  ← 项目/Agent 身份描述
    <workspaceDir>/.agent/SOUL.md      ← 行为准则、价值观
    <workspaceDir>/.agent/AGENTS.md    ← Multi-agent 协作说明（预留）
    <workspaceDir>/.agent/TOOLS.md     ← 工具使用说明
```

**幂等**：目录已存在不报错，文件已存在不覆盖——对已有项目重新启动时安全。

---

## 4. 上下文文件加载（loadContextFiles）

### 4.1 加载顺序与文件集

| mode | 加载的文件 |
|---|---|
| `'full'`（默认） | IDENTITY.md → SOUL.md → AGENTS.md → TOOLS.md |
| `'minimal'` | IDENTITY.md → SOUL.md |

顺序固定，不可配置——越靠前的文件越先消耗 token 预算，因此最重要的文件排在前面。

### 4.2 截断策略

单文件超出 `maxFileChars` 时，保留头部 70% + 尾部 20%，中间插入截断标记：

```
[...truncated, read {fileName} for full content...]
...(truncated {fileName}: kept {head}+{tail} chars of {original})...
```

参考 OpenClaw 的 `trimBootstrapContent()`，头重尾轻的设计：上下文文件通常把最关键信息（项目概述、角色定义）放在开头，尾部保留用于捕获总结性内容。

### 4.3 总预算管理

```
loadContextFiles(workspaceDir, { mode, maxFileChars, maxTotalChars, warn }):

  remainingBudget = maxTotalChars  // 默认 150,000

  for each file in fileList:
    if remainingBudget < 64: warn + break
    读取文件 → 空文件跳过
    fileBudget = min(maxFileChars, remainingBudget)
    truncate(content, fileBudget)   // 超出则截断 + warn
    remainingBudget -= result.length
    results.push({ path, content })
```

### 4.4 默认值

| 参数 | 默认值 | 来源 |
|---|---|---|
| `maxFileChars` | 20,000 | `config.workspace.maxFileChars` |
| `maxTotalChars` | 150,000 | `config.workspace.maxTotalChars` |
| `warn` | `console.warn` | 可注入（测试用） |

---

## 5. ContextFile 类型

```
ContextFile {
  path: string    // 文件名，如 'SOUL.md'（用作 system prompt section 标题）
  content: string // 文件内容（已截断）
}
```

`ContextFile[]` 由 runtime 在 bootstrap 时加载并缓存，在每轮 `runTurn` 时传入 `SystemPromptBuilder.build({ contextFiles })`。

---

## 6. 关键设计决策

| 决策 | 说明 |
|---|---|
| 模板文件"仅首次写入" | 避免覆盖用户对模板的自定义修改 |
| 上下文文件缓存在 runtime | bootstrap 阶段加载一次，`reloadContextFiles` 在特定事件后触发重新加载，不在每轮重读磁盘 |
| 截断而非跳过超长文件 | 保证文件始终有部分内容进入 prompt，不会因为文件偶尔变大就突然消失 |
| `minimal` 模式仅加载 IDENTITY + SOUL | 减少 token 消耗，适合机器调用或无需完整上下文的场景 |
