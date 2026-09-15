# Source Layout Refactoring Migration Plan

> Status: Archived — S0 through S6 completed under owner-authorized full-auto delivery
> Date: 2026-09-15
> Role: Refactoring scope, validation, and acceptance provenance; not current source authority
> Selected direction: Option A — vertically grouped builtin capabilities

## Delivered scope

The change vertically grouped application-delivered concrete capabilities under `src/builtins/`:

- Anthropic-compatible Provider implementation, protocol codec, Runtime Unit, and tests moved to `src/builtins/providers/anthropic/`;
- CLI and WebSocket implementations, Runtime Units, and tests moved to `src/builtins/channels/{cli,websocket}/`;
- Workspace, Memory, and Task Tool implementations, Runtime Contributions, and tests moved to `src/builtins/tools/{workspace,memory,task}/`;
- concrete builtin exports were removed from Core Tool and Memory barrels;
- Runtime Builder callers, supported Hosts, diagnostic scripts, tests, fixtures, and Architecture Fitness rules were redirected to the new ownership paths;
- `src/runtime-modules/`, concrete `src/adapters/` capability roots, and `src/core/tools/builtin/` were deleted without forwarding facades or a second runtime path.

Primary symbols now describe their actual contracts: Provider and Channel factories return Runtime Units, while Tool factories return Runtime Contributions that Runtime Builder wraps through the existing generic lifecycle.

## Preserved invariants

Stable Provider, Unit, Contribution, Channel, and Tool identities remain unchanged. Concrete Provider construction is still deferred until Unit `create()`. Runtime remains the sole owner of staging, registration publication, lifecycle, reload, retirement, and stop. No Unit was split or merged, and no Provider/model selection, protocol conversion, Tool behavior, failure, or lifecycle semantics were intentionally changed.

## Validation evidence

Completed on Node.js 22.22.2:

- root `npm run lint` passed;
- Architecture Fitness passed: 38 tests;
- full `npm test` passed: 110 files and 1018 tests;
- `npm run build` passed, including Relay error-boundary and artifact audits;
- `npm run build:host`, `npm run verify:host-build`, and `npm run verify:websocket-host` passed;
- all relative Markdown links under `docs/` resolved;
- residual scans found no old production/script/Current Architecture/Specification import path or renamed symbol;
- `git diff --check` passed and no README file changed;
- independent review found no Critical or High behavior issue; follow-up review findings about stale closeout/decision-time wording were resolved, and the final review reported no unresolved Medium finding.

The broad `scripts/tsconfig.json` check remains red because diagnostic scripts contain preexisting API drift unrelated to this source move. Comparison with the pre-migration barrels confirmed the reported stale members and configuration shapes were already absent. Migration-relevant imports resolve to current files, supported Host compilation passes, and expanding this refactor into historical diagnostic-script modernization was explicitly excluded.

## Authority transfer

Durable source-ownership direction is owned by [ADR-007](../../../decisions/adr-007-builtin-capability-source-ownership.md). Current implemented ownership and evidence are recorded by [Overview](../../../architecture/overview.md), [Runtime](../../../architecture/runtime.md), [Providers](../../../architecture/providers.md), [Channels](../../../architecture/channels.md), [Builtin Tools](../../../architecture/builtin-tools.md), and [Memory](../../../architecture/memory.md). Stable Specifications retain behavior authority.

The temporary design-options input had no remaining unique authority and was deleted at closeout. Architecture Foundation closeout remains a separate task.
