# Platform Config 模块设计文档

> 基准版本：v1.0
> 文档日期：2026-05-29
> 关联文档：`runtime.md`

---

## 1. 概述

`src/platform/config/` 是应用的**配置中心**：统一的类型定义、一个加载函数、一个 agent 配置解析函数。目标是把散落在各模块的硬编码常量和构造参数收归到一处，让 runtime 层按需提取最小子集后传给各模块。

### 1.1 容易混淆的边界

`loadConfig()` 只负责"文件 + 硬编码默认值"合并，**不**合并环境变量和 CLI 参数——这两步在 `resolveAgentConfig()` 中叠加。Runtime 是唯一允许调用这两个函数的运行时模块；底层领域模块不直接访问 config。

---

## 2. 目录结构

```
src/platform/config/
├── index.ts        # 公共导出
├── types.ts        # 全部类型定义
├── defaults.ts     # DEFAULT_AGENT_CONFIG / DEFAULT_LOGGER_CONFIG
├── loader.ts       # loadConfig / resolveAgentConfig / deepMerge / getEnvOverrides
├── loader.test.ts
└── wizard/         # 交互式配置向导（scripts/config.ts 的实现）
    ├── fields.ts
    ├── prompts.ts
    ├── display.ts
    ├── diff.ts
    └── run-wizard.ts
```

---

## 3. 配置文件

位置：`<workspaceDir>/.agent/config.json`。只需写想覆盖的字段，文件不存在或格式错误时降级为全默认值。

```json
{
  "agents": {
    "defaults": {
      "llm": {
        "model": "claude-sonnet-4-6",
        "maxTokens": 8192
      },
      "tools": {
        "approval": {
          "allow": ["read_*", "file_search"],
          "deny": ["exec"]
        }
      }
    }
  },
  "logger": {
    "file": { "enabled": true }
  }
}
```

---

## 4. 配置来源与优先级

四层，优先级递增：

| 优先级 | 来源 | 合并时机 |
|---|---|---|
| 1 | `defaults.ts` 硬编码 | `loadConfig()` |
| 2 | `.agent/config.json` `agents.defaults` | `loadConfig()` |
| 3 | `.agent/config.json` `agents.list[i]` | `resolveAgentConfig()` |
| 4 | 环境变量 | `resolveAgentConfig(envOverrides)` |
| 5 | CLI 参数 | `resolveAgentConfig(cliOverrides)` |

### 4.1 环境变量映射

| 变量 | 字段 |
|---|---|
| `ANTHROPIC_API_KEY` | `llm.apiKey` |
| `ANTHROPIC_BASE_URL` | `llm.baseURL` |
| `MY_AGENT_MODEL` | `llm.model` |

---

## 5. 类型体系

### 5.1 顶层结构

```
AppConfig {
  workspaceDir: string        // 运行时确定，不来自文件
  agents: AgentsConfig {
    defaults: AgentDefaults
    list: AgentEntry[]        // per-agent 覆盖（预留）
  }
  logger: LoggerModuleConfig  // 日志配置
}

ConfigFile {                  // config.json 的 schema（全字段可选）
  agents?: {
    defaults?: DeepPartial<AgentDefaults>
    list?: AgentEntry[]
  }
  logger?: LoggerModuleConfig
}
```

### 5.2 AgentDefaults 子配置一览

```
AgentDefaults {
  llm:        LLMConfig
  runner:     RunnerConfig
  memory:     MemoryModuleConfig
  prompt:     PromptConfig
  session:    SessionConfig
  tools:      ToolsConfig
  workspace:  WorkspaceConfig
  compaction: CompactionConfig
}
```

### 5.3 各子配置与默认值

```
LLMConfig {
  apiKey?: string                    // 无默认；从 env 读取
  baseURL?: string                   // 无默认；Anthropic 官方端点
  model?: string                     // 无默认（预留）
  maxTokens: number                  // 4096
  contextWindowTokens: number        // 200_000（Claude 3.5/4 系列）
}

RunnerConfig {
  maxLlmCalls: number                // 12
  inTurnMessageMode: 'steer'|'followup'  // 'followup'
}

MemoryModuleConfig {
  enabled: boolean                   // true
  dbPath: string                     // '.agent/memory.sqlite'
  embedding: { provider; model; dimensions }     // local / Xenova/all-MiniLM-L6-v2 / 384
  chunking:  { chunkChars; overlapChars }        // 1600 / 320
  search:    { maxResults; minScore; vectorWeight; textWeight }  // 6 / 0.25 / 0.7 / 0.3
}

PromptConfig {
  safetyLevel: 'strict'|'normal'|'relaxed'  // 'normal'
}

SessionConfig {
  dir: string                        // 'sessions'（相对 .agent/）
}

ToolsConfig {
  execTimeout: number                // 30 秒
  readMaxLines: number               // 200 行
  webFetchTimeout: number            // 30000 毫秒
  webFetchMaxChars: number           // 50000 字符
  fs: FsToolsConfig {
    workspaceOnly: boolean           // true（限制文件工具在工作区内）
  }
  approval: ToolApprovalConfig {
    allow: string[]                  // []
    deny: string[]                   // []（优先于 allow）
  }
}

WorkspaceConfig {
  agentDir: string                   // '.agent'
  maxFileChars: number               // 20000
  maxTotalChars: number              // 150000
}

CompactionConfig {
  enabled: boolean                   // true
  reserveTokens: number              // 20000
  keepRecentTurns: number            // 3
  toolResultContextShare: number     // 0.5（最大占 50% 窗口）
  toolResultHeadChars: number        // 10000
  toolResultTailChars: number        // 5000
  timeoutSeconds: number             // 300
  customInstructions?: string        // 摘要自定义指令（可选）
}

LoggerModuleConfig {
  minLevel?: LoggerLevel             // 'info'
  console?: { enabled?; minLevel? }  // enabled=true
  file?: { enabled?; dir?; prefix?; minLevel?; maxQueueSize? }  // enabled=false
}
```

