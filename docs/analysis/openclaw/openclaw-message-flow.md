# OpenClaw 用户消息处理完整流程

> 分析日期：2026-04-01  
> 参考项目：C:\dev\my-agent\openclaw

---

## 1. 数据流程图

### 1.1 完整流程概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户发送消息                                  │
│          Telegram / Slack / Discord / WhatsApp / CLI / ...          │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第一阶段：渠道消息接收                                              │
│  extensions/<channel>/src/inbound.ts                                │
│                                                                     │
│  ├─ 媒体解析（图片、文件等）                                         │
│  ├─ 消息验证（空消息丢弃）                                           │
│  ├─ 权限检查（access group）                                        │
│  └─ 构建 Session Key                                                │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第二阶段：消息预处理                                                │
│  src/auto-reply/                                                    │
│                                                                     │
│  ├─ 防抖缓冲（inbound-debounce.ts）                                 │
│  │   └─ 同一 Session 的多条消息合并                                   │
│  ├─ 文本规范化（inbound-text.ts）                                    │
│  │   └─ 换行符统一 + 防伪造系统标签                                   │
│  ├─ 元数据构建（inbound-meta.ts）                                    │
│  │   └─ 系统信任元数据 + 用户不信任元数据                              │
│  └─ 统一分发（dispatch.ts）                                         │
│      └─ dispatchInboundMessage() → agentCommand()                   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第三阶段：执行准备                                                  │
│  src/agents/agent-command.ts → prepareAgentCommandExecution()        │
│                                                                     │
│  ├─ 内部事件注入（prependInternalEventContext）                       │
│  ├─ 中止提示注入（applySessionHints）                                │
│  ├─ 配置加载（loadConfig + 密钥解密）                                 │
│  ├─ Session 解析（resolveSession → 已有或新建）                       │
│  ├─ Agent 选择（resolveSessionAgentId）                              │
│  ├─ 工作区初始化（ensureAgentWorkspace）                              │
│  ├─ 模型/提供商选择（resolveDefaultModelForAgent）                    │
│  ├─ 模型白名单验证                                                   │
│  ├─ 思考级别解析（resolveThinkingDefault）                            │
│  └─ 技能快照构建（buildWorkspaceSkillSnapshot）                       │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第四阶段：模型 Fallback 包装                                        │
│  src/agents/model-fallback.ts → runWithModelFallback()               │
│                                                                     │
│  首选模型 ──失败──→ 备用模型 1 ──失败──→ 备用模型 2 ──失败──→ 报错    │
│      │                  │                   │                       │
│      ▼                  ▼                   ▼                       │
│  runAgentAttempt()  runAgentAttempt()   runAgentAttempt()            │
│  (isFallbackRetry   (isFallbackRetry    (isFallbackRetry            │
│   = false)           = true)             = true)                    │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第五阶段：Agent 执行（runAgentAttempt 路由）                        │
│  src/agents/agent-command.ts                                        │
│                                                                     │
│  isCliProvider?                                                     │
│  ├─ YES → runCliAgent()         ← 调用外部 CLI（claude-cli 等）      │
│  │         └─ session 过期 → 清除 + 重试                             │
│  └─ NO  → runEmbeddedPiAgent()  ← 内嵌 Agent 引擎（主路径）         │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ （走 runEmbeddedPiAgent 路径）
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第六阶段：内嵌引擎                                                  │
│  src/agents/pi-embedded-runner/run.ts → runEmbeddedPiAgent()         │
│                                                                     │
│  ├─ 并发控制（Session 队列 + 全局队列）                               │
│  ├─ 插件加载（ensureRuntimePluginsLoaded）                           │
│  ├─ Hook 执行（before_model_resolve / before_agent_start）           │
│  ├─ 模型解析（resolveModelAsync）                                    │
│  ├─ 上下文窗口检查（resolveContextWindowInfo）                        │
│  │   └─ < 16K tokens → 阻止运行                                     │
│  │   └─ < 32K tokens → 警告                                         │
│  ├─ 认证解析（resolveAuthProfileOrder → API Key 轮换）               │
│  │                                                                   │
│  └─ 重试循环（认证失败 / thinking 降级）                              │
│      └─ runEmbeddedAttempt()  ← 单次 LLM 调用                       │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第七阶段：单次 LLM 调用                                             │
│  src/agents/pi-embedded-runner/run/attempt.ts → runEmbeddedAttempt() │
│                                                                     │
│  ┌─ 7a. 上下文文件加载 ─────────────────────────────────────┐       │
│  │  resolveBootstrapContextForRun()                          │       │
│  │  ├─ loadWorkspaceBootstrapFiles()  （读磁盘）             │       │
│  │  ├─ filterBootstrapFilesForSession()（Session 过滤）      │       │
│  │  ├─ applyBootstrapHookOverrides() （插件覆盖）            │       │
│  │  └─ buildBootstrapContextFiles()  （转换 + 字符预算）     │       │
│  └───────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌─ 7b. System Prompt 构建 ─────────────────────────────────┐       │
│  │  buildAgentSystemPrompt({                                 │       │
│  │    contextFiles, toolNames, toolSummaries,                │       │
│  │    skillsPrompt, promptMode, ...20+ 参数                  │       │
│  │  })                                                       │       │
│  │  └─ 25 个 Section 硬编码拼接 → 字符串                     │       │
│  └───────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌─ 7c. User Prompt 构建 ───────────────────────────────────┐       │
│  │  effectivePrompt =                                        │       │
│  │    prependBootstrapPromptWarning()                        │       │
│  │    + hookResult.prependContext                             │       │
│  │    + 用户原始消息                                          │       │
│  │                                                           │       │
│  │  detectAndLoadPromptImages()  （从文本检测图像路径并加载）  │       │
│  └───────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌─ 7d. Session 初始化 ─────────────────────────────────────┐       │
│  │  SessionManager.open(sessionFile)                         │       │
│  │  prepareSessionManagerForRun()                            │       │
│  │  limitHistoryTurns()  （历史轮次裁剪）                     │       │
│  └───────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌─ 7e. LLM API 调用（流式） ───────────────────────────────┐       │
│  │  session.prompt(effectivePrompt, { images })               │       │
│  │                                                           │       │
│  │  for await (event of stream) {                            │       │
│  │    text_delta  → 收集文本片段                              │       │
│  │    tool_call   → 执行工具 → 返回结果 → 继续生成            │       │
│  │    stop        → 结束                                     │       │
│  │  }                                                        │       │
│  └───────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌─ 7f. Session 持久化 ─────────────────────────────────────┐       │
│  │  sessionManager.appendMessage({ role: 'user', ... })      │       │
│  │  sessionManager.appendMessage({ role: 'assistant', ... }) │       │
│  │  sessionManager.write()  → JSONL 文件                     │       │
│  └───────────────────────────────────────────────────────────┘       │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第八阶段：结果回传                                                  │
│  src/agents/command/delivery.ts → deliverAgentCommandResult()        │
│                                                                     │
│  ├─ 分发计划解析（resolveAgentDeliveryPlan）                         │
│  │   └─ 确定回复渠道、目标、线程                                      │
│  ├─ 负载格式化（normalizeOutboundPayloads）                          │
│  │   └─ 文本分块（过长消息拆分）                                      │
│  └─ 渠道分发（deliverOutboundPayloads）                              │
│      └─ 调用渠道 SDK 发送回复                                        │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第九阶段：Session 状态更新                                          │
│  src/agents/command/session-store.ts                                 │
│                                                                     │
│  updateSessionStoreAfterAgentRun()                                  │
│  ├─ 记录使用的模型/提供商                                            │
│  ├─ 记录 token 使用量和成本                                          │
│  ├─ 记录压缩次数                                                    │
│  ├─ 记录中止状态                                                    │
│  └─ 原子性写入 Session Store                                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 渠道消息接收

