# Built-in Endpoint and Session Affinity Support Specification

> Status: Validated
> Date: 2026-10-16
> Owner: Project owner
> Related Plan: [Built-in Endpoint and Session Affinity Support Plan](plan.md)
> Implementation: Implemented and validated with focused automated tests; owner delivery acceptance pending

## 1. Scope

Provide generic endpoint and session-affinity support through `builtin`, with
OpenCode Go as the first integration example, not a separate Provider.
This Change owns two HTTP headers, Session ID propagation, and one optional
per-model endpoint field. It does not introduce per-model base URLs or
credentials, vendor-specific route inference, or an additional routing framework.
Independent Extension Provider transports remain unchanged.

## 2. Request identity

Add one optional field to the existing `ModelInvocationRequest`:

```ts
sessionId?: string;
```

It identifies the conversation to which an invocation belongs. It is not a
per-call identity, context snapshot/version, authentication credential, or
instruction to restore server-side history. `invocationId` keeps its existing
per-call meaning.

Provider implementations may use the field for session-aware routing or cache
affinity, or ignore it. No public interface method signature changes.

## 3. Runner propagation

Normal calls use `turnCtx.sessionId` when constructing the Model invocation
request. The private `callLLMStream()` method does not need an additional
`params.sessionId`, because it already receives `turnCtx`.

Compaction summary calls receive the same Session ID. Multiple Turns, Tool
rounds, and Compaction calls in one Session retain that identity. A Child uses
its own existing Session ID; this Change introduces no Parent-grouping policy.
Concurrent Sessions remain independent, including when they share a Provider.

## 4. Built-in HTTP headers

Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions send:

- `User-Agent`: an application-specific identity, initially `my-agent/0.1.0`.
- `x-opencode-session`: the supplied `request.sessionId`, otherwise a fresh UUID.

The resolution rule is `request.sessionId ?? randomUUID()`. The optional field
does not introduce a separate normalization or blank-string fallback policy.
Resolve the value once per logical client invocation and reuse it for any
existing HTTP compatibility retry. Do not store a fallback UUID on a shared
Provider/client instance, generate a new value per retry, or substitute
`invocationId`. Separate invocations without a supplied Session ID receive
separate UUIDs and therefore have no cross-call affinity guarantee.

Both streaming and collected calls use the same rule. Send these headers
without OpenCode-specific hostname checks. Preserve existing protocol-specific
authentication, request bodies, and error handling. Operation paths change only
when a model explicitly configures the endpoint described below.

## 5. Per-model relative endpoint

Add one optional field to `BuiltinModelRegistration`:

```ts
readonly endpoint?: string;
```

`baseURL` remains provider-wide. A model endpoint contains the relative path
including any required version and operation name. It is not another base URL.
This is independent of vendor identity. For example, gateways using the same
Responses wire protocol may expose `/responses` or `/v1/responses`; protocol
selection alone must not force one versioned path onto both.

The implementation boundary is small: add and preserve the optional model
property, then use it instead of the default path when constructing the request
URL. Pass the selected property privately to the existing transport as needed;
do not introduce a general-purpose routing abstraction.

```ts
const path = model.endpoint ?? protocolDefaultPath;
const url = `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
```

The expression illustrates supplied-endpoint composition. For an omitted
endpoint, retain existing protocol-default URL behavior as specified below.

| Configuration | Final invocation URL |
|---|---|
| `baseURL: https://gateway.example`, `endpoint: responses` | `https://gateway.example/responses` |
| `baseURL: https://gateway.example`, `endpoint: v1/responses` | `https://gateway.example/v1/responses` |
| `baseURL: https://opencode.ai/inference/go/anthropic`, `endpoint: v1/messages` | `https://opencode.ai/inference/go/anthropic/v1/messages` |
| `baseURL: https://opencode.ai/inference/go`, `endpoint: anthropic/v1/messages` | `https://opencode.ai/inference/go/anthropic/v1/messages` |
| `baseURL: https://opencode.ai/inference/go`, `endpoint: openai/v1/responses` | `https://opencode.ai/inference/go/openai/v1/responses` |
| `baseURL: https://opencode.ai/inference/go`, `endpoint: openai/v1/chat/completions` | `https://opencode.ai/inference/go/openai/v1/chat/completions` |

