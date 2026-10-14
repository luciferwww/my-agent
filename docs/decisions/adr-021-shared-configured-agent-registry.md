# ADR-021: Shared Configured Agent Registry

> Status: Accepted
> Decision date: 2026-10-14
> Owner: Project owner
> Related Plan/Specification: [Plan](../changes/archive/shared-configured-agents/plan.md) and [Specification](../changes/archive/shared-configured-agents/specification.md)
> Supersedes on acceptance: the named-profile and public `subagents` configuration portions of the current Configuration and Subagent contracts
> Acceptance: The project owner accepted this decision and authorized Delivery on 2026-10-14.

## Context

`agents.list[]` currently carries per-Agent capability overrides, while
`agents.defaults.subagents.list[]` separately carries named Subagent profiles
and `<agentHome>/subagents/<id>/` stores their Context. The same reviewer,
explorer, or researcher definition may later be selected by Automation, so its
identity cannot belong exclusively to the Child execution envelope.

## Decision drivers

- One identity and configuration source for a named Agent.
- Reuse by Subagent now and Automation later.
- Preserve existing configuration ownership and merge behavior.
- Keep Child lifecycle semantics outside reusable Agent definitions.
- Remove duplicate public configuration directly.

## Options considered

1. Keep Subagent-owned profiles.
2. Add a second generic Role registry and synchronize both.
3. Make `agents.list[]` the sole registry and move named Context to
   `agents/<agentId>/`.

## Decision

Choose option 3.

The shared vocabulary is:

```text
agents.list[]
agentId
<agentHome>/agents/<agentId>/
```

`AgentEntry` gains only the description and optional Model fields needed by a
named Agent profile. Its existing Tool
override supplies the current profile Tool policy. Subagent execution projects
those existing profile-supported fields and adds unchanged Parent/Child
semantics. `maxLlmCalls` remains global Runner/per-Turn policy and is rejected
in a Role; every Root and Child Turn independently applies
`agents.maxLlmCallsPerTurn`. Other Agent
capability overrides do not gain new Child behavior.

The deprecated public section is removed:

```text
agents.defaults.subagents.list[]   -> agents.list[]
agents.defaults.subagents.maxDepth -> agents.maxSubagentDepth
agents.defaults.subagents.enabled  -> effective task Tool policy
runner.steeringEnabled              -> agents.steeringEnabled
runner.maxLlmCalls                  -> agents.maxLlmCallsPerTurn
```

The Subagent module retains depth semantics and Child execution ownership.
Every Root and Child Turn independently applies the global
`agents.maxLlmCallsPerTurn`; Role definitions do not carry a call limit.
This decision does not implement Automation.

## Consequences

### Positive

- Subagent and future Automation can share one Agent definition.
- Configuration identity and filesystem layout use the same `agentId`.
- Duplicate profile lists and precedence disappear.

### Negative

- Configuration, Core Subagent, Runtime, tests, and documentation change
  together.
- Existing Agent Homes are not compatible and must be recreated.
- `AgentEntry` gains description and optional Model metadata.

## Validation

Configuration, Context, Task selection, depth, Tool policy, Root resolution,
Child resolution, direct-cutover, and broader regression tests must pass.

## Migration and rollback

There is no migration or compatibility path. Rollback requires restoring the
previous configuration and directory together.

## Follow-up

Agent Home initialization may install first-party entries after this contract
is implemented. Automation requires a separate accepted Change.

Process authority: [Development Workflow](../governance/development-workflow.md).
