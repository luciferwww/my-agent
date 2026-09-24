# Model-Aware Input Budget Plan

> Status: Completed, Validated, Accepted, and Archived
> Date: 2026-09-24
> Owner: Project owner
> Type: Provider facts and Runner context policy
> Specification: [Model-Aware Input Budget Specification](model-aware-input-budget-specification.md)
> Validation: [Validation Record](validation.md)
> Authorization: Opened and authorized by the project owner on 2026-09-24.
> Acceptance: Accepted by the project owner and archived on 2026-09-24.

## 1. Outcome

Replace the fixed subtraction of `reserveTokens` from every model's effective
input limit with a model-aware budget derived from optional Provider facts.
Allow Built-in model registrations to configure total Context, Prompt, and
output limits independently while preserving a conservative fallback for
registrations that omit all limits.

## 2. Problem

The current Runner interprets one `effectiveContextLimit` as a total Context
window and always subtracts the fixed `reserveTokens=20000`. Some Providers,
including Copilot Relay, already publish an effective limit derived from a
Provider-declared Prompt limit. Subtracting the reserve again underuses those
models. Conversely, a fixed 20,000-token reserve consumes most of a small
32,768-token fallback window.

Provider facts already support optional `maximumOutputTokens`, but Runner
treats it as informational and cannot distinguish total Context from Prompt
limits.

## 3. Scope

- Add optional `maximumContextTokens` and `maximumPromptTokens` Provider facts.
- Retain `maximumOutputTokens` as optional trusted metadata.
- Preserve required `effectiveContextLimit` in resolved bindings as a
  compatibility fallback.
- Let Built-in model registrations configure all three maximum values
  independently; every field remains optional.
- Preserve Built-in `32768` as the fallback when no Prompt or Context limit is
  configured.
- Preserve exact Copilot Relay discovery values while retaining its effective
  Prompt limit.
- Derive Runner input budget in this order:
  1. known Prompt limit;
  2. known total Context minus bounded adaptive output headroom;
  3. Provider effective fallback.
- Keep output request parameters unchanged.
- Synchronize stable configuration, Provider, Model Resolution, and Runner
  documentation.

## 4. Non-goals

- Requiring every Provider to know every model limit.
- Treating maximum output capability as the desired output size for every
  invocation.
- Adding public per-request output-token controls.
- Sending a new `max_output_tokens` field to OpenAI-compatible endpoints.
- Changing model identity, Catalog selection, or Provider discovery policy.
- Folding this work into the WebSocket Channel Extension Change.

## 5. Delivery slices

| Slice | Status | Outcome |
|---|---|---|
| MIB-1 Facts and configuration | Complete | Extend optional raw model limits through Built-in, Copilot Relay, Model Resolution, and Extension API |
| MIB-2 Runner budget | Complete | Derive one input budget without double-subtracting Prompt limits |
| MIB-3 Authority and validation | Complete | Synchronize docs and pass focused/full validation |

Only one slice may be In Progress.

## 6. Validation

- Built-in validation accepts omitted, partial, and complete model limits and
  rejects invalid or internally inconsistent values.
- Resolver freezes and preserves optional facts and rejects invalid facts.
- Copilot Relay preserves discovered Context, Prompt, and output limits.
- Runner budget tests cover Prompt precedence, adaptive Context headroom,
  maximum-output clamping, small windows, zero configured reserve, and legacy
  effective fallback.
- Existing Provider, Runner, Runtime, Extension, and architecture tests remain
  green.
