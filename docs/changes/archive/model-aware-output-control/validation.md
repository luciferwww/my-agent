# Model-Aware Output Control Validation

> Status: Complete, Accepted, and Archived
> Date: 2026-09-24
> Plan: [Model-Aware Output Control Plan](plan.md)
> Specification: [Model-Aware Output Control Specification](model-aware-output-control-specification.md)

## Verified behavior

- Built-in configuration accepts an optional output policy and rejects invalid
  numeric values.
- Model Resolution freezes the invocation defaults, rejects invalid values,
  and clamps them to known output capability.
- The Built-in router applies model defaults and clamps direct overrides.
- Runner passes the policy to normal and Compaction calls.
- Context-only input budgeting prefers the invocation policy.
- Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions serialize
  the effective policy to their protocol fields.
- Omitted-policy compatibility tests preserve existing wire behavior.

## Validation gates

| Gate | Result |
|---|---|
| Focused configuration/resolution/adapter/Runner tests | 84 tests passed |
| Focused Runner/Runtime/configuration tests | 207 tests passed |
| Final Protocol Client regression | 8 tests passed |
| Workspace TypeScript and workspace lint | Passed |
| Unit | 105 files / 1,147 tests passed with one worker |
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
was rerun. No commit was requested as part of acceptance.
