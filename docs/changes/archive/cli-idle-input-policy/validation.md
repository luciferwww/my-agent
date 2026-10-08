# CLI Idle Input Policy Validation

> Status: Passed and owner-accepted
> Date: 2026-10-08
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Contract: [Specification](specification.md)

## 1. Acceptance matrix

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| CIIP-01 | Idle CLI input and existing commands remain available | Focused CLI test | Passed |
| CIIP-02 | `run_start` suspends an active ordinary prompt and discards its partial line | Focused CLI test | Passed |
| CIIP-03 | No new ordinary prompt opens until the final tracked `run_end` | Focused CLI test | Passed |
| CIIP-04 | Multiple, duplicate, and unmatched Turn events preserve idempotent busy state | Focused CLI test | Passed |
| CIIP-05 | Runtime events continue rendering while ordinary input is suspended | Focused CLI test | Passed |
| CIIP-06 | A selector interrupted by `run_start` performs no mutation | Focused CLI test | Passed |
| CIIP-07 | Approval remains usable while busy and does not reopen ordinary input early | Focused CLI test | Passed |
| CIIP-08 | Ctrl+C Abort and double-press close behavior remain compatible while busy | Existing and focused CLI tests | Passed |
| CIIP-09 | `stop()` and input closure cannot strand an idle waiter | Focused CLI lifecycle test | Passed |
| CIIP-10 | No active-turn input is dispatched as a Steering message | Focused CLI test | Passed |
| CIIP-11 | README and Current Architecture describe turn-at-a-time behavior | Documentation review | Passed |
| CIIP-12 | Focused tests, unit tier, lint/type-check, and diff checks pass | Command evidence | Passed |

## 2. Planned checks

```text
Focused CliChannel tests
npm test
npm run lint
git diff --check
```

No Integration, Fitness, live Provider, or paid Model execution is required
unless focused evidence reveals a changed cross-boundary contract.

## 3. Review record

- `CliChannel.test.ts`: 39 tests passed.
- Default unit tier: 112 files and 1,362 tests passed.
- `npm run lint`: root and both Extension TypeScript checks passed.
- `git diff --check`: passed.
- Production changes are limited to `CliChannel`; no public contract or
  dependency changed.
- No Integration, Fitness, live Provider, or paid Model execution was needed.
- Delivery was accepted by the project owner on 2026-10-08.
