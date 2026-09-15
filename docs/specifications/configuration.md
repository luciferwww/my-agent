# Configuration Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-15
> Authority: Stable workspace/application configuration contract

## Scope

Own application configuration types/defaults, `<workspace>/.agent/config.json`, deep merge, five-stage precedence, environment/caller overrides, default Model Reference input, and Tool/Subagent policy. Host Extension configuration belongs to [Extension Acquisition](extension-acquisition.md).

## Loading and precedence

A missing, unreadable, malformed, or non-object workspace config degrades to defaults. This differs from malformed existing Host config, which is fatal.

Precedence is:

`hardcoded defaults -> file defaults -> matching agent entry -> environment overrides -> caller/CLI overrides`

`deepMerge` recursively merges plain objects, ignores `undefined`, and replaces arrays/scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic reference override; partial presence fails. There is no first-Provider inference.

## Stable shape and ownership

- `AgentDefaults.model?: { providerId, modelId }` is the optional preferred reference for a Root Turn without an explicit selection, not resolved facts, a mandatory startup model, a Child default, or a fallback list.
- LLM connection/token/deployment-facts fields are inputs to narrower boundaries.
- Tool policy includes filesystem workspace restriction, allow, and deny.
- Subagent policy includes enablement, max depth, and profile list.
- Configuration does not own Catalog membership, canonical Model identity, effective facts, Provider semantics, or Runtime lifecycle.

Removed fields are not contract: `llm.model`, global `llm.contextWindowTokens`, Memory DB path/dimensions, configurable Session/agent directories, Tool implementation limits, nested `tools.approval`, and Logger path/prefix/queue fields.

Tool deny hides matching definitions and remains enforced at execution. Allow bypasses approval. Unmatched Tools require approval capability and fail closed without it. Exact names and `*`/`?` globs are supported; `group:*` is not.

## Acceptance scenarios and evidence

Cover each precedence stage, object/array/scalar merge, partial model environment override, absent/invalid files, per-agent metadata exclusion, removed fields, and Tool glob policy.

Evidence: [types](../../src/platform/config/types.ts), [defaults](../../src/platform/config/defaults.ts), [loader](../../src/platform/config/loader.ts), and [loader tests](../../src/platform/config/loader.test.ts). Current facts: [Configuration](../architecture/configuration.md).
