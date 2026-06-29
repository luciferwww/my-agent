# Config 结构重构 · 实施文档

> 创建日期：2026-06-26（按 spec 大改重写）
> 配套 spec：[platform-config-restructure-spec.md](./platform-config-restructure-spec.md)
> 关联文档：[core-subagent-spec.md §12](./core-subagent-spec.md#12-配置扩展)
> 改动范围：`src/platform/config/**` · `src/runtime/{bootstrap,tool-registry,tool-approval-policy,RuntimeApp}.ts` · `src/core/memory/{MemoryManager,internal/LocalEmbeddingProvider}.ts` · 4 个测试文件

---

## 0. 基线事实（实施前必读）

spec §1.1 列出了「假字段」，下表是**真正消费 config 的地方**——本次重构必须改的代码消费点：

| 字段 | 消费点 | 改动 |
|---|---|---|
| `tools.fs.workspaceOnly` | [bootstrap.ts#L165](../../src/runtime/bootstrap.ts#L165) | 唯一保留的 tools 行为参数，**不动** |
| `tools.approval.{allow,deny}` | [RuntimeApp.ts#L203](../../src/runtime/RuntimeApp.ts#L203) | 字段路径改为 `tools.{allow,deny}`（语义见 §3 PR-4） |
| `memory.dbPath` | [MemoryManager.ts#L63-L64](../../src/core/memory/MemoryManager.ts#L63) | 删字段；MemoryManager.create 签名同步改 |
| `logger.file.{dir,prefix,maxQueueSize}` | [bootstrap.ts#L89-L94](../../src/runtime/bootstrap.ts#L89) | 删字段；bootstrap 固定传 `<workspaceDir>/logs/` 给 FileAdapter |

**假字段一律清理**（types/defaults/wizard 同步删），但**不需要改对应模块代码**——SessionManager / workspace/init.ts / workspace/loader.ts 本来就硬编码路径，与 spec §4.1 约定一致。

---

## 1. 实施级决策（spec 未拍板的实施细节）

spec 已经把架构和命名拍死。下面只列开工前需要确定的**实施细节**决策；review 时请确认。

| # | 决策项 | 推荐 |
|---|---|---|
| **D1** | glob 实现 | 抽出 [`src/runtime/glob-match.ts`](../../src/runtime/glob-match.ts)（10 行纯函数，支持 `*` `?`），`tool-registry.ts` 和 `tool-approval-policy.ts` 都 import；旧 [tool-approval-policy.ts#L11-L17](../../src/runtime/tool-approval-policy.ts#L11-L17) 的 `globMatch` 移到这里 |
| **D2** | `applyDenyFilter` 摆放位置 | 放进 [tool-registry.ts](../../src/runtime/tool-registry.ts)，导出 `applyDenyFilter(tools, deny): Tool[]` 纯函数；`assembleRuntimeTools` 内部最后一步调用；未来 MCP / 动态注册路径也 import 这个 |
| **D3** | `allow` 运行时短路位置 | [RuntimeApp.ts#L203](../../src/runtime/RuntimeApp.ts#L203) 的 `before_tool_call` hook——把现 `resolveToolApprovalAction(toolName, approvalConfig, hasApprovalCapability)` 改成 `resolveToolPolicy(toolName, tools, hasApprovalCapability)`，三档分支不变 |
| **D4** | `KNOWN_DIMENSIONS` 表所在文件 | 放在 [LocalEmbeddingProvider.ts](../../src/core/memory/internal/LocalEmbeddingProvider.ts) 顶部（与 `DEFAULT_MODEL` 同处），不单开文件 |
| **D5** | 探测维度的 log 级别 | `info`（不是 warn）——首次遇到新模型是正常事件，warn 会让用户紧张 |

> spec §10 明确不提供向后兼容。原「D1 迁移 warn 输出渠道」与「D5 迁移窗口」已从决策清单删除。

---

## 2. 现状符号清单（按此签名改，不要臆造）

| 文件 | 现状 | 本期动作 |
|---|---|---|
| [src/platform/config/types.ts](../../src/platform/config/types.ts) | 包含 `ToolApprovalConfig`、`SessionConfig`、`ToolsConfig`（flat）、`WorkspaceConfig.agentDir`、`MemoryModuleConfig.dbPath`、`EmbeddingConfig.dimensions`、`LoggerFileConfig.{dir,prefix,maxQueueSize}`；无 `SubagentsConfig` | 见 spec §7.1 / §7.2 / §7.3 / §7.4 / §7.6 |
| [src/platform/config/defaults.ts](../../src/platform/config/defaults.ts) | `DEFAULT_AGENT_CONFIG` 包含 dbPath / dimensions / 完整 tools 行为参数；`DEFAULT_LOGGER_CONFIG` 含 file.dir/prefix/maxQueueSize | 见 spec §9 |
| [src/platform/config/loader.ts](../../src/platform/config/loader.ts) | `loadConfig()` 走 `deepMerge`；`readConfigFile` 内读 `DEFAULT_AGENT_CONFIG.workspace.agentDir` 构造 config 路径 | `agentDir` 字段被删 → `readConfigFile` 改为硬编码 `'.agent'`。**不加迁移逻辑**（spec §10） |
| [src/platform/config/wizard/fields.ts#L289-L345](../../src/platform/config/wizard/fields.ts#L289) | 询问 `tools.execTimeout` / `readMaxLines` / `webFetchTimeout` / `webFetchMaxChars` / `tools.fs.workspaceOnly` / `session.dir` / `workspace.agentDir` / `memory.dbPath` | 删除除 `tools.fs.workspaceOnly` 外的所有这些项 |
| [src/runtime/tool-approval-policy.ts](../../src/runtime/tool-approval-policy.ts) | `TOOL_GROUPS` 常量 + group 分支；`ToolApprovalConfig` 参数；`resolveToolApprovalAction(toolName, config, hasApprovalCapability)` | 删 `TOOL_GROUPS`；签名改为 `resolveToolPolicy(toolName, tools, hasApprovalCapability)`；类型从 `ToolApprovalConfig` 换成新的 `ToolsConfig` |
| [src/runtime/tool-registry.ts](../../src/runtime/tool-registry.ts) | `assembleRuntimeTools()` 不接 deny；`getDefaultBuiltinTools()` 注册全部 builtin | 新增 `applyDenyFilter(tools, deny)` 导出；`assembleRuntimeTools()` 最后一步过滤；签名加 `deny: string[]` 参数 |
| [src/runtime/bootstrap.ts](../../src/runtime/bootstrap.ts) | L42-L47 `createDefaultRuntimeDependencies.createMemoryManager` 接 `dbPath: options.dbPath`；L89-L94 FileAdapter 接 `fileCfg.dir/prefix/maxQueueSize`；L142 `MemoryManager.create` 传 `dbPath: resolvedConfig.memory.dbPath`；L165 `assembleRuntimeTools` 不传 deny | 四处都改：删 L43 `dbPath: options.dbPath`；FileAdapter 固定路径；不再传 dbPath；新增传 `deny` |
| [src/runtime/types.ts#L44](../../src/runtime/types.ts#L44) | `RuntimeMemoryOptions.dbPath?: string`——供 createMemoryManager 传递用 | 删 `dbPath` 字段 |
| [src/runtime/RuntimeApp.ts#L203](../../src/runtime/RuntimeApp.ts#L203) | `this.resources.resolvedConfig.tools.approval` | 改为 `this.resources.resolvedConfig.tools`（同时读 allow/deny） |
| [src/core/memory/types.ts#L126](../../src/core/memory/types.ts#L126) | `MemoryConfig.dbPath?: string`——`MemoryManager.create` 接受的参数类型 | 删 `dbPath` 字段 |
| [src/core/memory/MemoryManager.ts](../../src/core/memory/MemoryManager.ts) | L19 `const DEFAULT_DB_PATH = '.agent/memory.sqlite'`；L55 `static async create(config: ...)`；L63 `const resolvedDbPath = config.dbPath ?? DEFAULT_DB_PATH`；L64 `isAbsolute(resolvedDbPath) ? ... : join(workspaceDir, resolvedDbPath)` | 删 L19 常量；改 L55 签名去 `dbPath`；删 L63–20 等代、`isAbsolute` 分支；内部固定 `join(workspaceDir, '.agent', 'memory.sqlite')` |
| [src/core/memory/internal/LocalEmbeddingProvider.ts](../../src/core/memory/internal/LocalEmbeddingProvider.ts) | constructor 接 `dimensions` 参数（默认 384）；[L42](../../src/core/memory/internal/LocalEmbeddingProvider.ts#L42) `slice(0, this.dimensions)`；[L80](../../src/core/memory/internal/LocalEmbeddingProvider.ts#L80) `createEmbeddingProvider` 仅读 provider/model | 加 `KNOWN_DIMENSIONS` 表；`createEmbeddingProvider` 内决定 dimensions（命中表→sync；未命中→await pipeline 探测）；删 L42 截断；constructor 接 `dimensions: number` 必填 |

测试：

| 测试文件 | 受影响内容 |
|---|---|
| [src/platform/config/loader.test.ts](../../src/platform/config/loader.test.ts) | L156-L186 全部基于旧 `tools.approval` / `execTimeout` / `group:fs` 等。**整段重写为新结构**（不写迁移用例，spec §10） |
| [src/runtime/prompt-factory.test.ts](../../src/runtime/prompt-factory.test.ts) | L10-L18 fixture 直接用了 `memory.dbPath` / `embedding.dimensions` / `session` / `tools.{execTimeout, ..., approval}` / `workspace.agentDir`——删字段后**类型编译不过**，必须重写 |
| [src/runtime/tool-approval-policy.test.ts](../../src/runtime/tool-approval-policy.test.ts) | 5 个 `group:*` 用例（L27 / L37 / L44 / L51 / L89）删除；新增 1 个「`group:fs` 不再展开」回归 |
| [src/runtime/tool-registry.test.ts](../../src/runtime/tool-registry.test.ts) | 新增 `applyDenyFilter` 单元测试；`assembleRuntimeTools` 加 deny-filter 集成测试 |
| [src/core/memory/MemoryManager.test.ts](../../src/core/memory/MemoryManager.test.ts) | L198-L217 `dbPath` 测试需重写（固定路径，不再接受参数） |
| [src/core/memory/internal/LocalEmbeddingProvider.test.ts](../../src/core/memory/internal/LocalEmbeddingProvider.test.ts) | 新增「KNOWN_DIMENSIONS 命中 sync 返回」「未命中走探测」用例（如该文件不存在则新建） |

---

## 3. PR 切分

上轮原划为 6 个独立 PR，但 PR-1 删除 `ToolApprovalConfig`、`SessionConfig`、`MemoryConfig.dbPath`、`RuntimeMemoryOptions.dbPath` 等类型后，PR-2/3/4/5 才改对应消费点——PR-1 **单独合入主干会编译失败**。

**本实施采用 atomic PR-A 拓扑**：

```
PR-A (atomic：合并为一个 commit）
  ├─ 阶段 1：base——types/defaults/loader/wizard 改动（原 PR-1）
  ├─ 阶段 2：MemoryManager + LocalEmbeddingProvider（原 PR-2）
  ├─ 阶段 3：bootstrap FileAdapter 固定路径（原 PR-3）
  ├─ 阶段 4：tool-approval-policy + RuntimeApp 改字段引用（原 PR-4）
  └─ 阶段 5：tool-registry applyDenyFilter + bootstrap 传 deny（原 PR-5）

PR-6 (独立）
  SubagentsConfig 类型骨架（无 consumer，不会破坏编译）
```

| # | PR | 代码量 | 依赖 |
|---|---|---|---|
| **PR-A** | atomic：上表 5 个阶段合为一个 commit，但文档上仍按阶段描述（便于 review） | ~1100 行 | — |
| **PR-6** | SubagentsConfig 类型骨架 | ~100 行 | PR-A |

> §4–§8 仍用 PR-1……PR-5 的阶段名描述，以保留内在逆辑边界；review 可按阶段逐节检查。**不要拆开提交**，否则 base 编译不过。

每个 PR 都能独立 build + 跑全测试通过。下面逐条展开。

---

## 4. PR-1：基础 config 层

### 4.1 types.ts 改动

按 spec §7 全部应用。具体增删：

**新增**：

```typescript
// 替代 ToolApprovalConfig
interface ToolsConfig {
  fs?: { workspaceOnly?: boolean };
  allow?: string[];   // 直接执行
  deny?: string[];    // 注册时过滤
}

// 新增（spec §7.4）
interface SubagentsConfig {
  enabled: boolean;
  maxDepth: number;
  list?: SubagentConfigEntry[];
}

interface SubagentConfigEntry {
  id: string;
  description: string;
  model?: string;
  maxLlmCalls?: number;   // 对齐主 agent RunParams.maxLlmCalls；详 spec §7.4
  tools?: SubagentToolsConfig;
}

interface SubagentToolsConfig {
  allow?: string[];   // 替换主 agent allow
  deny?: string[];    // 叠加主 agent deny
}
```

**删除**：

```typescript
// 整个删
interface ToolApprovalConfig { ... }
interface SessionConfig { ... }

// 字段删
interface MemoryModuleConfig {
  // 删 dbPath
}
interface EmbeddingConfig {
  // 删 dimensions
}
interface WorkspaceConfig {
  // 删 agentDir
}
interface LoggerFileConfig {
  // 删 dir, prefix, maxQueueSize
}
interface AgentDefaults {
  // 删 session
  // 加 subagents?: SubagentsConfig
}
```

⚠️ `AgentDefaults.session` 删除会触发**全项目编译错误**——所有 fixture 都需要同步更新（见测试段）。

### 4.2 defaults.ts 改动

按 spec §9 应用。代码层面就是删 `dbPath` / `dimensions` / `agentDir` / `session` 节 / `tools` 子对象（保留 `fs`/`allow`/`deny`）/ `logger.file.{dir,prefix,maxQueueSize}`；新增 `subagents` 节。

### 4.3 loader.ts 改动（仅硬编码 .agent）

**不加迁移逻辑**。spec §10 明确不提供向后兼容；loader 保持原有 deepMerge 结构，仅修一处：

```typescript
// [loader.ts#L78](../../src/platform/config/loader.ts#L78) 附近原写：
//   const agentDir = DEFAULT_AGENT_CONFIG.workspace.agentDir;
//   const configPath = join(workspaceDir, agentDir, CONFIG_FILE_NAME);
// 改为（agentDir 字段已删）：
const AGENT_DIR = '.agent';   // 与 workspace/init.ts 保持一致；spec §4.1
const configPath = join(workspaceDir, AGENT_DIR, CONFIG_FILE_NAME);
```

存量 config 里的旧字段（`tools.approval` / `memory.dbPath` / `session.dir` / `workspace.agentDir` 等）会被 deepMerge 帮进 resolved config，但**运行时消费点不读**——静默失效。占一点内存但不影响行为。用户需手动按 spec §8 改名表清理。

### 4.4 wizard/fields.ts 改动

删除以下 7 个 prompt 项（[L289-L345](../../src/platform/config/wizard/fields.ts#L289) 段）：

- `tools.execTimeout` / `tools.readMaxLines` / `tools.webFetchTimeout` / `tools.webFetchMaxChars`
- `session.dir`
- `workspace.agentDir`
- `memory.dbPath`

**保留**：`tools.fs.workspaceOnly`（唯一活跃的 tools 行为参数）。

### 4.5 PR-1 测试

#### loader.test.ts 重写

L156-L186 全部基于旧 `tools.approval` / `execTimeout` / `group:fs` 的用例**删除**。新增用例：

| 用例 | 断言 |
|---|---|
| `tools.allow / deny defaults to empty arrays` | `config.agents.defaults.tools.{allow,deny}` 都是 `[]` |
| `tools.allow / deny merge from config file` | 配 `{tools:{allow:['x'],deny:['y']}}` → 读出来一致 |
| `tools.fs.workspaceOnly defaults to true` | 不变 |
| `subagents defaults: enabled=true, maxDepth=1, list=[]` | 新增 |
| `subagents.list[] preserves config-file entries` | 写一条 SubagentConfigEntry，resolved 中完整呈现 |

> **不再写「迁移 + warn」类用例**——spec §10 不提供迁移，不需要验证。

#### prompt-factory.test.ts 重写

L10-L18 fixture 直接构造了大量被删字段，重写为新结构。可以提取一个 `createTestAgentDefaults(): AgentDefaults` helper 函数复用，避免后续测试再踩同样的坑。

### 4.6 PR-1 阶段验收

- [ ] **仅在 PR-A 全部 5 个阶段都完成后跑 `pnpm tsc --noEmit`**——阶段 1 单独检查会有预期中的编译错（消费点在阶段 2-5 才改）；仅检查该阶段的类型文件 + defaults + loader + wizard 改动是否在阶段内部闭环
- [ ] `pnpm test src/platform/config src/runtime/prompt-factory` 全绿（config + prompt-factory 测试不依赖后续阶段）
- [ ] 端到端验证推迟到 PR-A 全部阶段完成后：用 spec §4 示例的**新格式** config.json 启动 → 正常运行，app_ready 事件发出，tools 列表与预期一致

---

## 5. PR-2：MemoryManager + LocalEmbeddingProvider + bootstrap memory 调用

### 5.1 MemoryManager.ts 改动

签名瘦身：

```typescript
// before
static async create(config: {
  workspaceDir: string;
  dbPath?: string;        // ← 删
  embedding?: ...;
  search?: ...;
  enabled: boolean;
}): Promise<MemoryManager | null>

// after
static async create(config: {
  workspaceDir: string;
  embedding?: ...;
  search?: ...;
  enabled: boolean;
}): Promise<MemoryManager | null>
```

内部固定：

```typescript
const dbPath = join(config.workspaceDir, '.agent', 'memory.sqlite');
```

删除 `DEFAULT_DB_PATH` 常量 + 绝对路径分支。

### 5.1.1 伴随接口改动（必须一同完成）

| 文件 | 改动 |
|---|---|
| [src/core/memory/types.ts#L126](../../src/core/memory/types.ts#L126) | `MemoryConfig` 接口删 `dbPath?: string` 行 |
| [src/runtime/types.ts#L44](../../src/runtime/types.ts#L44) | `RuntimeMemoryOptions` 接口删 `dbPath?: string` 行 |
| [src/runtime/bootstrap.ts#L43](../../src/runtime/bootstrap.ts#L43) | `createDefaultRuntimeDependencies.createMemoryManager` 内 `dbPath: options.dbPath` 删除 |
| [src/runtime/bootstrap.ts#L142](../../src/runtime/bootstrap.ts#L142) | `MemoryManager.create({ ... dbPath: resolvedConfig.memory.dbPath, ... })` 删 dbPath 行 |

四处加上 MemoryManager.ts 本身，共 5 处同步改动。任何一处漏改会导致类型不一致或调用时 dbPath 静默丢失。

### 5.2 LocalEmbeddingProvider.ts 改动

按 spec §7.5 实施。具体：

**新增常量与函数**：

```typescript
const KNOWN_DIMENSIONS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2':         384,
  'Xenova/all-mpnet-base-v2':        768,
  'Xenova/bge-base-en-v1.5':         768,
  'Xenova/multilingual-e5-small':    384,
  'Xenova/multilingual-e5-base':     768,
  'Xenova/multilingual-e5-large':    1024,
};

async function detectDimensions(model: string): Promise<number> {
  const { pipeline } = await import('@xenova/transformers');
  const pipe = await pipeline('feature-extraction', model);
  const output = await pipe('', { pooling: 'mean', normalize: true });
  return (output.data as Float32Array).length;
}
```

**改 constructor**：

```typescript
// before
constructor(modelId: string = DEFAULT_MODEL, dimensions: number = DEFAULT_DIMENSIONS)

// after
constructor(modelId: string, dimensions: number)   // 两个都必填，由 factory 决定
```

**改 createEmbeddingProvider**：

```typescript
export async function createEmbeddingProvider(
  config?: { provider?: string; model?: string },
): Promise<EmbeddingProvider | null> {
  const providerType = config?.provider ?? 'local';
  if (providerType !== 'local') return null;

  const model = config?.model ?? DEFAULT_MODEL;
  let dimensions = KNOWN_DIMENSIONS[model];
  if (dimensions === undefined) {
    try {
      dimensions = await detectDimensions(model);
      log.info('Detected embedding dimensions for unknown model', { model, dimensions });
    } catch (err) {
      log.warn('Failed to detect dimensions, falling back to keyword-only search', {
        model,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  return new LocalEmbeddingProvider(model, dimensions);
}
```

**删除截断**：

```typescript
// before (L42)
const embedding = Array.from(output.data as Float32Array).slice(0, this.dimensions);

// after
const embedding = Array.from(output.data as Float32Array);
```

（`this.dimensions` 现在永远等于 `output.data.length`，slice 是 no-op。但它必须删除：**保留会掩盖维度不匹配 bug**——如 KNOWN_DIMENSIONS 表填错、或 detectDimensions 有误返回值，截断会静默隐藏该错误，写入 SQLite 的向量长度仍在错误值上「看似成功」，后续搜索报怪错。）

**删除 `DEFAULT_DIMENSIONS = 384` 常量**。

### 5.3 bootstrap.ts memory 段改动

[L42-L47](../../src/runtime/bootstrap.ts#L42)：删 `dbPath: options.dbPath` 一行（`createMemoryManager` 也不接 `dbPath` 了）。
[L140-L148](../../src/runtime/bootstrap.ts#L140)：删 `dbPath: resolvedConfig.memory.dbPath` 和 log 里的 `dbPath` 字段；改为 log `workspaceDir`。

### 5.4 PR-2 测试

#### MemoryManager.test.ts

| 现用例 | 处置 |
|---|---|
| `create() respects a custom dbPath` (L198) | **删除** — 不再支持 |
| 新增 `create() always writes to <workspaceDir>/.agent/memory.sqlite` | 断言 SqliteMemoryStore 收到固定路径 |
| 其他用例 | 检查是否依赖 dbPath；不依赖则原样保留 |

#### LocalEmbeddingProvider.test.ts（如不存在则新建）

| 用例 | 断言 |
|---|---|
| `createEmbeddingProvider returns provider with KNOWN dimensions sync` | mock 不到 `await pipeline()`；返回的 provider.dimensions 命中表中值 |
| `createEmbeddingProvider detects dimensions for unknown model` | mock pipeline 返回 `{data:Float32Array(512)}`；provider.dimensions === 512 |
| `createEmbeddingProvider returns null on detection failure` | mock pipeline 抛错 → 返回 null + warn |

### 5.5 PR-2 验收

- [ ] `pnpm test src/core/memory src/runtime/bootstrap` 全绿
- [ ] 端到端：删 `.agent/memory.sqlite`，启动 → 自动创建在正确位置
- [ ] 端到端：换模型为非默认模型（`bge-base-en-v1.5` 之类，在 KNOWN_DIMENSIONS 内）→ provider 启动成功
- [ ] 端到端：换为完全陌生模型 → info log 出探测结果

---

## 6. PR-3：bootstrap FileAdapter 固定路径

### 6.1 bootstrap.ts logger 段改动

[L88-L94](../../src/runtime/bootstrap.ts#L88)：

```typescript
// before
if (appConfig.logger.file?.enabled) {
  const fileCfg = appConfig.logger.file;
  adapters.push(new FileAdapter({
    dir: join(options.workspaceDir, fileCfg.dir ?? 'logs'),
    ...(fileCfg.prefix !== undefined ? { prefix: fileCfg.prefix } : {}),
    ...(fileCfg.minLevel !== undefined ? { minLevel: fileCfg.minLevel } : {}),
    ...(fileCfg.maxQueueSize !== undefined ? { maxQueueSize: fileCfg.maxQueueSize } : {}),
  }));
}

// after
if (appConfig.logger.file?.enabled) {
  const fileCfg = appConfig.logger.file;
  adapters.push(new FileAdapter({
    dir: join(options.workspaceDir, 'logs'),
    ...(fileCfg.minLevel !== undefined ? { minLevel: fileCfg.minLevel } : {}),
    // prefix / maxQueueSize 走 FileAdapter 内部默认（'app' / 10_000）
  }));
}
```

### 6.2 PR-3 测试

bootstrap 没有 unit test 直接测 FileAdapter 配置。手测：

- [ ] 启动 `logger.file.enabled: true` → `<workspaceDir>/logs/app.YYYY-MM-DD.log` 存在

### 6.3 PR-3 验收

- [ ] `pnpm tsc --noEmit` 通过
- [ ] `pnpm test src/runtime/bootstrap` 全绿
- [ ] 手测两项

---

## 7. PR-4：tool-approval-policy 简化 + RuntimeApp 改引用

### 7.1 抽出 glob-match.ts（D2）

新建 [src/runtime/glob-match.ts](../../src/runtime/glob-match.ts)：

```typescript
/** glob 匹配：`*` 任意字符序列、`?` 单字符 */
export function globMatch(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(name);
}

export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globMatch(name, p));
}
```

PR-5 的 `applyDenyFilter` 也从这里 import。

### 7.2 tool-approval-policy.ts 简化

```typescript
import type { ToolsConfig } from '../platform/config/types.js';
import { matchesAny } from './glob-match.js';

/**
 * 根据工具策略和 channel 能力决定执行动作。
 *
 * 三档：
 *   - allow 命中 → 'allow'（直接执行）
 *   - deny  命中 → 'deny'（直接拒绝；理论上 deny 已在注册时过滤掉，运行时不应到这里）
 *   - 都没命中 + 有 channel → 'prompt'
 *   - 都没命中 + 无 channel → 'deny'（fail-closed）
 */
export function resolveToolPolicy(
  toolName: string,
  tools: ToolsConfig,
  hasApprovalCapability: boolean,
): 'allow' | 'deny' | 'prompt' {
  const allow = tools.allow ?? [];
  const deny = tools.deny ?? [];

  // 防御性：理论上 deny 工具已被 applyDenyFilter 过滤掉
  if (matchesAny(toolName, deny)) return 'deny';
  if (matchesAny(toolName, allow)) return 'allow';
  return hasApprovalCapability ? 'prompt' : 'deny';
}
```

**关键变化**：

1. 函数改名 `resolveToolApprovalAction` → `resolveToolPolicy`
2. 参数类型从 `ToolApprovalConfig` 换成 `ToolsConfig`（直接传 `resolvedConfig.tools`）
3. 删除 `TOOL_GROUPS` 常量与 group 分支
4. `globMatch` / `matchesPatterns` 提到 `glob-match.ts`，本文件不再有

### 7.3 RuntimeApp.ts 改字段引用

[L203](../../src/runtime/RuntimeApp.ts#L203)：

```typescript
// before
const approvalConfig = this.resources.resolvedConfig.tools.approval;
const action = resolveToolApprovalAction(toolName, approvalConfig, hasApprovalCapability);

// after
const action = resolveToolPolicy(
  toolName,
  this.resources.resolvedConfig.tools,
  hasApprovalCapability,
);
```

import 同步改：`resolveToolApprovalAction` → `resolveToolPolicy`。

### 7.4 PR-4 测试

#### tool-approval-policy.test.ts 改动

| 现用例（L 行号约值）| 处置 |
|---|---|
| L27 `allows tools in group:fs` | **删除** |
| L37 `allows tools in group:exec` | **删除** |
| L44 `allows tools in group:search` | **删除** |
| L51 `allows tools in group:memory` | **删除** |
| L89 `deny via group:exec, allow via group:fs, prompt for other` | **删除** |
| L59 `deny list is ignored when no channel` | **断言反转**——旧实现无 channel 时只看 allow（该用例原期望 `'allow'`）；新 `resolveToolPolicy` deny 优先（与有 channel 一致，spec §5.3）。同配置 `{allow:['exec'], deny:['exec']}` + `hasApprovalCapability=false` 应返回 `'deny'`。原注释「allow wins if present」也要删 |
| 其他 exact-name 和 glob 用例 | **保留** + 改成新签名 `resolveToolPolicy(name, {allow, deny}, hasApproval)` |
| **新增**：`treats "group:fs" as literal — matches no tool` | 断言 `resolveToolPolicy('read_file', {allow:['group:fs']}, true)` 返回 `'prompt'`（regression for group removal） |
| **新增**：`reads from ToolsConfig directly` | 断言传 `{fs:{...}, allow:[...], deny:[...]}` 完整对象也能工作 |

#### glob-match.test.ts（新建）

| 用例 | 断言 |
|---|---|
| `* matches any sequence` | `globMatch('memory_search', 'memory_*')` true |
| `? matches single char` | `globMatch('execX', 'exec?')` true，`'exec'` false |
| `escapes regex special chars` | `globMatch('a.b', 'a.b')` true（不当成 regex `.`） |
| `case sensitive` | `globMatch('Exec', 'exec')` false |

### 7.5 PR-4 验收

- [ ] `pnpm test src/runtime/tool-approval-policy src/runtime/glob-match` 全绿
- [ ] 端到端：CLI 模式（无 channel）下，工具不在 allow → 立即 deny（fail-closed 行为不变）
- [ ] 端到端：旧 config 写 `tools.approval.allow:['group:fs']` 启动 → loader 不迁移、不报警；deepMerge 会把该字段挂到 resolved config 的 `tools.approval`（旧位置）但运行时消费点只读 `tools.allow / deny`（两者均为空）。调 read_file 运行时：有 channel 走 prompt；无 channel fail-closed deny。**验证 `tools.approval` 字段的存在完全不影响新行为路径**（spec §10）

---

## 8. PR-5：tool-registry `applyDenyFilter` + bootstrap 传 deny

### 8.1 tool-registry.ts 改动

新增导出函数：

```typescript
import { matchesAny } from './glob-match.js';

/**
 * 按 deny 列表过滤工具。spec §5.2：注册时一次性应用。
 * 所有工具注册入口（builtin / memory / 未来 MCP / 动态工具）都应过这个函数。
 */
export function applyDenyFilter(tools: Tool[], deny: readonly string[]): Tool[] {
  if (deny.length === 0) return tools;
  return tools.filter((t) => !matchesAny(t.name, deny));
}
```

修改 `assembleRuntimeTools`：

```typescript
export interface AssembleRuntimeToolsParams {
  builtinTools: Tool[];
  memoryManager: MemoryManager | null;
  deny: readonly string[];   // 新增：来自 resolvedConfig.tools.deny ?? []
}

export function assembleRuntimeTools(params: AssembleRuntimeToolsParams): RuntimeToolBundle {
  let tools = [...params.builtinTools];
  if (params.memoryManager) {
    tools.push(...createMemoryTools(params.memoryManager));
  }
  
  // 在 memory tools 加入之后过滤——这样 deny:['memory_*'] 能命中 memory 工具
  tools = applyDenyFilter(tools, params.deny);

  return {
    tools,
    executor: createToolExecutor(tools),
    llmDefinitions: toLlmToolDefinitions(tools),
    promptDefinitions: toPromptToolDefinitions(tools),
  };
}
```

⚠️ **关键设计**：`deny` 是必填参数（不是 optional），强制调用方思考是否要传——避免遗漏导致 deny 失效。空数组 `[]` 表示「不过滤」是合法值。

### 8.2 bootstrap.ts 改动

[L162-L171](../../src/runtime/bootstrap.ts#L162) 给 `assembleRuntimeTools` 加 `deny` 参数：

```typescript
const toolBundle = assembleRuntimeTools({
  builtinTools: deps.getBuiltinTools({
    workspaceDir: options.workspaceDir,
    fsWorkspaceOnly: resolvedConfig.tools.fs?.workspaceOnly ?? true,   // optional 后要兜底
    webFetchEnabled: true,
    execEnabled: true,
    processEnabled: true,
  }),
  memoryManager,
  deny: resolvedConfig.tools.deny ?? [],   // 新增
});
```

### 8.3 未来的扩展点（spec §5.2 要求）

**本期不实现**，但要在代码注释里写明：

```typescript
// applyDenyFilter export 注释里加：
/**
 * 注册入口约定（spec §5.2）：
 * 凡是把工具注入运行时 toolBundle 的代码路径，**都必须在自己的注入点调一次 applyDenyFilter**。
 * 不能依赖 assembleRuntimeTools 里那一次过滤——那是启动时的一次性调用，运行时后动态注入的工具不会被重复过滤。
 *
 * 当前入口：
 *   - bootstrap.ts → assembleRuntimeTools (builtin + memory tools)
 * 未来入口（接入时必须调 applyDenyFilter）：
 *   - MCP server 连上后注入工具——在 MCP 适配层自己调一次后再 push 进 toolBundle
 *   - 用户自定义动态工具注册 API——同上
 */
```

### 8.4 PR-5 测试

#### tool-registry.test.ts 新增

| 用例 | 断言 |
|---|---|
| `applyDenyFilter empty deny → unchanged` | 返回的数组就是输入 |
| `applyDenyFilter exact name` | `deny:['exec']` → 不含 exec |
| `applyDenyFilter glob` | `deny:['*_file']` → 不含 read_file/write_file/edit_file |
| `applyDenyFilter case sensitive` | `deny:['Exec']` 不匹配 `exec` |
| `assembleRuntimeTools applies deny after memory tools` | mock memoryManager + `deny:['memory_*']` → llmDefinitions 不含 memory 工具 |
| `assembleRuntimeTools deny=[] keeps all tools` | builtin + memory 全保留 |

### 8.5 PR-5 验收

- [ ] `pnpm test src/runtime/tool-registry` 全绿
- [ ] 端到端：配 `tools.deny:['exec']` 启动 → `app_ready` 事件的 `toolNames` 不含 `exec`；LLM 系统 prompt 中不出现 exec 描述
- [ ] 端到端：配 `tools.deny:['memory_*']` 启动 → memory 工具全部消失

---

## 9. PR-6：SubagentsConfig 类型骨架

> **范围严格**：仅加类型 + defaults；不实现 task 工具、不解析 `model:'inherit'`、不实现 `maxDepth` 检查。subagent 完整实施归 `core-subagent-spec.md`。

### 9.1 types.ts 改动

按 §4.1 已经定义的 `SubagentsConfig` / `SubagentConfigEntry` / `SubagentToolsConfig`。

### 9.2 defaults.ts 改动

```typescript
subagents: {
  enabled:  true,
  maxDepth: 1,
  list:     [],
},
```

并把 `subagents` 加进 `AgentDefaults` 的 type union。

### 9.3 PR-6 测试

loader.test.ts 加用例（其实 PR-1 §4.5 已经有 `subagents defaults` 用例，可以挪过来 / 或保持在 PR-1 一起合）：

| 用例 | 断言 |
|---|---|
| `subagents defaults: enabled=true, maxDepth=1, list=[]` | resolved config 三字段都对 |
| `subagents.list from config file preserved` | 写一条 SubagentConfigEntry，断言读出来一致 |
| `subagents.maxDepth override merges correctly` | 配 `{subagents:{maxDepth:3}}` → 其他字段保留默认 |

### 9.4 PR-6 验收

- [ ] `pnpm tsc --noEmit` 通过
- [ ] `pnpm test src/platform/config` 全绿
- [ ] `RuntimeApp` / `AgentRunner` 行为**完全无变化**（没有 consumer）

---

## 10. 测试矩阵总览

| 测试文件 | PR-1 | PR-2 | PR-3 | PR-4 | PR-5 | PR-6 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `src/platform/config/loader.test.ts` | ✏️ |  |  |  |  | ➕ |
| `src/runtime/prompt-factory.test.ts` | ✏️ |  |  |  |  |  |
| `src/core/memory/MemoryManager.test.ts` |  | ✏️ |  |  |  |  |
| `src/core/memory/internal/LocalEmbeddingProvider.test.ts` |  | ➕ |  |  |  |  |
| `src/runtime/tool-approval-policy.test.ts` |  |  |  | ✏️ |  |  |
| `src/runtime/glob-match.test.ts` |  |  |  | ➕ |  |  |
| `src/runtime/tool-registry.test.ts` |  |  |  |  | ➕ |  |

> ✏️ = 改写现有用例；➕ = 新建/新增

---

## 11. 回归与冒烟（合并大 PR 前必做）

按依赖关系合并完所有 PR 后，在 [my-agent/](../../) 跑：

```bash
pnpm tsc --noEmit
pnpm test
```

人工冒烟测试：

1. **空 config**：`{}` → 一切走默认；启动正常；app_ready 事件 `toolNames` 为全部内置工具
2. **新格式 config**：用 spec §4 示例 → 启动 + 跑一个 turn；行为符合三档语义
   - `tools.allow: ['read_file', 'grep_search', 'file_search']` 中的工具调用不弹审批
   - `tools.deny: ['exec']` → LLM 看不到 exec（`toolNames` 不含 exec）
3. **CLI 模式**（无 approval channel）下，未出现在 allow / deny 的工具调用 → **拒绝**（fail-closed，spec §5.1）。验证 `resolveToolPolicy` 返回 `'deny'` 且不弹 prompt。

> **说明**：spec §10 明确不提供向后兼容，本表不含「旧格式 config 验证」。如果存量 `.agent/config.json` 是旧格式，启动不会报错但旧字段静默失效；请手动按 spec §8 改名表清理。

---

## 12. 不在本次范围

明确**不做**：

- 让 `exec.ts` / `read-file.ts` / `web-fetch.ts` 真正读取 config 行为参数（spec 已删字段）
- 实现 task 工具 / SubagentRunner / `model:'inherit'` 解析（归 [core-subagent-spec.md](./core-subagent-spec.md)）
- `agents.list[]` 的 per-agent 覆盖完整实现（[loader.ts#L143-L158](../../src/platform/config/loader.ts#L143) 现有逻辑保留）
- 实现 MCP / 动态工具注册路径（spec §5.2 只要求 `applyDenyFilter` 出口可复用；具体接入是 MCP 子系统的事）
- 子 agent 在 `core-subagent-spec.md` 的所有运行时实现

---

## 13. 时间估算

| PR | 净开发量 |
|---|---|
| **PR-A**（atomic）= 阶段 1–5 | 1–1.5 天：loader/prompt-factory 测试重写 + MemoryManager/LocalEmbeddingProvider 改造 + tool-registry/applyDenyFilter + RuntimeApp 改引用 + bootstrap 三处改动。不含迁移逻辑（spec §10 不提供向后兼容）。 |
| **PR-6** | 1 小时：SubagentsConfig 类型骨架 |
| **合计** | **约 2.5–3 个工作日** |

> 上轮原拆的 6 个 PR 总量不变，只是物理上合为 1 个 atomic PR。Review 难度集中但可按 §4–§8 的阶段逐节查。

---

## 14. 与上游 spec 的对齐校验

实施前请确认 spec 当前版本满足以下，否则任何分歧以 spec 为准（spec 是 source of truth）：

- [ ] spec §4 示例与本文档 §11 冒烟测试新格式一致
- [ ] spec §5.3「subagent 不对称」与本文档 §4.1 类型注释一致
- [ ] spec §7.5 dimensions 反查规则与本文档 §5.2 实施代码一致
- [ ] spec §10 「不提供兼容」的决策与本文档 §4.3 / §11 一致（未出现 migrateLegacyConfig 函数 / 旧格式冒烟用例）
- [ ] spec §11.1 改动清单覆盖本文档所有 PR 列出的文件
