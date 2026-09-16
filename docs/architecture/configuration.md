# Configuration

> Status: Current Authority
> Authority: Current implemented configuration behavior
> Verified: 2026-09-16
> Ownership: Agent configuration shape, defaults, precedence, immutable projections, and environment overrides
> Ownership key: application-configuration

---

## 1. Boundary

`src/platform/config/` owns Agent configuration types, hardcoded defaults, one strict Agent Home file read, immutable consumer projections, merge precedence, and environment extraction. The standalone Host reads `<agentHome>/config.json` once and injects the Application projection into `RuntimeApp.create()` and the Extension projection into acquisition. Runtime never reads configuration files.

Agent Home owns the configuration document and mutable Agent state. `installDir` owns executable Extensions; Extension enablement and scoped configuration remain a namespace in the Agent document. Configuration may carry a default Model Reference and Provider deployment-facts input, but [Model Resolution](model-resolution.md) owns canonical identity, Catalog membership, effective limits, and Model Facts.

## 2. Agent configuration

`loadAgentConfig({ agentHome })` reads `<agentHome>/config.json` exactly once. A missing file yields defaults. An unreadable file, malformed JSON, non-object root, unknown top-level namespace, or invalid known namespace is a classified fatal error. The document may contain:

```text
AgentConfigDocument
├── agents.defaults?: DeepPartial<AgentDefaults>
├── agents.list?: AgentEntry[]
├── logger?: LoggerModuleConfig
├── extensions?: Extension enablement and scoped settings
└── host?: standalone Host mode settings
```

The returned snapshot and all nested projections are defensively copied and frozen. The working directory is not a configuration source, and there is no multi-file merge.

## 3. Precedence and merge

Lowest to highest precedence:

| Stage | Source | Owner/API |
|---:|---|---|
| 1 | `DEFAULT_AGENT_CONFIG` / `DEFAULT_LOGGER_CONFIG` | `loadAgentConfig()` |
| 2 | file `agents.defaults` and `logger` | `loadAgentConfig()` |
| 3 | matching `agents.list[]` entry | `resolveAgentConfig()` |
| 4 | environment overrides | `resolveAgentConfig()` |
| 5 | caller/CLI overrides | `resolveAgentConfig()` |

`deepMerge()` recursively merges plain objects, ignores `undefined`, and replaces arrays and scalars. `getEnvOverrides()` maps `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` into the LLM branch. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic default Model Reference override: both must be present or both absent. A supported Host rejects a partial pair rather than inferring a Provider or Model.

## 4. Current schema and defaults

| Section | Current fields and defaults |
|---|---|
| `model` | Optional preferred Root-Turn `{ providerId, modelId }` when no explicit selection is supplied; not required for startup, inherited directly by Children, or used as a fallback list |
| `llm` | Optional API key/base URL; `maxTokens=4096`; optional Provider-owned `deploymentFacts[]` input |
| `runner` | `maxLlmCalls=12`; `inTurnMessageMode='followup'` |
| `memory` | Enabled; local `Xenova/all-MiniLM-L6-v2`; chunk `1600/320`; search `6`, `0.25`, weights `0.7/0.3` |
| `prompt` | `safetyLevel='normal'` |
| `tools` | Optional `fs.workingDirOnly=true`; `allow=[]`; `deny=[]` |
| `context` | Agent Context budgets: `maxFileChars=20000`; `maxTotalChars=150000` |
| `compaction` | Enabled; reserve `20000`; keep 3 turns; result share `0.5`; head/tail `10000/5000`; timeout 300 seconds |
| `subagents` | Enabled; `maxDepth=1`; empty profile list |
| `logger` | Global `info`; console enabled; file disabled |

`tools.fs.workingDirOnly` is the current coarse filesystem implementation switch, not a stable permission-model decision. Its present lexical behavior is documented by [Builtin Tools](builtin-tools.md); trusted roots, external-path approval, and grant persistence remain outside this architecture Change.

Removed concepts are not current fields: `llm.model`, `llm.contextWindowTokens`, Memory DB path, embedding dimensions, Session directory, the legacy workspace-owned agent directory, Tool implementation limits, nested `tools.approval`, and Logger file path/prefix/queue size.

### Tool policy

`tools.deny` removes matching definitions from the visible Tool projection. `tools.allow` bypasses current-call approval. An unmatched Tool requests approval when an origin interaction capability exists and fails closed otherwise. Exact names and `*`/`?` globs are supported; `group:*` expansion is not.

### Subagent policy

`subagents.list[]` carries profile identity, description, Model selection, optional LLM-call limit, and narrow Tool policy. An explicit Child allow-list replaces the Parent allow-list; an explicit Child deny-list adds to the Parent deny-list. Runtime owns delegation and generation inheritance.

## 5. Core APIs

```text
loadAgentConfig({ agentHome }): Promise<AgentConfigSnapshot>
resolveAgentConfig(appConfig, { agentId?, envOverrides?, cliOverrides? }): AgentDefaults
getEnvOverrides(): DeepPartial<AgentDefaults>
deepMerge(target, source): merged copy
```

`AgentConfigSnapshot` contains immutable `application`, `extensions`, and `host` projections. Runtime combines the injected Application projection with explicit `agentHome` and non-owning `workingDir` inputs. `resolveAgentConfig()` excludes `id` and `default` metadata from the selected per-agent entry before applying environment and caller overrides.

The retired `agents.defaults.workspace` and per-agent `workspace` keys are rejected directly. There is no alias or dual read; Agent Context budgets use `context` only.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [types.ts](../../src/platform/config/types.ts), [defaults.ts](../../src/platform/config/defaults.ts), [Agent configuration loader](../../src/platform/config/agent-config-loader.ts), [configuration errors](../../src/platform/config/agent-config-errors.ts), [resolution](../../src/platform/config/loader.ts) |
| Tests | [Agent configuration loader tests](../../src/platform/config/agent-config-loader.test.ts), [resolution tests](../../src/platform/config/loader.test.ts) |
| Controlling authority | [ADR-004](../decisions/adr-004-provider-model-identity-and-facts-ownership.md), [Configuration Specification](../specifications/configuration.md), [Model Resolution Specification](../specifications/model-resolution.md) |
