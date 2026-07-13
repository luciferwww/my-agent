# Config 结构重构 Spec

> 文档日期：2026-06-26
> 关联文档：`v1.0/platform-config-design.md` · `current/platform_config.md` · `core-subagent-spec.md`

---

## 1. 背景

当前 `ToolsConfig` 结构存在以下问题：

1. **行为参数 flat 堆放**：`execTimeout`、`readMaxLines`、`webFetchTimeout`、`webFetchMaxChars` 全部平铺在 `tools` 顶层，每加一个工具参数就污染顶层，无法扩展。
2. **`approval` 嵌套与命名重叠**：`tools.approval.allow/deny` 与（未来需要的）顶层工具集控制字段同名同形，用户读 config 易混淆。同时 approval 只能在运行时拦截工具调用，无法在 LLM schema 暴露前剪枝——禁用工具仍会消耗 input tokens、引发 LLM 反复尝试。
3. **group 机制与动态工具注册冲突**：`tools.approval.allow/deny` 支持 `group:fs`、`group:search` 等静态分组，但动态注册的工具无法加入任何 group，等于对动态工具永远失效。
4. **subagents 节尚未存在**：subagent 相关配置（`core-subagent-spec.md §12`）还没有对应的 TypeScript 类型和默认值。
5. **多个 config 字段是「假字段」**：用户填了不起作用，导致 spec 与运行时行为不一致——见 §1.1 清单。

### 1.1 假字段清单（代码核对结果）

以下字段当前 config 接收但**运行时根本不消费**，是 spec 与代码长期不一致的源头：

