# Global Runtime and Runner Configuration Validation

> Status: Complete and Accepted
> Date: 2026-09-21
> Plan: [Global Runtime and Runner Configuration Plan](plan.md)
> Specification: [Global Runtime and Runner Configuration Specification](global-runtime-runner-configuration-specification.md)

## Delivered behavior

- `runtime` and `runner` are top-level global Application namespaces.
- Runtime and Runner retain ownership of their leaf Contracts, defaults, and
  semantic validation.
- Platform Configuration composes and freezes both global projections.
- `AgentDefaults` and `AgentEntry` no longer contain Runtime/Runner policy.
- `agents.defaults.runtime`, `agents.defaults.runner`, and corresponding
  `agents.list[]` fields fail with exact placement paths.
- Agent selection, environment overrides, and caller Agent overrides cannot
  alter Runtime/Runner policy.
- Runtime steering reads the global Runtime projection.
- Root Runner invocation reads the global Runner limit.
- Explicit per-Turn `maxLlmCalls` still overrides the global value.
- Child profile override and Parent effective-limit inheritance are unchanged.
- The local test workspace uses top-level `runtime` and `runner`; Memory remains
  under `agents.defaults`.
- Stable Configuration and Current Architecture describe the final placement.
- Fitness prevents Runtime/Runner from returning to `AgentDefaults`.

## Automated evidence

| Check | Result |
|---|---|
| Focused configuration, Runtime, Host, and Fitness tests | Pass — 193 tests |
| Unit suite | Pass — 100 files, 1,086 tests |
| Integration suite | Pass — 6 files, 18 tests |
| Architecture Fitness suite | Pass — 12 files, 40 tests |
| TypeScript lint/typecheck | Pass — application and Copilot Relay workspace |
| Build | Pass — TypeScript builds, Host audit 324 files, Relay 45 tests |
| WebSocket Host smoke | Pass |
| Test-workspace shape check | Pass |
| `git diff --check` | Pass |
| Changed-document local link validation | Pass — 5 documents |

## Independent review

An independent code review scoped to the placement migration found no
significant correctness, type-safety, validation, or Contract issues.

## Owner validation

The project owner manually tested the updated test-workspace configuration,
accepted the delivered behavior, and authorized archive on 2026-09-21.

## Closeout

- Delivery, automated validation, manual validation, and owner acceptance are
  complete.
- GRC-3 and the complete Change are closed.
- Plan, Specification, and validation record are archived together.
- Commit and push remain separate explicit actions.
