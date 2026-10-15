# Configuration Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-10-15
> Authority: Stable Agent configuration contract

## Scope

Own the sole `<agentHome>/config.json` document, application composition, one-read immutable Application/Extension projections, deep merge, five-stage Agent precedence, configured-Agent metadata, credential materialization, environment/caller overrides, and validation-error field attribution. Every configurable behavioral module owns its leaf contract, semantic validation, and immutable default: Built-in LLM, Runner/Compaction, Memory, Tool Policy, Agent Context, Subagent depth, and Logger. Platform Configuration imports and assembles those leaves without redefining their structures or literals. Extension projection semantics belong to [Extension Acquisition](extension-acquisition.md). Host-private process and Channel selection are not configuration namespaces.

Owner validators reject unknown fields at every leaf and nested-leaf level. Platform preserves the exact composed field path in the resulting `NAMESPACE_INVALID` error.

## Loading and precedence

Ordinary Standalone startup never creates a missing configuration document. A missing `<agentHome>/config.json` fails before Runtime creation with guidance to run `my-agent --initialize --agent-home <path>`. Explicit Standalone initialization verifies Provider/Model access and publishes `config.json` last. Existing configuration paths are never opened for writing, overwritten, reformatted, merged, migrated, repaired, or rolled back. The physical loader remains globally strict: a document missing at read time is `FILE_MISSING`; an unreadable file, malformed JSON, non-object root, unknown namespace, or invalid known namespace is another classified fatal error. The Host reads document content exactly once per ordinary startup attempt. Runtime receives a defensively copied/frozen Application projection and never reads configuration files. `ensureAgentConfigDocument()` remains an explicit Platform API for other callers but is not used by ordinary Standalone startup.

Agent-scoped precedence is:

`hardcoded defaults -> file defaults -> matching agent entry -> environment overrides -> caller/CLI overrides`

Global Agent execution policy precedence is `module default -> agents top-level field`. Agent selection, Agent environment overrides, and Agent caller/CLI overrides do not participate. `deepMerge` recursively merges plain objects, ignores `undefined`, and replaces arrays/scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic reference override; partial presence fails. There is no first-Provider inference.

## Stable shape and ownership

- `llm.defaultModel?: { providerId, modelId }` is the optional preferred reference for a Root Turn without an explicit selection and the client Catalog default, not resolved facts, a mandatory startup model, a Child default, or a fallback list.
- `llm.builtin?: { baseURL, apiKey?, models[] }` configures one optional Built-in Provider. Each model declares an opaque `modelId`, one of the three supported protocols, optional `displayName`, optional positive safe-integer capability facts `maximumContextTokens`, `maximumPromptTokens`, and `maximumOutputTokens`, and separate optional positive safe-integer invocation policy `outputTokenLimit`; an empty list is valid. Omitting Prompt and Context limits uses the Built-in Provider's conservative `131,072` effective fallback.
- Built-in `apiKey` accepts a literal or one exact `${ENV_VAR}` reference. Platform materializes it once and fails safely when the referenced value is missing or blank. Arbitrary interpolation is not supported.
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
- The only top-level namespaces are `llm`, `agents`, `logger`, and `extensions`; the physical-load snapshot contains only immutable `application` and `extensions` projections.

Unknown fields are rejected rather than ignored or treated as aliases. Top-level `runtime`/`host`, `agents.defaults.model`, Agent-level `llm`/`prompt`, nested/per-Agent `runtime`/`runner` or `maxLlmCalls`, `agents.defaults.subagents`, and `agents.defaults.workspace` or per-agent `workspace` are explicitly invalid. `agents.list[].model` is configured-Agent metadata rather than an Agent-default capability override.

Tool deny hides matching definitions and remains final at execution. Session permission mode is Runtime state, not configuration. In `manual`, lexically external structured targets and all Exec calls require current-call Approval even when the Tool name is allowed; internal allowed targets bypass Approval, while other unmatched Tools require Approval. Missing required Approval fails closed. In `allow_all`, every non-denied registered Tool is automatically authorized. Exact names and `*`/`?` globs are supported; `group:*` is not.

Agent Home is the relative path anchor, not a confinement boundary. Approval is current-call only. Canonical/symlink-aware authorization, persistent grants, command patterns, and sandboxing are outside this contract.

## Acceptance scenarios

Cover each Agent precedence stage, global Agent execution-policy precedence, object/array/scalar merge, partial model environment override, absent/invalid files, one-read immutable Application/Extension projections, owner-module defaults and validation with exact field attribution, configured-Agent metadata and depth validation, rejection of the retired nested Subagent path, rejection of nested/per-Agent placement, absence of retired steering fields and hidden Runner limits, Built-in endpoint/model validation, exact credential reference materialization, per-agent metadata exclusion, direct rejection of `runtime`, `host`, and other retired fields, effective Memory chunking, Context budget projection, Tool glob policy, fresh default composition, and the absence of centralized leaf contracts/default literals.

## Related authority

[Configuration](../architecture/configuration.md) owns current implementation facts. [ADR-012](../decisions/adr-012-agent-home-path-unification.md) owns Agent Home path unification and [ADR-013](../decisions/adr-013-standalone-host-arguments-and-channels.md) owns Host-private argument selection.
