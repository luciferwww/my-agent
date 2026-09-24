# Model-Aware Input Budget Specification

> Status: Implemented, Validated, Accepted, and Archived
> Date: 2026-09-24
> Owner: Project owner
> Related Plan: [Model-Aware Input Budget Plan](plan.md)

## 1. Provider facts

`ProviderModelFacts` may publish:

```ts
interface ProviderModelFacts {
  effectiveContextLimit?: number;
  maximumContextTokens?: number;
  maximumPromptTokens?: number;
  maximumOutputTokens?: number;
  toolUse?: boolean;
  mediaKinds?: readonly string[];
}
```

All known numeric limits are positive safe integers. When both a Context and
Prompt limit are known, Prompt cannot exceed Context. When both a Context and
output limit are known, output cannot exceed Context.

`effectiveContextLimit` remains required after Model Resolution so existing
Providers and Turn bindings remain compatible. Raw optional facts refine
Runner budgeting; they do not replace canonical Model identity or invocation
binding.

## 2. Built-in configuration

Each `llm.builtin.models[]` registration may contain:

```ts
{
  modelId: string;
  protocol: BuiltinProtocol;
  displayName?: string;
  maximumContextTokens?: number;
  maximumPromptTokens?: number;
  maximumOutputTokens?: number;
}
```

Every limit is optional. The Built-in Provider derives its compatibility
effective limit as:

```text
maximumPromptTokens
  ?? maximumContextTokens
  ?? 32768
```

No model-name or Provider-brand inference is allowed.

## 3. Runner input budget

Runner derives one immutable input budget for the Turn:

```text
if maximumPromptTokens is known:
  inputBudget = maximumPromptTokens
else if maximumContextTokens is known:
  proportionalHeadroom = floor(maximumContextTokens * 0.10)
  outputHeadroom = min(
    configured reserveTokens,
    proportionalHeadroom,
    maximumOutputTokens when known
  )
  inputBudget = maximumContextTokens - outputHeadroom
else:
  inputBudget = effectiveContextLimit
```

A known Prompt limit is already an input limit and must not have
`reserveTokens` subtracted again. `maximumOutputTokens` caps headroom when
known; it never forces every invocation to reserve the model's full maximum
output.

The derived input budget controls preflight budget routing, Tool Result
pruning budgets, and overflow thresholds. It does not alter Provider request
parameters.

## 4. Copilot Relay

Relay discovery retains exact positive `max_context_window_tokens`,
`max_prompt_tokens`, and `max_output_tokens` values when supplied. Its
effective compatibility limit remains the smaller known Prompt/Context input
limit. Missing required discovery facts continue to follow Relay's existing
eligibility policy.

## 5. Compatibility

- Providers that publish only `effectiveContextLimit` continue to resolve.
- Their effective limit is treated as an already usable input boundary.
- Built-in registrations that omit all new fields retain the conservative
  `32768` fallback.
- `reserveTokens` remains a Runner policy input, but applies only when the
  Provider supplies a total Context limit without an authoritative Prompt
  limit.
- No output-limit request option or Channel protocol field is introduced.

## 6. Acceptance scenarios

1. Prompt `922000`, Context `1050000`, output `128000` yields input budget
   `922000`.
2. Context `32768`, no Prompt, no output, reserve `20000` yields adaptive
   headroom `3276` and input budget `29492`.
3. Context `32768`, output `2048`, reserve `20000` yields input budget `30720`.
4. A Provider with only effective fallback `32768` yields input budget `32768`.
5. Invalid, zero, fractional, or Context-inconsistent limits fail validation.
6. Unknown optional facts remain absent rather than guessed.
