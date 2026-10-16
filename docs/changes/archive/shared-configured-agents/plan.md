# Shared Configured Agents Plan

> Status: Completed, validated, owner-accepted, and archived
> Date: 2026-10-14
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Shared Configured Agents Specification](specification.md)
> Decision: [ADR-021: Shared Configured Agent Registry](../../../decisions/adr-021-shared-configured-agent-registry.md)
> Authorization: The project owner accepted the Plan, Specification, and ADR-021 and authorized Delivery on 2026-10-14.
> Closeout: The project owner accepted completed Delivery and validation and authorized archive on 2026-10-14.

## 1. Outcome

Replace the Subagent-owned profile registry and directory with one shared
Configured Agent contract:

```text
agents.list[]
agentId
<agentHome>/agents/<agentId>/
```

Subagent execution consumes that contract now. Future Automation may consume
the same contract through a separate Change.

## 2. Scope

- Make `agents.list[]` the sole named Agent registry.
- Extend `AgentEntry` only with the current named-profile description and
  optional Model override. Reuse its existing Tool override for the current
  profile Tool policy.
- Move global `steeringEnabled` and the renamed `maxLlmCallsPerTurn` alongside
  the other global Agent execution fields.
- Move `maxDepth` to `agents.maxSubagentDepth`.
- Remove `agents.defaults.subagents.enabled`; effective `task` Tool policy
  controls whether an Agent can delegate.
- Remove `agents.defaults.subagents.list[]`.
- Resolve named Agent Context from `<agentHome>/agents/<agentId>/`.
- Keep existing file-by-file Parent Context fallback.
- Preserve the built-in anonymous `general-purpose` behavior.
- Update Task selection, Runtime Child preparation, configuration validation,
  Current Architecture, Stable Specifications, and the configuration guide.

## 3. Non-goals

- Agent Home initialization.
- Automation Jobs, Runs, schedules, or UI.
- Changing Parent/Child Session, Abort, Approval, result, or retention behavior.
- A Role marketplace or downloadable profiles.
- Profile creation or editing commands.
- Configuration or Session versioning.
- Compatibility reads, migration, or dual directories.
- Moving any other global Runtime or Runner configuration.

## 4. Ownership

Platform Configuration validates the relocated fields. Core Subagent retains
depth semantics and all Child execution behavior, but reads named profiles
from `agents.list[]`. Agent Context retains allowlisted file loading. No other
Agent capability changes behavior in this Change.

## 5. Delivery items

| Item | Status | Exit condition |
|---|---|---|
| SCA-1 Shared configuration contract | Complete | `agents.list[]` carries the accepted named Agent fields; global execution policy and Subagent depth are validated under `agents` |
| SCA-2 Named Context path | Complete | named Context loads only from `agents/<agentId>/` with existing fallback |
| SCA-3 Subagent consumption | Complete | Task selection and Child preparation use the shared Agent entry |
| SCA-4 Deprecated path deletion | Complete | no production read or validator accepts `agents.defaults.subagents`, the top-level `runner` namespace, or `subagents/<id>/` |
| SCA-5 Validation and authority | Complete | focused, regression, build, documentation, and review gates pass, subject only to the recorded pre-existing FT-12 baseline mismatch |

Only one item may be `In Progress`.

## 6. Compatibility

This is a direct cutover. Existing Agent Homes may be deleted. There is no
alias, migration, Feature Flag, warning period, or fallback path.

## 7. Validation

- Configuration shape, defaults, unknown-field, and precedence tests.
- Named and anonymous Agent resolution tests.
- Tool-policy and depth-limit tests.
- Context path and Parent fallback tests.
- Root and Child model-resolution regression tests.
- Relevant Unit, integration, Fitness, lint, build, documentation-link, and
  diff checks.

## 8. Exit gate

The Change exits when the shared contract is implemented and validated, no
deprecated public `subagents` configuration/profile path remains, stable
authority is updated, and the project owner accepts closeout.

## 9. Validation record

Validated on 2026-10-14:

- TypeScript and workspace lint passed.
- Focused Shared Agent, configuration, Runtime, Subagent, Host, and affected
  Fitness tests passed: 308 tests.
- Full Unit suite passed: 115 files, 1429 tests.
- Integration suite passed: 7 files, 23 tests.
- Build, Host audit, WebSocket Client verification, and Relay tests passed.
- `test-workspace/config.json` parses as JSON and uses
  `agents.steeringEnabled`, `agents.maxLlmCallsPerTurn`,
  `agents.maxSubagentDepth`, and `agents.list[]`.
- `git diff --check` passed.
- Independent closeout review found one unknown-field validation gap in
  `agents.defaults` and `agents.list[]`; the loader now rejects misplaced
  global policy and arbitrary unknown fields, with 72 focused configuration
  tests passing after the fix.
- The full Fitness command has one unrelated existing failure: FT-12 hardcodes
  `Verified: 2026-09-18`, while the repository's HEAD version of
  `docs/architecture/runtime.md` already declares `Verified: 2026-10-02`.
  Affected FT-03 and all other Fitness tests pass.
