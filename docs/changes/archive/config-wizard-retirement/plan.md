# Config Wizard Retirement Plan

> Status: Archived — completed
> Date: 2026-09-15
> Accepted: 2026-09-15
> Archived: 2026-09-15
> Owner: Project owner
> Type: Capability Retirement Architecture Slice

## Delivered scope

The unused pre-refactoring Config Wizard was removed without replacement or compatibility:

- deleted `src/platform/config/wizard/`, including its two test files;
- deleted the unsupported `scripts/config.ts` shell;
- removed Wizard behavior from Current Configuration architecture and the stable Configuration Specification;
- updated Architecture Overview, Extension Acquisition wording, FT-12 ownership/evidence, and the dated capability summary;
- retained configuration types, defaults, loading, five-stage precedence, merge, environment/caller overrides, Model Reference input, and Tool/Subagent policy;
- left archived historical records unchanged.

The Wizard had no Runtime caller, package command, or Platform Config entry export. No replacement command, deprecation layer, or forwarding facade was introduced.

## Validation

- focused Config Loader and FT-12 validation passed: 32 tests;
- root TypeScript lint passed;
- final full regression passed: 110 files / 998 tests;
- clean build, Relay error-boundary audit, and Relay artifact audit passed;
- active residual search found no Wizard path, symbol, CLI entry, ownership key, or authority claim;
- independent review reported PASS with no Critical, High, or Medium finding;
- the review's presentation-only module-tree finding was corrected and the clean build removed stale ignored output.

## Closeout

The project owner approved the simplest direct retirement on 2026-09-15. Current behavior is owned by [Configuration](../../../architecture/configuration.md) and the stable [Configuration Specification](../../../specifications/configuration.md). This archive is delivery provenance only.
