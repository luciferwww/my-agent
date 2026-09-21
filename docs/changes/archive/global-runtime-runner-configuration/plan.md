# Global Runtime and Runner Configuration Plan

> Status: Complete and Accepted
> Date: 2026-09-21
> Owner: Project owner
> Type: Configuration Contract Correction
> Specification: [Global Runtime and Runner Configuration Specification](global-runtime-runner-configuration-specification.md)
> Predecessor: [Runtime Steering and Runner Configuration](../runtime-steering-and-runner-configuration/plan.md)
> Authorization: Delivery authorized by project owner on 2026-09-21.

## 1. Outcome

Move Runtime and Runner configuration from `agents.defaults` to top-level global
Application namespaces while retaining `agents.defaults` and `agents.list[]`
for genuinely Agent-scoped configuration.

Target shape:

```json
{
  "llm": {},
  "runtime": {
    "steeringEnabled": false
  },
  "runner": {
    "maxLlmCalls": 12
  },
  "agents": {
    "defaults": {
      "memory": {},
      "prompt": {},
      "tools": {},
      "context": {},
      "compaction": {},
      "subagents": {}
    },
    "list": []
  },
  "logger": {},
  "extensions": {}
}
```

`runner.maxLlmCalls` remains optional; `12` above is an example explicit value,
not a default.

## 2. Problem

The predecessor Change moved `RuntimeConfig` and `RunnerConfig` type/default
ownership into their modules but composed both leaves inside `AgentDefaults`.
That placement gives them per-Agent override semantics:

```text
agents.defaults
├── runtime
└── runner
```

Runtime steering admission and the Runner execution budget are instead global
Application policies. Their physical placement and precedence must match that
scope, as the existing top-level `llm` namespace already does.

## 3. Scope

- Add top-level `runtime?: Partial<RuntimeConfig>` and
  `runner?: Partial<RunnerConfig>` document namespaces.
- Project required immutable `runtime` and `runner` values into
  `ApplicationConfigProjection` and `AppConfig`.
- Remove `runtime` and `runner` from `AgentDefaults`.
- Reject `runtime` and `runner` inside `agents.defaults` and `agents.list[]`.
- Retain `agents.defaults` and `agents.list[]` for:
  - `memory`
  - `prompt`
  - `tools`
  - `context`
  - `compaction`
  - `subagents`
- Preserve Runtime ownership of `RuntimeConfig`, validation, and defaults.
- Preserve Runner ownership of `RunnerConfig`, validation, and defaults.
- Let Platform Configuration read, validate, compose, freeze, and project the
  two top-level namespaces.
- Wire Runtime resources to the global Runtime/Runner projections instead of
  resolved Agent defaults.
- Preserve explicit per-Turn `RunTurnParams.maxLlmCalls`.
- Preserve Child profile override and Parent effective-limit inheritance.
- Update the test workspace only during authorized Delivery.
- Amend stable configuration and architecture authority after implementation.

## 4. Non-goals

- Removing `agents`, `agents.defaults`, or `agents.list[]`.
- Moving Memory, Prompt, Tools, Context, Compaction, or Subagent configuration
  to top-level namespaces.
- Dynamic Runtime/Runner configuration reload.
- Per-Agent steering or Runner Model-call budgets.
- Per-Channel steering policy.
- Changing steering batching, terminal handoff, Abort, or limit-stop behavior.
- Adding aliases or compatibility reads for the misplaced nested form.
- Changing top-level `llm`, `logger`, or `extensions`.

## 5. Ownership rule

Configuration placement follows behavioral scope:

| Configuration | Scope | Placement | Per-Agent override |
|---|---|---|---:|
| LLM deployment/default selection | Application | `llm` | No |
| Runtime steering policy | Application | `runtime` | No |
| Runner execution policy | Application | `runner` | No |
| Memory/Prompt/Tools/Context/Compaction/Subagents | Agent | `agents.defaults` / `agents.list[]` | Yes |
| Logger | Application | `logger` | No |
| Extension acquisition | Application | `extensions` | No |

Module ownership remains separate from physical loading: Runtime and Runner own
their leaf Contracts/defaults; Platform owns the one physical document and
Application composition.

## 6. Compatibility

This is a direct cutover:

- top-level `runtime` and `runner` are accepted;
- nested `agents.defaults.runtime` and `agents.defaults.runner` are invalid;
- per-Agent `runtime` and `runner` are invalid;
- no alias, migration reader, conflict rule, or dual production path is added.

The repository has not committed the predecessor delivery, so all repository
fixtures and the local test-workspace example can move atomically during
Delivery.

## 7. Delivery slices

| Slice | Status | Outcome | Exit condition |
|---|---|---|---|
| GRC-0 Contract acceptance | Complete | Placement and precedence are accepted; Delivery is explicitly authorized | Plan and Specification accepted; explicit Delivery approval recorded |
| GRC-1 Configuration schema cutover | Complete | Top-level namespaces load, validate, default, freeze, and reject nested placement | Configuration and precedence tests pass |
| GRC-2 Runtime wiring and fixtures | Complete | Runtime/Runner consume global projections; Agent resolution excludes them | Runtime, Runner, Subagent, Host, and test-workspace checks pass |
| GRC-3 Authority and closeout | Complete | Stable authority and Fitness lock the final shape | Full validation, independent review, owner acceptance, and archive complete |

Only one Slice may be `In Progress`.

## 8. Validation strategy

### Focused

- Empty document resolves `runtime.steeringEnabled=false` and `runner={}`.
- Valid top-level values project unchanged and are deeply frozen.
- Invalid top-level types, values, and unknown leaf fields fail safely.
- Nested and per-Agent Runtime/Runner fields are rejected.
- Agent precedence still works for Agent-scoped modules.
- Agent precedence cannot influence Runtime/Runner values.
- Explicit per-Turn limit overrides the global Runner value.
- Omitted Child profile limit inherits the Parent effective global/per-Turn
  value.
- Steering reads the global Runtime value.
- Test-workspace configuration uses top-level `runtime` and `runner`.
- Fitness prevents Runtime/Runner fields from returning to `AgentDefaults`.

### Final

- `npm test`
- `npm run test:integration`
- `npm run test:fitness`
- `npm run lint`
- `npm run build`
- WebSocket Host smoke
- `git diff --check`
- Changed-document link validation
- Independent review

## 9. Stop conditions

Return to design review if Delivery requires:

- removing per-Agent configuration;
- moving another Agent-scoped module to top level;
- a compatibility alias or dual read;
- a new public Event or Result field;
- dynamic configuration mutation;
- changes to steering or Model-loop behavior.

## 10. Closeout

- Stable Configuration and Current Architecture describe the final placement.
- The predecessor Change remains archived as historical provenance.
- This Change records the placement correction and its validation.
- Archive only after owner acceptance.
- Commit and push remain separate explicit actions.

Follow [Development Workflow](../../../governance/development-workflow.md).
