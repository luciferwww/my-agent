# Runtime Composition and Policy Layout Specification

> Status: Validated
> Date: 2026-11-11
> Owner: Project owner
> Related Plan: [Plan](plan.md)

## Contract

Move exactly the Plan's 13 existing files without changing basenames or
executable behavior. Broaden physical composition organization to overall
Runtime assembly/startup/component lifecycle; introduce policy as a private
organization group for existing applied Agent policy and Tool authorization.

Builder retains overall assembly and shutdown coordination. Bootstrap retains
configuration/resource preparation. Agent Home lock retains exclusive process
ownership and instance-safe release. Channel lifecycle retains preparation,
binding, ingress gates and cleanup. Existing Unit/generation owners stay intact.

AgentPolicyState remains the authoritative applied Agent registry/policy owner
and Settings projection provider. Tool policy remains the existing authorization
decision implementation; glob matching is its local supporting mechanism, not a
new shared utility API. Settings, Session permissions, interactions, request
gates and Parent/Child execution retain their established owners.

## Migration requirements

1. Update resolved static imports/re-exports, import types, dynamic imports and
   actual source-relative locators if affected. No old-path proxies or duplicate
   implementations; preserve Runtime and Extension public facade names/shapes.
2. Do not add composition/policy barrels, interfaces, Managers or configuration.
   Internal files may directly import established sibling implementations.
3. Relocate existing Fitness selectors/Mixed entries without reclassification,
   additional exemptions or weaker dependency enforcement. The process lock
   remains Infrastructure despite its physical composition directory.
4. Update Current Architecture for the verified broad composition/policy
   organization, including the previously retained root Builder/bootstrap paths.
   Do not rewrite archived acceptance records to imply these files moved earlier.
5. Mechanically repair actual live source-link targets affected by these moves,
   retaining historical prose, source-line suffixes and unrelated user changes.
   Research repairs require explicit permission; do not stage them automatically.
6. Preserve RuntimeApp, Subagent orchestration and other retained root files.
   Do not add generic execution/helpers/startup groups or reorganize Core.
7. Translate Chinese comments in moved source/tests and directly affected
   callers/tests into English without changing meaning, runtime strings or
   test names. Comment-only changes are allowed alongside resolved path edits;
   synthetic source and diagnostic path strings follow the same migration.

## Acceptance and validation

1. Use a TypeScript-aware resolved module migration. After the first coherent
   policy or composition move, run the smallest affected unit selection before
   proceeding to the other group.
2. Verify exactly 13 old paths absent/new paths present and Runtime root has
   exactly 14 files (8 production, 6 tests). Keep tests colocated; do not add a
   permanent source-layout snapshot gate.
3. Compare changed/relocated production and test bodies against `b589364`
   after module-target normalization. Separately review Fitness selector edits
   and confirm import bindings/public exports are preserved.
4. Run all Runtime unit tests, Runner and Tool-pipeline regressions, and the
   WebSocket Channel unit suite. Run acquisition-to-Runtime integration and
   FT-01/03/12/13 on Node.js 22.
5. Run existing lint and full build. Verify both emitted output trees contain
   moved production JS/declarations and no stale root artifacts; public Runtime
   and Extension facade surfaces remain unchanged and emitted targets resolve.
   Retain existing Client asset, Host package and Relay audits.
6. Search production/test/script/config references for stale paths; validate
   affected Markdown targets and whitespace. Record any restricted or
   unauthorized research-link limitations rather than hiding them with shims.
7. Record direct versus independent review and actual validation limits.
   Synchronize Plan/Specification and Change index. Owner acceptance of delivery
   and validation precedes archive; commit, push and merge need separate approval.

## Failure and rollback

Unresolved paths or changed logical classifications are migration failures:
correct them within scope rather than suppressing errors or weakening checks.
If rollback is needed, restore moved files and their callers together without
touching unrelated research edits. Pause if a physical move requires a semantic
change or conflicts with an accepted behavioral decision.

## Authorization

The owner accepted the exact Plan/Specification and authorized Delivery and
narrow invalidated research source-link repairs on 2026-11-11, then requested
English translations of Chinese comments in related source files. Implementation
and required checks passed; the [delivery evidence](plan.md#delivery-evidence)
records results and review limits. The owner accepted delivery/validation and
authorized archive on 2026-11-11, explicitly without commit, push or merge.
This archived record preserves delivery provenance; Current Architecture and
stable contracts remain authoritative for ongoing implementation.
