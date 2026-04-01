# OpenClaw Prompt 构建系统深度分析

> 分析日期：2026-03-31  
> 目的：深入理解 OpenClaw 的 Prompt 构建实现，为自研 Prompt Builder 提供参考

---

## 1. 核心设计思路：字符串数组拼接

整个系统非常直白——没有魔法，核心就是一个大函数 `buildAgentSystemPrompt()`，把所有内容推入一个 `lines[]` 数组，最后 `join("\n")` 输出：

```typescript
const lines = [];
lines.push("## Identity", "You are a personal assistant...", "");
lines.push("## Tooling", ...toolLines, "");
lines.push("## Memory", ...memoryLines, "");
// ... 依次类推
return lines.filter(Boolean).join("\n");
```

**核心文件**：`src/agents/system-prompt.ts`（约 690 行）

---

## 2. 完整的 Section 组成（25 个部分）

| # | Section 名称 | 条件 | 来源 | 用途 |
|---|------------|------|------|------|
| 1 | 身份定义 | 总是 | 硬编码文本 | 定义 Agent 的基本身份："You are a personal assistant running inside OpenClaw"，是整个 prompt 的起点 |
| 2 | Tooling | 总是 | `toolNames` 参数控制显示哪些工具 | 列出当前可用的工具及其简短描述（read/write/exec/browser 等），让 LLM 知道自己有哪些能力 |
| 3 | Tool Call Style | 总是 | 硬编码文本 | 规范工具调用的风格和准则，例如何时用工具、避免不必要的工具调用等 |
| 4 | Safety | 总是 | 硬编码文本 | 安全约束：禁止追求自我保全、资源获取、权力扩张；禁止操纵用户、绕过安全机制等（参考 Anthropic 宪法） |
| 5 | OpenClaw CLI | 总是 | 硬编码文本 | OpenClaw 内置命令的快速参考（如 `/compact`、`/model` 等），让 Agent 知道如何调用这些命令 |
| 6 | Skills | `if skillsPrompt` | `skillsPrompt` 参数注入 | 列出可用的 Skill 列表（XML 格式），告知 LLM 匹配用户意图时先读取对应的 SKILL.md 再执行 |
| 7 | Memory | `if !isMinimal` | 硬编码（minimal 模式跳过） | 告知 LLM 何时调用 `memory_search`/`memory_get` 工具（回答历史工作、决策、偏好等问题前先检索记忆） |
| 8 | Self-Update | `if hasGateway && !isMinimal` | 条件性硬编码 | 告知 Agent 如何更新自身（仅在有 Gateway 时启用），引导 LLM 使用正确的更新流程 |
| 9 | Model Aliases | `if modelAliasLines && !isMinimal` | `modelAliasLines` 参数注入 | 模型别名映射表（如 `fast` → `claude-haiku`），让 LLM 知道简写别名对应的真实模型名 |
| 10 | Timezone Hint | `if userTimezone` | `userTimezone` 参数 | 告知 LLM 用户的时区，用于时间相关的推理和格式化（与 Date & Time section 配合） |
| 11 | Workspace | 总是 | `workspaceDir` 参数 | 告知当前工作目录路径，是 Agent 进行文件操作的根路径参考 |
| 12 | Documentation | 总是 | `buildDocsSection()` 函数 | 提供 OpenClaw 文档的链接，Agent 在需要了解平台能力时可读取 |
| 13 | Sandbox | `if sandboxInfo?.enabled` | `sandboxInfo` 参数 | 沙箱环境说明：告知 Agent 当前运行在隔离容器中，哪些操作受限、如何与宿主通信 |
| 14 | Authorized Senders | 可选 | `ownerNumbers` 参数 | 授权发送者白名单，告知 Agent 只信任来自指定用户（手机号/ID）的指令，防止其他人冒充 |
| 15 | Date & Time | 可选 | `userTime` 参数 | 注入当前日期时间（按用户时区格式化），让 LLM 在无法访问系统时钟时也能感知当前时间 |
| 16 | Reply Tags | `if !isMinimal` | `buildReplyTagsSection()` 函数 | 定义回复标签协议（如 `[[reply_to_current]]`），控制 Agent 回复消息的路由目标 |
| 17 | Messaging | `if !isMinimal` | `buildMessagingSection()` 函数 | 消息发送工具的使用规范：如何通过 `message` 工具发送到不同渠道（Slack/Telegram 等） |
| 18 | Voice/TTS | 可选 | `buildVoiceSection()` 函数 | 语音输出提示：告知 Agent 当前支持 TTS，回复时注意语音友好性（避免纯 Markdown 格式） |
| 19 | Group Chat Context | `if extraSystemPrompt` | `extraSystemPrompt` 参数直接注入 | 注入额外的上下文信息，常用于群聊场景（说明当前是群组对话、谁是管理员等） |
| 20 | Reactions | `if reactionGuidance` | `reactionGuidance` 参数 | Telegram 特有：告知 Agent 如何用 emoji reaction 对消息表态（如用 👀 表示"正在处理"） |
| 21 | Reasoning Format | `if reasoningHint` | 条件性硬编码 | 指导 LLM 的推理格式，如是否使用 `<thinking>` 标签、推理深度级别（对应 ThinkLevel/ReasoningLevel） |
| 22 | Project Context | `if contextFiles.length > 0` | `contextFiles` 参数循环注入 | 将工作区的引导文件内容直接嵌入 prompt（如 AGENTS.md、SOUL.md），提供项目级上下文 |
| 23 | Silent Replies | `if !isMinimal` | 硬编码 | 定义静默回复协议（`SILENT_REPLY_TOKEN`）：Agent 某些情况下应静默执行而不回复用户 |
| 24 | Heartbeats | `if !isMinimal` | 硬编码 + `heartbeatPrompt` 参数 | 长任务心跳机制：告知 Agent 在执行耗时操作时定期发送进度消息，防止用户以为卡死 |
| 25 | Runtime | 总是 | `buildRuntimeLine()` 函数 | 运行时元信息（OS、Node 版本、Agent ID、当前模型等），帮助 Agent 了解自身运行环境 |

