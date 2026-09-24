# Module-owned Agent Configuration and Defaults Plan

> Status: Implemented, Validated, Accepted, and Archived
> Date: 2026-09-23
> Owner: Project owner
> Type: Architecture Contract Completion
> Specification: [Module-owned Agent Configuration Specification](module-owned-agent-configuration-specification.md)
> Authorization: Delivery authorized by project owner on 2026-09-23.

## 1. Outcome

Complete the project-wide configuration ownership rule:

> A module owns its leaf configuration contract, semantic validation, and
> behavioral defaults. Platform Configuration owns document composition,
> reading, merging, credential materialization, and immutable projection.

The Change preserves the current user-facing `config.json` structure while
removing Agent leaf types and default literals from
`src/platform/config/types.ts` and `src/platform/config/defaults.ts`.

## 2. Problem

Runtime, Runner, and the Built-in LLM Provider already own their configuration
contracts and defaults. Other Agent modules do not:

- Memory;
- Prompt;
- Tool policy;
- Agent Context;
- Compaction;
- Subagents;
- Logger.

Platform Configuration currently defines their leaf interfaces and repeats
their default values in `DEFAULT_AGENT_CONFIG` or `DEFAULT_LOGGER_CONFIG`.
Several owning modules also retain equivalent fallback constants. This creates
multiple authorities for the same behavior.

One mismatch is already observable: `memory.chunking.chunkChars` and
`memory.chunking.overlapChars` are accepted and projected by configuration,
but Runtime does not pass them to Memory and `MemoryIndexer` uses private
hard-coded values. A valid configuration can therefore be ignored.

## 3. Scope

- Inventory every public Agent and Logger leaf configuration field.
- Identify the module that executes each configured behavior.
- Move each leaf interface, default value, and semantic validator to that
  owner.
- Export immutable module defaults from the owning module.
- Keep Platform-owned composition types for:
  - the top-level document;
  - `agents.defaults`;
  - `agents.list[]`;
  - complete Application projections;
  - deep-partial merge input.
- Replace the centralized default-literal table with a composition function
  that imports module-owned defaults and returns a fresh complete projection.
- Make `memory.chunking` effective end to end.
- Remove duplicate behavioral fallback literals where callers always receive a
  resolved projection.
- Retain defensive defaults only at independently supported module APIs, sourced
  from the same owner constant rather than copied literals.
- Move Logger configuration/default ownership to `platform/logger`.
- Update stable Configuration, Runtime, Runner, Memory, Tools, Session,
  Subagent, Agent Context, and Logger authority where applicable.
- Add Fitness coverage preventing Platform Configuration from redefining leaf
  contracts or default literals.

## 4. Non-goals

- Changing the `config.json` namespace or field names.
- Changing configuration precedence.
- Changing current default values.
- Adding compatibility aliases or dual-read paths.
- Redesigning Agent selection or per-Agent overrides.
- Adding new Memory algorithms, embedding Providers, Tool policy modes, or
  Logger adapters.
- Moving Runtime or Runner configuration back under `agents`.
- Changing Session permission-mode behavior.
- Making all internal constructor options public configuration.

## 5. Target ownership

| Configuration leaf | Owner |
|---|---|
| `llm.builtin` | Built-in LLM Provider |
| `runtime` | Runtime |
| `runner` | Runner |
| `agents.*.memory` | Core Memory |
| `agents.*.prompt` | Core Prompt |
| `agents.*.tools` | Application Tool Policy |
| `agents.*.context` | Core Agent Context |
| `agents.*.compaction` | Runner Compaction |
| `agents.*.subagents` | Core Subagent |
| `logger` | Platform Logger |
| top-level composition and `agents.defaults/list` merge | Platform Configuration |

Platform Configuration may re-export imported leaf types for consumer
convenience, but it must not define a second structural interface or literal
default for them.

## 6. Delivery slices

| Slice | Status | Outcome | Exit condition |
|---|---|---|---|
| MAC-0 Inventory and contract acceptance | Complete | Every field, owner, default, validator, consumer, and duplicate fallback is recorded | Plan and Specification accepted; Delivery explicitly authorized |
| MAC-1 Leaf contracts and defaults | Complete | Leaf types/defaults moved to owners; Platform composes them without literals | Typecheck and focused module/config tests pass |
| MAC-2 Validation and runtime wiring | Complete | Owners validate semantics and every accepted field affects behavior, including Memory chunking | Invalid-input and behavioral tests pass |
| MAC-3 Central authority removal | Complete | Central leaf definitions and duplicate fallbacks are removed; imports converge | Search/Fitness prove one owner per leaf |
| MAC-4 Authority and closeout | Complete | Stable docs and full validation describe the final boundary | Full gates, independent review, owner acceptance, and archive |

Only one Slice may be `In Progress`.

## 7. Validation strategy

### Contract inventory

- Every documented configuration field maps to exactly one exported leaf
  contract.
- Every leaf default maps to exactly one owner constant.
- Every semantically constrained field maps to owner validation.
- Every accepted field has at least one execution consumer or is rejected as
  unsupported.

### Behavioral

- An empty document produces the same complete effective configuration as
  before this Change.
- Existing explicit configuration produces the same effective projection.
- Agent override precedence remains unchanged.
- `memory.chunking` changes actual indexing boundaries.
- Directly supported module APIs use the same owner defaults as configuration
  composition.
- Runtime and Runner remain top-level global policy.
- Logger defaults and Host output-conflict behavior remain unchanged.

### Structural

- `platform/config/types.ts` contains only Platform composition contracts.
- Platform Configuration imports leaf contracts; leaf modules do not import
  Platform Configuration.
- No leaf default literal is duplicated in Platform Configuration, Runtime
  Bootstrap, or module implementations.
- Fitness tests lock the dependency direction and central-file deletion.

### Full gates

- `npm test`
- `npm run test:integration`
- `npm run test:fitness`
- `npm run lint`
- `npm run build`
- `npm run verify:websocket-host`
- documentation links
- `git diff --check`
- independent code review

## 8. Risks

- Moving types can create circular dependencies if composition types leak back
  into leaf modules.
- Removing defensive fallbacks can break direct module callers that do not use
  Platform Configuration.
- A shallow shared default object could allow mutation across projections;
  composition must return fresh values and final projections must remain
  deeply frozen.
- Wiring `memory.chunking` may reveal that existing tests relied on ignored
  custom values.
- Validator movement can accidentally alter error codes or field paths.

## 9. Acceptance

Before Delivery:

- project owner accepts the ownership table;
- project owner accepts that valid `memory.chunking` values must become
  effective rather than removing the fields;
- project owner explicitly authorizes Delivery.

After Delivery:

- automated gates and independent review pass;
- stable authority is updated;
- project owner manually accepts configuration compatibility;
- the Change is archived.
