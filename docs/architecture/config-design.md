# Config 模块设计

## 1. 动机

目前各模块的配置散落在代码中——硬编码常量（`DEFAULT_MAX_TOKENS`、`DEFAULT_CHUNK_CHARS` 等）和构造函数参数各自为政，没有统一的配置入口。随着模块增多，这种分散的方式会带来几个问题：

- **改一个值要找到对应源文件**，无法集中管理
- **环境变量和 API Key 没有标准读取路径**，AnthropicClient 的 apiKey 必须手动传入
- **新模块没有参考规范**，每个模块各自定义自己的 config 接口
- **未来加 CLI、多 agent 时缺少扩展点**

Config 模块的目标是：**一个中心化的类型定义 + 一个统一的加载函数**，收拢所有可配置项，同时不改动现有模块的内部实现。

## 2. 设计原则

| 原则 | 说明 |
|------|------|
| **显式参数传递** | 参考 OpenClaw：无全局状态，config 作为参数在模块间传递 |
| **分层覆盖** | 默认值 → 配置文件 → 环境变量 → CLI 参数，优先级递增 |
| **部分配置** | 配置文件中只需写想改的字段，其余自动继承默认值 |
| **类型安全** | 完整的 TypeScript 类型定义，IDE 自动补全 |
| **向前兼容** | 预留 `agents.list[]` per-agent 覆盖结构，当前单 agent 不需要也不碍事 |

### 2.1 配置访问边界

Config 模块的目标不只是提供 `loadConfig()`，还要收拢配置访问边界。

除 `config` 模块本身、`runtime` 模块，以及少数以“配置管理 / 外层入口”为职责的模块外，其余领域模块原则上不应直接访问 config。

这里的“直接访问 config”包括：

- 直接调用 `loadConfig()`；
- 直接调用 `resolveAgentConfig()`；
- 通过 `process.env` 绕过 Runtime 读取关键运行配置；
- 在领域模块中以完整 `AgentDefaults` 作为常规输入接口。

推荐的边界是：

- `config` 负责加载、解析、合并配置；
- `runtime` 负责把全局 config 映射为各模块所需的最小配置子集；
- 底层模块通过构造参数、工厂参数或 run params 接收自己真正需要的局部 options。

这条约束的目的，是避免全局配置结构向下层模块渗透，确保 Runtime 真正承担 composition root 的职责。

## 3. 配置文件

### 3.1 位置

```
<workspaceDir>/.agent/config.json
```

跟随项目，与 session、memory 等数据同在 `.agent/` 下。

### 3.2 示例

```json
{
  "agents": {
    "defaults": {
      "llm": {
        "model": "claude-sonnet-4-20250514",
        "maxTokens": 8192
      },
      "memory": {
        "search": {
          "maxResults": 10
        }
      }
    },
    "list": [
      {
        "id": "coding",
        "llm": { "model": "claude-opus-4-20250514" },
        "memory": { "enabled": true }
      }
    ]
  }
}
```

切换到上下文窗口较小的模型时，需在 `llm` 下显式覆盖 `contextWindowTokens`：

```json
{
  "agents": {
    "defaults": {
      "llm": {
        "model": "some-small-model",
        "contextWindowTokens": 32000
      }
    }
  }
}
```

只需写想覆盖的字段。不存在或解析失败时降级为全默认值。

## 4. 配置来源与优先级

四层来源，优先级递增：

| 优先级 | 来源 | 说明 |
|-------|------|------|
| 1（最低） | `defaults.ts` 硬编码默认值 | 兜底，永远存在 |
| 2 | `.agent/config.json` 文件 | 项目级定制（`agents.defaults` + `agents.list[i]`） |
| 3 | 环境变量 | 部署/CI 场景 |
| 4（最高） | CLI 参数 | 运行时临时覆盖 |

具体的合并流程见第 6 节。

### 4.1 环境变量映射

只映射少量关键变量（不做通用 `MY_AGENT_*` 前缀，复杂度高可读性差）：

| 环境变量 | 映射字段 |
|---------|---------|
| `ANTHROPIC_API_KEY` | `llm.apiKey` |
| `ANTHROPIC_BASE_URL` | `llm.baseURL` |
| `MY_AGENT_MODEL` | `llm.model` |

