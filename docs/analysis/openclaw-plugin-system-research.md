# OpenClaw Plugin 系统调研报告

> 用途：为 my-agent plugin 系统设计提供参考
> 调研日期：2026-04-22
> 调研对象：`c:\dev\my-agent\openclaw`

---

## 1. 概述

OpenClaw 的 plugin 系统是一个**全能扩展点**，通过统一的 `OpenClawPluginApi` 接口向第三方 plugin 暴露所有扩展能力。Plugin 可以拦截系统行为（hook）、注册新能力（工具/通道/命令）、替换内置 provider（LLM/记忆/语音等）。

Plugin 不感知系统内部实现，只通过 `api` 对象与框架交互。

---

## 2. Plugin 注册与加载

### 2.1 Plugin 定义格式

```typescript
// extensions/my-plugin/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  register(api: OpenClawPluginApi) {
    // 所有扩展能力在此注册
    api.registerTool(...);
    api.registerHook(...);
    api.on('before_tool_call', handler);
  },
});
```

### 2.2 加载流程

```
loadGatewayStartupPlugins()
  ├─ loadOpenClawPlugins()         扫描并加载所有 plugin 模块
  └─ activatePluginRegistry()
       ├─ setActivePluginRegistry() 设为全局活跃注册表
       └─ initializeGlobalHookRunner(registry)  ← Hook Runner 先于 channel 就绪
                │
startGatewaySidecars()
  └─ startChannels()               Channel 启动（此时 Hook Runner 已就绪）
```

**关键顺序**：Hook Runner 初始化早于所有 Channel 的 `startAccount()`，channel 启动时可安全调用 hook。

### 2.3 Plugin 去重机制

- 同名 hook（`name` 字段）重复注册会报 error 并忽略
- Provider 类 注册多为独占槽位（exclusive slot），第二个注册会失败
- Tool、Channel 等可多个共存

---

## 3. Hook 系统

### 3.1 所有 Hook 名称（31 种）

| 分类 | Hook 名称 |
|------|-----------|
| **工具执行** | `before_tool_call`, `after_tool_call`, `tool_result_persist` |
| **LLM 调用** | `llm_input`, `llm_output` |
| **Agent 生命周期** | `before_agent_start`, `before_agent_reply`, `agent_end` |
| **提示词** | `before_model_resolve`, `before_prompt_build` |
| **消息** | `before_message_write`, `message_received`, `message_sending`, `message_sent`, `inbound_claim` |
| **会话** | `session_start`, `session_end`, `before_reset` |
| **压缩** | `before_compaction`, `after_compaction` |
| **子 Agent** | `subagent_spawning`, `subagent_delivery_target`, `subagent_spawned`, `subagent_ended` |
| **网关** | `gateway_start`, `gateway_stop` |
| **分发** | `before_dispatch`, `reply_dispatch` |
| **安装** | `before_install` |

### 3.2 Hook 注册方式

```typescript
// 推荐方式（类型安全）
api.on('before_tool_call', async (event, ctx) => { ... }, { priority: 100 });

// 低级方式（多事件绑定）
api.registerHook(['before_tool_call', 'after_tool_call'], handler, { name: 'my-hook' });
```

**选项**：
- `name`（必须，唯一标识符，用于去重和日志）
- `priority`（数字，高值优先执行）
- `description`（可选，文档用途）

### 3.3 Hook 执行语义

| Hook 类型 | 执行方式 | 能否修改数据 | 能否终止链 |
|-----------|----------|------------|-----------|
| `before_tool_call` | sequential，逐个 await | 是（返回 `params`） | 是（返回 `block: true`） |
| `after_tool_call` | sequential | 否 | 否 |
| `tool_result_persist` | sequential | 是 | 是 |
| `before_message_write` | sequential | 是 | 是 |
| `llm_input` / `llm_output` | sequential | 是 | 否 |
| `session_start/end` 等生命周期 | parallel（fire-and-forget） | 否 | 否 |

**失败策略**（`failurePolicyByHook`）：

- `before_tool_call`：`fail-closed`（hook 抛异常 → 工具被阻止）
- 其他大多数：`fail-open`（hook 抛异常 → warn log，继续执行）

### 3.4 `before_tool_call` 返回值详解

```typescript
type BeforeToolCallResult =
  | undefined                          // 允许，不修改参数
  | { params: Record<string, unknown> } // 允许，修改参数
  | { block: true; blockReason: string } // 阻止执行（终止链）
  | {
      requireApproval: {               // 触发 approval 流程
        title: string;
        description: string;
        severity: 'low' | 'medium' | 'high' | 'critical';
        pluginId: string;
        timeoutMs?: number;            // 默认 120_000
        timeoutBehavior?: 'allow' | 'deny';  // 默认 'deny'
        onResolution?: (decision: ApprovalResolution) => Promise<void>;
      };
    };
```

多个 hook 返回的 `params` 会被**深度合并**（后执行的 hook 可基于前一个 hook 修改后的 params 继续修改）。

### 3.5 Hook 与 Channel 的关系

- **完全解耦**：channel plugin 不注册 hook，hook plugin 不感知 channel
- Channel 通过 `api.on('subagent_spawning', ...)` 等方式**监听** hook 事件，但不**拥有** hook
- Approval 流程的唯一连接点是 Gateway 的 `plugin.approval.*` RPC，两者通过 Gateway 中间层通信

---

## 4. 能力注册

### 4.1 工具注册

```typescript
api.registerTool(tool: AnyAgentTool, opts?: {
  agentIds?: string[];   // 只对特定 agent 可见
  hidden?: boolean;      // 在提示词中隐藏
});
```

