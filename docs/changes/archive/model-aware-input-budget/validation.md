# Model-Aware Input Budget Validation

> Status: Complete, Accepted, and Archived
> Date: 2026-09-24
> Plan: [Model-Aware Input Budget Plan](plan.md)
> Specification: [Model-Aware Input Budget Specification](model-aware-input-budget-specification.md)

## Outcome

The Change is implemented and validated. Provider facts retain optional raw
total Context, Prompt, and output limits. Built-in registrations may configure
any subset, Copilot Relay preserves discovery distinctions, Model Resolution
validates and freezes the facts, and Runner derives one input budget without
double-subtracting output headroom from a known Prompt limit.

The WebSocket Channel Extension Change was not expanded to own this behavior.

## Verified behavior

- `gpt-5.6-sol` test configuration resolves:

  ```text
  maximumContextTokens = 1050000
  maximumPromptTokens  = 922000
  maximumOutputTokens  = 128000
  effectiveContextLimit = 922000
  Runner input budget   = 922000
  ```

- Context-only `32768` with default reserve derives ten-percent headroom and
  input budget `29492`.
- Context-only `32768` with known output `2048` derives input budget `30720`.
- A Provider publishing only effective fallback `32768` retains input budget
  `32768`.
- Known Prompt limits are not reduced by `reserveTokens`.
- No output request parameter or public per-request output control was added.

## Validation gates

| Gate | Result |
|---|---|
| Focused Provider/Resolver/budget tests | 66 tests passed |
| Focused AgentRunner tests | 65 tests passed |
| Workspace lint and TypeScript checks | Passed |
| Unit | 105 files / 1,141 tests passed with one worker |
| Integration | 6 files / 18 tests passed with one worker |
| Architecture Fitness | 13 files / 43 tests passed |
| Build | Passed |
| Host build audit | 336 files passed |
| Copilot Relay package | 3 files / 46 tests passed |
| Installed npm package verification | Passed; 356 files |
| `git diff --check` | Passed |

Installed-package verification used npm engine-strict disabled only in the
verification process because the local runtime is Node 20.16.0 while the
package correctly retains its Node 22.x requirement.

## Acceptance and archive

The project owner accepted the Change on 2026-09-24. The Change was moved to
the archive, the Change index was updated, and the post-archive Fitness gate
was rerun before commit.
