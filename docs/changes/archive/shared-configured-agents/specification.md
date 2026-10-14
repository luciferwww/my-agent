# Shared Configured Agents Specification

> Status: Implemented and validated
> Date: 2026-10-14
> Owner: Project owner
> Related Plan: [Shared Configured Agents Plan](plan.md)
> Related Decision: [ADR-021](../../../decisions/adr-021-shared-configured-agent-registry.md)
> Acceptance: The project owner accepted this Specification and authorized Delivery on 2026-10-14.
> Closeout: The project owner accepted completed Delivery and validation and authorized archive on 2026-10-14.

## 1. Purpose

A named Agent definition describes who performs work and which reusable
capabilities apply. It does not belong to the Subagent execution mechanism.
Subagent execution selects a Configured Agent by `agentId`; future Automation
may do the same without duplicating the profile.

## 2. Public configuration

The public shape becomes:

```ts
interface AgentsConfig {
  readonly steeringEnabled: boolean;
  readonly maxLlmCallsPerTurn?: number;
  readonly maxSubagentDepth: number;
  readonly defaults: AgentDefaults;
  readonly list: readonly AgentEntry[];
}

interface AgentEntry extends DeepPartial<AgentDefaults> {
  readonly id: string;
  readonly description: string;
  readonly default?: boolean;
  readonly model?: ModelReference;
}
```

Semantics:

- `id` is the stable `agentId` and remains unique.
- `description` is required for selection and presentation.
- omitted `model` means the execution entry supplies its base Model; for a
  Child this is the Parent effective Model.
- explicit `model` replaces that base reference.
- existing Agent capability overrides retain their current Root-Agent
  precedence and behavior.
- `steeringEnabled` is a global boolean with current default `false`.
- `maxLlmCallsPerTurn` is an optional positive integer applied independently
  to every Root and Child Turn; omission means no call-count limit.
- `maxSubagentDepth` is a non-negative safe integer with current default `1`.

The former public `runner` section is removed. Runner retains implementation
ownership of Steering and Model-call limit semantics, while Platform composes
those global values under `agents`. No Runner field moves into the shared Role
definition.

## 3. Removed configuration

The complete public section is removed:

```text
agents.defaults.subagents
runner
```

Its former fields map as follows:

```text
list      -> agents.list[]
maxDepth  -> agents.maxSubagentDepth
enabled   -> effective task Tool policy
runner.steeringEnabled -> agents.steeringEnabled
runner.maxLlmCalls     -> agents.maxLlmCallsPerTurn
```

An effective deny of `task` prevents delegation. Reaching
`agents.maxSubagentDepth` removes the `task` capability independently of Role
configuration; no Agent entry can restore it.

Unknown-field validation rejects the removed section. There is no deprecated
warning or compatibility read.

## 4. Context location

Named Agent Context resolves only from:

```text
<agentHome>/agents/<agentId>/
```

The existing allowlist and file order remain:

```text
IDENTITY.md
SOUL.md
AGENTS.md
TOOLS.md
```

For each missing named file, Child preparation falls back to the corresponding
Root Agent Context file exactly as today. Whitespace, loading budgets,
truncation, and error behavior remain Agent Context-owned.

`<agentHome>/subagents/<id>/` is not probed.

## 5. Subagent execution

The Task Tool presents configured `agents.list[]` entries plus the built-in
anonymous `general-purpose` option.

For a named selection, Runtime:

1. resolves the selected `AgentEntry`;
2. projects only the fields supported by the current Subagent profile:
   description, Model, and Tool policy;
3. resolves named Context from `agents/<agentId>/`;
4. adds the unchanged Parent/Child execution envelope.

Memory, Context-budget, Compaction, and other existing `AgentEntry` overrides
do not gain new Child semantics in this Change.

The shared entry does not contain Parent Session identity, Child depth,
Approval routing, Abort propagation, result delivery, retention, schedule, or
Automation lifecycle.

`general-purpose` remains built in, inherits the Parent effective Model, and
uses Root Context fallback. It is not required in `agents.list[]`.

## 6. Ownership

- Platform Configuration owns composition, validation, and existing
  precedence.
- Model Resolution owns exact Model identity and availability.
- Agent Context owns Context loading and fallback inputs.
- Core Subagent owns depth and Child-specific execution semantics.
- Runtime composes the resolved Agent with the Child envelope.

No new generic Agent framework or `core/agent` module is introduced. Existing
internal Subagent names remain because they describe the Child execution
mechanism; this Change replaces only the public profile/configuration source
and filesystem directory.

## 7. Compatibility

Direct cutover:

```text
agents.defaults.subagents     -> rejected
<agentHome>/subagents/<id>/   -> ignored
```

Existing Agent Homes may be deleted and recreated. No version, migration, dual
read, or Feature Flag is added.

## 8. Acceptance

- `agents.list[]` is the only named Agent registry.
- duplicate, blank, or structurally invalid entries fail with exact paths.
- omitted and explicit Model behavior are deterministic.
- per-Agent `maxLlmCalls` is rejected and every Root/Child Turn independently
  applies `agents.maxLlmCallsPerTurn`.
- effective `task` deny disables delegation.
- depth removal of `task` cannot be overridden by a Role.
- named Context uses only `agents/<agentId>/`.
- Parent file fallback and `general-purpose` behavior remain unchanged.
- Root Agent resolution continues to use the same `agents.list[]` precedence.
- no removed config or directory compatibility remains.
- affected Unit, integration, Fitness, lint, build, link, and diff checks pass.

## 9. Open questions

No design question remains open in this Draft. Acceptance still requires
project-owner review of the exact public shape and direct-cutover behavior.
