# Configuration Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-23
> Authority: Stable Agent configuration contract

## Scope

Own the sole `<agentHome>/config.json` document, application composition, one-read immutable Application/Extension projections, deep merge, five-stage Agent precedence, credential materialization, environment/caller overrides, and validation-error field attribution. Every behavioral module owns its leaf contract, semantic validation, and immutable default: Built-in LLM, Runtime, Runner/Compaction, Memory, Prompt, Tool Policy, Agent Context, Subagent, and Logger. Platform Configuration imports and assembles those leaves without redefining their structures or literals. Extension projection semantics belong to [Extension Acquisition](extension-acquisition.md). Host-private process and Channel selection are not configuration namespaces.

Owner validators reject unknown fields at every leaf and nested-leaf level. Platform preserves the exact composed field path in the resulting `NAMESPACE_INVALID` error.

## Loading and precedence

Standalone startup ensures Agent Home exists and exclusively creates a missing configuration document with exact UTF-8 bytes `{}\n` before loading it. Existing configuration paths are never opened for writing, overwritten, reformatted, merged, migrated, repaired, or rolled back. The physical loader is globally strict: a document still missing at read time is `FILE_MISSING`; an unreadable file, malformed JSON, non-object root, unknown namespace, or invalid known namespace is another classified fatal error. The Host reads document content exactly once per startup attempt, and bootstrap does not read it. Runtime receives a defensively copied/frozen Application projection and never reads configuration files.

Agent-scoped precedence is:

`hardcoded defaults -> file defaults -> matching agent entry -> environment overrides -> caller/CLI overrides`

Global Runtime/Runner precedence is `module default -> top-level file value`. Agent selection, Agent environment overrides, and Agent caller/CLI overrides do not participate. `deepMerge` recursively merges plain objects, ignores `undefined`, and replaces arrays/scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic reference override; partial presence fails. There is no first-Provider inference.

## Stable shape and ownership

- `llm.defaultModel?: { providerId, modelId }` is the optional preferred reference for a Root Turn without an explicit selection and the client Catalog default, not resolved facts, a mandatory startup model, a Child default, or a fallback list.
- `llm.builtin?: { baseURL, apiKey?, models[] }` configures one optional Built-in Provider. Each model declares an opaque `modelId`, one of the three supported protocols, and optional `displayName`; an empty list is valid.
- Built-in `apiKey` accepts a literal or one exact `${ENV_VAR}` reference. Platform materializes it once and fails safely when the referenced value is missing or blank. Arbitrary interpolation is not supported.
- Public output-token configuration is removed. There is no `llm.maxTokens`, replacement output-limit field, or Agent-level LLM compatibility path.
- Top-level `runtime.steeringEnabled` is a Runtime-owned boolean and defaults to `false`.
- Top-level `runner.maxLlmCalls` is a Runner-owned optional positive integer. Omission means no Model-call count limit.
- Runtime/Runner projections are global and frozen. `agents.defaults`, `agents.list[]`, Agent environment overrides, and Agent caller overrides cannot contain or override them.
- An explicit per-Turn `RunTurnParams.maxLlmCalls` overrides the global Runner value. Child profile override and Parent effective-limit inheritance remain unchanged.
- `runner.inTurnMessageMode` is removed with no alias or compatibility path; strict Runner leaf validation rejects it as unknown.
- Tool policy includes only allow and deny; there is no `tools.fs` subtree.
- Agent Context owns the contract/defaults for per-file and total loading budgets; `AgentDefaults.context` composes that leaf.
- Memory owns embedding, chunking, and search contracts/defaults. Resolved chunking values control actual indexing boundaries and require positive safe integers with overlap smaller than chunk size.
- Subagent policy includes enablement, max depth, and profile list.
- Platform Logger owns Logger contracts/defaults/validation; Platform Configuration only composes the `logger` namespace.
- Configuration does not own Catalog membership, canonical Model identity, effective facts, Provider semantics, or Runtime lifecycle.
- The only top-level namespaces are `llm`, `runtime`, `runner`, `agents`, `logger`, and `extensions`; the physical-load snapshot contains only immutable `application` and `extensions` projections.

Unknown fields are rejected rather than ignored or treated as aliases. Top-level `host`, Agent-level `model`/`llm`, nested/per-Agent `runtime`/`runner`, and `agents.defaults.workspace` or per-agent `workspace` are explicitly invalid.

Tool deny hides matching definitions and remains final at execution. Session permission mode is Runtime state, not configuration. In `manual`, lexically external structured targets and all Exec calls require current-call Approval even when the Tool name is allowed; internal allowed targets bypass Approval, while other unmatched Tools require Approval. Missing required Approval fails closed. In `allow_all`, every non-denied registered Tool is automatically authorized. Exact names and `*`/`?` globs are supported; `group:*` is not.

Agent Home is the relative path anchor, not a confinement boundary. Approval is current-call only. Canonical/symlink-aware authorization, persistent grants, command patterns, and sandboxing are outside this contract.

## Acceptance scenarios

Cover each Agent precedence stage, global Runtime/Runner precedence, object/array/scalar merge, partial model environment override, absent/invalid files, one-read immutable Application/Extension projections, owner-module defaults and validation with exact field attribution, rejection of nested/per-Agent placement, absence of the retired steering field and hidden Runner limit, Built-in endpoint/model validation, exact credential reference materialization, per-agent metadata exclusion, direct rejection of `host` and other retired fields, effective Memory chunking, Context budget projection, Tool glob policy, fresh default composition, and the absence of centralized leaf contracts/default literals.

## Related authority

[Configuration](../architecture/configuration.md) owns current implementation facts. [ADR-012](../decisions/adr-012-agent-home-path-unification.md) owns Agent Home path unification and [ADR-013](../decisions/adr-013-standalone-host-arguments-and-channels.md) owns Host-private argument selection.
