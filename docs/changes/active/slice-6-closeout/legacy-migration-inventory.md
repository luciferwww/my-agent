# Legacy Migration Inventory

> Status: Active control — accepted inventory; Slice 6 owner closeout remains open
> Date: 2026-09-14
> Owner: Project owner

## Purpose and classification

This inventory records the earlier Foundation Legacy boundary across documentation, production paths, APIs, configuration, and composition. Legacy is determined by authority and target replacement, not age or directory.

Classes were Retained Authority, Active Candidate, Document Candidate, Compatibility Candidate, and No Entry at Baseline. Candidate exit required successor ownership, real-caller migration, unique-value review, inbound-link replacement, appropriate tests/Fitness, and no target-to-Compatibility dependency.

## Document disposition summary

The frozen 52-entry document ledger is retained in [Document Disposition Manifest](document-disposition-manifest.json). It records:

- 13 Current Fact candidates retained through successor Current Architecture;
- Root README and capability summary retained as navigation/evidence, not second Current Architecture;
- two Subagent design inputs retained only as Deferred;
- 25 other root candidates and 12 versioned candidates reviewed for deletion after migration.

The clean-room documentation change now provides the physical successors, but the historical Slice remains active until its own owner acceptance is explicitly recorded.

## Production/API terminal state

| Entry group | Terminal result |
|---|---|
| CODE-M01–M08 | Provider/Model/config/Runner ownership migrated in Slice 1 |
| CODE-M09 | Parentless/legacy Child path removed in Slice 2 |
| CODE-E01/E02 | central Tool bundle and mutable Hook path removed in Slice 3 |
| API-E01 | direct Channel lifecycle path removed in Slice 4 |
| API-M01/M02 and CODE-E03 | canonical request fields and Runtime composition converged in Slice 5 |
| API-M04 | deprecated LLM adapter facade removed in Slice 6 |
| CODE-E04/E05 | Provider/Channel physical ownership converged in later Source Layout work |

No architecture old/new Feature Flag existed at baseline or was introduced. Product settings such as Subagent enablement are not migration flags.

## Durable exit rules

- A target implementation cannot depend on Compatibility.
- Facades/aliases must be one-way, named, tested, owner-bound, and time-limited.
- A Slice freezes its affected entries and must satisfy $Legacy_{end} < Legacy_{start}$.
- Adding Registry/Adapter layers does not offset unmigrated callers or retained duplicate paths.
- Unknown external consumers require an explicit breaking/deprecation decision.
- Library rollback uses reviewed version/release rollback unless a separately designed Feature Flag exists.

## Remaining gate

The earlier terminal validation reported 52/52 reviewed document dispositions and completed production removals. Explicit project-owner Slice 6 acceptance and a later archive/discard decision remain outstanding. This inventory stays a change-control ledger, not Current Architecture or durable decision authority.
