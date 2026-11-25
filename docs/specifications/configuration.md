# Configuration Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-11-11
> Authority: Stable Agent configuration contract
> Implemented amendment: [Agent Management](agent-management.md) owns named-Agent
> discovery, sparse overrides and subsequent-Turn shared/named Tool policy.

## Scope

Own the sole `<agentHome>/config.json` document, application composition, one-read immutable Application/Extension projections, deep merge, five-stage Agent precedence, configured-Agent metadata, credential materialization, environment/caller overrides, and validation-error field attribution. Every configurable behavioral module owns its leaf contract, semantic validation, and immutable default: Built-in LLM, Runner/Compaction, Memory, Tool Policy, Agent Context, Subagent depth, and Logger. Platform Configuration imports and assembles those leaves without redefining their structures or literals. Extension projection semantics belong to [Extension Acquisition](extension-acquisition.md). Host-private process and Channel selection are not configuration namespaces.

Owner validators validate recognized leaf values. Platform first projects supported
Agent fields, ignoring unknown Agent/default/entry/nested-leaf content rather than
interpreting it as a legacy form. Recognized invalid values still fail with the
exact composed field path in `NAMESPACE_INVALID`; other namespaces retain their
own strict contracts.

## Loading and precedence

The physical loader remains globally strict: a document missing at read time is `FILE_MISSING`; an unreadable file, malformed JSON, non-object root, unknown namespace, or invalid known namespace is another classified fatal error. Only `FILE_MISSING` causes the Standalone Host to call Platform's `ensureAgentConfigDocument()`, which recursively creates the Home and exclusively writes `{}\n`, then load again. Existing or concurrently created files are never overwritten. Existing document content is read once per startup. The initialization wizard is removed; an empty object needs no Provider or default Model to start. Runtime receives a defensively copied/frozen Application projection and never reads configuration files.

Agent-scoped precedence is:

`hardcoded defaults -> file defaults -> matching agent entry -> environment overrides -> caller/CLI overrides`

Global Agent execution policy precedence is `module default -> agents top-level field`. Agent selection, Agent environment overrides, and Agent caller/CLI overrides do not participate. `deepMerge` recursively merges plain objects, ignores `undefined`, and replaces arrays/scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic reference override; partial presence fails. There is no first-Provider inference.

## Stable shape and ownership

- `llm.defaultModel?: { providerId, modelId }` is the optional preferred reference for a Root Turn without an explicit selection and the client Catalog default, not resolved facts, a mandatory startup model, a Child default, or a fallback list.
- `llm.builtin?: { baseURL, apiKey?, models[] }` configures one optional Built-in Provider. Each model declares an opaque `modelId`, one of the three supported protocols, optional `displayName`, optional positive safe-integer capability facts `maximumContextTokens`, `maximumPromptTokens`, and `maximumOutputTokens`, and separate optional positive safe-integer invocation policy `outputTokenLimit`; an empty list is valid. Omitting Prompt and Context limits uses the Built-in Provider's conservative `131,072` effective fallback.
- Built-in `apiKey` accepts a literal or one exact `${ENV_VAR}` reference. Platform materializes it once and fails safely when the referenced value is missing or blank. Arbitrary interpolation is not supported.
- A Built-in model may declare `endpoint?: string`, a nonblank relative operation
  path including any version and operation suffix. It is joined to the shared
  `baseURL` with one boundary slash and replaces, rather than extends, the
  protocol-default path. Omission preserves existing URL construction.
  Absolute URLs, scheme-relative authorities, queries, fragments, backslashes,
  whitespace within the path, and dot-segment traversal are invalid and report
  the exact `llm.builtin.models[index].endpoint` field. Accepted endpoints survive
  immutable configuration capture and supported model round trips. Credentials
  and host remain provider-wide; no protocol or vendor inference is performed.
- The legacy global `llm.maxTokens` is removed. Built-in output control is per-model `outputTokenLimit`; there is no global, Agent-level, Channel-level, or compatibility alias.
- `agents.steeringEnabled` is a global Runner-owned boolean and defaults to `true`; explicit `false` disables steering.
- `agents.maxLlmCallsPerTurn` is a global Runner-owned optional positive integer. Omission means no Model-call count limit. Every Root and Child Turn applies the same configured limit independently.
- Global Agent execution fields are frozen. `agents.defaults`, `agents.list[]`, Agent environment overrides, and Agent caller overrides cannot contain or override them.
- An explicit internal `RunTurnParams.maxLlmCalls` may override the configured value for that Root Turn. Child Turns still apply the global `agents.maxLlmCallsPerTurn`; Role-level limits and Parent remaining-budget inheritance are not supported.
- The top-level `runner` namespace and `inTurnMessageMode` are removed with no alias or compatibility path.
- Tool policy includes only allow and deny; there is no `tools.fs` subtree.
- Builtins Environment owns the separate global startup-only `agents.sandbox`
  leaf. Omission is disabled; `read`/`write`/`deny` absolute local path lists and
  enabled state and the `none`/`outbound`/`outbound-and-loopback` network mode
  (default `none`) are validated with exact composed field paths. Per-Agent placement
  is rejected. The independent `agents:sandbox` Settings section saves all five
  fields through the same owner validator and exposes saved/startup values,
  Host platform and restart status. It does not apply policies live or probe
  native capabilities while saving; other section saves preserve it.
  [Sandbox Execution](sandbox-execution.md) owns OS enforcement and lifecycle.
