# Model Invocation Errors Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-09-14
> Authority: Stable structural invocation-error contract

## Scope

This contract defines a versioned structural error boundary that permits independently bundled Provider code to communicate normalized invocation failure without sharing a JavaScript constructor. It does not define acquisition errors, a universal Error framework, serialized cross-process security, Abort, or context overflow.

## Contract

```ts
interface ModelInvocationStructuralErrorV1 extends Error {
  readonly protocol: 'my-agent.model-invocation-error';
  readonly version: 1;
  readonly category: ModelInvocationFailureCategory;
  readonly diagnostics?: ModelInvocationDiagnostics;
}
```

Categories are exactly `authentication`, `rate_limit`, `invalid_request`, `unavailable`, `transport`, and `provider_failure`.

`toModelInvocationError(value)` returns a Host-local canonical error or `undefined`. Protocol and version must match exactly; identity is not inferred from name/message. Only own data discriminator properties are accepted—accessors and inherited values are rejected. Canonicalization is total and non-throwing.

## Diagnostics and privacy

Diagnostics are optional and allowlisted. If present but invalid, the entire diagnostics value is discarded while a valid category remains. Canonical diagnostics and request summary are defensively frozen.

Opaque Provider model IDs are preserved exactly. The boundary must not retain Extension identity/locator, foreign message/stack/cause, prompt text, images, credentials, Tool input/results/schema, unknown fields, or complete Provider responses.

## Cause traversal and realm boundary

Runtime may inspect at most eight same-realm `Error` nodes with cycle detection. It does not retain foreign nodes after canonicalization. Version 1 assumes trusted same-realm ESM code; Worker, VM, subprocess, RPC, and serialized hostile inputs are out of scope.

Relay and other separately emitted producers must not runtime-import, subclass, or depend on the Host `ModelInvocationError` constructor. They produce the structural V1 shape.

Abort remains `AbortError`; context overflow remains its own normalized error and recovery path.

## Acceptance scenarios and evidence

Cover duplicate-constructor acceptance, same-name lookalike rejection, invalid protocol/version/category, diagnostics discard, accessor/inherited rejection, proxy failure containment, exact opaque IDs, privacy allowlist, bounded cyclic cause traversal, and emitted Relay code without Host constructor import.

Evidence: [Core errors](../../src/core/model-invocation/errors.ts), [Core tests](../../src/core/model-invocation/errors.test.ts), [Runtime](../../src/runtime/RuntimeApp.ts), and [Relay producer](../../src/extensions/copilot-relay-provider/responses-client.ts). Current facts: [Providers](../architecture/providers.md).
