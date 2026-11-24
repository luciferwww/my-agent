# Configuration

> Status: Current Authority
> Authority: Current implemented configuration behavior
> Verified: 2026-11-16
> Ownership: Agent configuration shape, defaults, precedence, immutable projections, and environment overrides
> Ownership key: application-configuration

---

## 1. Boundary

`src/platform/config/` owns application-document composition, its bootstrap API, strict Agent Home loading, credential materialization, immutable consumer projections, Agent merge precedence, configured-Agent metadata, and environment extraction. Modules own their leaf contracts, semantic validation, and behavioral defaults: Built-in LLM, Runner/Compaction, Memory, Tool Policy, Agent Context, Subagent depth, and Logger each export their own contract/default/validator. Platform imports those leaves and maps owner validation failures to document field paths; leaf modules never import Platform Configuration. After resolving paths, ordinary Standalone startup reads `<agentHome>/config.json` and passes the complete immutable snapshot to `RuntimeApp.create()` as a generic startup fact. Only a missing document invokes Platform bootstrap before retrying strict loading. The old initialization wizard is removed. Runtime Bootstrap selects the Application and Extension projections without rereading document content; Runtime never reads configuration files.

Agent Home owns the configuration document and mutable Agent state. Platform Configuration owns configuration bootstrap and loading; Core Agent Context independently owns Context files even though both may ensure their shared parent exists. `installDir` owns executable Extensions; Extension enablement and scoped configuration remain a namespace in the Agent document. Configuration may carry `llm.defaultModel` and one optional Built-in Provider deployment, but [Model Resolution](model-resolution.md) owns canonical identity, Catalog membership, effective limits, and Model Facts.

## 2. Agent configuration

`ensureAgentConfigDocument({ agentHome })` creates the parent recursively and exclusively writes `{}\n` for a missing document. Ordinary Standalone startup invokes it only after strict loading returns `FILE_MISSING`, then loads again. `loadAgentConfig({ agentHome })` itself still reads once and throws on missing files. An unreadable file, malformed JSON, non-object root, unknown top-level namespace, or invalid known namespace remains a classified fatal error. Existing configuration is never overwritten by bootstrap. The document may contain:

```text
AgentConfigDocument
├── llm.defaultModel?: ModelReference
├── llm.builtin?: { baseURL, apiKey?, models[] }
├── agents.steeringEnabled?: boolean
├── agents.maxLlmCallsPerTurn?: number
├── agents.maxSubagentDepth?: number
├── agents.memory?: DeepPartial<MemoryConfig>
├── agents.sandbox?: Partial<SandboxConfig>
├── agents.defaults?: DeepPartial<AgentDefaults>
├── agents.list?: AgentEntry[]
├── logger?: LoggerModuleConfig
└── extensions?: Extension enablement and scoped settings
```

These are the only valid top-level namespaces. Agent execution policy is global
Application policy under `agents`; nested/per-Agent values cannot override it.
Retired `runtime`, `runner`, `host`, and every other unknown namespace fail
directly. Unknown Agent fields are ignored by supported-field projection, while
invalid recognized values fail. Application/Extension projections are defensively
copied and frozen. Startup CWD is not a source, and there is no multi-file merge.

The snapshot also retains the frozen raw editing document on the server; it is
not a safe Channel view. Extension enablement exists only per entry. Any legacy
`extensions.enabled` field fails with explicit per-entry/removal guidance on load
or section save, rather than silently activating entries previously covered by
global `false`.

## 3. Precedence and merge

Lowest to highest precedence:

| Stage | Source | Owner/API |
|---:|---|---|
| 1 | owner-module defaults assembled by `createDefaultAgentConfig()` plus the Logger-owned default | `loadAgentConfig()` |
| 2 | top-level Agent execution fields, file `agents.defaults`, and `logger` | `loadAgentConfig()` |
| 3 | matching `agents.list[]` entry | `resolveAgentConfig()` |
| 4 | environment overrides | `resolveAgentConfig()` |
| 5 | caller/CLI overrides | `resolveAgentConfig()` |