---

## 3. 三种 Prompt 模式

| Section | `full` | `minimal` | `none` |
|---------|:------:|:---------:|:------:|
| 身份 + 工具 + 安全 | ✅ | ✅ | ❌ |
| Skills + Project Context | ✅ | ✅ | ❌ |
| Memory | ✅ | ❌ | ❌ |
| Messaging / Voice | ✅ | ❌ | ❌ |
| Silent Replies / Heartbeats | ✅ | ❌ | ❌ |
| Reply Tags | ✅ | ❌ | ❌ |

> - `full`：主 Agent 使用，包含所有 sections
> - `minimal`：子 Agent 使用，节省 token
> - `none`：仅返回基础身份行，特殊场景使用

---

## 4. 工具系统设计

### 4.1 工具来源

```
内置工具（coreToolSummaries，23 个）     外部工具（toolSummaries 参数）
  read, write, edit, grep,         +    自定义工具（追加在末尾）
  find, ls, exec, browser...
              ↓
     toolNames 参数决定哪些工具显示
              ↓
        按 toolOrder 排序后注入 prompt
```

### 4.2 内置核心工具列表（部分）

```
read      - Read file contents
write     - Create or overwrite files
edit      - Make precise edits to files
apply_patch - Apply a unified diff patch
grep      - Search file contents for patterns
find      - Find files by name or pattern
ls        - List directory contents
exec      - Run shell commands
process   - Manage background processes
browser   - Control web browser
canvas    - Present/eval/snapshot the Canvas
message   - Send messages and channel actions
sessions_spawn - Spawn an isolated sub-agent session
subagents - List, steer, or kill sub-agent runs
```

### 4.3 工具构建核心代码

```typescript
// 硬编码 23 个内置工具摘要
const coreToolSummaries: Record<string, string> = {
  read: "Read file contents",
  write: "Create or overwrite files",
  // ...
};

// 工具显示顺序（共 25 个）
const toolOrder = ["read", "write", "edit", "apply_patch", "grep", ...];

// 构建逻辑
const availableTools = new Set(params.toolNames?.map(t => t.toLowerCase()) ?? []);
const toolLines = toolOrder
  .filter(tool => availableTools.has(tool))
  .map(tool => {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    return `- ${tool}: ${summary}`;
  });
// 外部工具（不在 toolOrder 中的）追加在末尾
```

