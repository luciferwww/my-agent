# Core Prompt 模块设计文档

> 文档日期：2026-05-29
> 关联文档：`runtime.md` · `core_workspace.md`

---

## 1. 概述

`src/core/prompt/` 提供两个 Builder：

- **`SystemPromptBuilder`**：把 config + tools + contextFiles 组装为 system prompt 字符串
- **`UserPromptBuilder`**：把用户输入 + 可选 hooks 前置块组装为最终发送给 LLM 的用户消息

---

## 2. 目录结构

```
src/core/prompt/
├── types.ts                # PromptMode / ToolDefinition / SystemPromptBuildParams
│                           # UserPromptInput / BuiltUserPrompt / ContextHook / MediaAttachment
├── SystemPromptBuilder.ts  # 7-section 组装
├── UserPromptBuilder.ts    # hooks + 原始输入拼接
├── ContextPrepender.ts     # hook 注册与执行
├── token-counter.ts        # 简单 token 估算（供提示工程参考）
└── index.ts
```

---

## 3. SystemPromptBuilder

### 3.1 7 个 Section（固定顺序）

| # | Section | 触发条件 |
|---|---|---|
| 1 | `agent-identity` | 始终输出 |
| 2 | `agent-datetime` | 始终输出 |
| 3 | `tool-definitions` | tools 非空时 |
| 4 | `behavior-rules` | 始终输出 |
| 5 | `safety-constraints` | `safetyLevel !== 'relaxed'` 时 |
| 6 | `memory-instructions` | `mode === 'full'` 且有 memory 工具时 |
| 7 | `project-context` | contextFiles 非空时 |

### 3.2 构建模式（PromptMode）

| mode | 行为 |
|---|---|
| `'full'` | 全部 7 个 section |
| `'minimal'` | 跳过 Section 6（memory-instructions） |
| `'none'` | 返回空字符串 |

### 3.3 API

```
SystemPromptBuildParams {
  mode?: PromptMode           // 默认 'full'
  toolNames?: readonly string[] // 仅用于 capability 条件，不含 Schema
  safetyLevel?: 'strict' | 'normal' | 'relaxed'   // 默认 'normal'
  contextFiles?: ContextFile[]
}

builder.build(params?): string
```

Runtime 的 `prompt-factory.ts` 负责从 `resolvedConfig` 和 `RegistrySnapshot.tools` 的窄名称投影中提取参数传入。

---

## 4. UserPromptBuilder

### 4.1 拼接逻辑

```
build(input: UserPromptInput): Promise<BuiltUserPrompt>

拼接顺序：
  [hook 1 前置块]
  [hook 2 前置块]
  ...
  [用户原始输入]   ← 始终在最后
```

hooks 按注册顺序执行，返回 `null` 则跳过。媒体附件（图片、文件）单独返回，不嵌入文本。

### 4.2 API

```
UserPromptBuilder {
  useContextHook(hook: ContextHook): this    // 注册 hook（链式）
  removeContextHook(id: string): this        // 注销
  build(input: UserPromptInput): Promise<BuiltUserPrompt>
}

ContextHook {
  id: string
  provider(rawInput, metadata): string | null | Promise<string | null>
}

BuiltUserPrompt {
  text: string                   // 最终文本（hooks + 原始输入）
  attachments: MediaAttachment[] // 图片/文件附件，单独传给 LLM API
  _debug?: { rawInput; prependedChunks }
}
```

### 4.3 MediaAttachment

```
ImageAttachment { type:'image'; data: string（base64）; mimeType; caption? }
FileAttachment  { type:'file';  filename; content; mimeType; caption? }
```

---

## 5. Tool name projection

`core/prompt` 不持有第二份 Tool Schema 或 Provider-shaped definition。Runtime 只投影 Snapshot 中的精确 Tool names，用于 Memory 等窄 capability 条件：

```
toolNames = registrySnapshot.tools.definitions.map(tool => tool.name)
```

完整 canonical definitions 只由 Registry Snapshot 拥有；Anthropic/OpenAI-compatible wire mapping 只在 Provider Adapter/reference codec boundary 发生。

---

## 6. 关键设计决策

| 决策 | 说明 |
|---|---|
| SystemPromptBuilder 无状态 | 每次 `build()` 重新组装，不缓存——runtime 缓存 contextFiles 并在合适时机重新调用 |
| UserPromptBuilder hooks 链 | 允许 runtime 或库消费者注入前置上下文（如 memory 召回结果），不侵入 runner 逻辑 |
| media attachments 单独返回 | LLM API 要求附件以独立 content block 传入，不能嵌入文本字符串 |
| `mode: 'none'` 返回空字符串 | 允许库消费者完全自定义 system prompt，不依赖 Builder |