每个渠道有自己的入口处理器，但最终都汇聚到统一的分发系统。

**关键文件**：
- Discord: `extensions/discord/src/monitor/message-handler.process.ts`
- Telegram: `extensions/telegram/src/inbound/...`
- 统一分发: `src/auto-reply/dispatch.ts`

**处理流程**：

```typescript
// 以 Discord 为例
processDiscordMessage(ctx) {
  // 1. 媒体解析
  const mediaList = await resolveMediaList(message, mediaMaxBytes);
  
  // 2. 空消息丢弃
  if (!text) return;
  
  // 3. 构建 Session Key（根据用户/频道）
  const boundSessionKey = ...;
  
  // 4. 分发到统一入口
  dispatchInboundMessage({ ctx, cfg, dispatcher });
}
```

**统一分发入口**（`dispatch.ts`）：

```typescript
export async function dispatchInboundMessage(params) {
  const finalized = finalizeInboundContext(params.ctx);
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () => dispatchReplyFromConfig({ ctx: finalized, cfg, ... }),
  });
}
```

---

## 3. 消息预处理

在到达 `agentCommand` 之前，消息经过三层预处理。

### 3.1 防抖缓冲

**文件**：`src/auto-reply/inbound-debounce.ts`

同一 Session 的多条快速连续消息被合并为一次处理，避免对每条消息都发起 LLM 调用。

