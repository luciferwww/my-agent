# Model-Aware Output Control Specification

> Status: Implemented, Validated, Accepted, and Archived
> Date: 2026-09-24
> Owner: Project owner
> Related Plan: [Model-Aware Output Control Plan](plan.md)

## 1. Separate capability and policy

`ProviderModelFacts.maximumOutputTokens` remains optional trusted capability
metadata. It means the largest output supported by the selected
model/deployment and is not sent automatically on every invocation.

An optional invocation default is published separately:

```ts
interface ProviderModelDescriptor {
  facts: ProviderModelFacts;
  invocationDefaults?: {
    outputTokenLimit?: number;
  };
}
```

`outputTokenLimit` is a desired per-invocation ceiling. It must be a positive
safe integer. Model Resolution clamps it to a known
`maximumOutputTokens` and freezes the resulting invocation-default object.

## 2. Built-in configuration

Each `llm.builtin.models[]` registration may contain:

```ts
{
  modelId: string;
  protocol: BuiltinProtocol;
  maximumOutputTokens?: number;
  outputTokenLimit?: number;
}
```

Both fields are optional and retain different meanings. A direct request
override takes precedence over the model default, and the Built-in router
clamps either value to a known model capability.

## 3. Invocation and Runner

`ModelInvocationRequest.outputTokenLimit?: number` carries the already
resolved policy to a Provider adapter. Runner passes the Turn-bound default to
every normal model call and every Compaction summary call.

For a known Prompt limit, input budget remains that Prompt limit. For a known
total Context limit without a Prompt limit, output headroom is:

```text
min(
  configured reserveTokens,
  floor(maximumContextTokens * 0.10),
  outputTokenLimit when known,
  otherwise maximumOutputTokens when known
)
```

An omitted invocation policy does not cause the model capability to be sent
as a request parameter.

## 4. Protocol mapping

| Protocol Client | Configured effective limit | Omitted limit |
|---|---|---|
| Anthropic Messages | `max_tokens` | private required fallback `4096` |
| OpenAI Responses | `max_output_tokens` | omit field |
| OpenAI Chat Completions | `max_tokens` | omit field |

The generic OpenAI Chat Completions protocol uses `max_tokens` for broad
OpenAI-compatible endpoint support. A future `max_completion_tokens` path
requires an explicit deployment/protocol capability and must not infer support
from model naming.

## 5. Compatibility

- Existing Built-in registrations remain valid.
- Existing OpenAI wire requests remain unchanged when no policy is configured.
- Existing Anthropic requests retain `max_tokens: 4096` when no policy is
  configured.
- Providers that publish no invocation defaults resolve with an empty frozen
  defaults object.
- Copilot Relay behavior remains unchanged.

## 6. Acceptance scenarios

1. Capability `8192` and configured policy `16384` resolve to `8192`.
2. Capability `128000` and configured policy `16000` resolve to `16000`.
3. Context `100000`, output capability `50000`, and invocation limit `4096`
   produce input budget `95904` with reserve `20000`.
4. All three Built-in Clients serialize `12345` to their protocol field.
5. Omitted policy preserves OpenAI omission and Anthropic `4096`.
6. Zero, negative, fractional, or unsafe limits fail validation.
