# AF-05 Provider/Model Resolution Spike Evidence

> Status: Completed — provisional pass accepted
> Executed: 2026-09-03
> Environment: Windows; Node 22.22.2; npm 10.9.7; TypeScript 5.9.3; Vitest 3.2.4
> Authority: Evidence only

## Question and method

A disposable target-shaped evaluator tested whether Provider-owned identity/facts, deterministic fail-closed Model Resolution, immutable per-Turn binding, Parent/Child isolation, and bounded overflow correction could work without changing the production graph or introducing Core-to-Compatibility dependencies. Synthetic fixtures and fake transport were deleted after acceptance.

## Evidence matrix

| ID | Bounded observation | Result |
|---|---|---|
| P2-E01 | Anthropic and fake Provider used one unchanged Runner path; one-way compatibility mapping | Pass |
| P2-E02 | Alternating Providers preserved internally consistent identity, Port, endpoint, limits, capabilities, and output | Pass |
| P2-E03 | Five fact sources were permuted for tightening/non-tightening; fallback filled only gaps and observation only tightened | Pass |
| P2-E04 | provenance distinguished Provider metadata/default; missing capability failed without SDK call | Pass |
| P2-E05 | Parent/Child leases and events/signals stayed isolated; inherit created a fresh Child binding | Pass |
| P2-E06 | old Turn retained old binding after Catalog/config/policy/reference replacement; new Turn used new binding | Pass |
| P2-E07 | eleven closed resolution failures occurred before invocation/network/paid probe | Pass |
| P2-E08 | Turn-local/retained correction and bounded overflow retry behaved without mutating original binding | Pass |

Final disposable suite: 10 tests passed across P2-E01–P2-E08. The aggregate hypothesis was supported; no stop condition was met.

## Limits and later authority

The harness did not prove production delivery, full precedence policy, Subagent concurrency, Runtime tree/Fanout/Shutdown behavior, or a final error field shape. Gaps observed in the then-current implementation were later superseded by production work.

Current contracts: [Model Resolution](../../specifications/model-resolution.md), [ADR-004](../../decisions/adr-004-provider-model-identity-and-facts-ownership.md), and [Current Model Resolution](../../architecture/model-resolution.md).
