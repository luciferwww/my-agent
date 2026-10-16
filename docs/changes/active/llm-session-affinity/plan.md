# Built-in Endpoint and Session Affinity Support Plan

> Status: Accepted
> Date: 2026-10-16
> Owner: Project owner
> Classification: Architecture Slice (additive Model invocation and Built-in configuration contracts)
> Authorization: Owner accepted the design and authorized implementation, tests, and authority synchronization on 2026-10-16
> Specification: [Built-in Endpoint and Session Affinity Support Specification](specification.md)

## 1. Outcome

Extend the existing Built-in Provider with three bounded, reusable capabilities:
two HTTP headers, Session ID propagation, and an optional per-model relative
endpoint. OpenCode Go is the first integration example, not the owner of a
special routing branch. Keep one shared base URL and credential; do not create
a new Provider. Retain the existing Change directory to preserve links.

## 2. Confirmed design

- Add `sessionId?: string` to `ModelInvocationRequest`.
- Runner supplies its existing Session ID for normal and Compaction calls.
- `callLLMStream()` already receives `turnCtx`; do not duplicate the identity in
  its private `params`.
- Built-in clients use the supplied ID, or a fresh UUID when it is absent.
- All three protocols send `x-opencode-session` and an application-specific
  `User-Agent`, without endpoint/domain checks.
- Add `endpoint?: string` to Built-in model registrations. It is a relative
  operation path, not a replacement base URL or an absolute URL.
- With an endpoint, the final URL is `baseURL + "/" + endpoint`, joining boundary
  slashes once and appending no further protocol suffix.
- Without an endpoint, retain the current protocol-derived operation path.
- Endpoint handling is a model configuration addition plus conditional request
  URL construction and any necessary private propagation. Protocol owns wire
  encoding; endpoint owns the operation path, including version segments.
  The same Responses protocol can therefore use `responses` or `v1/responses`.
  No vendor lookup or new routing framework is needed.
- Keep the existing provider-wide `baseURL`, `apiKey`, exact environment
  references, and explicit Model protocol registrations.

## 3. Non-goals

No new Provider, per-model host/base URL or credentials, AsyncLocalStorage,
session scope framework, `contextId`, separate affinity group, dependency,
Google protocol support, server-side history, model discovery, or cache-hit
guarantee. Independent Extension Providers, including Copilot Relay, do not
automatically adopt Built-in configuration or change their own transports.
The only new configuration field is the model-level `endpoint`. Do not refactor
unrelated code; keep endpoint support to the existing configuration-to-request
path rather than introducing a new framework.

## 4. Delivery plan

| Item | Status | Work | Exit condition |
|---|---|---|---|
| LSA-0 Design | Completed | Review this Plan and Specification | Independent review found no blocking issues; owner accepted design and authorized implementation on 2026-10-16 |
| LSA-1 Implementation | In Review | Add optional identity, Runner/Compaction propagation, Built-in headers, and per-model endpoint validation/routing | Implemented using existing protocol clients and one captured endpoint map per protocol; awaiting owner delivery acceptance |
| LSA-2 Validation | In Review | Focused configuration, Provider routing, Runner, Compaction, and three-protocol tests; type-check | 292 focused tests passed and TypeScript no-emit passed on 2026-10-16 |
| LSA-3 Documentation | In Review | Update owning current architecture and stable contracts, including OpenCode Go configuration | Configuration Specification, Provider architecture, user guide, and OpenCode reference synchronized; awaiting owner delivery acceptance |

## 5. Validation and completion

Use existing tests and tooling. Verify the Specification's acceptance scenarios,
preserve unrelated working-tree changes, and do not store a real API key in code,
tests, documentation, or committed configuration.

A live Go smoke test is optional, requires an explicitly authorized credential
and active subscription, and does not replace automated regression coverage.
This Change is not implemented or validated merely because these documents exist.

### Recorded evidence (2026-10-16)

- Independent design review reported no blocking or high-confidence design
  defects before owner authorization.
- Focused test runner: **292 passed, 0 failed**, covering Built-in configuration,
  Provider, all three protocol clients, Runtime Unit, Runner, Compaction,
  Platform configuration loading, and Standalone initialization/edit workflow.
- `tsc --noEmit`: passed.
- Five documented Built-in configuration examples parsed and passed the actual
  Built-in validator; `git diff --check` passed.
- Tests verify exact endpoint paths, same-protocol concurrent routing,
  captured registration stability, protocol defaults, both invocation styles,
  authentication preservation, supplied Session IDs, UUID fallback, retry
  identity, Compaction/restart identity, credential materialization, exact
  validation field paths, and endpoint preservation during configuration edits.
- No paid or live upstream request was made for this delivery. No production
  changes were made to independent Extension Providers or initialization UI.
- Owner delivery acceptance is pending; the Change remains active.