### 4.2 API Key 优先级

```
CLI > ANTHROPIC_API_KEY 环境变量 > agents.list[i].llm.apiKey > agents.defaults.llm.apiKey > undefined
```

## 5. 类型设计

### 5.1 顶层结构

```typescript
/** 应用顶层配置（loadConfig 的返回值） */
interface AppConfig {
  workspaceDir: string;                // 运行时确定，不来自文件
  agents: AgentsConfig;                // agent 配置（defaults + list）
}

/** agents 配置分区 */
interface AgentsConfig {
  defaults: AgentDefaults;             // 全局默认配置
  list: AgentEntry[];                  // per-agent 覆盖列表（预留）
}
```

### 5.2 AgentDefaults — 单个 agent 的完整配置集

```typescript
interface AgentDefaults {
  llm: LLMConfig;
  runner: RunnerConfig;
  memory: MemoryModuleConfig;
  prompt: PromptConfig;
  session: SessionConfig;
  tools: ToolsConfig;
  workspace: WorkspaceConfig;
  compaction: CompactionConfig;
}
```

### 5.3 各模块子配置

```typescript
/** LLM 配置 */
interface LLMConfig {
  apiKey?: string;          // Anthropic API Key
  baseURL?: string;         // 自定义端点（LiteLLM Proxy 等）
  model?: string;           // 默认模型（预留）
  maxTokens: number;        // 默认 max tokens → 4096
  /**
   * 模型上下文窗口大小（tokens）。默认值适用于 Claude 3.5 Sonnet / Claude 4 系列（200k）。
   * 使用其他模型时应在 config.json 中显式覆盖，否则压缩触发时机将基于错误的窗口大小计算。
   */
  contextWindowTokens: number;  // → 200_000
}

/** Agent Runner 配置 */
interface RunnerConfig {
  maxToolRounds: number;    // 内层 tool-use 最大轮数 → 10
  maxFollowUpRounds: number; // 外层 followUp 最大轮数 → 5
}

/** Memory 模块配置 */
interface MemoryModuleConfig {
  enabled: boolean;         // 是否启用 → true
  dbPath: string;           // SQLite 路径（相对 workspaceDir）→ '.agent/memory.sqlite'
  embedding: {
    provider: 'local' | 'openai';  // → 'local'
    model: string;                  // → 'Xenova/all-MiniLM-L6-v2'
    dimensions: number;             // → 384
  };
  chunking: {
    chunkChars: number;     // → 1600
    overlapChars: number;   // → 320
  };
  search: {
    maxResults: number;     // → 6
    minScore: number;       // → 0.25
    vectorWeight: number;   // → 0.7
    textWeight: number;     // → 0.3
  };
}

/** Prompt 配置 */
interface PromptConfig {
  mode: 'full' | 'minimal' | 'none';          // → 'full'
  safetyLevel: 'strict' | 'normal' | 'relaxed'; // → 'normal'
}

/** Session 配置 */
interface SessionConfig {
  dir: string;              // 目录名（相对 .agent/）→ 'sessions'
}

/** Tools 配置 */
interface ToolsConfig {
  execTimeout: number;      // exec 超时（秒）→ 30
  readMaxLines: number;     // read_file 最大行数 → 200
  webFetchTimeout: number;  // web_fetch 超时（毫秒）→ 30000
  webFetchMaxChars: number; // web_fetch 最大字符数 → 50000
}

/** Workspace 配置 */
interface WorkspaceConfig {
  agentDir: string;         // → '.agent'
  maxFileChars: number;     // 上下文单文件最大 → 20000
  maxTotalChars: number;    // 上下文总上限 → 150000
}

/** 对话压缩配置（contextWindowTokens 从 llm.contextWindowTokens 读取，不在此处定义） */
interface CompactionConfig {
  enabled: boolean;             // → true
  reserveTokens: number;        // 为新回复和 system prompt 预留 → 20000
  keepRecentTurns: number;      // 压缩后保留最近 N 个用户轮次 → 3
  /**
   * 单条 tool result 最大占 context window 的比例。
   * 运行时计算：maxChars = contextWindowTokens × 2 × toolResultContextShare
   * → 0.5（即最大占 50% 窗口）
   */
  toolResultContextShare: number;
  toolResultHeadChars: number;  // 保留头部字符数 → 10000
  toolResultTailChars: number;  // 保留尾部字符数 → 5000
  timeoutSeconds: number;       // 压缩超时（秒）→ 300
  customInstructions?: string;  // 摘要生成的自定义指令（可选）
}

/** agents.list 中的单项：id + 覆盖字段 */
interface AgentEntry extends DeepPartial<AgentDefaults> {
  id: string;               // agent 标识，如 "main"、"coding"
  default?: boolean;         // 是否为默认 agent
}
```

