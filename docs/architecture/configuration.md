# Configuration

> Status: Current Authority
> Authority: Current implemented configuration behavior
> Verified: 2026-09-16
> Ownership: Agent configuration shape, defaults, precedence, immutable projections, and environment overrides
> Ownership key: application-configuration

---

## 1. Boundary

`src/platform/config/` owns Agent configuration types, hardcoded defaults, missing-document bootstrap, one strict Agent Home file read, immutable consumer projections, merge precedence, and environment extraction. After resolving paths, the standalone Host ensures Agent Home exists, exclusively creates a missing `<agentHome>/config.json` with exact UTF-8 bytes `{}\n`, then reads that document once and injects the Application projection into `RuntimeApp.create()` and the Extension projection into acquisition. Bootstrap does not read document content. Runtime never reads configuration files.

Agent Home owns the configuration document and mutable Agent state. Platform Configuration owns configuration bootstrap and loading; Core Agent Context independently owns Context files even though both may ensure their shared parent exists. `installDir` owns executable Extensions; Extension enablement and scoped configuration remain a namespace in the Agent document. Configuration may carry a default Model Reference and Provider deployment-facts input, but [Model Resolution](model-resolution.md) owns canonical identity, Catalog membership, effective limits, and Model Facts.

## 2. Agent configuration

`ensureAgentConfigDocument({ agentHome })` creates the parent recursively and uses exclusive creation for a missing document. `EEXIST` proceeds to strict loading; all existing path types and bytes are preserved. `loadAgentConfig({ agentHome })` then reads `<agentHome>/config.json` exactly once. Missing at read time is fatal `FILE_MISSING`, not an in-memory default path. An unreadable file, malformed JSON, non-object root, unknown top-level namespace, or invalid known namespace is another classified fatal error. The document may contain:

```text
AgentConfigDocument
├── agents.defaults?: DeepPartial<AgentDefaults>
├── agents.list?: AgentEntry[]
├── logger?: LoggerModuleConfig
├── extensions?: Extension enablement and scoped settings
└── host?: standalone Host mode settings
```

The returned snapshot and all nested projections are defensively copied and frozen. Startup CWD is not a configuration source, and there is no multi-file merge.

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
| `tools` | `allow=[]`; `deny=[]` |
| `context` | Agent Context budgets: `maxFileChars=20000`; `maxTotalChars=150000` |
| `compaction` | Enabled; reserve `20000`; keep 3 turns; result share `0.5`; head/tail `10000/5000`; timeout 300 seconds |
| `subagents` | Enabled; `maxDepth=1`; empty profile list |
| `logger` | Global `info`; console enabled; file disabled |

Removed concepts are not current fields: `llm.model`, `llm.contextWindowTokens`, Memory DB path, embedding dimensions, Session directory, the legacy workspace-owned agent directory, `tools.fs`, Tool implementation limits, nested `tools.approval`, and Logger file path/prefix/queue size.

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

`AgentConfigSnapshot` contains immutable `application`, `extensions`, and `host` projections. Runtime combines the injected Application projection with explicit `agentHome`. `resolveAgentConfig()` excludes `id` and `default` metadata from the selected per-agent entry before applying environment and caller overrides.

The retired `agents.defaults.workspace` and per-agent `workspace` keys are rejected directly. There is no alias or dual read; Agent Context budgets use `context` only.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [types.ts](../../src/platform/config/types.ts), [defaults.ts](../../src/platform/config/defaults.ts), [Agent configuration bootstrap](../../src/platform/config/agent-config-bootstrap.ts), [Agent configuration loader](../../src/platform/config/agent-config-loader.ts), [configuration errors](../../src/platform/config/agent-config-errors.ts), [resolution](../../src/platform/config/loader.ts) |
| Tests | [Agent configuration bootstrap tests](../../src/platform/config/agent-config-bootstrap.test.ts), [Agent configuration loader tests](../../src/platform/config/agent-config-loader.test.ts), [resolution tests](../../src/platform/config/loader.test.ts) |
| Controlling authority | [ADR-004](../decisions/adr-004-provider-model-identity-and-facts-ownership.md), [ADR-011](../decisions/adr-011-standalone-agent-home-configuration-bootstrap.md), [ADR-012](../decisions/adr-012-agent-home-path-unification.md), [Configuration Specification](../specifications/configuration.md), [Model Resolution Specification](../specifications/model-resolution.md) |