- Agent Context owns the contract/defaults for per-file and total loading budgets; `AgentDefaults.context` composes that leaf.
- Memory owns enablement, embedding, chunking, and search contracts/defaults.
  Platform composes them under global `agents.memory`, separately from
  AgentDefaults and named-Agent/environment/caller capability overrides.
  Precedence is `module defaults -> agents.memory`; partial nested values merge,
  and the complete resolved leaf is validated. Resolved chunking values control
  indexing boundaries and require positive safe integers with overlap smaller
  than chunk size.
- `agents.list[]` contains sparse named-Agent overrides, not registrations.
  Each entry requires a unique valid nonreserved ID and may provide `enabled`,
  nonblank `description`, `"inherit"` or a native Model Reference, and supported
  Agent-scoped capability overrides. Valid Home definitions default enabled.
  Configuration-only entries remain saved and diagnosed but are not executable
  specialist definitions. Model precedence is concrete config, explicit config
  `"inherit"`, MD recommendation, then Parent canonical Model.
- `agents.maxSubagentDepth` is a global non-negative safe integer and defaults
  to `1`. Effective `task` Tool policy controls delegation enablement; Runtime
  removes `task` at the configured depth boundary.
- Platform Logger owns Logger contracts/defaults/validation; Platform Configuration only composes the `logger` namespace.
- Logger's document admits global `minLevel` and optional `console.minLevel`
  and `file.minLevel`, using `debug`, `info`, `warn` or `error`; the global
  threshold defaults to `info` and is applied before local thresholds.
  File logging is always enabled by product Runtime startup. Console logging
  is Host-selected, not a document switch. Both adapter `enabled` fields are
  unsupported and follow ordinary unknown-field validation, with no migration
  or special retired-field handling. Configuration never chooses a CLI mode.
- Product File logs reside in `<agentHome>/logs`, using UTC daily names and
  retaining today plus the six preceding UTC calendar dates. Cleanup runs at
  startup and on the next write after the date advances, targeting only
  recognized regular log files; there is no timer, size cap or disk quota.
  Initialization must verify a usable current file or fail startup. Later
  append/queue-loss and cleanup failures emit bounded emergency stderr
  diagnostics without stopping the Agent; write loss remains attributable at
  shutdown. See [Observability](../architecture/observability.md) for the
  implemented lifecycle and diagnostic boundaries.
- Configuration does not own Catalog membership, canonical Model identity, effective facts, Provider semantics, or Runtime lifecycle.
- The only top-level namespaces are `llm`, `agents`, `logger`, and `extensions`.
  The physical-load snapshot contains immutable `application` and `extensions`
  projections plus the frozen raw `document` for server-side editing. The raw
  document contains unresolved credentials and must never be sent as a Channel view.
  Existing embedding snapshots may omit this editing source.
- Extension enablement is per `extensions.entries.<id>.enabled`. The retired
  `extensions.enabled` field is rejected on load and section save for every value,
  with guidance to configure per-entry enablement and remove the global field.
  An old global `false` is not silently discarded or interpreted as enabled.

Unknown top-level namespaces, including `runtime` and `host`, are rejected.
Unknown Agent content is omitted from the applied projection without detection,
conversion or repair. The raw editing document remains intact. `agents.list[]`
identity, enablement, description and model are metadata, not capability leaves.
Global execution fields, shared Tool defaults and named enabled/Tool overrides
support dynamic publication; other Agent defaults remain startup-only.
Settings may save/reset the three global execution fields independently through
`agents:execution`, preserving all other document content. Module-composed
defaults and resolved saved values are projected without a duplicate startup
view. Execution saves prepare/persist/publish through AgentPolicyState; new Root
and Child Turns capture the latest global policy while already captured Turn
parameters remain unchanged. No execution-policy restart notice is needed. The shared pure
execution-policy resolver is reused for startup and Settings, without copying
default literals into the client or persisting defaults merely on inspection.