| 假字段 | 实际硬编码位置 |
|---|---|
| `workspace.agentDir` | [src/core/workspace/init.ts#L14](../../src/core/workspace/init.ts#L14)、[src/core/workspace/loader.ts#L6](../../src/core/workspace/loader.ts#L6)、[src/core/session/SessionManager.ts#L54](../../src/core/session/SessionManager.ts#L54) 三处都硬写 `'.agent'` |
| `session.dir` | [src/core/session/SessionManager.ts#L15](../../src/core/session/SessionManager.ts#L15) `const SESSIONS_DIR = 'sessions'`，构造器不接 dir 参数 |
| `memory.embedding.dimensions` | [src/core/memory/internal/LocalEmbeddingProvider.ts#L80](../../src/core/memory/internal/LocalEmbeddingProvider.ts#L80) `createEmbeddingProvider` 仅 destructure `provider/model`，dimensions 被丢弃 |
| `tools.execTimeout` / `readMaxLines` / `webFetchTimeout` / `webFetchMaxChars` | 各工具自己使用 `DEFAULT_*` 常量，不读 config |

这些字段统一在本次重构中删除，从 spec / types / defaults / wizard 一并消失。

---

## 2. 目标

- `tools` 节按工具分组，行为参数和权限策略职责分离
- 顶层只保留**一对** `tools.allow / deny`，承载「允许 / 禁用 / 需审批」三档语义；删除 `tools.approval` 嵌套
- `tools.deny` 在工具注册时即过滤（LLM 完全感知不到），节省 token 并避免 LLM 反复试探
- 去掉 `group:*` 支持，改用精确名 + glob
- 新增 `subagents` 节，纳入 `AgentDefaults`
- **清理 §1.1 列出的假字段**——能按约定推导的固定路径、能从 model 反查的派生值，都不再让用户配置
- **削减低价值可配置字段**：`memory.dbPath` 改为约定路径；`logger.file.dir/prefix/maxQueueSize` 删除（FileAdapter 默认值已足够）

---

## 3. 非目标

- 不改 `llm` / `runner` / `prompt` / `compaction` 的结构
- `memory` 与 `logger` 的**顶层**结构不动，仅在子字段上瘦身（详见 §8）
- 不做多 agent（`agents.list[]`）的完整实现，`list` 继续预留为空
- 不改主 agent **builtin 工具集**的注册顺序——只在每个注册入口尾部新增一道 deny 过滤

---

## 4. 目标 config 结构

完整示例（仅写想覆盖的字段，其余继承默认值）：

```json
{
  "agents": {
    "defaults": {
      "llm": {
        "apiKey": "sk-ant-...",
        "baseURL": "https://...",
        "maxTokens": 4096,
        "contextWindowTokens": 200000
      },
      "runner": {
        "maxLlmCalls": 12,
        "inTurnMessageMode": "followup"
      },
      "memory": {
        "enabled": true,
        "embedding": {
          "provider": "local",
          "model": "Xenova/all-MiniLM-L6-v2"
        },
        "chunking": { "chunkChars": 1600, "overlapChars": 320 },
        "search": {
          "maxResults": 6,
          "minScore": 0.25,
          "vectorWeight": 0.7,
          "textWeight": 0.3
        }
      },
      "prompt":    { "safetyLevel": "normal" },
      "workspace": { "maxFileChars": 20000, "maxTotalChars": 150000 },
      "compaction": {
        "enabled": true,
        "reserveTokens": 20000,
        "keepRecentTurns": 3,
        "toolResultContextShare": 0.5,
        "toolResultHeadChars": 10000,
        "toolResultTailChars": 5000,
        "timeoutSeconds": 300
      },

      "tools": {
        "fs":    { "workspaceOnly": true },
        "allow": ["read_file", "grep_search", "file_search"],
        "deny":  ["exec"]
      },

      "subagents": {
        "enabled":  true,
        "maxDepth": 1,
        "list": [
          {
            "id":          "code-reviewer",
            "description": "审计代码安全问题，合并前使用。",
            "model":       "inherit",
            "maxLlmCalls": 20,
            "tools": {
              "deny": ["exec", "write_file", "apply_patch", "edit_file"]
            }
          }
        ]
      }
    },
    "list": []
  },
  "logger": {
    "minLevel": "info",
    "console": { "enabled": true },
    "file":    { "enabled": false }
  }
}
```

### 4.1 约定优于配置：固定路径与派生值

下表路径与值由代码按约定推导，**用户不可配置**（删了相关字段）：

| 路径 / 值 | 规则 |
|---|---|
| Agent 根目录 | `<workspaceDir>/.agent/` |
| Memory DB | `<workspaceDir>/.agent/memory.sqlite` |
| Session 目录 | `<workspaceDir>/.agent/sessions/` |
| Subagent 个性目录 | `<workspaceDir>/.agent/subagents/<id>/`（目录不存在 → 视为匿名 subagent） |
| Log 目录 | `<workspaceDir>/logs/`（bootstrap 固定传给 FileAdapter） |
| Embedding 维度 | 由 `embedding.model` 反查（详见 §7.4） |
| `exec` 默认超时 / `read_file` 默认行数 / `web_fetch` 超时与上限 | 工具自身的 `DEFAULT_*` 常量 |

---

## 5. 工具控制

工具相关 config 字段分两层，职责独立：

| 层 | 字段 | 控制什么 |
|---|---|---|
| 工具行为参数 | `tools.fs` | 文件系统工具是否限制在 workspace 内 |
| 工具策略 | `tools.allow / deny`（主 agent）<br>`subagents.list[].tools.allow / deny`（subagent） | 单个工具是允许 / 禁用 / 需审批 |

> `tools.exec.timeout` / `readFile.maxLines` / `webFetch.timeout` / `webFetch.maxChars` 本轮不入 config。各工具使用自身的 `DEFAULT_*` 常量；以后真需要外部可调时再同步加入 + 接通。

### 5.1 三档语义

用户视角下，`tools.allow / deny` 把工具划分到三档之一：

| 工具所在位置 | 结果 |
|---|---|
| 在 `deny` | **禁用**：LLM 完全感知不到该工具（schema 不暴露） |
| 在 `allow`（且不在 `deny`） | **直接执行**：不弹审批 |
| 既不在 `allow` 也不在 `deny` | **需审批**：弹审批等待用户决策（有 approval channel）/ 直接拒绝（无 channel） |

### 5.2 为什么 `allow` 与 `deny` 在实现上不对称

> 内部处理逻辑上不对称，但外接口其实是统一的。

两者作用点不同：

| 字段 | 作用点 | 形式 |
|---|---|---|
| `deny` | **工具注册时**——每个注册入口（builtin / memory tools / 未来 MCP 动态工具）都过同一份 `applyDenyFilter`，过滤后才把剩余工具的 schema 暴露给 LLM | 每次注册时应用 |
| `allow` | **运行时**——`before_tool_call` hook 命中 allow 即短路成自动通过，未命中走 prompt | 每次工具调用时判断 |

> “注册时”不等于“启动时一次性”。动态注册（如 MCP server 运行中连上后注入的工具）也走同一份 `applyDenyFilter` 那一趟，所以 deny 列表中的 glob 能命中以后才出现的工具（§6.3）。

这种不对称是有意为之的优化：

1. **节省 token**：被 `deny` 的工具如果还出现在 LLM schema 里，每次 LLM 调用都要付 input tokens（约 100–500 tokens/工具）。注册时过滤后这部分开销直接为零。
2. **避免无效尝试与幻觉**：如果 LLM 看到 `delete-all` 但调用被审批层拒，可能在 reasoning 中反复犹豫、换其他工具绕路尝试，浪费 output tokens；干脆不暴露可让 LLM 的世界观从一开始就干净。
3. **subagent 隔离更可靠**：subagent 一般 deny 列表更长（如 code-reviewer deny 所有写工具），这种场景下注册时过滤的收益更明显。

外接口上，用户只需写「这个工具放在 allow 还是 deny，或者都不放」，两个字段都是 `string[]`、都接受精确名或 glob、语义都对应一档行为。实现细节用户不需要关心。

### 5.3 主 agent 与 subagent 的选择规则

字段语义一致；subagent 不写时**降级用主 agent 的同名列表**。

| 字段 | 主 agent | subagent |
|---|---|---|
| `allow` 不写 | 等同 `[]`（无工具免审批） | 降级用主 agent 的 `allow` |
| `allow: ['a']` | 仅 `a` 直接执行；其他走 prompt | 仅 `a` 直接执行；其他走 prompt |
| `deny` 不写 | 等同 `[]`（不禁用任何工具） | 降级用主 agent 的 `deny` |
| `deny: ['c']` | `c` 注册时被过滤；其他走默认 | 在主 agent 的 deny 基础上再减 `c`（叠加） |
| 同一工具同时出现在 allow 与 deny | `deny` 优先（用户语义清晰：禁用强于允许） | 同 |

> 「`deny` 优先」不是运行时分支顺序，而是注册时直接被 `applyDenyFilter` 过滤掉——即使同名工具也出现在 allow，运行时 LLM 也看不到该工具、`before_tool_call` hook 也永远不会为它触发。

#### 为何 subagent 的 allow 与 deny 降级策略不对称

| 场景 | 设计意图 |
|---|---|
| `deny` 叠加（主 agent deny ∩ subagent deny——两者都生效） | 保证 subagent **不会比主 agent 更宽松**。主 agent deny 了 `exec`，subagent 不会因为自己没写而拿回 exec 能力。这是 subagent 隔离的安全底线。|
| `allow` 替换（subagent 写了就只用自己的） | 保证 subagent 能「更紧地」限制免审批集。主 agent 为了方便打开了很大一批工具免审批时，subagent 可以单独添一个 `allow: ['read_file']` 把免审批面锁死在仅读，不会被主 agent 的 allow 污染。|

两者不对称是有意为之，统一成「两边都叠加」或「两边都替换」都会破坏隔离语义。后续维护者请勿为了「对称」而重构本表。

---

## 6. 去掉 group 支持

### 6.1 现状

`tool-approval-policy.ts` 中有静态 group 映射：

```typescript
const TOOL_GROUPS: Record<string, string[]> = {
  'group:fs':     ['read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir'],
  'group:exec':   ['exec', 'process'],
  'group:search': ['grep_search', 'file_search'],
  'group:web':    ['web_fetch'],
  'group:memory': ['memory_search', 'memory_get', 'memory_write'],
};
```

用户可以在 `tools.approval.allow/deny` 里写 `"group:fs"` 来批量匹配。

### 6.2 去掉理由

1. **与动态工具注册冲突**：group 映射表静态 hardcoded，动态注册的工具无法自动加入任何 group，等于对动态工具永远失效
2. **语义不透明**：用户写 `group:fs` 不知道实际包含哪些工具，出问题难排查
3. **分组粒度不匹配需求**：`group:fs` 同时包含 `read_file` 和 `write_file`，但用户可能只想 allow 读不想 allow 写
4. **工具总数少，显式更清晰**：内置工具只有十几个，直接写工具名比 group 更可读

### 6.3 替代方案：精确名 + glob

```json
"tools": {
  "allow": ["read_file", "grep_search", "file_search"],
  "deny":  ["exec", "process"]
}
```

需要批量匹配时用 glob（`*` 匹配任意字符序列）：

```json
"allow": ["memory_*"]   // 匹配所有 memory_ 开头的工具，包括动态注册的
"deny":  ["*_file"]      // 注册时过滤掉所有 _file 结尾的工具
```

glob 天然兼容动态注册工具，无需维护静态映射表。

---

## 7. TypeScript 类型变更

### 7.1 ToolsConfig 重构

```typescript
/** 工具行为参数 + 工具策略 */
interface ToolsConfig {
  /** 文件系统工具路径限制 */
  fs?: { workspaceOnly?: boolean };

  /**
   * 直接执行的工具列表（精确名或 glob）。
   * 命中即跳过审批；运行时由 before_tool_call hook 短路。
   * 默认 [] = 无工具免审批，全部走 prompt（有 channel）/ deny（无 channel）。
   */
  allow?: string[];

  /**
   * 禁用的工具列表（精确名或 glob）。
   * 命中即在工具注册组件中过滤掉——LLM 完全看不到该工具的 schema。
   * deny 优先于 allow：同一工具同时出现在两者中时按 deny 处理。
   * 默认 [] = 不禁用任何工具。
   */
  deny?: string[];
}
```

> 删除了旧字段：`execTimeout` / `readMaxLines` / `webFetchTimeout` / `webFetchMaxChars` / `approval` / `exec` / `readFile` / `webFetch` 子对象。

### 7.2 MemoryModuleConfig / WorkspaceConfig 瘦身

```typescript
interface MemoryModuleConfig {
  enabled:   boolean;
  embedding: EmbeddingConfig;
  chunking:  ChunkingConfig;
  search:    SearchConfig;
  // 删除 dbPath：按约定固定为 <workspaceDir>/.agent/memory.sqlite
}

interface EmbeddingConfig {
  provider: EmbeddingProviderType;
  model:    string;
  // 删除 dimensions：按 §7.4 所述从 model 反查
}

interface WorkspaceConfig {
  maxFileChars:  number;
  maxTotalChars: number;
  // 删除 agentDir：代码原本就在三处 hardcode `.agent`，config 不上变。从 spec 上双向认领该让步
}
```

删除整个 `SessionConfig` 接口与 `AgentDefaults.session` 字段——唯一字段 `dir` 本来就是假字段（SessionManager 硬写 `'sessions'`）。

### 7.3 LoggerFileConfig 瘦身

```typescript
interface LoggerFileConfig {
  enabled?:  boolean;
  minLevel?: LoggerLevel;
  // 删除 dir / prefix / maxQueueSize：FileAdapter 内部默认值已足够；
  //   dir          → 固定 `<workspaceDir>/logs/`
  //   prefix       → `'app'`【FileAdapter 默认】
  //   maxQueueSize → 10_000【FileAdapter 默认】
}
```

### 7.4 SubagentsConfig 新增

```typescript
interface SubagentsConfig {
  enabled:  boolean;            // 默认 true；false 则不注册 task 工具
  maxDepth: number;             // 默认 1（原 maxSubagentDepth）
  list?:    SubagentConfigEntry[];
}

interface SubagentConfigEntry {
  id:          string;
  description: string;
  model?:      string;          // 'inherit'（默认）或具体 model id
  maxLlmCalls?: number;          // 与主 agent `RunParams.maxLlmCalls` 同语义；不写沿用父。
                                  // 用 maxLlmCalls 而非 maxTurns 是为了与主 agent 术语一致——
                                  // 一个 turn = 一轮用户消息 → 最终回复，可能含多次 LLM 调用
                                  // （详 core-subagent-spec.md §9.2 字段表）。
  tools?:      SubagentToolsConfig;
  // 删除 agentDir：按约定固定为 <workspaceDir>/.agent/subagents/<id>/，目录不存在 = 匿名 subagent
  // 删除 cwd：预留未消费，需要时再加
}

/** subagent 工具策略，与主 agent tools.allow/deny 语义一致。不对称设计见 §5.3「为何不对称」。 */
interface SubagentToolsConfig {
  /** 不写时降级用主 agent 的 tools.allow；写了完全替换（不与主 agent allow 叠加） */
  allow?: string[];
  /** 不写时降级用主 agent 的 tools.deny；写了则在主 agent deny 基础上叠加 */
  deny?:  string[];
}
```

### 7.5 Embedding 维度反查机制（代码侧配套改造）

删除 `embedding.dimensions` 后，[`LocalEmbeddingProvider`](../../src/core/memory/internal/LocalEmbeddingProvider.ts) 需能自动推导维度。采用「静态表 + 动态探测 fallback」组合：

```typescript
const KNOWN_DIMENSIONS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2':         384,
  'Xenova/all-mpnet-base-v2':        768,
  'Xenova/bge-base-en-v1.5':         768,
  'Xenova/multilingual-e5-small':    384,
  'Xenova/multilingual-e5-base':     768,
  'Xenova/multilingual-e5-large':    1024,
  // 以后遇到新常用 model 补上即可
};
```

运行时：

1. 检查 `model` 是否在 `KNOWN_DIMENSIONS` 中，在 → 直接用
2. 未命中 → 加载 pipeline 后跑一次空字符串推理，取 `output.data.length`（~毫秒级，可忽略），同时打 info log 提示「未知 model `<id>`，探测到 dims=`<N>`」方便以后补表
3. **一并删除** [LocalEmbeddingProvider.ts#L42](../../src/core/memory/internal/LocalEmbeddingProvider.ts#L42) 的 `slice(0, this.dimensions)` 截断逻辑——现在 dimensions 始终等于模型真实维度，截断已无意义，保留只会掩盖 bug

**接口契约**：[`EmbeddingProvider`](../../src/core/memory/types.ts#L4) 接口不变，`dimensions` 仍是 `readonly number`。探测走在现已是 `async` 的 [`createEmbeddingProvider`](../../src/core/memory/internal/LocalEmbeddingProvider.ts#L80) 内部：未命中 KNOWN_DIMENSIONS 时在该函数里 `await` 探测完成后再 `new LocalEmbeddingProvider(model, detectedDims)` 返回。**调用方拿到 provider 时 `.dimensions` 已是稳定终值**，后续 sync 读取零额外顾虑。

### 7.6 AgentDefaults 改动

```typescript
interface AgentDefaults {
  llm:        LLMConfig;
  runner:     RunnerConfig;
  memory:     MemoryModuleConfig;
  prompt:     PromptConfig;
  tools:      ToolsConfig;
  workspace:  WorkspaceConfig;
  compaction: CompactionConfig;
  subagents?: SubagentsConfig;    // 新增
  // 删除 session：§7.2 已取消整个 SessionConfig
}
```

---

## 8. 字段变更对照表

### 8.1 重命名（用户手动修改 `.agent/config.json`）

| 现有字段 | 目标字段 | 说明 |
|---|---|---|
| `tools.approval.allow` | `tools.allow` | 嵌套打平；语义不变（直接执行） |
| `tools.approval.deny` | `tools.deny` | 嵌套打平；语义**升级**（从「调用时拒」改为「注册时过滤」） |
| `subagents.maxSubagentDepth` | `subagents.maxDepth` | 去冗余前缀 |

> 本表是用户改写 config 的参考，**不会触发任何自动迁移**；旧名留在文件里只会被 deepMerge 默默挂在 resolved config 上、运行时不读（参见 §10）。

### 8.2 删除（假字段类——删了对运行时零影响）

| 字段 | 删除后的生效方式 |
|---|---|
| `tools.execTimeout` | 工具自身 `DEFAULT_TIMEOUT_SECONDS=30` |
| `tools.readMaxLines` | 工具自身 `DEFAULT_MAX_LINES=200` |
| `tools.webFetchTimeout` | 工具自身 `DEFAULT_TIMEOUT_MS=30_000` |
| `tools.webFetchMaxChars` | 工具自身 `DEFAULT_MAX_CHARS=50_000` |
| `tools.approval`（含 group 支持） | 语义平移到 `tools.allow / deny`；group 见 §6 |
| `workspace.agentDir` | 代码三处 hardcode `'.agent'`，本来就不可配 |
| `session` 节（`session.dir`） | SessionManager hardcode `'sessions'`，本来就不可配 |
| `memory.embedding.dimensions` | 代码路径不读；改由 model 反查（§7.5） |
| `subagents.list[].agentDir` | 按约定 `<workspaceDir>/.agent/subagents/<id>/` |
| `subagents.list[].cwd` | 预留未消费 |
| `subagents.generalPurposeEnabled` | general-purpose 始终内置，无需开关 |
| subagent 的 `allow/deny` 顶层 | 移入 `tools.allow / deny` 嵌套（§7.4） |
| subagent 的 `approval` 字段 | 通过 `tools.allow/deny` 已足够 |

### 8.3 删除（低价值可配置类——删后需少量代码改动）

| 字段 | 删除后的生效方式 | 代码侧改动 |
|---|---|---|
| `memory.dbPath` | 固定 `<workspaceDir>/.agent/memory.sqlite` | `MemoryManager.create` 签名去掉 `dbPath`；bootstrap 不再传 |
| `logger.file.dir` | 固定 `<workspaceDir>/logs/` | bootstrap 不再读 `fileCfg.dir`，直接 `join(workspaceDir, 'logs')` |
| `logger.file.prefix` | FileAdapter 默认 `'app'` | bootstrap 不传 `prefix` |
| `logger.file.maxQueueSize` | FileAdapter 默认 `10_000` | bootstrap 不传 `maxQueueSize` |

---

## 9. 默认值变更

```typescript
export const DEFAULT_AGENT_CONFIG: AgentDefaults = {
  // ... 其他字段不变 ...

  memory: {
    enabled: true,
    embedding: {
      provider: 'local',
      model:    'Xenova/all-MiniLM-L6-v2',
      // 不再提供 dimensions；provider 启动时反查
    },
    chunking: { chunkChars: 1600, overlapChars: 320 },
    search:   { maxResults: 6, minScore: 0.25, vectorWeight: 0.7, textWeight: 0.3 },
    // 不再提供 dbPath
  },

  workspace: {
    maxFileChars:  20_000,
    maxTotalChars: 150_000,
    // 不再提供 agentDir
  },

  tools: {
    fs:       { workspaceOnly: true },
    allow:    [],
    deny:     [],
    // 不再提供 exec / readFile / webFetch 子对象
  },

  subagents: {
    enabled:  true,
    maxDepth: 1,
    list:     [],
  },
};

export const DEFAULT_LOGGER_CONFIG: LoggerModuleConfig = {
  minLevel: 'info',
  console:  { enabled: true },
  file:     { enabled: false },
  // 不再提供 file.dir / prefix / maxQueueSize
};
```

同时删除顶层 `DEFAULT_AGENT_CONFIG.session` 字段。

---

## 10. 向后兼容说明

**本次重构不提供迁移代码 / 废弃警告**。项目处于单用户重度开发期，没有外部存量 config 需要兼容；迁移逻辑反而会拖累 loader 结构、额外背测试。

**存量 `.agent/config.json` 必须手动按 §8 改名表改**。如果不改：

- 旧字段（`tools.approval`、`memory.dbPath`、`session.dir` 等）会被 deepMerge 帮进 resolved config，但**运行时消费点不读**——静默失效，与重构前「假字段」同病。
- 使用了 `tools.approval` 的用户：原本能跳过审批的工具现在按「不在 allow」路径处理 → 弹 prompt（有 channel）/ deny（无 channel）。可能出现「以前能一键过现在要按」的体验变化。
- 使用了 `group:*` 的用户：TypeScript 类型不会报错（是字符串），但运行时该字符串被当作字面名区配任何工具——等同没写。

如后续出现不可控的多用户场景需要迁移能力，再单独补一个一次性迁移脚本，不拼成运行时 loader 的一部分。

---

## 11. 代码改动清单（需伴随本 spec）

以下是 spec 变更伴随的最小代码侧改动清单（详细的 PR 切分交付给 impl 文档）：

### 11.1 需要修改的文件

| 文件 | 修改点 |
|---|---|
| [src/platform/config/types.ts](../../src/platform/config/types.ts) | 删 `SessionConfig`、删 `WorkspaceConfig.agentDir`、删 `EmbeddingConfig.dimensions`、删 `MemoryModuleConfig.dbPath`、重构 `ToolsConfig`（见 §7.1）、删 `LoggerFileConfig.dir/prefix/maxQueueSize`、新增 `SubagentsConfig` 与子类型 |
| [src/platform/config/defaults.ts](../../src/platform/config/defaults.ts) | 同步瘦身（见 §9） |
| [src/platform/config/loader.ts](../../src/platform/config/loader.ts) | `readConfigFile` 内部原本读 `DEFAULT_AGENT_CONFIG.workspace.agentDir`；该字段被删后改为硬编码 `'.agent'`。**不加迁移逻辑**（§10）——旧字段静默被 deepMerge 帮过来但运行时不读 |
| [src/platform/config/wizard/fields.ts](../../src/platform/config/wizard/fields.ts) | 删除 `tools.execTimeout` / `readMaxLines` / `webFetchTimeout` / `webFetchMaxChars` / `session.dir` / `workspace.agentDir` / `memory.dbPath` 这些旧路径的 prompt 项；仅保留 `tools.fs.workspaceOnly` 作为唯一的 tools 行为参数项 |
| [src/core/memory/MemoryManager.ts](../../src/core/memory/MemoryManager.ts) | `create()` 参数去掉 `dbPath`；内部固定 `join(workspaceDir, '.agent', 'memory.sqlite')` |
| [src/core/memory/internal/LocalEmbeddingProvider.ts](../../src/core/memory/internal/LocalEmbeddingProvider.ts) | 加入 `KNOWN_DIMENSIONS` 表；缺失时加载后探测；删除 `slice(0, dimensions)` 截断（见 §7.5） |
| [src/runtime/bootstrap.ts](../../src/runtime/bootstrap.ts) | `FileAdapter` 构造参数仅传 `dir: join(workspaceDir, 'logs')` 与 `minLevel`；不再读 `fileCfg.dir / prefix / maxQueueSize` |
| [src/runtime/tool-registry.ts](../../src/runtime/tool-registry.ts) | 抽出 `applyDenyFilter(tools, deny)` 公共函数；**所有工具注册入口都必须调过该函数**，含 builtin 注册、memory tools 注入、未来 MCP / 动态工具注册路径（§5.2） |
| [src/runtime/RuntimeApp.ts](../../src/runtime/RuntimeApp.ts#L203) | `resolvedConfig.tools.approval` 改为 `resolvedConfig.tools`（读 `allow/deny`） |
| [src/runtime/tool-approval-policy.ts](../../src/runtime/tool-approval-policy.ts) | 删除 `TOOL_GROUPS` 常量与 group 分支（§6） |
| [src/platform/config/loader.test.ts](../../src/platform/config/loader.test.ts) | L156–L186 现断言旧字段 `tools.approval` / `tools.execTimeout` 等，需重写为新结构（§10：不写迁移 / warn 测试用例） |
| [src/runtime/prompt-factory.test.ts](../../src/runtime/prompt-factory.test.ts) | L10–L18 fixture 直接构造了多个被删字段：`memory.dbPath`、`memory.embedding.dimensions`、`session.dir`、`tools.{execTimeout, readMaxLines, webFetchTimeout, webFetchMaxChars, approval}`、`workspace.agentDir`——删字段后**类型编译会不过**，必须同步重写 |

### 11.2 代码侧**不**需要改的文件

- 各工具实现（`exec.ts`、`read-file.ts`、`web-fetch.ts`）——原本就使用自身 `DEFAULT_*` 常量，本轮不接入 config
- [SessionManager.ts](../../src/core/session/SessionManager.ts)、[workspace/init.ts](../../src/core/workspace/init.ts)、[workspace/loader.ts](../../src/core/workspace/loader.ts)——本来就硬编码路径，与 §4.1 约定一致，无需修改

---

## 12. 相关文档

- 现有类型定义：`src/platform/config/types.ts`
- 现有默认值：`src/platform/config/defaults.ts`
- 现有 approval 实现：`src/runtime/tool-approval-policy.ts`
- Subagent 设计：`docs/architecture/core-subagent-spec.md §12`