```typescript
// 按 Session Key 分组缓冲，防抖超时后批量发送
const enqueue = async (item) => {
  const key = params.buildKey(item);  // 通常是 sessionKey
  const debounceMs = resolveDebounceMs(item);
  
  if (canDebounce && key) {
    existing.items.push(item);       // 缓冲
    scheduleFlush(key, existing);    // 延迟处理
  } else {
    await params.onFlush([item]);    // 立即处理
  }
};
```

### 3.2 文本规范化

**文件**：`src/auto-reply/reply/inbound-text.ts`

```typescript
// 换行符统一
export function normalizeInboundTextNewlines(input: string): string {
  return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

// 防止用户伪造系统标签
export function sanitizeInboundSystemTags(input: string): string {
  return input
    .replace(BRACKETED_SYSTEM_TAG_RE, (_match, tag) => `(${tag})`)
    .replace(LINE_SYSTEM_PREFIX_RE, "$1System (untrusted):");
}
```

### 3.3 元数据构建

**文件**：`src/auto-reply/reply/inbound-meta.ts`

构建两种元数据注入到消息中：

| 类型 | 内容 | 信任级别 |
|------|------|---------|
| 系统元数据 | chat_id、channel、provider、chat_type | 信任（系统生成） |
| 用户元数据 | message_id、sender_id、sender_name、timestamp | 不信任（用户提供） |

---

## 4. agentCommand 入口

**文件**：`src/agents/agent-command.ts`

所有渠道的消息最终汇聚到这里，有两个入口变体：

| 入口 | 调用方 | 信任级别 |
|------|--------|---------|
| `agentCommand()` | CLI / 本地调用 | `senderIsOwner` 默认 `true` |
| `agentCommandFromIngress()` | HTTP / WebSocket / 渠道网关 | `senderIsOwner` 必须显式传入 |

两者最终都调用 `agentCommandInternal()`。

---

## 5. 执行准备（prepareAgentCommandExecution）

**文件**：`src/agents/agent-command.ts`（第 536 行）

这是最关键的预处理函数，按顺序执行：

```
prepareAgentCommandExecution()
  │
  ├─ 1. 验证消息不为空
  ├─ 2. 注入内部事件（prependInternalEventContext）
  │      └─ sub agent 完成通知等
  ├─ 3. 加载配置 + 密钥解密（loadConfig + resolveCommandSecretRefsViaGateway）
  ├─ 4. Session 解析（resolveSession）
  │      └─ 已有 Session → 复用 | 新 Session → 创建
  ├─ 5. Agent 选择（resolveSessionAgentId）
  ├─ 6. 工作区初始化（ensureAgentWorkspace）
  │      └─ 首次运行 → 创建模板文件
  ├─ 7. 模型/提供商选择
  │      ├─ 默认模型（resolveDefaultModelForAgent）
  │      ├─ Session 存储的覆盖
  │      └─ 运行时覆盖（如 /model 命令）
  ├─ 8. 模型白名单验证
  ├─ 9. 思考级别解析（resolveThinkingDefault）
  ├─ 10. 技能快照构建（buildWorkspaceSkillSnapshot）
  └─ 返回完整的执行参数包
```

