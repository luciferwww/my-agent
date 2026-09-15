# Configuration Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
> Authority: Stable workspace/application configuration contract

## Scope

Own application configuration types/defaults, `<workspace>/.agent/config.json`, deep merge, five-stage precedence, environment/caller overrides, default Model Reference input, Tool/Subagent policy, and Config Wizard behavior. Host Extension configuration belongs to [Extension Acquisition](extension-acquisition.md).

## Loading and precedence

A missing, unreadable, malformed, or non-object workspace config degrades to defaults. This differs from malformed existing Host config, which is fatal.

Precedence is:

`hardcoded defaults -> file defaults -> matching agent entry -> environment overrides -> caller/CLI overrides`

`deepMerge` recursively merges plain objects, ignores `undefined`, and replaces arrays/scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic reference override; partial presence fails. There is no first-Provider inference.

## Stable shape and ownership

- `AgentDefaults.model?: { providerId, modelId }` is structured input, not resolved facts.
- LLM connection/token/deployment-facts fields are inputs to narrower boundaries.
- Tool policy includes filesystem workspace restriction, allow, and deny.
- Subagent policy includes enablement, max depth, and profile list.
- Configuration does not own Catalog membership, canonical Model identity, effective facts, Provider semantics, or Runtime lifecycle.

Removed fields are not contract: `llm.model`, global `llm.contextWindowTokens`, Memory DB path/dimensions, configurable Session/agent directories, Tool implementation limits, nested `tools.approval`, and Logger path/prefix/queue fields.

Tool deny hides matching definitions and remains enforced at execution. Allow bypasses approval. Unmatched Tools require approval capability and fail closed without it. Exact names and `*`/`?` globs are supported; `group:*` is not.

## Wizard

Wizard reads existing JSON as prompt defaults, schema-filters governed branches, reports discarded leaves, overlays input, removes default-valued/empty objects, preserves unrelated top-level content, shows a full dry-run, and writes only after confirmation. Cancellation writes nothing. Existing-file backup is best-effort and does not block the primary write. Wizard does not read environment overrides, run Runtime resolution, or prove deployment validity.

## Acceptance scenarios and evidence

Cover each precedence stage, object/array/scalar merge, partial model environment override, absent/invalid files, per-agent metadata exclusion, removed fields, Tool glob policy, Wizard preservation/discard/default elision/dry-run/cancel/backup behavior.

Evidence: [types](../../src/platform/config/types.ts), [defaults](../../src/platform/config/defaults.ts), [loader](../../src/platform/config/loader.ts), [loader tests](../../src/platform/config/loader.test.ts), [Wizard fields tests](../../src/platform/config/wizard/fields.test.ts), and [Wizard diff tests](../../src/platform/config/wizard/diff.test.ts). Current facts: [Configuration](../architecture/configuration.md).
