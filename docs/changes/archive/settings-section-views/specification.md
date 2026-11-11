# Settings Section View Specification

> Status: Validated
> Date: 2026-11-11
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Existing decision: [ADR-024](../../../decisions/adr-024-settings-contract-and-model-test-ownership.md)

## Purpose and observable outcome

Make LLM/Extension credential-safe projection and restart comparison independently
testable without changing any Settings response or lifecycle behavior.

## Boundaries and structural contract

Add two stateless functions in private
`src/runtime/settings/section-views.ts`: one for an LLM section and one for an
Extension section. They may share private credential/comparison helpers.

SettingsManager supplies the necessary raw section values, startup comparison
values, revision, current application status, descriptor, and diagnostics.
Use existing concrete types and narrow explicit inputs; do not pass the manager,
its full options, a Runtime handle, a mutable state container, or a getter facade.
Do not resolve credentials or read the environment.

The manager retains all mutable facts: document, startup baseline, descriptor
lookup, revisions, file consistency, application status, and queued operations.
The functions retain no state, own no resources, and do not mutate inputs.
No clone of the complete document or second authoritative baseline is needed.

Keep the Agent branch of `section()` and `modelCatalog()` in SettingsManager.
AgentPolicyState remains the Agent projection/policy owner. The new functions
do not reconstruct Agent views, determine model availability, or link Providers
to configuration sections.

Export only the functions/types actually needed by SettingsManager through the
existing private `settings/index.ts`; do not change Runtime or Extension public
exports or introduce a generic section interface/registry.

## Behavior and invariants

### LLM section

- Preserve the section ID/revision, `restartRequired: false`, and current
  application status supplied by the manager.
- Reuse existing LLM configuration validation without environment resolution.
  Preserve default-model/Built-in omission rules and all noncredential fields.
- Remove the Built-in API key from ordinary settings; expose only its existing
  metadata under `/builtin/apiKey`.
- Credential metadata distinguishes unset/blank, literal, exact environment
  reference, and invalid credential representation exactly as today. Never
  include the raw key, environment variable name/reference, resolved value, or
  private parsing error in the result.

### Extension section

- Preserve section ID/revision, descriptor display-name fallback, form fields,
  diagnostics filtering/order, application status, and output omission rules.
- Ordinary config exposes only own, editable, nonsensitive scalar values under
  the existing field rules. Unsupported, read-only, sensitive, nested, and
  nonfinite values must not be copied into ordinary settings.
- Credential fields expose only metadata for editable sensitive fields, not
  raw credential values. Reuse existing schema helpers rather than inferring a
  second interpretation of `writeOnly` or editability.
- An absent entry is enabled. Restart comparison uses startup baseline and the
  same schema/default normalization as current code, including absent entries,
  explicit enablement, credentials, and invalid comparison values.
- `restartRequired` is derived independently per Extension and clears when
  effective saved values return to baseline. Do not retain a sticky changed bit.

### Timing and errors

Functions are synchronous and pure apart from existing synchronous validation.
Do not catch and default unknown errors. Preserve the existing narrow handling
of invalid credential metadata; other errors propagate to the manager's existing
request error boundary.

Loads still wait for serialized updates. The manager invokes projections from
the current completed state, including existing save, apply, unknown-publication,
and rollback outcomes. Neither function changes revisions, publishes policy,
performs I/O, or decides whether to roll back.

## Compatibility and migration

Delegate existing LLM/Extension branches and remove the superseded helper
definitions in the same cutover. No adapter, duplicate implementation, flag,
compatibility alias, new dependency, response-field change, or UI migration.
Retain meaningful manager-level integration assertions; do not replace
transactional coverage with pure-function tests.

## Acceptance and validation

1. Immediately after first extraction, run direct projection tests without a
   SettingsManager, temporary Home, file writes, Provider, or Runtime:
   - LLM absence/default-model/Built-in omission and status preservation;
   - unset, blank, literal, environment-reference, and invalid credentials;
     assert complete serialized output excludes distinctive secret/reference
     sentinels, not only that one expected field exists;
   - Extension editable/sensitive/read-only/nested/nonfinite filtering, name
     fallback, and diagnostic selection;
   - absent/default/disabled entries, schema-normalized restart equality,
     changed/reverted values, credential differences, and invalid comparison;
   - unchanged input objects and deterministic repeated results.
2. Run `settings-manager.test.ts`, `settings/model-test.test.ts`, and
   `agent-policy-state.test.ts` together: retain revision, serialized load,
   save/apply/rollback, unknown-state, pending-restart isolation, and Agent/Test
   lifecycle coverage. Add a narrow regression only where delegation changes
   are not already exercised.
3. Run the existing acquisition-to-Runtime integration suite for Settings
   response integration. No live Provider E2E or UI change is required.
4. Run FT-01/12/13 and existing lint/build on supported Node.js 22.
   The existing Settings directory classification and entry rules should cover
   the module; add no filename snapshot or new exception just for this extraction.
5. Review the real manager call paths, credential exposure, unchanged response
   shapes, absence of duplicated state, and removed helper definitions.
   Record direct versus independent review accurately.
6. Synchronize only verified Runtime Settings layout/ownership prose and Change
   index/status. Check links/whitespace; do not rewrite stable behavioral
   Specifications or ADR-024 when their authority has not changed.

## Open decisions

No open design decision remains. The owner accepted the Plan/Specification,
authorized Delivery, then accepted delivery/validation and authorized archive
on 2026-11-11, explicitly without commit, push or merge. Direct tests established
independent value without additional ownership or dependency changes. The Plan
records validation and its limits; this archive does not replace stable authority.