---

## 6. 模型 Fallback 机制

**文件**：`src/agents/model-fallback.ts`

```
首选模型（如 claude-sonnet）
    │
    ├─ 成功 → 返回结果
    └─ 失败（超时/认证/API 错误）
         │
         ▼
    备用模型 1（如 claude-haiku）
         │
         ├─ 成功 → 返回结果
         └─ 失败
              │
              ▼
         备用模型 2 → ... → 所有备用都失败 → 抛出错误
```

Fallback 重试时，`isFallbackRetry=true`，prompt 被替换为：
> "Continue where you left off. The previous model attempt failed or timed out."

---

## 7. runAgentAttempt 路由

**文件**：`src/agents/agent-command.ts`（第 352 行）

根据 provider 类型分两条路：

| 路径 | 条件 | 执行方式 |
|------|------|---------|
| `runCliAgent()` | provider 是 CLI 类型（claude-cli、codex-cli） | 调用外部 CLI 进程 |
| `runEmbeddedPiAgent()` | 其他所有 provider（Anthropic、OpenAI 等） | 内嵌引擎，直接调 LLM API |

CLI 路径还有 session 过期自动重建的逻辑。

---

## 8. 内嵌引擎（runEmbeddedPiAgent）

**文件**：`src/agents/pi-embedded-runner/run.ts`（第 267 行）

这是 API provider 的执行引擎，负责 LLM 调用前的所有准备工作：

```
runEmbeddedPiAgent()
  │
  ├─ 并发控制
  │   └─ Session 队列 + 全局队列，确保同一 Session 不并发
  │
  ├─ 插件加载（ensureRuntimePluginsLoaded）
  │
  ├─ Hook 执行
  │   ├─ before_model_resolve → 插件可覆盖 provider/model
  │   └─ before_agent_start（legacy）
  │
  ├─ 模型解析（resolveModelAsync）
  │
  ├─ 上下文窗口检查
  │   ├─ < 16K tokens → 阻止运行
  │   └─ < 32K tokens → 警告
  │
  ├─ 认证解析（resolveAuthProfileOrder）
  │   └─ 多 API Key 轮换
  │
  └─ 重试循环
      ├─ 认证失败 → 切换下一个 API Key
      ├─ thinking 不支持 → 降级
      └─ runEmbeddedAttempt() ← 单次 LLM 调用
```

---

## 9. 单次 LLM 调用（runEmbeddedAttempt）

**文件**：`src/agents/pi-embedded-runner/run/attempt.ts`

这是最核心的函数，包含从 prompt 构建到 LLM 响应处理的全过程。

### 9.1 上下文文件加载

```
resolveBootstrapContextForRun()
  ├─ loadWorkspaceBootstrapFiles()     ← 读磁盘（9 个文件）
  ├─ filterBootstrapFilesForSession()  ← Session 过滤（sub agent 只保留 5 个）
  ├─ applyBootstrapHookOverrides()     ← 插件覆盖
  └─ buildBootstrapContextFiles()      ← 转换 + 字符预算控制
      └─ EmbeddedContextFile[] = [{ path, content }, ...]
```

### 9.2 System Prompt 构建

```
buildAgentSystemPrompt({
  contextFiles, toolNames, toolSummaries,
  skillsPrompt, promptMode, ownerNumbers,
  userTimezone, sandboxInfo, ... 20+ 参数
})
  └─ 25 个 Section 硬编码拼接 → 字符串
     身份 → 工具 → 规范 → 安全 → Skills → Memory
     → 工作区 → 时间 → 消息 → Project Context → ...
```

### 9.3 User Prompt 构建

