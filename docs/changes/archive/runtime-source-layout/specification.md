# Runtime Source Layout Specification

> Status: Validated
> Date: 2026-11-11
> Owner: Project owner
> Related Plan: [Plan](plan.md)

## Purpose and observable outcome

Group established Runtime responsibilities to reduce top-level navigation noise
from 47 files to 27. The Plan's exact move list is the migration boundary;
runtime behavior, interfaces, state ownership, and dependency semantics do not
change.

## Ownership and dependencies

- Composition files retain Unit registration, lifecycle, generation publication,
  capture, retirement, and reload responsibilities.
- SettingsManager moves into its existing private module; it remains the sole
  transaction/revision/baseline owner. Model Test and stateless view ownership
  remain as previously delivered.
- Scheduling contains related message payload, FIFO, and request gate sources.
  Directory membership does not give the scheduler ownership of request gates:
  RuntimeApp still owns gate creation, terminalization, routing and execution.
- Runtime public `index.ts` and the Extension API keep the same exports with
  updated internal targets. Do not add a direct Root execution API.
- Do not add directory barrels except extending the already-existing private
  Settings entry with the concrete manager needed by its callers.

## Migration contract

1. Move the 11 production files and 9 tests listed in the Plan without renaming
   basenames or altering executable statements. Update relative imports,
   re-exports, dynamic imports, and actual source-relative fixture/asset locators
   where applicable.
2. Settings callers outside that directory use its existing `index.ts`.
   SettingsManager imports sibling Model Test/view/helpers directly rather than
   importing its own entry. Add no proxy at the old manager path.
3. Keep all other public facade exports unchanged, including Unit loading,
   composition handle types, and Settings capability names.
4. Update Fitness path selectors and Mixed inventory entries to their new
   locations without weakening the prior dependency rule, adding an exemption,
   or forcing a new logical boundary merely because a file moved.
5. Update build/script references and live Markdown source links affected by
   relocation. Preserve historical status/prose, old conceptual examples, and
   accepted decisions that have not changed. Do not broadly rewrite archives.
6. Preserve the owner's existing research modifications. If source links in
   those files require repair, request narrow permission or report the
   remaining stale links; never create old-path shims to conceal them.
7. Leave no duplicate implementation or transitional import path. If a
   source-relative location cannot be migrated safely, stop that move and
   reassess rather than changing behavior.

## Acceptance and validation

1. Immediately after the first coherent move group, run the smallest affected
   tests or type check. Use existing TypeScript-aware rename/refactor support
   where available rather than unbounded textual replacement.
2. Confirm exactly 20 files moved and exactly 27 top-level files remain,
   consisting of 15 production files and 12 tests. Tests remain colocated.
3. Compare relocated production bodies to the accepted base: only import,
   export, and necessary source-relative locator changes are permitted.
   Review the small Settings-entry import rewiring separately.
4. Run all Runtime unit tests plus Runner steering/Tool-pipeline regressions to
   catch moved-test discovery and cross-module import effects. Do not add
   source-path snapshots as a permanent behavioral test.
5. Run acquisition-to-Runtime integration, FT-01/03/12/13, lint, and build on
   Node.js 22. Existing build audits must verify packaged Host files and Client
   assets; inspect emitted Runtime paths/public facade targets. Do not
   compensate with timeouts, retries, or new dependencies.
6. Check actual production/test/script references for stale old paths, including
   Fitness string fixtures. Check affected document links and whitespace and
   record any explicitly preserved user-owned research-link limitation.
7. Review no semantic changes, no duplicate owner/path, no new framework/barrel
   layers, unchanged facade export names, and measured navigation improvement.
   Record direct versus independent review accurately.
8. Synchronize verified Runtime layout and Change records. Owner delivery and
   validation acceptance are required before closeout; commit/push/merge require
   separate authorization.

## Failure and rollback

There is no new runtime failure/cancellation policy. A moved file that no longer
resolves is a migration failure, not a reason to default or suppress errors.
Correct imports and path fixtures within scope. If rollback is needed, restore
the moved owner and all callers together, preserving unrelated worktree changes.

## Acceptance

The owner accepted the exact design and authorized Delivery and narrow repair
of research source links on 2026-11-11. No accepted behavior or architectural
decision is being amended. Implementation and required checks are complete;
the [Plan's delivery evidence](plan.md#delivery-evidence) records the results
and review limits. The owner accepted delivery/validation and authorized archive
on 2026-11-11, explicitly without commit, push or merge. This archived record
preserves delivery provenance; Current Architecture and stable contracts remain
authoritative for ongoing implementation.
