# Configuration Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-16
> Authority: Stable Agent configuration contract

## Scope

Own Agent configuration types/defaults, the sole `<agentHome>/config.json` document, one-read immutable projections, deep merge, five-stage Agent precedence, environment/caller overrides, default Model Reference input, Context loading budgets, and Tool/Subagent policy. Extension projection semantics belong to [Extension Acquisition](extension-acquisition.md).

## Loading and precedence

A missing Agent Home config yields defaults. An unreadable file, malformed JSON, non-object root, unknown namespace, or invalid known namespace is a classified fatal error. The Host reads the document at most once per startup attempt. Runtime receives a defensively copied/frozen Application projection and never reads configuration files.

Precedence is:

`hardcoded defaults -> file defaults -> matching agent entry -> environment overrides -> caller/CLI overrides`

`deepMerge` recursively merges plain objects, ignores `undefined`, and replaces arrays/scalars. `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` form one atomic reference override; partial presence fails. There is no first-Provider inference.

## Stable shape and ownership

- `AgentDefaults.model?: { providerId, modelId }` is the optional preferred reference for a Root Turn without an explicit selection, not resolved facts, a mandatory startup model, a Child default, or a fallback list.
- LLM connection/token/deployment-facts fields are inputs to narrower boundaries.
- Tool policy includes allow and deny.
- `AgentDefaults.context` owns Agent Context per-file and total loading budgets.
- Subagent policy includes enablement, max depth, and profile list.
- Configuration does not own Catalog membership, canonical Model identity, effective facts, Provider semantics, or Runtime lifecycle.

Removed fields are not contract: `llm.model`, global `llm.contextWindowTokens`, Memory DB path/dimensions, configurable Session/agent directories, the former `workspace` Context-budget key, Tool implementation limits, nested `tools.approval`, and Logger path/prefix/queue fields. The former `agents.defaults.workspace` and per-agent `workspace` keys are rejected directly without aliases or dual reads.

Tool deny hides matching definitions and remains enforced at execution. Allow bypasses approval. Unmatched Tools require approval capability and fail closed without it. Exact names and `*`/`?` globs are supported; `group:*` is not.

Filesystem path scope and external-path authorization are not stabilized by this Specification. The current coarse `tools.fs.workingDirOnly` field remains an implementation fact documented by [Builtin Tools](../architecture/builtin-tools.md); it is not a decision about trusted roots, approval, grant lifetime, or persistent authorization.

## Acceptance scenarios and evidence

Cover each precedence stage, object/array/scalar merge, partial model environment override, absent/invalid files, one-read immutable projection, per-agent metadata exclusion, direct rejection of retired fields, Context budget projection, and Tool glob policy.

Evidence: [types](../../src/platform/config/types.ts), [defaults](../../src/platform/config/defaults.ts), [Agent configuration loader](../../src/platform/config/agent-config-loader.ts), [resolution loader](../../src/platform/config/loader.ts), [Agent configuration tests](../../src/platform/config/agent-config-loader.test.ts), and [resolution tests](../../src/platform/config/loader.test.ts). Decision: [ADR-010](../decisions/adr-010-install-and-agent-home-ownership.md). Current facts: [Configuration](../architecture/configuration.md).
