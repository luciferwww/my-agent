# AF-06 Extension Framework Spike Evidence

> Status: Completed — provisional pass accepted
> Executed: 2026-09-03
> Environment: Windows; Node 22.22.2; npm 10.9.7; TypeScript 5.9.3; Vitest 3.2.4
> Authority: Evidence only

## Question and method

A disposable out-of-production harness tested one typed Unit/Contribution API, immutable cross-kind Registry Snapshots, generation pinning, candidate isolation, reload coordination, retirement, and bounded Shutdown. It did not authorize production dynamic loading or freeze production TypeScript APIs.

## Static composition evidence

| ID | Observation | Result |
|---|---|---|
| P3-E01 | deterministic discovery/order and all Builtin/External duplicate permutations | Pass |
| P3-E02 | failure injection at staging boundaries preserved atomicity, neighbor isolation, and one lifecycle owner | Pass |
| P3-E03 | Channel/Tool/Hook/Provider projections came from one API and were actually consumed | Pass |
| P3-E04 | namespaces and schema migration isolated versions; invalid groups failed atomically | Pass |
| P3-E05 | required capability absence failed; optional absence degraded; typed current-call capability executed | Pass |

## Generation/lifecycle evidence

| ID | Observation | Result |
|---|---|---|
| P4-E01 | capture/publish linearization and Parent/Child generation pinning | Pass |
| P4-E02 | pre-publication failures left current unchanged and residual cleanup attributable | Pass |
| P4-E03 | latest-wins, no-op, and pending request coordination | Pass |
| P4-E04 | drain/Abort/nonresponsive retirement with pin protection and new-generation liveness | Pass |
| P4-E05 | post-publication retirement failure did not roll back publication and blocked unsafe future reload | Pass |
| P4-E06 | identity winner changes traveled through candidate lifecycle and atomic publication | Pass |
| P4-E07 | bounded reverse-order Shutdown covered current/candidate/retiring/residual states | Pass |

The final suite passed 28 tests, including canonical scenarios and a non-canonical race probe. Fixtures were removed after acceptance.

## Limits and later authority

No watcher, hot reload, production SDK, multi-instance identity, or broad dynamic Extension promise was proven. Current contracts are [Runtime Composition](../../specifications/runtime-composition.md), [Extension Acquisition](../../specifications/extension-acquisition.md), and [ADR-005](../../decisions/adr-005-extension-registry-runtime-composition.md).