When present, join `baseURL` and `endpoint` with exactly one boundary slash.
Accept boundary slashes without discarding the base URL's path. Do not append
`/messages`, `/responses`, or `/chat/completions` again. Do not use root-relative
URL resolution that replaces the configured base path.

When absent, preserve existing URL construction exactly:

- Anthropic Messages appends `/messages`.
- OpenAI Responses appends `/responses`.
- OpenAI Chat Completions appends `/chat/completions`.

The Built-in configuration owner validates the new field. A supplied endpoint
must be a nonblank string containing a relative path, not an absolute URL,
scheme-relative authority, query, fragment, or dot-segment traversal. Invalid
values fail with the existing exact model-field error attribution; they are
not silently ignored or replaced with a protocol default.

The Provider retains the endpoint in its immutable model snapshot and routes
by the selected registration. Two models using the same protocol may have
different endpoints. Never mutate shared client state to switch targets during
concurrent calls. Existing configured-model round trips must retain the field
when preserving or reserializing a supported model registration.

The protocol still determines request/response encoding and authentication.
An endpoint changes only the destination path; it does not infer the protocol
or convert an incompatible payload. Endpoint resolution remains Built-in-private,
not a new field in the shared `ModelInvocationRequest`.

## 6. OpenCode Go configuration

Use a common Go base URL and explicit per-model operation paths to mix the
supported protocols under one Built-in Provider:

```json
{
  "llm": {
    "defaultModel": { "providerId": "builtin", "modelId": "glm-5.2" },
    "builtin": {
      "baseURL": "https://opencode.ai/inference/go",
      "apiKey": "${OPENCODE_API_KEY}",
      "models": [
        {
          "modelId": "glm-5.2",
          "protocol": "openai-chat-completions",
          "endpoint": "openai/v1/chat/completions"
        },
        {
          "modelId": "gpt-5.6-luna",
          "protocol": "openai-responses",
          "endpoint": "openai/v1/responses"
        },
        {
          "modelId": "claude-haiku-5-5",
          "protocol": "anthropic-messages",
          "endpoint": "anthropic/v1/messages"
        }
      ]
    }
  }
}
```

The process environment supplies the key. Go access requires an active Go or
Go Plus subscription. Model IDs and protocols remain explicitly registered;
this Change adds no discovery or automatic protocol inference.

Anthropic Messages uses `v1/messages`, not `v1/completions`. Clients follow the
configured protocol and path rather than correcting a semantically wrong path.
This configuration contract is implemented. Existing registrations without
`endpoint` remain valid. Automated validation does not certify live upstream
model availability or parameter compatibility.

The [official Go documentation](https://opencode.ai/docs/go/#where-can-i-use-it)
requests a stable ID per conversation to optimize routing and prompt caching.
It does not require UUID format. UUID is our fallback for callers without a
conversation identity, not an OpenCode generation requirement.

Session affinity does not guarantee cache hits, reduce the submitted history,
or control reasoning. Existing non-Built-in Providers need not map this field.

## 7. Acceptance scenarios

1. A request without `sessionId` remains valid at the Model invocation boundary.
2. Normal Runner calls and Compaction calls carry the actual Session ID;
   different Turns in the same Session retain it.
3. Every Built-in protocol preserves a supplied ID exactly in the header,
   independently of `invocationId`.
4. Concurrent Sessions sharing a client send their respective IDs.
5. Missing IDs produce valid UUIDs, distinct across separate invocations.
6. Existing compatibility retries reuse the resolved ID within one invocation.
7. Both collected and streaming calls follow the rule.
8. Non-OpenCode endpoints also receive the two headers; existing authentication
   and payload behavior remain unchanged.
9. Existing environment-reference credential materialization still works; no
   actual key is added to repository files.
10. Configured endpoint paths produce the exact full URLs shown above for all
    three protocols, without duplicate version or operation segments.
11. An omitted endpoint preserves the existing protocol operation path and
    configuration behavior; boundary slashes cannot drop the base URL path.
12. Same-protocol models with different endpoints route independently, including
    concurrent calls and any existing compatibility retry.
13. Invalid endpoint types and paths fail at the exact model configuration field;
    supported model capture and configuration round trips retain valid endpoints.
14. The three-protocol example passes configuration validation and mocked
    full-request tests. Headers alone do not establish live model, Thinking,
    effort, or tool compatibility.
15. Responses models can independently select `responses` and `v1/responses`
    under the same base URL without vendor detection or protocol changes.