`agents:memory` edits only `{ enabled: boolean }` with its own revision and no
credential intents. Saves preserve embedding/chunking/search and unrelated
content. Resolved saved enablement is compared with the actual startup Application
value: differences require restart and saving that startup value clears the
marker. Load/reload uses the saved server document, not a fresh disk read.
Memory saves do not publish Agent policy, load models, index files or change Tools.

Local embedding loading honors optional `HF_ENDPOINT` for a trusted
Hugging Face-compatible source. It must be an absolute HTTP(S) URL without
credentials, query or fragment; normalize its trailing slash and preserve the
SDK's model/revision layout and cache behavior. Invalid input fails explicitly.
Both lazy loading and dimension detection use the same path. Loading start and
success are INFO; failures are ERROR with model, endpoint, original failure and
available cause/code/actual file URL. Do not invent a URL, HTTP status or stage
from file-progress order. Connectivity hints may suggest a mirror; local or
authorization failures must not be mislabeled as connectivity failures.
Preserve original-error propagation and existing keyword-only fallback decisions.

Tool deny hides matching definitions and remains final at execution. Session permission mode is Runtime state, not configuration. In `manual`, all Exec calls require current-call Approval even when the Tool name is allowed; other allowed tools bypass Approval regardless of Home-relative/external targets, while unmatched Tools require Approval. Missing required Approval fails closed. In `allow_all`, every non-denied registered Tool is automatically authorized, without bypassing independent resource checks. Exact names and `*`/`?` globs are supported; `group:*` is not.

Agent Home is the relative path anchor, not a confinement boundary. Approval is current-call only. Canonical/symlink-aware authorization, persistent grants and command patterns remain outside this contract; separately configured sandbox enforcement belongs to [Sandbox Execution](sandbox-execution.md), not Tool approval or configuration loading.

## Section editing primitives

Platform Configuration owns `saveAgentConfigSection` and
`restoreAgentConfigSection`. A save reads the current document, edits only the
identified LLM, Extension, Memory, Sandbox, execution-policy, Skills, named Agent or shared Tool-default section, validates without environment resolution,
then exclusively creates a same-directory temporary file and renames it over
`config.json`. It returns the committed raw document and target preimage without
rereading after publication. This does not provide external-write CAS protection.
The shared file-publication primitive remains owned by Platform Configuration;
the removed Standalone wizard is not a consumer.
A Runtime-owned pre-commit callback can validate candidate model facts and recheck
shutdown admission after preparation but before file writing starts. The
configuration layer does not own admission policy or revisions.
Agent saves preserve sibling overrides, metadata, unsupported raw values and other
defaults; unchanged edits do not rewrite the document or materialize defaults.
Omitted allow restores shared inheritance; explicit `[]` replaces inherited allow.
Shared deny always remains final alongside local deny.

Credential changes are explicit keep/replace/clear intents. Omission keeps the raw
value, including an exact environment reference; credential values cannot be sent
as ordinary editable settings. Literal Extension credentials satisfy declared
constraints; legal exact references defer resolved-value constraints until startup.
Unknown credential paths and read-only/unsupported field edits are rejected.
Existing unsupported/read-only Extension values remain intact. Deleted model rows
are not restored; retained model IDs preserve omitted limit/reasoning fields.

Restoration reads the current file and restores only the captured target, including
an originally absent LLM section. Unrelated current values remain untouched.
File-publication and temporary-file cleanup failures propagate explicitly.
These persistence primitives are wired through Runtime SettingsManager, which owns
revision checks, serialization, Runtime application/rollback decisions, safe views
and shutdown coordination. The same Settings capability is available to Channels
and embedding. Model Test uses the in-memory section editor and explicit credential
intents without file I/O; saved-credential revision checks remain Runtime-owned.
The bundled WebSocket editor uses this capability for independent section saves;
it never reads files directly.
Agent saves prepare a complete next policy from currently applied Agent state
before persistence, then synchronously publish after confirmed persistence.
They do not apply unrelated pending-restart fields from the reread document.

## Acceptance scenarios

Cover Agent and global execution-policy precedence, object/array/scalar merge,
partial model environment overrides, absent/invalid documents, immutable startup
projections, supported-field projection with precise invalid-value attribution,
sparse overrides and reserved/duplicate IDs, model metadata exclusion, Root/Child
policy capture and subsequent-Turn saves, no-op persistence, pending-restart
isolation, Built-in endpoint/model validation, credential references, unknown
top-level rejection, effective Memory/Context budgets, Tool globs and fresh
owner-module default composition.

## Related authority

[Configuration](../architecture/configuration.md) owns current implementation facts. [ADR-012](../decisions/adr-012-agent-home-path-unification.md) owns Agent Home path unification and [ADR-013](../decisions/adr-013-standalone-host-arguments-and-channels.md) owns Host-private argument selection.