### 4.4 工具摘要构建（buildToolSummaryMap）

**位置**：`src/agents/tool-summaries.ts`

```typescript
export function buildToolSummaryMap(tools: AgentTool[]): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const tool of tools) {
    const summary = tool.description?.trim() || tool.label?.trim();
    if (!summary) continue;
    summaries[tool.name.toLowerCase()] = summary;
  }
  return summaries;
}
```

---

## 5. Skills 系统设计

### 5.1 Skills 加载流程

```
工作目录下的 skills/ 文件夹
  └─ SKILL.md（每个 skill 一个文件）
       ↓
  loadSkillEntries()
  ├─ 从多个目录按优先级加载（高优先级覆盖低优先级）：
  │  ├─ openclaw-workspace  (workspace/skills)      ← 最高优先级
  │  ├─ agents-skills-project (.agents/skills)
  │  ├─ agents-skills-personal (~/.agents/skills)
  │  ├─ openclaw-managed
  │  ├─ openclaw-bundled
  │  └─ openclaw-extra                              ← 最低优先级
       ↓
  filterSkillEntries()  ← 过滤禁用的 skill
       ↓
  applySkillsPromptLimits()
  ├─ 最多 150 个 skill
  └─ 最多 30,000 字符
       ↓
  formatSkillsForPrompt() 或 formatSkillsCompact()
       ↓
  skillsPrompt 字符串 → 注入 prompt
```

### 5.2 Skills 在 Prompt 中的格式

**完整格式**（字符数充足时）：
```xml
<available_skills>
  <skill>
    <name>github</name>
    <location>~/path/to/skills/github/SKILL.md</location>
    <description>Interact with GitHub via CLI</description>
  </skill>
  ...
</available_skills>
```

**紧凑格式**（字符数接近限制时，去掉 description）：
```xml
<available_skills>
  <skill>
    <name>github</name>
    <location>~/path/to/skills/github/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

### 5.3 Skills Section 构建逻辑

```typescript
function buildSkillsSection(params: {
  skillsPrompt?: string;
  readToolName: string;
}) {
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) return [];

  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "",
    trimmed,  // 直接注入 skillsPrompt 参数
    "",
  ];
}
```

---

## 6. 上下文文件注入（contextFiles）

### 6.1 加载流程

**位置**：`src/agents/bootstrap-files.ts`

```typescript
// 从工作目录加载 bootstrap 文件（如 AGENTS.md、SOUL.md 等）
const contextFiles = await resolveBootstrapContextForRun({
  workspaceDir,
  config,
  maxChars: 10000,       // 单文件最大字符数
  totalMaxChars: 50000,  // 所有文件总最大字符数
});
```

### 6.2 在 Prompt 中的注入格式

```markdown
# Project Context

（如果有 soul.md）：
If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies...

## AGENTS.md
（文件完整内容...）

## .agents/soul.md
（文件完整内容...）
```

### 6.3 注入代码逻辑

```typescript
// src/agents/system-prompt.ts:604-627
if (validContextFiles.length > 0) {
  lines.push("# Project Context", "");

  // 特殊处理 soul.md
  const hasSoulFile = validContextFiles.some((file) => {
    const baseName = file.path.split("/").pop();
    return baseName?.toLowerCase() === "soul.md";
  });
  if (hasSoulFile) {
    lines.push("If SOUL.md is present, embody its persona and tone...");
  }

  // 循环注入所有文件
  for (const file of validContextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }
}
```

**EmbeddedContextFile 数据结构**：
```typescript
{
  path: string;    // 相对路径，如 "AGENTS.md"、".agents/soul.md"
  content: string; // 文件完整内容
}
```

---

## 7. 完整参数列表及影响

| 参数 | 类型 | 影响 |
|------|------|------|
| `workspaceDir` | `string` | Workspace section，必填 |
| `promptMode` | `"full"\|"minimal"\|"none"` | 决定包含哪些 sections |
| `toolNames` | `string[]` | 决定显示哪些工具 |
| `toolSummaries` | `Record<string, string>` | 外部工具的描述 |
| `skillsPrompt` | `string` | Skills section 的完整内容 |
| `contextFiles` | `EmbeddedContextFile[]` | Project Context 注入的文件 |
| `extraSystemPrompt` | `string` | 作为 Group Chat Context 直接注入 |
| `ownerNumbers` | `string[]` | Authorized Senders section |
| `userTimezone` | `string` | 激活 Date & Time section |
| `userTime` | `string` | 当前时间显示 |
| `modelAliasLines` | `string[]` | Model Aliases section |
| `sandboxInfo` | `SandboxInfo` | 激活 Sandbox section |
| `reactionGuidance` | `ReactionGuidance` | Reactions section |
| `heartbeatPrompt` | `string` | Heartbeats section 追加内容 |
| `runtimeInfo` | `RuntimeInfo` | Runtime section |
| `defaultThinkLevel` | `ThinkLevel` | 影响工具调用规范描述 |
| `reasoningLevel` | `ReasoningLevel` | 影响 Reasoning Format section |
| `acpEnabled` | `boolean` | 影响部分工具描述 |
| `memoryCitationsMode` | `MemoryCitationsMode` | 影响 Memory section |
| `ttsHint` | `string` | Voice/TTS section |
| `workspaceNotes` | `string[]` | Workspace section 后的自定义注释 |

---

## 8. 完整调用链

```
用户命令输入
  │
  ▼
