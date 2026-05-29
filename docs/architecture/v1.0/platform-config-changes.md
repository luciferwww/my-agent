# Config 模块变更说明（v0.9 → v1.0）

> 版本：v1.0
> 创建日期：2026-05-26
> 标准设计文档：[platform-config-design.md](./platform-config-design.md)
> v0.9 文档：[../platform-config-design.md](../platform-config-design.md)

本文档描述 Config 模块从 v0.9 升级到 v1.0 的所有变更。仅作为升级参考；canonical 设计请看同目录 [platform-config-design.md](./platform-config-design.md)。

---

## 1. 变更速览

| 维度 | v0.9 | v1.0 |
|---|---|---|
| 工具审批策略配置 | `ToolsConfig` 无审批配置字段；审批行为由 RuntimeApp 硬编码（有 channel 全部触发，无 channel 全部直通） | 新增 `ToolApprovalConfig` 类型与 `tools.approval` 字段；支持精确名称 / glob / 工具组简写三种匹配模式；默认 `{ allow: [], deny: [] }` |
| `PromptConfig.mode` | `PromptConfig` 包含 `mode: 'full' \| 'minimal' \| 'none'`，默认 `'full'` | 从 `PromptConfig` 移除；prompt mode 由调用方在 `RunTurnParams.promptMode` 传入（必填），不再由 config 决定 |

---

## 2. 类型变更

### 2.1 新增 `ToolApprovalConfig`

```diff
+/** 工具审批策略 */
+interface ToolApprovalConfig {
+  allow: string[];   // 直接放行（精确名称 / glob / group:xxx）→ []
+  deny: string[];    // 直接拒绝，优先于 allow → []
+}
```

**模式匹配语法**（`allow` / `deny` 条目）：

| 写法 | 语义 |
|---|---|
| `"Bash"` | 精确名称匹配（大小写敏感） |
| `"Read*"` | glob：`*` 匹配任意字符序列，`?` 匹配单字符 |
| `"group:fs"` | 展开为预定义工具集合（`Read, Write, Edit`） |

预定义工具组：

| 简写 | 展开 |
|---|---|
| `group:fs` | `Read, Write, Edit` |
| `group:exec` | `Bash` |
| `group:search` | `Grep, Glob` |
| `group:web` | `WebFetch` |
| `group:memory` | memory 相关工具 |

### 2.2 `ToolsConfig` 新增 `approval` 字段

```diff
 interface ToolsConfig {
   execTimeout: number;
   readMaxLines: number;
   webFetchTimeout: number;
   webFetchMaxChars: number;
+  /** 工具审批策略 → { allow: [], deny: [] } */
+  approval: ToolApprovalConfig;
 }
```

### 2.3 默认值变更（`defaults.ts`）

```diff
 tools: {
   execTimeout: 30,
   readMaxLines: 200,
   webFetchTimeout: 30_000,
   webFetchMaxChars: 50_000,
+  approval: {
+    allow: [],
+    deny: [],
+  },
 },
```

### 2.4 `PromptConfig` 移除 `mode` 字段

```diff
 interface PromptConfig {
-  mode: 'full' | 'minimal' | 'none';    // → 'full'（已移除）
   safetyLevel: 'strict' | 'normal' | 'relaxed'; // → 'normal'
 }
```

`mode` 不再是部署时配置项。调用方在每次 `runTurn()` 时通过 `RunTurnParams.promptMode`（必填）传入；`prompt-factory.ts` 直接使用该值，不再回退到 config。

---

## 3. 行为变更

### 3.1 审批策略三档

v0.9：RuntimeApp 中 `wireApprovalRouting()` 只在"存在 approval/interaction channel"时才注册 hook；注册后所有工具统一触发 approval。

v1.0：hook 始终注册（无论是否存在 approval channel）；hook 内按以下优先级决策：

```
有 approval/interaction channel 时：
  1. 命中 deny → 直接拒绝
  2. 命中 allow → 直接放行
  3. 两者均不命中 → 向 TurnInteractionManager 请求 prompt

无 approval/interaction channel 时（fail-closed）：
  1. 命中 allow → 直接放行
  2. 未命中 allow → 直接拒绝（即使工具不在 deny 中）
```

**影响**：
- 默认值 `allow: [], deny: []`，有 channel 时所有工具都走 prompt（与 v0.9 有 channel 场景行为一致）；
- 无 channel 场景（sub-agent、定时任务）：v0.9 全部直通 → v1.0 全部拒绝，除非主动将工具加入 `allow`；
- 审批策略实现位于 `src/runtime/tool-approval-policy.ts`，`wireApprovalRouting()` 内部调用；详见 [runtime-design.md（v1.0）](./runtime-design.md) §13。

---

## 4. 升级 checklist

1. **`ToolsConfig` 消费方**：新增了 `approval` 字段，若有对 `ToolsConfig` 做 `satisfies` 或严格 `Pick` 的代码，需要补上该字段；
2. **无 channel 场景**（如直接调用 RuntimeApp、脚本跑 sub-agent）：v0.9 下工具调用无阻拦 → v1.0 默认全部拒绝；需要在 `config.json` 的 `tools.approval.allow` 中显式列出允许的工具；
3. **`loader.test.ts`**：`tools.approval` 的 `allow` / `deny` 数组合并和默认值有独立测试用例，见设计文档 §12；
4. **`defaults.ts`**：若有自定义 `DEFAULT_AGENT_CONFIG` 覆盖，需补 `tools.approval` 字段；
5. **`RunTurnParams` 消费方**：`promptMode` 已从可选变为必填，所有调用 `runTurn()` 的地方必须传入。交互式场景传 `'full'`，sub-agent / 定时任务按需传 `'minimal'` 或 `'none'`；
6. **`PromptConfig` 消费方**：若有对 `PromptConfig` 做 `satisfies` 或解构的代码，`mode` 字段已不存在，需要删除对它的引用。

---

## 5. 不变的部分

- `loadConfig()` / `resolveAgentConfig()` / `deepMerge()` 的 API 签名；
- 分层覆盖机制（defaults → config.json → 环境变量 → CLI）；
- `ToolsConfig` 其余四个字段（`execTimeout` / `readMaxLines` / `webFetchTimeout` / `webFetchMaxChars`）；
- 所有其他模块子配置（`LLMConfig` / `RunnerConfig` / `MemoryModuleConfig` / `PromptConfig`（`safetyLevel` 字段保留） / `SessionConfig` / `WorkspaceConfig` / `CompactionConfig`）。
