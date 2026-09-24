# Model-Aware Output Control Plan

> Status: Completed, Validated, Accepted, and Archived
> Date: 2026-09-24
> Owner: Project owner
> Type: Invocation policy and protocol adaptation
> Specification: [Model-Aware Output Control Specification](model-aware-output-control-specification.md)
> Validation: [Validation Record](validation.md)
> Authorization: Opened and authorized by the project owner on 2026-09-24.
> Acceptance: Accepted by the project owner and archived on 2026-09-24.

## 1. Outcome

Add one optional per-model `outputTokenLimit` invocation policy without
changing the meaning of `maximumOutputTokens`. Resolve and clamp that policy
once, apply it to normal and Compaction calls, and map it through all three
Built-in Protocol Clients while preserving their existing behavior when the
policy is omitted.

## 2. Problem

`maximumOutputTokens` is a model/deployment capability fact. Treating it as
the desired size of every response would conflate capability with product
policy. The Built-in Anthropic Client nevertheless must send `max_tokens` and
currently uses a fixed private `4096` fallback, while the two OpenAI Clients
omit output limits entirely.

Runner input budgeting can use a known invocation limit as tighter output
headroom, but no invocation-policy value currently exists.

## 3. Scope

- Add optional positive safe-integer `outputTokenLimit` to each Built-in model
  registration.
- Keep `maximumOutputTokens` as a capability fact.
- Publish invocation defaults separately from Provider facts.
- Clamp a configured or per-request limit to a known model output capability.
- Add optional `outputTokenLimit` to the Provider-neutral invocation request.
- Pass the resolved limit through normal Runner calls and Compaction summary
  calls.
- Prefer the invocation limit over maximum output capability when deriving
  Context-only input headroom.
- Map the limit to:
  - Anthropic Messages `max_tokens`;
  - OpenAI Responses `max_output_tokens`;
  - OpenAI Chat Completions `max_tokens`.
- Preserve omission behavior: OpenAI omits its field and Anthropic retains its
  private `4096` fallback when no invocation policy is configured.

## 4. Non-goals

- Making `maximumOutputTokens` an invocation default.
- Adding a global, Agent-level, Channel-level, or per-Turn public override.
- Adding Reasoning Effort, Thinking Budget, or a Thinking selection UI.
- Guessing `max_completion_tokens` support from a model name.
- Changing Copilot Relay request behavior.

## 5. Delivery slices

| Slice | Status | Outcome |
|---|---|---|
| MAOC-1 Contracts and resolution | Complete | Separate capability facts from clamped invocation defaults |
| MAOC-2 Runner and adapters | Complete | Apply the effective limit to budgeting, normal/Compaction calls, and all Built-in Clients |
| MAOC-3 Validation and authority | Complete | Synchronize documentation and complete focused/full validation |

## 6. Acceptance

- Omitting `outputTokenLimit` preserves existing wire behavior.
- A configured limit reaches normal and Compaction model calls.
- A limit above known `maximumOutputTokens` resolves to the known capability.
- Context-only input headroom prefers the effective invocation limit.
- Each Built-in Protocol Client emits its correct wire field.
- Invalid limits fail configuration or Model Resolution.
