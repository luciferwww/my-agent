# Extension Acquisition Readiness Spike Evidence

> Status: Completed readiness evidence — accepted 2026-09-14
> Executed: 2026-09-11
> Environment: Windows win32/x64; Node 22.22.2; Ajv 8.20.0
> Authority: Evidence only

## Method and observations

Disposable repository scripts and OS temporary directories tested risks before production acquisition delivery:

- canonical path containment rejected traversal and symlink/junction/reparse escape;
- a relocated multi-file ESM artifact loaded from a closed copied tree;
- strict Draft-07 Ajv validation applied defaults without coercion or unknown-property removal;
- environment/secret materialization and structured diagnostics did not serialize secret values or raw config.

Focused scenarios passed and disposable artifacts were removed after review.

## Limits

One Windows run was not cross-platform proof. The synthetic artifact did not prove actual Relay package deployment, complete Host config behavior, duplicate-ID handling, or Runtime handoff. The spike authorized no production delivery by itself; later A0–A5 implementation superseded its readiness assumptions.

Current facts: [Extensions](../../architecture/extensions.md). Stable contract: [Extension Acquisition](../../specifications/extension-acquisition.md).