src/cli/run-main.ts
  agentCommand(opts)
  │
  ▼
src/agents/agent-command.ts
  prepareAgentCommandExecution()
  │
  ├─ resolveSkillsPromptForRun()
  │    └─ buildWorkspaceSkillsPrompt(workspaceDir) → skillsPrompt
  │
  ├─ resolveBootstrapContextForRun()
  │    └─ → contextFiles
  │
  ├─ buildToolSummaryMap(params.tools)
  │    └─ → toolSummaries
  │
  ▼
src/agents/system-prompt.ts
  buildAgentSystemPrompt({
    workspaceDir,
    toolNames,
    toolSummaries,
    skillsPrompt,
    contextFiles,
    promptMode,
    userTimezone,
    userTime,
    // ... 其他 20+ 参数
  })
  └─ → 最终 System Prompt 字符串
  │
  ▼
runWithModelFallback()
  └─ 调用 AI Model API（Anthropic/OpenAI/Google 等）
```

---

## 9. 关键设计结论

### 优点

| 优点 | 说明 |
|------|------|
| **实现简单** | 纯字符串拼接，无框架依赖，易于理解 |
| **行为可预测** | 硬编码顺序，输出完全确定 |
| **参数化灵活** | 20+ 参数控制各 section 的显示与内容 |
| **性能高效** | 无反射、无动态加载开销 |
| **三种模式** | full/minimal/none 适应不同场景 |

### 局限性

| 局限性 | 说明 |
|--------|------|
| **完全硬编码** | 没有 section 注册表，添加新 section 需修改核心函数 |
| **顺序固定** | 无法在运行时重排 section 顺序 |
| **无扩展钩子** | 没有 before/after hooks，没有 section 替换机制 |
| **唯一扩展点** | 只能通过 `extraSystemPrompt` + `contextFiles` 添加自定义内容 |

---

## 10. 对自研系统的启示

基于 OpenClaw 的实现，自研 Prompt Builder 可以：

1. **保留**：字符串拼接的核心思路（简单有效）
2. **保留**：参数驱动各 section 的开关控制
3. **保留**：三种 Prompt 模式（full/minimal/none）
4. **改进**：将硬编码改为 **section 注册机制**，支持动态添加、排序和替换
5. **改进**：支持 **section 优先级/权重**，灵活控制顺序
6. **改进**：增加 **before/after hooks**，方便扩展

### 参考文件快速索引

| 想了解什么 | 文件路径 |
|-----------|---------|
| Prompt 构建主逻辑 | `src/agents/system-prompt.ts` |
| Prompt 参数定义 | `src/agents/system-prompt-params.ts` |
| Agent 执行编排 | `src/agents/agent-command.ts` |
| Skills 加载 | `src/agents/skills/workspace.ts` |
| Skills Prompt 格式化 | `src/infra/skills-remote.ts` |
| 工具摘要构建 | `src/agents/tool-summaries.ts` |
| 上下文文件加载 | `src/agents/bootstrap-files.ts` |
| Skills Section 构建 | `src/agents/system-prompt.ts`（函数 buildSkillsSection） |
