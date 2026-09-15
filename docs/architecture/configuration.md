# Configuration

> Status: Current Authority
> Authority: Current implemented configuration behavior
> Verified: 2026-09-15
> Ownership: application and workspace configuration shape, defaults, precedence, merge, and environment overrides
> Ownership key: application-configuration

---

## 1. Boundary

`src/platform/config/` owns application configuration types, hardcoded defaults, workspace-file loading, merge precedence, and environment extraction. Runtime calls `loadConfig()` and `resolveAgentConfig()` and projects the result into narrow module inputs.

This topic does not own Agent Home or Host Extension configuration; [Extensions](extensions.md) owns that separate acquisition surface. Configuration may carry a default Model Reference and Provider deployment-facts input, but [Model Resolution](model-resolution.md) owns canonical identity, Catalog membership, effective limits, and Model Facts.

## 2. Workspace configuration

`loadConfig({ workspaceDir })` reads `<workspaceDir>/.agent/config.json`. The partial file may contain:

```text
ConfigFile
├── agents.defaults?: DeepPartial<AgentDefaults>
├── agents.list?: AgentEntry[]
└── logger?: LoggerModuleConfig
```

A missing, unreadable, malformed, or non-object file degrades to defaults. This permissive read is not JSON Schema validation.

## 3. Precedence and merge

Lowest to highest precedence:

| Stage | Source | Owner/API |
|---:|---|---|
| 1 | `DEFAULT_AGENT_CONFIG` / `DEFAULT_LOGGER_CONFIG` | `loadConfig()` |
| 2 | file `agents.defaults` and `logger` | `loadConfig()` |
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
| `tools` | Optional `fs.workspaceOnly=true`; `allow=[]`; `deny=[]` |
| `workspace` | `maxFileChars=20000`; `maxTotalChars=150000` |
| `compaction` | Enabled; reserve `20000`; keep 3 turns; result share `0.5`; head/tail `10000/5000`; timeout 300 seconds |
| `subagents` | Enabled; `maxDepth=1`; empty profile list |
| `logger` | Global `info`; console enabled; file disabled |

Removed concepts are not current fields: `llm.model`, `llm.contextWindowTokens`, Memory DB path, embedding dimensions, Session directory, Workspace agent directory, Tool implementation limits, nested `tools.approval`, and Logger file path/prefix/queue size.

### Tool policy

`tools.deny` removes matching definitions from the visible Tool projection. `tools.allow` bypasses current-call approval. An unmatched Tool requests approval when an origin interaction capability exists and fails closed otherwise. Exact names and `*`/`?` globs are supported; `group:*` expansion is not.

### Subagent policy

`subagents.list[]` carries profile identity, description, Model selection, optional LLM-call limit, and narrow Tool policy. An explicit Child allow-list replaces the Parent allow-list; an explicit Child deny-list adds to the Parent deny-list. Runtime owns delegation and generation inheritance.

## 5. Core APIs

```text
loadConfig({ workspaceDir }): AppConfig
resolveAgentConfig(appConfig, { agentId?, envOverrides?, cliOverrides? }): AgentDefaults
getEnvOverrides(): DeepPartial<AgentDefaults>
deepMerge(target, source): merged copy
```

`loadConfig()` returns `workspaceDir`, merged `agents.defaults`, unmodified `agents.list`, and merged Logger configuration. `resolveAgentConfig()` excludes `id` and `default` metadata from the selected per-agent entry before applying environment and caller overrides.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [types.ts](../../src/platform/config/types.ts), [defaults.ts](../../src/platform/config/defaults.ts), [loader.ts](../../src/platform/config/loader.ts) |
| Tests | [config loader tests](../../src/platform/config/loader.test.ts) |
| Controlling authority | [ADR-004](../decisions/adr-004-provider-model-identity-and-facts-ownership.md), [Configuration Specification](../specifications/configuration.md), [Model Resolution Specification](../specifications/model-resolution.md) |
