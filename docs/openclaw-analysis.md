# OpenClaw 项目分析备忘

> 分析日期：2026-03-31  
> 目的：参考 OpenClaw 的 Prompt Builder 设计，用于实现个人 AI Agent

---

## 1. 项目概述

**OpenClaw** 是一个多渠道个人 AI 助手网关（不是单纯的 prompt builder），但其内部包含一个**高度模块化的 Prompt 构建系统**，这是我们重点借鉴的部分。

**项目根目录：** `C:\dev\my-agent\openclaw`

**关键数据：**
- TypeScript 文件数：5026 个
- 源代码总量：~500,000+ 行
- 主要模块数：51 个
- 支持渠道：19+（WhatsApp, Telegram, Slack, Discord, Signal, iMessage 等）
- 支持 AI 模型：10+ 个提供商
- 版本号：v2026.3.22（年.月.日格式）

---

## 2. 项目目录结构

```
openclaw/
├── src/                    # 51 个核心模块
│   ├── agents/            # AI Agent 核心引擎（Prompt 构建、model fallover、执行）
│   ├── auto-reply/        # 自动回复系统
│   ├── channels/          # 多渠道集成（19+ 渠道）
│   ├── cli/               # 命令行接口
│   ├── config/            # 配置管理系统
│   ├── gateway/           # Gateway 控制平面（多通道路由、会话管理）
│   ├── acp/               # ACP 运行时（Agent Code Pilot）
│   ├── memory/            # 记忆系统（LanceDB 向量数据库）
│   ├── sessions/          # 会话管理和持久化
│   ├── infra/             # 基础设施（事件系统、skill 管理）
│   ├── bootstrap/         # Bootstrap 文件处理
│   ├── browser/           # 浏览器控制
│   ├── canvas-host/       # Canvas UI 宿主
│   ├── media/             # 媒体处理
│   ├── tts/               # 文本转语音
│   ├── web-search/        # Web 搜索集成
│   └── plugins/           # 插件系统
├── apps/                  # 客户端应用
│   ├── macos/
│   ├── ios/
│   └── android/
├── extensions/            # 扩展库
├── skills/                # Skills/Agents 库
├── ui/                    # UI 前端
└── package.json
```

---

## 3. Prompt 构建系统（核心借鉴点）

### 3.1 核心文件

| 文件 | 功能 |
|------|------|
| `src/agents/system-prompt.ts` | 主 Prompt 构建器（~700 行） |
| `src/agents/system-prompt-params.ts` | Prompt 参数解析 |
| `src/agents/agent-command.ts` | Agent 命令执行编排（~900+ 行） |
| `src/auto-reply/reply/commands-system-prompt.ts` | 命令系统 Prompt |
| `src/agents/prompt-composition-scenarios.ts` | Prompt 场景测试 |
| `src/memory/prompt-section.ts` | 内存 Prompt 部分 |
| `src/gateway/agent-prompt.ts` | Gateway Prompt 构建 |

### 3.2 核心函数签名

```typescript
// src/agents/system-prompt.ts
export function buildAgentSystemPrompt(params: {
  workspaceDir: string;               // 工作目录
  defaultThinkLevel?: ThinkLevel;     // 思考级别
  reasoningLevel?: ReasoningLevel;    // 推理级别
  extraSystemPrompt?: string;         // 额外 Prompt
  ownerNumbers?: string[];            // 所有者号码
  toolNames?: string[];               // 可用工具列表
  toolSummaries?: Record<string, string>; // 工具摘要
  modelAliasLines?: string[];         // 模型别名
  userTimezone?: string;              // 用户时区
  userTime?: string;                  // 用户当前时间
  skillsPrompt?: string;              // Skills 部分 Prompt
  contextFiles?: EmbeddedContextFile[]; // 注入的上下文文件
  acpEnabled?: boolean;               // ACP 启用
  promptMode?: "full" | "minimal" | "none"; // 3 种 Prompt 模式
  runtimeInfo?: RuntimeInfo;          // 运行时信息
  sandboxInfo?: SandboxInfo;          // 沙箱信息
  reactionGuidance?: ReactionGuidance; // 反应指导
  memoryCitationsMode?: MemoryCitationsMode; // 记忆引用模式
}): string  // 返回完整 Prompt 字符串
```

### 3.3 Prompt 的 23 个组成部分

`buildAgentSystemPrompt()` 将 System Prompt 分解为以下独立部分，按需组装：

1. **Identity** — 身份定义
2. **Tooling** — 工具列表（read, write, edit, grep, exec, browser, canvas 等）
3. **Tool Call Style** — 工具调用准则
4. **Safety** — 安全约束
5. **Skills** — 可用 Skills/插件
6. **Memory** — 记忆系统指导
7. **OpenClaw CLI** — 命令参考
8. **Self-Update** — 更新指导
9. **Model Aliases** — 模型别名映射
10. **Workspace** — 工作目录信息
11. **Sandbox** — 沙箱信息（可选）
12. **User Identity** — 授权发送者
13. **Time** — 时区信息
14. **Reply Tags** — 回复标签（`[[reply_to_current]]`）
15. **Messaging** — 消息工具和路由
16. **Voice (TTS)** — 文本转语音提示
17. **Documentation** — 文档链接
18. **Group Chat Context** — 群组对话上下文（可选）
19. **Reactions** — 反应指导（Telegram 特定）
20. **Project Context** — 注入的上下文文件
21. **Silent Replies** — SILENT_REPLY_TOKEN 规则
22. **Heartbeats** — 心跳检测
23. **Runtime** — 运行时信息