Stages 3–5 apply only to Agent-scoped configuration. Global Agent execution policy and Memory use `module default -> agents top-level field`; Agent selection, environment overrides, and caller Agent overrides cannot change them. `deepMerge()` recursively merges plain objects, ignores `undefined`, and replaces arrays and scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic per-run Model Reference override: both must be present or both absent. A supported Host rejects a partial pair rather than inferring a Provider or Model. Built-in and Extension `apiKey` fields support a literal or one exact `${ENV_VAR}` reference. Platform materializes that reference once; missing or blank referenced values fail without exposing the secret. Other Extension fields have no generic environment-reference syntax.

## 4. Current schema and defaults

| Section | Current fields and defaults |
|---|---|
| `llm.defaultModel` | Optional preferred Root-Turn `{ providerId, modelId }`; also projected to clients as `unset`, `available`, or `unavailable`; never a fallback list |
| `llm.builtin` | Optional `{ baseURL, apiKey?, models[] }`; each model has `modelId`, `protocol`, optional `displayName`, optional positive safe-integer capability facts `maximumContextTokens`, `maximumPromptTokens`, and `maximumOutputTokens`, plus separate optional invocation policy `outputTokenLimit`; omitting Prompt and Context limits uses `131072`; an empty model list is valid |
| `agents.steeringEnabled` | Global boolean; defaults to `true`; explicit `false` disables steering |
| `agents.maxLlmCallsPerTurn` | Global optional positive integer applied independently to each Root or Child Turn; omitted means no Model-call count limit |
| `agents.memory` | Global; enabled; local `Xenova/all-MiniLM-L6-v2`; chunk `1600/320`; search `6`, `0.25`, weights `0.7/0.3` |
| `agents.sandbox` | Global startup-only opt-in; disabled; explicit paths and `network: none/outbound/outbound-and-loopback` (default `none`); Windows BaseContainer/Linux bubblewrap enforcement belongs to Builtins Environment |
| `tools` | `allow=[]`; `deny=[]` |
| `skills` | `[]`; default names under `agents.defaults.skills`; optional `agents.list[].skills` completely replaces defaults, including explicit `[]` |
| `context` | Agent Context budgets: `maxFileChars=20000`; `maxTotalChars=150000` |
| `compaction` | Enabled; maximum desired output headroom `20000` when only a total Context limit is known; keep 3 turns; result share `0.5`; head/tail `10000/5000`; timeout 300 seconds |
| `agents.maxSubagentDepth` | Global non-negative safe integer; defaults to `1`; `0` removes `task` from the Root Agent's effective Tool policy |
| `agents.list[]` | Sparse overrides of Home-discovered Agents; unique nonreserved `id`, optional `enabled`, description, model reference or `"inherit"`, and supported capability overrides; not a registration source |
| `logger` | Global `info`; file always enabled; Console output selected by Host startup policy |

### Global Sandbox and Memory

Sandbox configuration is separately resolved by the Builtins-owned leaf validator.
It is not an Agent capability or live execution setting; per-Agent placement is
rejected. Runtime's asynchronous Builtin assembly prepares the SDK before Registry
publication when enabled. Runtime's `agents:sandbox` Settings section edits the
enabled flag, network mode and three path lists using the existing section
editor. It compares resolved saved values with the actual startup configuration,
reports current startup values and restart requirements, and never publishes
live Sandbox changes. Other section saves preserve the leaf. No native probe
or command is executed by a Sandbox save.
[Sandbox Execution](../specifications/sandbox-execution.md) owns
the enforcement and lifecycle contract.

Memory is composed by `resolveMemoryConfig()` separately from AgentDefaults.
The `agents:memory` Settings section edits only its enabled flag, preserving
embedding/chunking/search and unrelated fields. It compares resolved saved
enablement with the actual startup Application value; changes require restart,
and saving the startup value clears the marker. It does not publish Agent policy.

### Tool policy

