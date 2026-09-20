# Configuration

> Status: Current Authority
> Authority: Current implemented configuration behavior
> Verified: 2026-09-18
> Ownership: Agent configuration shape, defaults, precedence, immutable projections, and environment overrides
> Ownership key: application-configuration

---

## 1. Boundary

`src/platform/config/` owns application-document composition, missing-document bootstrap, one strict Agent Home file read, credential materialization, immutable consumer projections, Agent merge precedence, and environment extraction. Modules own their leaf contracts and behavioral defaults; the Built-in LLM module applies this boundary under `src/builtins/providers/builtin/`. After resolving paths, the standalone Host ensures Agent Home exists, exclusively creates a missing `<agentHome>/config.json` with exact UTF-8 bytes `{}\n`, then reads that document once and passes the complete immutable snapshot to `RuntimeApp.create()` as a generic startup fact. Runtime Bootstrap selects the Application and Extension projections without rereading document content; Runtime never reads configuration files.

Agent Home owns the configuration document and mutable Agent state. Platform Configuration owns configuration bootstrap and loading; Core Agent Context independently owns Context files even though both may ensure their shared parent exists. `installDir` owns executable Extensions; Extension enablement and scoped configuration remain a namespace in the Agent document. Configuration may carry `llm.defaultModel` and one optional Built-in Provider deployment, but [Model Resolution](model-resolution.md) owns canonical identity, Catalog membership, effective limits, and Model Facts.

## 2. Agent configuration

`ensureAgentConfigDocument({ agentHome })` creates the parent recursively and uses exclusive creation for a missing document. `EEXIST` proceeds to strict loading; all existing path types and bytes are preserved. `loadAgentConfig({ agentHome })` then reads `<agentHome>/config.json` exactly once. Missing at read time is fatal `FILE_MISSING`, not an in-memory default path. An unreadable file, malformed JSON, non-object root, unknown top-level namespace, or invalid known namespace is another classified fatal error. The document may contain:

```text
AgentConfigDocument
├── llm.defaultModel?: ModelReference
├── llm.builtin?: { baseURL, apiKey?, models[] }
├── agents.defaults?: DeepPartial<AgentDefaults>
├── agents.list?: AgentEntry[]
├── logger?: LoggerModuleConfig
└── extensions?: Extension enablement and scoped settings
```

These are the only valid top-level namespaces. Retired `host` and every other unknown namespace fail directly. Retired Agent-level `model`/`llm` fields are also rejected. The returned Application/Extension snapshot and all nested projections are defensively copied and frozen. Startup CWD is not a configuration source, and there is no multi-file merge.

## 3. Precedence and merge

Lowest to highest precedence:

| Stage | Source | Owner/API |
|---:|---|---|
| 1 | `DEFAULT_AGENT_CONFIG` / `DEFAULT_LOGGER_CONFIG` | `loadAgentConfig()` |
| 2 | file `agents.defaults` and `logger` | `loadAgentConfig()` |
| 3 | matching `agents.list[]` entry | `resolveAgentConfig()` |
| 4 | environment overrides | `resolveAgentConfig()` |
| 5 | caller/CLI overrides | `resolveAgentConfig()` |

`deepMerge()` recursively merges plain objects, ignores `undefined`, and replaces arrays and scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic per-run Model Reference override: both must be present or both absent. A supported Host rejects a partial pair rather than inferring a Provider or Model. Built-in `apiKey` supports a literal or one exact `${ENV_VAR}` reference. Platform materializes that reference once; missing or blank referenced values fail without exposing the secret. The same resolver is used by Copilot Relay while retaining its `$env`/`$secret` forms.

## 4. Current schema and defaults

| Section | Current fields and defaults |
|---|---|
| `llm.defaultModel` | Optional preferred Root-Turn `{ providerId, modelId }`; also projected to clients as `unset`, `available`, or `unavailable`; never a fallback list |
| `llm.builtin` | Optional `{ baseURL, apiKey?, models[] }`; each model has `modelId`, `protocol`, and optional `displayName`; an empty model list is valid |
| `runner` | `maxLlmCalls=12`; `inTurnMessageMode='followup'` |
| `memory` | Enabled; local `Xenova/all-MiniLM-L6-v2`; chunk `1600/320`; search `6`, `0.25`, weights `0.7/0.3` |
| `prompt` | `safetyLevel='normal'` |
| `tools` | `allow=[]`; `deny=[]` |
| `context` | Agent Context budgets: `maxFileChars=20000`; `maxTotalChars=150000` |
| `compaction` | Enabled; reserve `20000`; keep 3 turns; result share `0.5`; head/tail `10000/5000`; timeout 300 seconds |
| `subagents` | Enabled; `maxDepth=1`; empty profile list |
| `logger` | Global `info`; console enabled; file disabled |

### Tool policy

`tools.deny` removes matching definitions from the visible Tool projection and remains final at execution. For structured path Tools, any lexically external declared target requires current-call Approval even when the Tool name is allowed; internal targets honor allow bypass. Unmatched Tools request Approval when an origin interaction capability exists and fail closed otherwise. Exec has no path confinement inference: deny blocks, allow authorizes arbitrary Shell execution, and otherwise it requires current-call Approval. Exact names and `*`/`?` globs are supported; `group:*` expansion is not.

### Subagent policy

`subagents.list[]` carries profile identity, description, Model selection, optional LLM-call limit, and narrow Tool policy. An explicit Child allow-list replaces the Parent allow-list; an explicit Child deny-list adds to the Parent deny-list. Runtime owns delegation and generation inheritance.

## 5. Core APIs

```text
ensureAgentConfigDocument({ agentHome }): Promise<void>
loadAgentConfig({ agentHome }): Promise<AgentConfigSnapshot>
resolveAgentConfig(appConfig, { agentId?, envOverrides?, cliOverrides? }): AgentDefaults
getEnvOverrides(): DeepPartial<AgentDefaults>
deepMerge(target, source): merged copy
```

`AgentConfigSnapshot` contains only immutable `application` and `extensions` projections. Runtime combines the injected Application projection with explicit `agentHome`. `resolveAgentConfig()` excludes `id` and `default` metadata from the selected per-agent entry before applying environment and caller overrides.

The retired `agents.defaults.workspace`, Agent-level `model`/`llm`, and corresponding per-agent keys are rejected directly. Public output-token configuration is removed; there is no `llm.maxTokens` or replacement. There is no alias or dual read; Agent Context budgets use `context` only.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [configuration types](../../src/platform/config/types.ts), [configuration loader](../../src/platform/config/agent-config-loader.ts) |
| Tests | [configuration loader tests](../../src/platform/config/agent-config-loader.test.ts) |
| Controlling authority | [Configuration Specification](../specifications/configuration.md) |