```
effectivePrompt =
  prependBootstrapPromptWarning()    ← Bootstrap 警告
  + hookResult.prependContext         ← 插件注入（如 memory-lancedb 自动召回）
  + 用户原始消息

detectAndLoadPromptImages()          ← 从文本检测图像路径并加载为 base64
```

### 9.4 LLM API 调用（流式）

```
session.prompt(effectivePrompt, { images })
  │
  ▼
for await (event of stream) {
  text_delta  → 收集文本片段，发送到渠道（流式显示）
  tool_call   → 解析工具名 → 执行工具 → 返回结果 → LLM 继续生成
  stop        → 结束
}
```

### 9.5 Session 持久化

```
sessionManager.appendMessage({ role: 'user', content, timestamp })
sessionManager.appendMessage({ role: 'assistant', content, usage, ... })
sessionManager.write()  → JSONL 文件
```

---

## 10. 结果回传

**文件**：`src/agents/command/delivery.ts`

```
deliverAgentCommandResult()
  │
  ├─ 分发计划解析
  │   └─ 确定回复到哪个渠道、哪个目标、哪个线程
  │
  ├─ 负载格式化
  │   └─ 过长消息分块（Discord 2000 字符限制等）
  │
  └─ 渠道分发
      └─ 调用对应渠道的 SDK 发送回复
         ├─ Discord: client.rest.channels.createMessage()
         ├─ Telegram: bot.sendMessage()
         ├─ Slack: web.chat.postMessage()
         └─ ...
```

---

## 11. Session 状态更新

**文件**：`src/agents/command/session-store.ts`

每次 Agent 运行后持久化以下信息：

| 字段 | 说明 |
|------|------|
| `runtimeModel` / `runtimeProvider` | 实际使用的模型和提供商 |
| `inputTokens` / `outputTokens` | Token 使用量 |
| `estimatedCostUsd` | 累计成本估算 |
| `compactionCount` | 压缩次数 |
| `abortedLastRun` | 是否被中止（下次会注入提示） |
| `systemPromptReport` | System Prompt 报告 |
| `skillsSnapshot` | 技能快照 |

---

## 12. 关键文件索引

### 渠道接收

| 文件 | 职责 |
|------|------|
| `extensions/<channel>/src/inbound.ts` | 各渠道消息入口 |
| `src/auto-reply/dispatch.ts` | 统一分发 |
| `src/auto-reply/inbound-debounce.ts` | 防抖缓冲 |
| `src/auto-reply/reply/inbound-text.ts` | 文本规范化 |
| `src/auto-reply/reply/inbound-meta.ts` | 元数据构建 |

### 执行引擎

| 文件 | 职责 |
|------|------|
| `src/agents/agent-command.ts` | 总入口 + 执行准备 + 路由 |
| `src/agents/model-fallback.ts` | 模型 Fallback |
| `src/agents/pi-embedded-runner/run.ts` | 内嵌引擎（并发、认证、重试） |
| `src/agents/pi-embedded-runner/run/attempt.ts` | 单次 LLM 调用 |

### Prompt 构建

| 文件 | 职责 |
|------|------|
| `src/agents/system-prompt.ts` | System Prompt 构建 |
| `src/agents/bootstrap-files.ts` | 上下文文件加载编排 |
| `src/agents/workspace.ts` | 文件定义 + 磁盘读取 |
| `src/agents/pi-embedded-runner/run/images.ts` | 图像检测和加载 |

### 结果回传

| 文件 | 职责 |
|------|------|
| `src/agents/command/delivery.ts` | 结果分发 |
| `src/agents/command/session-store.ts` | Session 状态更新 |
| `src/agents/pi-embedded-runner/history.ts` | 历史轮次管理 |

### 会话管理

| 文件 | 职责 |
|------|------|
| `src/config/sessions/store.ts` | Session CRUD |
| `src/config/sessions/transcript.ts` | 会话文件读写（JSONL） |
| `src/agents/pi-embedded-runner/compact.ts` | 对话压缩 |
| `src/agents/context-window-guard.ts` | 上下文窗口计算 |