### 5.4 配置文件 Schema

```typescript
/** config.json 的类型——所有字段可选，不含 workspaceDir */
interface ConfigFile {
  agents?: {
    defaults?: DeepPartial<AgentDefaults>;
    list?: AgentEntry[];
  };
}
```

## 6. Agent 覆盖机制

借鉴 OpenClaw 的 `agents.defaults` + `agents.list[]` 模型，配合环境变量和 CLI 叠加。

`resolveAgentConfig` 的完整合并流程：

```
1. defaults.ts 硬编码默认值      ← 兜底
2. config.json agents.defaults   ← 文件级定制
3. config.json agents.list[i]    ← per-agent 覆盖
4. 环境变量                      ← 部署/CI 覆盖
5. CLI 参数                      ← 最高优先级
```

每一步只合并出现的字段，未出现的继承上一步的值。

示例：

```json
{
  "agents": {
    "defaults": {
      "llm": { "model": "claude-sonnet-4-20250514" },
      "memory": { "enabled": true }
    },
    "list": [
      {
        "id": "main",
        "default": true
      },
      {
        "id": "coding",
        "llm": { "model": "claude-opus-4-20250514" }
      }
    ]
  }
}
```

每个 agent 的实际配置：

| 字段 | main | coding |
|------|------|--------|
| llm.model | `claude-sonnet-4-20250514`（继承） | `claude-opus-4-20250514`（覆盖） |
| memory.enabled | `true`（继承） | `true`（继承） |

**当前只有单 agent，不传 `agentId` 即可**。`resolveAgentConfig` 会跳过 per-agent 合并，直接在 `agents.defaults` 上叠加环境变量和 CLI。

## 7. 文件结构

```
src/config/
├── index.ts          # 公共导出
├── types.ts          # 完整类型定义
├── defaults.ts       # DEFAULT_AGENT_CONFIG 常量
├── loader.ts         # loadConfig() + deepMerge() + resolveAgentConfig()
└── loader.test.ts    # 单元测试
```

## 8. 核心 API

### 8.1 loadConfig

```typescript
function loadConfig(options: {
  workspaceDir: string;
}): AppConfig
```

读取配置文件，合并硬编码默认值和 `config.json`，返回 AppConfig。
**不合并环境变量和 CLI**——这些在 `resolveAgentConfig` 中叠加。

### 8.2 resolveAgentConfig

```typescript
function resolveAgentConfig(
  config: AppConfig,
  options?: {
    agentId?: string;
    envOverrides?: DeepPartial<AgentDefaults>;
    cliOverrides?: DeepPartial<AgentDefaults>;
  },
): AgentDefaults
```

产出指定 agent 的最终配置。在 `loadConfig` 已完成第 1、2 步（硬编码 + 文件 defaults 合并）的基础上，继续合并：

1. `config.agents.list` 中匹配 `agentId` 的条目（per-agent 覆盖）
2. `envOverrides`（环境变量）
3. `cliOverrides`（CLI 参数）

不传 agentId 或未找到时跳过第 1 步。

### 8.3 deepMerge

```typescript
function deepMerge<T>(target: T, source: DeepPartial<T>): T
```

深度合并工具函数。`undefined` 值不覆盖已有值，数组和非对象值直接替换。

## 9. 与现有模块的关系

各模块从自己的硬编码常量迁移到从 config 读取，由 orchestrator/entrypoint 统一传入。迁移计划见第 10 节。

