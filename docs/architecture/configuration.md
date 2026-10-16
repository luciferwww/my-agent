# Configuration

> Status: Current Authority
> Authority: Current implemented configuration behavior
> Verified: 2026-09-18
> Ownership: Agent configuration shape, defaults, precedence, immutable projections, and environment overrides
> Ownership key: application-configuration

---

## 1. Boundary

`src/platform/config/` owns application-document composition, its explicit bootstrap API, one strict Agent Home file read, credential materialization, immutable consumer projections, Agent merge precedence, configured-Agent metadata, and environment extraction. Modules own their leaf contracts, semantic validation, and behavioral defaults: Built-in LLM, Runner/Compaction, Memory, Tool Policy, Agent Context, Subagent depth, and Logger each export their own contract/default/validator. Platform imports those leaves and maps owner validation failures to document field paths; leaf modules never import Platform Configuration. After resolving paths, ordinary Standalone startup reads `<agentHome>/config.json` once and passes the complete immutable snapshot to `RuntimeApp.create()` as a generic startup fact. A missing document instead produces bounded `--initialize` guidance before Runtime creation. Explicit Standalone initialization owns its interactive verification and config-last publication path. Runtime Bootstrap selects the Application and Extension projections without rereading document content; Runtime never reads configuration files.

Agent Home owns the configuration document and mutable Agent state. Platform Configuration owns configuration bootstrap and loading; Core Agent Context independently owns Context files even though both may ensure their shared parent exists. `installDir` owns executable Extensions; Extension enablement and scoped configuration remain a namespace in the Agent document. Configuration may carry `llm.defaultModel` and one optional Built-in Provider deployment, but [Model Resolution](model-resolution.md) owns canonical identity, Catalog membership, effective limits, and Model Facts.

## 2. Agent configuration

`ensureAgentConfigDocument({ agentHome })` remains an explicit Platform API that creates the parent recursively and uses exclusive creation for a missing document; ordinary Standalone startup does not call it. `loadAgentConfig({ agentHome })` reads `<agentHome>/config.json` exactly once. Missing at read time is fatal `FILE_MISSING`, not an in-memory default path. An unreadable file, malformed JSON, non-object root, unknown top-level namespace, or invalid known namespace is another classified fatal error. The document may contain:

```text
AgentConfigDocument
├── llm.defaultModel?: ModelReference
├── llm.builtin?: { baseURL, apiKey?, models[] }
├── agents.steeringEnabled?: boolean
├── agents.maxLlmCallsPerTurn?: number
├── agents.maxSubagentDepth?: number
├── agents.defaults?: DeepPartial<AgentDefaults>
├── agents.list?: AgentEntry[]
├── logger?: LoggerModuleConfig
└── extensions?: Extension enablement and scoped settings
```

These are the only valid top-level namespaces. Agent execution policy is global Application policy under `agents` and cannot appear in `agents.defaults` or `agents.list[]`. Retired `runtime`, `runner`, `host`, and every other unknown namespace fail directly. Retired Agent-level `model`/`llm` fields are also rejected. The returned Application/Extension snapshot and all nested projections are defensively copied and frozen. Startup CWD is not a configuration source, and there is no multi-file merge.

## 3. Precedence and merge

Lowest to highest precedence:

| Stage | Source | Owner/API |
|---:|---|---|
| 1 | owner-module defaults assembled by `createDefaultAgentConfig()` plus the Logger-owned default | `loadAgentConfig()` |
| 2 | top-level Agent execution fields, file `agents.defaults`, and `logger` | `loadAgentConfig()` |
| 3 | matching `agents.list[]` entry | `resolveAgentConfig()` |
| 4 | environment overrides | `resolveAgentConfig()` |
| 5 | caller/CLI overrides | `resolveAgentConfig()` |

Stages 3–5 apply only to Agent-scoped configuration. Global Agent execution policy uses `module default -> agents top-level field`; Agent selection, environment overrides, and caller Agent overrides cannot change it. `deepMerge()` recursively merges plain objects, ignores `undefined`, and replaces arrays and scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic per-run Model Reference override: both must be present or both absent. A supported Host rejects a partial pair rather than inferring a Provider or Model. Built-in and Extension `apiKey` fields support a literal or one exact `${ENV_VAR}` reference. Platform materializes that reference once; missing or blank referenced values fail without exposing the secret. Other Extension fields have no generic environment-reference syntax.

## 4. Current schema and defaults