### 3.4 三种 Prompt 模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `full` | 包含所有部分 | 完整的 Agent 运行 |
| `minimal` | 精简版本 | 资源受限或简单任务 |
| `none` | 无 System Prompt | 特殊场景 |

---

## 4. 数据流

```
用户输入（CLI / 渠道消息）
  │
  ▼
消息处理（src/cli/run-main.ts）
  │
  ▼
会话解析 & 配置加载
  resolveSession() + loadConfig()
  │
  ▼
★ PROMPT 构建（核心）
  buildAgentSystemPrompt()
  输入：工作目录、工具列表、Skills、上下文文件、时区、运行时信息等
  输出：完整的 System Prompt 字符串
  │
  ▼
模型选择 & Fallback
  resolveConfiguredModelRef() + runWithModelFallback()
  │
  ▼
Agent 执行
  a) CLI Mode：runCliAgent()
  b) Embedded Mode：runEmbeddedPiAgent()
  │
  ▼
AI Model API 调用
  Anthropic / OpenAI / Google / AWS Bedrock
  │
  ▼
流式响应处理
  Tool Calls 识别 / Silent Replies / Heartbeat / 文本流聚合
  │
  ▼
结果传递 & 渠道路由
  deliverAgentCommandResult()
  │
  ▼
会话持久化
  ~/.openclaw/sessions.json
```

---

## 5. 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript 5.9 |
| 运行时 | Node.js 22.16+ |
| 包管理 | pnpm 10.23.0 |
| AI SDK | `@anthropic-ai/sdk`、`@aws-sdk/client-bedrock` 等 |
| Schema 验证 | Zod 4.3.6 |
| HTTP 框架 | Express 5.2.1 / Hono 4.12.8 |
| CLI 交互 | Commander 14.0.3 + `@clack/prompts` |
| 向量数据库 | LanceDB（sqlite-vec） |
| 浏览器自动化 | Playwright 1.58.2 |
| 图像处理 | Sharp 0.34.5 |
| 构建工具 | tsdown 0.21.4 |
| 测试框架 | Vitest 4.1.0 |
| Lint | oxlint 1.56.0 |

---

## 6. 关键设计决策

| 决策 | 实现方式 | 原因 |
|------|----------|------|
| 多渠道支持 | 19+ 独立 handlers | 支持用户已有的通讯平台 |
| 单用户 Local-first | 本地运行 | 隐私、快速、无云依赖 |
| Prompt 可组合性 | 模块化 sections | 灵活组装不同场景的 Prompt |
| 3 种 Prompt 模式 | full/minimal/none | 不同运行时的优化 |
| 模型 Fallback | auth-profiles 轮换 | 避免单一 API 失败 |
| Skills/Agents | Plugin SDK | 扩展功能而不修改核心 |
| 语音支持 | TTS integration | 语音交互能力 |
| 安全沙箱 | Docker runtime | 安全的代码执行 |

---

## 7. 对我们项目的借鉴方向

基于 OpenClaw 的设计，我们的 Prompt Builder 建议采用以下架构：

### 推荐目录结构

```
my-agent/
├── src/
│   ├── prompt-builder/
│   │   ├── sections/          # 各 section 独立模块
│   │   │   ├── identity.ts
│   │   │   ├── tools.ts
│   │   │   ├── context.ts
│   │   │   ├── memory.ts
│   │   │   └── runtime.ts
│   │   ├── builder.ts         # 组装逻辑
│   │   └── types.ts           # 类型定义
│   ├── tools/                 # 工具定义
│   ├── memory/                # 记忆管理
│   ├── sessions/              # 会话管理
│   └── cli/                   # CLI 入口
├── docs/                      # 文档目录
└── package.json
```

### 实现步骤

1. **Step 1** — 核心 Prompt 构建器（模块化 sections + 组装逻辑）
2. **Step 2** — 工具定义系统（参考 `toolNames` + `toolSummaries` 模式）
3. **Step 3** — CLI 入口（用 `@clack/prompts` 做交互式界面）

---

## 8. 参考文件快速索引

| 想了解什么 | 看哪个文件 |
|-----------|-----------|
| Prompt 构建主逻辑 | `src/agents/system-prompt.ts` |
| Prompt 参数定义 | `src/agents/system-prompt-params.ts` |
| Agent 执行编排 | `src/agents/agent-command.ts` |
| Skills 系统 | `src/infra/skills-remote.ts` + `src/agents/skills.ts` |
| 工具摘要生成 | `src/agents/tool-summaries.ts` |
| 会话管理 | `src/sessions/` + `src/config/sessions.ts` |
| CLI 入口 | `src/cli/run-main.ts` |
| Gateway 路由 | `src/gateway/server.ts` |