将来的使用方式（伪代码）：

```typescript
const config = loadConfig({ workspaceDir });
const resolved = resolveAgentConfig(config, {
  agentId,
  envOverrides: getEnvOverrides(),
  cliOverrides,
});

const llm = new AnthropicClient(resolved.llm.apiKey!, resolved.llm.baseURL);
const memory = await MemoryManager.create({
  workspaceDir,
  dbPath: resolved.memory.dbPath,
  embedding: resolved.memory.embedding,
});
const runner = new AgentRunner({ llmClient: llm, ... });
```

当前单 agent 场景下：

```typescript
const config = loadConfig({ workspaceDir });
const resolved = resolveAgentConfig(config, {
  envOverrides: getEnvOverrides(),
});
// resolved 就是最终可用的配置
```

### 9.1 现有硬编码与 config 字段的映射

| 模块 | 当前硬编码位置 | 对应 config 字段 |
|------|--------------|-----------------|
| agent-runner | `AgentRunner.ts` DEFAULT_MAX_TOKENS / DEFAULT_MAX_TOOL_ROUNDS / DEFAULT_MAX_FOLLOWUP_ROUNDS | `runner.*`, `llm.maxTokens` |
| llm-client | `AnthropicClient.ts` DEFAULT_MAX_TOKENS | `llm.apiKey`, `llm.baseURL`, `llm.maxTokens` |
| memory | `MemoryManager.ts` DEFAULT_DB_PATH, `MemoryIndexer.ts` DEFAULT_CHUNK_CHARS / DEFAULT_OVERLAP_CHARS, `MemorySearcher.ts` DEFAULT_MAX_RESULTS / DEFAULT_MIN_SCORE / DEFAULT_*_WEIGHT, `LocalEmbeddingProvider.ts` DEFAULT_MODEL / DEFAULT_DIMENSIONS | `memory.*` |
| prompt-builder | `SystemPromptBuilder.ts` 构建参数 | `prompt.mode`, `prompt.safetyLevel` |
| session | `SessionManager.ts` SESSIONS_DIR | `session.dir` |
| tools | `exec.ts` DEFAULT_TIMEOUT_SECONDS, `read-file.ts` DEFAULT_MAX_LINES, `web-fetch.ts` DEFAULT_TIMEOUT_MS / DEFAULT_MAX_CHARS | `tools.*` |
| workspace | `init.ts` AGENT_DIR, `loader.ts` DEFAULT_MAX_FILE_CHARS / DEFAULT_MAX_TOTAL_CHARS | `workspace.*` |

## 10. 开发计划

1. 创建 `src/config/types.ts` — 所有类型定义
2. 创建 `src/config/defaults.ts` — 硬编码默认值常量
3. 创建 `src/config/loader.ts` — `loadConfig()`、`resolveAgentConfig()`、`deepMerge()`
4. 创建 `src/config/index.ts` — 公共导出
5. 创建 `src/config/loader.test.ts` — 单元测试
6. 创建 `scripts/test-config-integration.ts` — 集成测试

**交付物**：独立可用的 config 模块，不改动现有模块。

如何将 config 与各模块串联（读取配置 → 参数传入 → 初始化），属于 entrypoint 模块的职责，见其独立设计文档。

## 11. 测试计划

### 单元测试（`loader.test.ts`）

- `deepMerge`：空 source、scalar 覆盖、嵌套合并、undefined 不覆盖、不可变性
- `loadConfig`：无文件返回默认值、文件合并、部分配置不影响其他模块、无效 JSON 降级、保留 agents.list
- `resolveAgentConfig`：无 agentId 返回 defaults 基线、agentId 不存在返回 defaults 基线、per-agent 合并、envOverrides 覆盖 list 值、cliOverrides 覆盖 env 值、apiKey 五级优先级链

### 集成测试（`scripts/test-config-integration.ts`）

- 创建临时目录 + config.json，验证 loadConfig 端到端行为
- 验证 resolveAgentConfig 多 agent 场景
- 验证 env 和 CLI override 优先级
- 无效 JSON 降级

### 运行方式

```bash
npx vitest run src/config/
npx tsx scripts/test-config-integration.ts
```