| Section | Current fields and defaults |
|---|---|
| `llm.defaultModel` | Optional preferred Root-Turn `{ providerId, modelId }`; also projected to clients as `unset`, `available`, or `unavailable`; never a fallback list |
| `llm.builtin` | Optional `{ baseURL, apiKey?, models[] }`; each model has `modelId`, `protocol`, optional `displayName`, optional positive safe-integer capability facts `maximumContextTokens`, `maximumPromptTokens`, and `maximumOutputTokens`, plus separate optional invocation policy `outputTokenLimit`; omitting Prompt and Context limits uses `131072`; an empty model list is valid |
| `agents.steeringEnabled` | Global boolean; defaults to `false` |
| `agents.maxLlmCallsPerTurn` | Global optional positive integer applied independently to each Root or Child Turn; omitted means no Model-call count limit |
| `memory` | Enabled; local `Xenova/all-MiniLM-L6-v2`; chunk `1600/320`; search `6`, `0.25`, weights `0.7/0.3` |
| `tools` | `allow=[]`; `deny=[]` |
| `context` | Agent Context budgets: `maxFileChars=20000`; `maxTotalChars=150000` |
| `compaction` | Enabled; maximum desired output headroom `20000` when only a total Context limit is known; keep 3 turns; result share `0.5`; head/tail `10000/5000`; timeout 300 seconds |
| `agents.maxSubagentDepth` | Global non-negative safe integer; defaults to `1`; `0` removes `task` from the Root Agent's effective Tool policy |
| `agents.list[]` | Shared configured-Agent registry; every entry requires unique `id` and nonblank `description`, and may declare `model` and Agent-scoped capability overrides; Runner fields including `maxLlmCalls` are rejected |
| `logger` | Global `info`; console enabled; file disabled |

### Tool policy

`tools.deny` removes matching definitions from the visible Tool projection and remains final at execution. The Runtime-owned Session permission mode is deliberately not configuration and does not alter these projected lists. In `manual`, structured targets outside Agent Home and all Exec calls require current-call Approval even when their Tool names are allowed; internal targets honor allow bypass, and other unmatched Tools request Approval. Missing required Approval fails closed. In process-local `allow_all`, every non-denied registered Tool is automatically authorized. Exact names and `*`/`?` globs are supported; `group:*` expansion is not.

### Configured Agents and delegation

`agents.list[]` is the shared configured-Agent registry. Runtime projects the entry fields currently supported by Child execution—identity, description, optional Model selection, and Tool policy—into an internal Subagent profile. An omitted Model means inherit the execution entry's Model. Configured Agent Context is loaded from `<agentHome>/agents/<agentId>/`. Every Root and Child Turn applies `agents.maxLlmCallsPerTurn` independently; counters and remaining capacity are not inherited.

Delegation enablement is ordinary effective Tool policy: denying `task` removes delegation for that Agent. `agents.maxSubagentDepth` independently bounds recursive delegation; Runtime removes `task` at the depth boundary. An explicit Child allow-list replaces the Parent allow-list, while an explicit Child deny-list adds to the Parent deny-list. Runtime owns delegation and generation inheritance.

## 5. Core APIs

```text
ensureAgentConfigDocument({ agentHome }): Promise<void>
loadAgentConfig({ agentHome }): Promise<AgentConfigSnapshot>
resolveAgentConfig(appConfig, { agentId?, envOverrides?, cliOverrides? }): AgentDefaults
deepMerge(target, source): merged copy
```

`AgentConfigSnapshot` contains only immutable `application` and `extensions` projections. Runtime combines the injected Application projection with explicit `agentHome`, keeps global Agent execution fields separate from resolved Agent defaults, and maps `agents.maxLlmCallsPerTurn` to each Runner invocation. `resolveAgentConfig()` excludes configured-Agent metadata (`id`, `description`, `default`, and `model`) from the selected capability override before applying environment and caller overrides.

`createDefaultAgentConfig()` returns a fresh aggregate assembled from immutable owner defaults; it contains no leaf literals. The former centralized `platform/config/defaults.ts` and mutable `DEFAULT_AGENT_CONFIG` export are removed. `platform/config/types.ts` retains only composition contracts and type re-exports.

The retired top-level `runtime`/`runner`, Agent-scoped `prompt`, `agents.defaults.workspace`, `agents.defaults.subagents`, Agent-level `llm`, nested/per-Agent `runtime`/`runner`, and corresponding per-agent keys are rejected directly. `model` is invalid under `agents.defaults` but valid as configured-Agent metadata in `agents.list[]`. `runner.inTurnMessageMode` has no compatibility reader and is rejected by strict Runner leaf validation. The legacy global `llm.maxTokens` remains removed with no alias; Built-in per-model `outputTokenLimit` is the only configured output invocation policy. There is no dual read, and Agent Context budgets use `context` only.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [configuration types](../../src/platform/config/types.ts), [configuration loader](../../src/platform/config/agent-config-loader.ts), [default composition](../../src/platform/config/default-composition.ts), [Runner config](../../src/core/runner/config.ts), [Memory config](../../src/core/memory/config.ts), [Tool policy config](../../src/core/tools/config.ts), [Agent Context config](../../src/core/agent-context/config.ts), [Compaction config](../../src/core/runner/compaction-config.ts), [Subagent config](../../src/core/subagent/config.ts), [Logger config](../../src/platform/logger/config.ts) |
| Tests | [configuration loader tests](../../src/platform/config/agent-config-loader.test.ts) |
| Controlling authority | [Configuration Specification](../specifications/configuration.md) |
