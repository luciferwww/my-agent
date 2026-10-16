# CLI Channel Interaction Parity Validation

> Status: Passed — owner accepted
> Date: 2026-10-08
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Contract: [Specification](specification.md)

## 1. Acceptance matrix

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| CCP-01 | `/help` lists existing and new controls without Runtime dispatch | Focused CLI test | Passed |
| CCP-02 | `/model`, `/session`, `/permission`, `/thinking`, and `/effort` without arguments open a consistent numbered selector and mark the current value | Focused CLI test | Passed |
| CCP-03 | Selector choices and equivalent direct commands use the same validation and mutation path | Focused CLI test | Passed |
| CCP-04 | Empty, non-integer, and out-of-range selector input leaves state unchanged with explicit output | Focused CLI test | Passed |
| CCP-05 | Selector prompts cannot conflict with interactive Approval, and selected `allow_all` retains exact confirmation | Focused CLI test | Passed |
| CCP-06 | Both default reasoning selections preserve omission of request reasoning | Focused CLI test | Passed |
| CCP-07 | Supported Thinking selection reaches `ChannelRunRequest` | Focused CLI test | Passed |
| CCP-08 | Supported effort selection reaches `ChannelRunRequest` | Focused CLI test | Passed |
| CCP-09 | Unknown and unsupported values fail locally without dispatch | Focused CLI test | Passed |
| CCP-10 | Invalid Thinking/effort combinations are rejected atomically | Focused CLI test | Passed |
| CCP-11 | Model change resets incompatible selections with an explicit notice | Focused CLI test | Passed |
| CCP-12 | Catalog change is revalidated before ordinary input | Focused CLI test | Passed |
| CCP-13 | Approval behavior remains interactive and origin-safe | Existing CLI regression tests | Passed |
| CCP-14 | Model, Session, permission, Thinking presentation, and abort behavior remain compatible | Existing CLI regression tests | Passed |
| CCP-15 | Successful direct or selected Session switching queries the latest 20 records and renders the newest chronological suffix within 80 lines and 16,384 UTF-16 code units, with required omission markers | Focused CLI test | Passed |
| CCP-16 | Empty or failed history reads are explicit, and a failed read does not roll back the selected Session | Focused CLI test | Passed |
| CCP-17 | Session history presentation does not dispatch a Model request or mutate CLI selections | Focused CLI test | Passed |
| CCP-18 | `/session new` does not request history, and no history pagination command or cursor is introduced | Focused CLI test | Passed |
| CCP-19 | README command grammar matches implementation | Documentation review | Passed |
| CCP-20 | Type-check/lint and relevant unit tiers pass | Command evidence | Passed |

## 2. Planned checks

```text
Focused CliChannel tests
npm test
npm run lint
git diff --check
```

Integration, Fitness, full build, or live Provider calls are not required
unless focused evidence reveals a changed cross-boundary contract. No paid or
real Model invocation is authorized by this Change.

## 3. Review record

- `CliChannel.test.ts`: 34 tests passed.
- Default unit tier: 112 files and 1,357 tests passed.
- `npm run lint`: root and both Extension TypeScript checks passed.
- `git diff --check`: passed.
- No Integration, Fitness, paid Provider, or live Model execution was needed;
  no public Runtime/Core contract changed.
- Project owner accepted complete Delivery on 2026-10-08.