`tools.deny` removes matching definitions from the visible Tool projection and remains final at execution. The Runtime-owned Session permission mode is deliberately not configuration and does not alter these projected lists. In `manual`, structured targets outside Agent Home and all Exec calls require current-call Approval even when their Tool names are allowed; internal targets honor allow bypass, and other unmatched Tools request Approval. Missing required Approval fails closed. In process-local `allow_all`, every non-denied registered Tool is automatically authorized. Exact names and `*`/`?` globs are supported; `group:*` expansion is not.

### Configured Agents and delegation

Skills selection is dynamic through Settings, independently of Tool policy.
`agents:skills` edits only default Skills; existing `agent:<id>` sections edit
named selections alongside enabled/Tools. Omission inherits and an explicit
empty list selects none. Missing packages do not invalidate or erase saved names.
Each Root/Child captures its own current selection; persistence precedes policy
publication. Core Skills owns name/selection validation, not Agent Context budgets.

Home `agents/<id>` definitions are the registration authority. Startup snapshots
hold validated MD metadata and instruction bodies; sparse `agents.list[]` values
override enabled, description, model and supported capabilities. Config-only
entries do not register specialists. Concrete config model precedes explicit
`"inherit"`, MD recommendation and Parent inheritance. See
[Agent Management](../specifications/agent-management.md) for initialization,
fallback and read-only Context contracts. Every Root and Child independently
applies `agents.maxLlmCallsPerTurn`; remaining capacity is not inherited.

Delegation enablement is ordinary effective Tool policy: denying `task` removes
delegation for that Agent. Depth independently bounds recursion. Each new Child
selects current shared Tool defaults plus only its own override: explicit allow
replaces shared allow, while shared/local deny combine. It does not merge a named
Parent's own denies or previously captured tools. Root/Child captures are immutable
for admitted Turns; Runtime owns delegation and Provider-generation inheritance.
Settings publishes global execution and shared/named Tool changes only after
persistence, based on current applied state rather than unrelated file edits.
Each new Root/Child captures the latest global execution policy; already
captured parameters remain stable. Child depth admission and canSpawn use the
same pre-setup snapshot, independently of the Parent's captured limits.

## 5. Core APIs

```text
ensureAgentConfigDocument({ agentHome }): Promise<void>
loadAgentConfig({ agentHome }): Promise<AgentConfigSnapshot>
resolveAgentConfig(appConfig, { agentId?, envOverrides?, cliOverrides? }): AgentDefaults
deepMerge(target, source): merged copy
```

`AgentConfigSnapshot` contains immutable `application` and `extensions`
projections and a server-only raw editing `document`. Runtime combines the
Application projection with explicit `agentHome`, keeps global execution fields
separate from resolved defaults, and maps `agents.maxLlmCallsPerTurn` to each
Runner invocation. `resolveAgentConfig()` projects supported capability leaves,
excluding metadata (`id`, `enabled`, `description`, `model`) and unknown fields
before environment and caller overrides.

`createDefaultAgentConfig()` returns a fresh aggregate assembled from immutable owner defaults; it contains no leaf literals. The former centralized `platform/config/defaults.ts` and mutable `DEFAULT_AGENT_CONFIG` export are removed. `platform/config/types.ts` retains only composition contracts and type re-exports.

Unknown Agent/default/entry/nested-leaf fields do not enter the applied projection.
There is no legacy detection, compatibility reader, migration or raw-file cleanup.
Unknown top-level namespaces still fail, and recognized invalid values are not
silently defaulted. Built-in per-model `outputTokenLimit` remains the configured
output invocation policy; Context budgets use `context` only.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [configuration types](../../src/platform/config/types.ts), [configuration loader](../../src/platform/config/agent-config-loader.ts), [default composition](../../src/platform/config/default-composition.ts), [Runner config](../../src/core/runner/config.ts), [Memory config](../../src/core/memory/config.ts), [Tool policy config](../../src/core/tools/config.ts), [Agent Context config](../../src/core/agent-context/config.ts), [Compaction config](../../src/core/runner/compaction-config.ts), [Subagent config](../../src/core/subagent/config.ts), [Logger config](../../src/platform/logger/config.ts) |
| Tests | [configuration loader tests](../../src/platform/config/agent-config-loader.test.ts) |
| Controlling authority | [Configuration Specification](../specifications/configuration.md) |