### 5.4 工具审批策略

`ToolApprovalConfig.allow` / `deny` 条目支持两种语法：

| 语法 | 示例 |
|---|---|
| 精确名称（大小写敏感） | `"exec"` |
| Glob | `"memory_*"` |

Glob 只解释 `*` 和 `?`。v1 不展开 `group:*`；例如 `group:fs` 只是字面 pattern，只会匹配同名工具，不会匹配 `read_file`。

策略优先级（有 approval channel 时）：**deny 命中 > allow 命中 > 触发 prompt**。  
无 approval channel 时：仅 allow 命中的工具可执行（fail-closed）。

---

## 6. 核心 API

### 6.1 loadConfig

```
loadConfig({ workspaceDir }): AppConfig

流程：
  1. DEFAULT_AGENT_CONFIG 作为起点
  2. deepMerge(defaults, file.agents.defaults)
  3. logger = deepMerge(DEFAULT_LOGGER_CONFIG, file.logger)
  4. 返回 { workspaceDir, agents: { defaults, list }, logger }
```

不合并环境变量和 CLI——由 `resolveAgentConfig` 负责。文件不存在或 JSON 格式错误时降级为全默认值。

### 6.2 resolveAgentConfig

```
resolveAgentConfig(appConfig, { agentId?, envOverrides?, cliOverrides? }): AgentDefaults

流程：
  1. 起点：appConfig.agents.defaults（已含文件 defaults 合并）
  2. if agentId → deepMerge(agents.list[i] 覆盖)
  3. if envOverrides → deepMerge(env 覆盖)
  4. if cliOverrides → deepMerge(CLI 覆盖)
```

当前单 agent 场景不传 `agentId`，直接在 `agents.defaults` 上叠加 env/CLI。

### 6.3 deepMerge

```
deepMerge<T>(target: T, source: DeepPartial<T>): T

规则：
  source 值为 undefined → 保留 target
  两边都是普通对象 → 递归合并
  其他 → source 覆盖 target（数组直接替换，不追加）
```

### 6.4 getEnvOverrides

```
getEnvOverrides(): DeepPartial<AgentDefaults>
```

从 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `MY_AGENT_MODEL` 提取覆盖对象。Runtime 的 `bootstrapRuntime` 调用此函数并传给 `resolveAgentConfig`。

---

## 7. Config Wizard

`src/platform/config/wizard/` 提供交互式配置生成器，入口为 `scripts/config.ts`：

```bash
npx tsx scripts/config.ts [--path <file>]
```

职责：
- 读取既有 `config.json` 作为交互默认值
- 两段式流程（核心字段必问 + 高级字段可选展开）
- **最简输出**：只写"与 `DEFAULT_*` 不同的字段"，避免文件膨胀
- 顶层未触及的段（`agents.list[]`）原样保留；`agents.defaults` / `logger` 段内按 schema 白名单过滤

不读取环境变量，不调 `loadConfig` / `resolveAgentConfig`，不验证最终装配。

---

## 8. ⚠️ 代码与 v1.0 文档的已知差异

### 差异 1：`AppConfig` 和 `ConfigFile` 缺少 `logger` 字段

**v1.0 文档** `§7.1` 和 `§7.4` 中 `AppConfig` 和 `ConfigFile` 均无 `logger` 字段。  
**实际代码**（`types.ts`）：

```typescript
AppConfig   { ..., logger: LoggerModuleConfig }
ConfigFile  { ..., logger?: LoggerModuleConfig }
```

同样，`loadConfig()` 的 v1.0 文档描述中未提到合并 `logger` 段，但实际实现做了 `deepMerge(DEFAULT_LOGGER_CONFIG, file.logger)`。

> 建议：在 `AppConfig` / `ConfigFile` 类型文档中补充 `logger` 字段，并在 `loadConfig` 流程中加入 logger 合并步骤说明。

### 差异 2：`ToolsConfig` 缺少 `fs: FsToolsConfig`

**v1.0 文档** `§7.3` 的 `ToolsConfig` 没有 `fs` 字段。  
**实际代码** `ToolsConfig` 增加了 `fs: FsToolsConfig { workspaceOnly: boolean }`（默认 `true`）。

> 建议：在 `ToolsConfig` 类型文档中补充 `fs` 子配置，说明 `workspaceOnly` 的作用和默认值。

### 差异 3：v1.0 工具组语法已移除

**v1.0 文档** `ToolApprovalConfig` 注释描述 `group:fs` 等工具组。
**实际代码**（`tool-approval-policy.ts`）不再展开 `group:*`，只支持精确名称和 `*`/`?` Glob。

> 当前配置应直接列出工具名或使用 Glob，不应依赖 `group:*` 展开。

---

## 9. 已知规划项

| 项目 | 状态 |
|---|---|
| per-agent 配置（`agents.list[]`）真正启用 | 规划中（类型已预留） |
| 配置校验（JSON Schema validate） | 规划中 |
| 更多环境变量映射 | 规划中 |
