# Test Portfolio Rationalization Record

> Status: Archived evidence
> Date: 2026-09-15
> Environment: Windows, Node.js 22.22.2, Vitest 3.2.4

## Baseline and final portfolio

| Measure | Baseline | Delivered TPR result |
|---|---:|---:|
| Maintained test files | 110 | 112 |
| Maintained tests | 1,018 | 1,022 |
| Tracked research-era scripts | 33 | 0 |
| Test fixtures | 41 | 41 |
| Full-suite Vitest duration | 12.54 s | 11.65 s |

Durations were single directional observations, not performance thresholds. The maintained suite added four focused tests while deleting approximately 8,243 lines of standalone research programs.

## Retirement disposition

All tracked research scripts retired. They comprised 13 Process/Exec, 6 Runtime, 5 Memory, 3 Abort/Compaction, 4 Tool/Config/Subagent, and 2 Live Provider diagnostics. Research-only and duplicated permutations were not recreated.

Ten candidates received focused exception review. Five were deleted with maintained coverage:

- Abort tree and timeout tree scripts;
- yielded descendant termination;
- Runtime multichannel composition;
- Abort end-to-end composition.

Five proposals supplied bounded maintained evidence:

- completed process can be killed repeatedly without changing its terminal state;
- one real parent/descendant process tree terminates through the platform implementation;
- a frame above 10 MiB and below the configured 15 MiB WebSocket limit is accepted;
- SQLite keyword, vector, and metadata state survive close/reopen;
- image base64 is absent from Compaction summary/next-turn model history but retained in Session persistence.

The proposed reopened Compaction-history scenario was already present in CH-11 and was not duplicated.

## Tier result

| Tier | Files | Tests | Result |
|---|---:|---:|---|
| Unit | 94 | 969 | Passed |
| Integration | 6 | 15 | Passed |
| Architecture Fitness | 12 | 38 | Passed |
| Full | 112 | 1,022 | Passed |

The three tiers were non-overlapping by collection count and summed to the full portfolio. The editor test host had a native `better-sqlite3` ABI mismatch; the authoritative Node.js 22.22.2 terminal runs executed all SQLite and full-suite tests successfully.
