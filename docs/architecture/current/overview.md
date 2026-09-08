# 架构总览

> 文档日期：2026-05-29
> 状态同步：2026-08-27（用户消息广播、用户主动中止）

---

## 1. 一句话定位

my-agent 是一个**可嵌入的 Agent 执行框架**：提供完整的 LLM 对话循环、工具执行、上下文压缩、记忆检索能力，既可通过 CLI / WebSocket channel 对外提供服务，也可作为库直接调用。

---

## 2. 模块地图

```
src/
├── runtime/                ← 装配根（Composition Root）
│   ├── RuntimeApp.ts
│   ├── bootstrap.ts
│   ├── registry-builder.ts
│   ├── prompt-factory.ts
│   └── tool-approval-policy.ts
│
├── core/
│   ├── runner/             ← 执行引擎（LLM 调用 + tool use 循环）
│   ├── session/            ← 消息历史持久化（JSONL）
│   ├── prompt/             ← System / User prompt 构建
│   ├── memory/             ← 语义记忆（向量搜索 + BM25）
│   ├── workspace/          ← 工作区初始化 + 上下文文件加载
│   ├── registry/           ← Contribution + immutable Snapshot projections
│   └── tools/              ← canonical Tool Contract + portable Schema + 内置工具
│       └── builtin/        ← fs / search / web / exec
│
├── adapters/
│   ├── llm/                ← Anthropic Provider Adapter + explicit Tool codecs
│   └── channel/            ← Channel 接口 + CliChannel + WebSocketChannel
│
└── platform/
    ├── config/             ← 配置加载、合并、类型定义
    └── logger/             ← 全局日志（Logger + ConsoleAdapter + FileAdapter）
```

---

## 3. 分层架构

```
┌─────────────────────────────────────────────────────────┐
│                      runtime/                           │
│   唯一调用 loadConfig() 的层；把全局 config 映射为     │
│   各模块所需的最小参数子集；装配所有组件               │
└────────────┬────────────────────────────────────────────┘
             │ 组装 + 调度
┌────────────▼────────────────────────────────────────────┐
│                     core/runner                         │
│   执行一次完整的 LLM 对话循环；管理上下文压缩与重试    │
└──┬──────────────┬──────────────┬──────────────┬─────────┘
   │              │              │              │
   ▼              ▼              ▼              ▼
core/session  core/prompt   core/tools   adapters/llm
（持久化）    （prompt 构建）（工具执行）  （LLM 调用）
                                │
                         core/tools/builtin
                         fs / search / web / exec
┌─────────────────────────────────────────────────────────┐
│                  adapters/channel                       │
│   CLI / WebSocket I/O 适配；TurnInteractionManager      │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│                   platform/                             │
│   config（配置加载）  logger（全局日志）                │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 关键数据流

### 4.1 一次完整 turn 的生命周期

```
Channel 入站消息
  ↓
RuntimeApp.handleInboundChannelMessage
  → media 处理 + 输入装配
  → emit user_message（同 session 多 client 广播）
  → enqueueQueuedTurn → scheduleNextQueuedTurn
  → startQueuedTurn（生成 turnId）
  ↓
RuntimeApp.runTurn
  → resolveSession（SessionManager）
  → buildSystemPrompt（SystemPromptBuilder + contextFiles）
  → buildUserPrompt（UserPromptBuilder）
  ↓
AgentRunner.run(RunParams)
  → appendMessage(user)                  ← SessionManager
  → runAttempt:
      loadHistory                        ← SessionManager
      pruneToolResults (Layer 1)
      checkContextBudget (Layer 2)
      LLM 调用循环:
        callLLMStream                    ← ResolvedModel invocation Port
        resolve/validate                 ← immutable ToolProjection
        before/after hooks               ← immutable HookProjection
        policy + current-call approval   ← explicit Application capabilities
        canonical Tool execute/result
        getSteeringMessages              ← drainSteeringMessages
  ↓
AgentEvent fanout
  → channel.send(event)                  ← CliChannel / WebSocketChannel
  → RuntimeAppOptions.onAgentEvent?

用户主动中止（CLI Ctrl+C / WS abort_turn / library abortTurn）
  → RuntimeApp.abortTurn(sessionKey)
  → AbortSignal 传入 Runner / LLM / Tool / Subagent
  → RunResult.stopReason = 'aborted'
  → 清空同 session 普通消息队列并 emit messages_dropped
```

### 4.2 压缩触发流程

```
ContextOverflowError（3 条路径中任一）
  ↓
AgentRunner.compactHistory
  → compactMessages（LLM 摘要）         ← ResolvedModel invocation Port
  → appendCompactionRecord              ← SessionManager
  → retry runAttempt（loadHistory 自动感知 compactionRecord）
```

---

## 5. 各模块文档索引

| 文档 | 覆盖内容 | v1.0 基线 |
|---|---|---|
| [runtime.md](./runtime.md) | 装配根、入站调度、approval 路由、生命周期 | ✅ |
| [core_runner.md](./core_runner.md) | 执行循环、4 层上下文管理、hook 系统 | ✅ |
| [adapter_channel.md](./adapter_channel.md) | Channel 接口、CliChannel、WebSocketChannel、TurnInteractionManager | ✅ |
| [platform_config.md](./platform_config.md) | 类型体系、4 层优先级合并、工具审批策略 | ✅ |
| [adapter_llm.md](./adapter_llm.md) | Model Invocation Adapter、Anthropic conversion、portable Tool codecs | — |
| [platform_logger.md](./platform_logger.md) | Logger 静态类、启动期 buffer、ConsoleAdapter / FileAdapter | — |
| [core_tools.md](./core_tools.md) | Canonical Tool Contract、portable Schema、Contribution/Registry Snapshot、Provider codecs | — |
| [core_tools_builtin.md](./core_tools_builtin.md) | fs / search / web / exec 工具、工厂函数、路径策略、ProcessRegistry | — |
| [core_session.md](./core_session.md) | JSONL 存储、消息树、SessionManager API | — |
| [core_prompt.md](./core_prompt.md) | SystemPromptBuilder 7 sections、UserPromptBuilder hooks | — |
| [core_memory.md](./core_memory.md) | 混合搜索、MemoryManager 组件架构、增量索引 | — |
| [core_workspace.md](./core_workspace.md) | 工作区初始化、上下文文件加载与截断 | — |

---

## 6. 核心设计原则

| 原则 | 体现 |
|---|---|
| **Composition Root 唯一** | 只有 `runtime/` 调用 `loadConfig()`；底层模块只接收最小参数子集 |
| **接口与实现分离** | `ModelInvocationPort`、`MemoryStore`、`Channel`、`LogAdapter` 均为接口，实现可替换 |
| **可选能力降级** | Memory 初始化失败不阻塞启动；无 approval transport 时 current-call capability fail closed |
| **事件自描述** | `AgentEvent` 自带 `sessionKey`；turn 内事件带 `turnId`，`user_message` 用 `messageId` 并由 `run_start.originMessageId` 关联 |
| **持久化立即写入** | 消息产生即写 JSONL，不批量——崩溃后可从磁盘恢复历史 |
| **配置边界清晰** | 每层只传下游需要的字段，不透传完整 `AgentDefaults` |
