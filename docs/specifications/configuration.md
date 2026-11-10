# Configuration Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-11-10
> Authority: Stable Agent configuration contract

## Scope

Own the sole `<agentHome>/config.json` document, application composition, one-read immutable Application/Extension projections, deep merge, five-stage Agent precedence, configured-Agent metadata, credential materialization, environment/caller overrides, and validation-error field attribution. Every configurable behavioral module owns its leaf contract, semantic validation, and immutable default: Built-in LLM, Runner/Compaction, Memory, Tool Policy, Agent Context, Subagent depth, and Logger. Platform Configuration imports and assembles those leaves without redefining their structures or literals. Extension projection semantics belong to [Extension Acquisition](extension-acquisition.md). Host-private process and Channel selection are not configuration namespaces.

Owner validators reject unknown fields at every leaf and nested-leaf level. Platform preserves the exact composed field path in the resulting `NAMESPACE_INVALID` error.

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
- `agents.steeringEnabled` is a global Runner-owned boolean and defaults to `false`.
- `agents.maxLlmCallsPerTurn` is a global Runner-owned optional positive integer. Omission means no Model-call count limit. Every Root and Child Turn applies the same configured limit independently.
- Global Agent execution fields are frozen. `agents.defaults`, `agents.list[]`, Agent environment overrides, and Agent caller overrides cannot contain or override them.
- An explicit internal `RunTurnParams.maxLlmCalls` may override the configured value for that Root Turn. Child Turns still apply the global `agents.maxLlmCallsPerTurn`; Role-level limits and Parent remaining-budget inheritance are not supported.
- The top-level `runner` namespace and `inTurnMessageMode` are removed with no alias or compatibility path.
- Tool policy includes only allow and deny; there is no `tools.fs` subtree.
- Agent Context owns the contract/defaults for per-file and total loading budgets; `AgentDefaults.context` composes that leaf.
- Memory owns embedding, chunking, and search contracts/defaults. Resolved chunking values control actual indexing boundaries and require positive safe integers with overlap smaller than chunk size.
- `agents.list[]` is the single configured-Agent registry. Every entry requires
  a unique ID and nonblank description and may declare an optional Model
  Reference and Agent-scoped capability overrides.
  An omitted Model means inheritance when the entry is used for Child
  execution.
- `agents.maxSubagentDepth` is a global non-negative safe integer and defaults
  to `1`. Effective `task` Tool policy controls delegation enablement; Runtime
  removes `task` at the configured depth boundary.
- Platform Logger owns Logger contracts/defaults/validation; Platform Configuration only composes the `logger` namespace.
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

Unknown fields are rejected rather than ignored or treated as aliases. Top-level `runtime`/`host`, `agents.defaults.model`, Agent-level `llm`/`prompt`, nested/per-Agent `runtime`/`runner` or `maxLlmCalls`, `agents.defaults.subagents`, and `agents.defaults.workspace` or per-agent `workspace` are explicitly invalid. `agents.list[].model` is configured-Agent metadata rather than an Agent-default capability override.

Tool deny hides matching definitions and remains final at execution. Session permission mode is Runtime state, not configuration. In `manual`, lexically external structured targets and all Exec calls require current-call Approval even when the Tool name is allowed; internal allowed targets bypass Approval, while other unmatched Tools require Approval. Missing required Approval fails closed. In `allow_all`, every non-denied registered Tool is automatically authorized. Exact names and `*`/`?` globs are supported; `group:*` is not.

Agent Home is the relative path anchor, not a confinement boundary. Approval is current-call only. Canonical/symlink-aware authorization, persistent grants, command patterns, and sandboxing are outside this contract.

## Section editing primitives

Platform Configuration owns `saveAgentConfigSection` and
`restoreAgentConfigSection`. A save reads the current document, edits only the
identified LLM or Extension section, validates without environment resolution,
then exclusively creates a same-directory temporary file and renames it over
`config.json`. It returns the committed raw document and target preimage without
rereading after publication. This does not provide external-write CAS protection.
The shared file-publication primitive remains owned by Platform Configuration;
the removed Standalone wizard is not a consumer.
A Runtime-owned pre-commit callback can validate candidate model facts and recheck
shutdown admission after preparation but before file writing starts. The
configuration layer does not own admission policy or revisions.

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
it never reads files directly. The
[Dynamic Settings Change](../changes/archive/dynamic-settings/plan.md) records
validated delivery and owner-authorized closeout.

## Acceptance scenarios

Cover each Agent precedence stage, global Agent execution-policy precedence, object/array/scalar merge, partial model environment override, absent/invalid files, one-read immutable Application/Extension projections, owner-module defaults and validation with exact field attribution, configured-Agent metadata and depth validation, rejection of the retired nested Subagent path, rejection of nested/per-Agent placement, absence of retired steering fields and hidden Runner limits, Built-in endpoint/model validation, exact credential reference materialization, per-agent metadata exclusion, direct rejection of `runtime`, `host`, and other retired fields, effective Memory chunking, Context budget projection, Tool glob policy, fresh default composition, and the absence of centralized leaf contracts/default literals.

## Related authority

[Configuration](../architecture/configuration.md) owns current implementation facts. [ADR-012](../decisions/adr-012-agent-home-path-unification.md) owns Agent Home path unification and [ADR-013](../decisions/adr-013-standalone-host-arguments-and-channels.md) owns Host-private argument selection.