### 4.2 Channel 注册

```typescript
api.registerChannel(channelPlugin: ChannelPlugin);
// 等价于声明此 plugin 实现了一个新的消息通道
// ChannelPlugin 接口见 channel 调研文档
```

### 4.3 Gateway RPC 方法注册

```typescript
api.registerGatewayMethod(
  'my-plugin.do-something',
  async (params, ctx) => { return result; },
  { scope: 'operator.user' }  // 权限 scope
);
```

注册后，WS 客户端可调用 `my-plugin.do-something` 方法。

### 4.4 HTTP 路由注册

```typescript
api.registerHttpRoute({
  method: 'POST',
  path: '/api/my-plugin/action',
  handler: async (req, res) => { ... },
  scope: 'operator.user',
});
```

### 4.5 CLI 命令注册

```typescript
api.registerCli((program) => {
  program
    .command('my-command')
    .description('...')
    .action(async (opts) => { ... });
});
```

### 4.6 自定义命令（绕过 LLM）

```typescript
api.registerCommand({
  name: '/toggle-feature',
  description: '直接切换功能，不经过 LLM',
  handler: async (ctx) => {
    // 直接执行，返回结果给用户
    return { text: 'Feature toggled.' };
  },
});
```

---

## 5. Provider 替换

所有 provider 为**独占槽位**，同类型只能注册一个。

| 注册方法 | 替换对象 | 备注 |
|----------|----------|------|
| `registerProvider()` | LLM 模型推理 | 替换核心 LLM |
| `registerMemoryRuntime()` | 记忆系统运行时 | 独占 |
| `registerMemoryEmbeddingProvider()` | 向量嵌入 | 独占 |
| `registerMemoryPromptSection()` | 记忆提示词构建 | 独占 |
| `registerSpeechProvider()` | 语音合成（TTS） | 独占 |
| `registerRealtimeTranscriptionProvider()` | 实时语音转文字（STT） | 独占 |
| `registerRealtimeVoiceProvider()` | 双工实时语音 | 独占 |
| `registerMediaUnderstandingProvider()` | 多媒体理解 | 独占 |
| `registerImageGenerationProvider()` | 图像生成 | 独占 |
| `registerVideoGenerationProvider()` | 视频生成 | 独占 |
| `registerMusicGenerationProvider()` | 音乐生成 | 独占 |
| `registerWebFetchProvider()` | 网页获取 | 独占 |
| `registerWebSearchProvider()` | 网页搜索 | 独占 |
| `registerContextEngine()` | 上下文引擎 | 独占 |

---

## 6. Plugin 访问的上下文信息

Plugin 通过 `api` 可访问：

```typescript
api.id              // plugin ID
api.config          // OpenClaw 全局配置（只读）
api.pluginConfig    // 本 plugin 的配置段
api.logger          // 日志（debug/info/warn/error）
api.runtime         // 运行时助手（仅受信任的原生 plugin 可用）
api.resolvePath()   // 相对于 plugin 根目录的路径解析
```

---

## 7. Plugin Manifest（静态能力声明）

Plugin 可以在 `package.json` 或 `manifest.ts` 里静态声明自己的能力，用于启动时快速扫描，不需要实际加载模块：

```typescript
type PluginManifest = {
  id: string;
  name: string;
  version: string;
  channels?: string[];                     // 声明的 channel ID
  tools?: string[];                        // 声明的工具名
  providers?: string[];                    // 声明的 provider ID
  skills?: string[];                       // 声明的技能 ID
  cliBackends?: string[];                  // CLI 推理后端
  memoryEmbeddingProviders?: string[];
  speechProviders?: string[];
  imageGenerationProviders?: string[];
  // ... 其他 provider 类型
};
```

---

## 8. 与 my-agent 的对应关系

OpenClaw plugin 系统包含三大类能力，my-agent 目前的覆盖情况：

| 能力分类 | OpenClaw 实现 | my-agent 现状 | 备注 |
|----------|---------------|----------------|------|
| **行为拦截** | 31 种 hook | `before/after_tool_call` ✓ | my-agent hook 系统对应此类 |
| **新能力注册** | 工具、channel、HTTP、命令 | `toolExecutor` 回调；channel 层设计中 | plugin 系统设计目标 |
| **Provider 替换** | 13 种独占槽位 | `LLMClient` 接口可替换，其余无 | plugin 系统设计目标 |

**核心差异**：OpenClaw 把上述三类能力全部统一在 plugin 系统下；my-agent 目前各扩展点是独立模块（hook 系统、channel 层），plugin 系统是把这些扩展点整合成统一注册接口的上层抽象。

---

## 9. 关键文件索引

| 文件 | 内容 |
|------|------|
| `src/plugins/api-builder.ts` | `OpenClawPluginApi` 完整接口定义（46 个方法） |
| `src/plugins/types.ts` | `PluginHookName`（31 种）、所有 plugin 类型定义 |
| `src/plugins/registry.ts` | `registerHook` / `registerTool` 等实现，去重逻辑 |
| `src/plugins/hooks.ts` | Hook 执行引擎，`runBeforeToolCall` 等 |
| `src/plugins/hook-runner-global.ts` | 全局 Hook Runner 单例，`initializeGlobalHookRunner` |
| `src/plugins/loader.ts` | Plugin 加载流程，`activatePluginRegistry` |
| `src/plugins/manifest.ts` | `PluginManifest` 静态能力声明类型 |
| `src/agents/pi-tools.before-tool-call.ts` | `before_tool_call` hook 的调用入口和 approval 流程 |
| `extensions/bluebubbles/src/channel.ts` | 最简 channel plugin 实现示例 |
