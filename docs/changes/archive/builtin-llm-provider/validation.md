# Unified Built-in LLM Provider Validation

> Status: Implemented and Validated
> Date: 2026-09-20
> Owner: Project owner
> Related Plan: [Plan](plan.md)
> Contract: [Unified Built-in LLM Provider Specification](builtin-llm-provider-specification.md)
> Decision: [ADR-016](../../../decisions/adr-016-unified-builtin-llm-provider.md)

## 1. Gate policy

Delivery used focused tests, Fitness checks, and type checks throughout implementation. At the project owner's request, the official full gate was deferred until manual acceptance. The owner completed manual testing and accepted closeout on 2026-09-20; the full gate then ran on the accepted source state.

## 2. Implementation evidence

| Boundary | Evidence |
|---|---|
| Unified Provider | One optional `builtin` Provider publishes only configured models and privately routes each model to Anthropic Messages, OpenAI Responses, or OpenAI Chat Completions |
| API prefix | Each Client treats `baseURL` as the complete API prefix and appends only its operation path without adding, removing, or guessing a version segment |
| Protocol Clients | Project-owned HTTP/SSE adapters cover the Agent invocation contract without vendor SDK fallback, hidden retries, or unrelated SDK surface |
| Configuration ownership | The Built-in module owns its leaf contract and defaults; Platform Configuration owns top-level composition and exact `${ENV_VAR}` credential materialization |
| Model facts | Context uses a conservative fallback while Tool and Media capability preserve unknown, explicit support, and explicit rejection |
| Runtime selection | `llm.defaultModel` provides initial client selection and Server fallback without implicit first-model substitution |
| Output tokens | Legacy public output-token configuration and invocation controls are removed; Anthropic retains its private required fallback |
| Attachments | Inbound attachment admission is atomic, and explicit image incompatibility is reflected in the WebSocket HTML client |
| Authority transfer | Current Architecture and stable Configuration, Provider, Model Resolution, Channel, and attachment documents describe the delivered behavior |

## 3. Manual acceptance

The project owner exercised the Built-in Provider against the configured local API prefix with:

- `gpt-5.6-sol` through OpenAI Responses;
- `gemini-3.8-flash` through OpenAI Chat Completions;
- persisted multi-turn Session history and model switching.

Both Protocol paths completed real conversations. Follow-up inspection showed Gemini could accurately reproduce recent messages, confirming that Session history reached the model; its earlier answer about the last discussion topic was accepted as a model-level semantic interpretation rather than a Session or Provider transport defect. The project owner reported no remaining issue and approved closeout on 2026-09-20.

## 4. Executed validation

| Check | Result |
|---|---|
| Focused configuration, resolution, Provider, Protocol, Runtime, Channel, attachment, credential, and compatibility tests during delivery | Passed |
| `npm test` on final source state | 100 files, 1,062 tests passed |
| `npm run test:integration` | 6 files, 18 tests passed |
| `npm run test:fitness` | 12 files, 39 tests passed |
| `npm run lint` | Main TypeScript no-emit and relay workspace TypeScript checks passed |
| `npm run build` | Main and Host builds passed; Host audit passed for 318 files; relay verification passed 45/45 |
| `npm run verify:websocket-host` | Generic WebSocket Host, install-owned Relay acquisition, and immutable installation verification passed |
| `git diff --check` before closeout | Passed |

## 5. Independent review

Independent review identified two actionable defects:

1. Copilot Relay did not initially share the Platform-owned exact-string API-key materialization path.
2. The shared SSE parser did not initially accept legal CR-only event framing.

Both were corrected with focused regression coverage. Credential materialization was then relocated from Core to Platform Configuration to preserve the accepted ownership boundary. A narrow follow-up review found no remaining issue in the reviewed scope.

Subsequent Client inspection also added a 1 MiB single-event SSE buffer limit and normalized streamed Provider error classification, including Context overflow. Focused Protocol and Provider tests passed after those reliability changes.

No remaining Critical, High, or Medium implementation issue is known.

## 6. Residual scope

- Built-in model registration remains intentionally manual; dynamic model discovery is outside this Change.
- Protocol Clients remain minimal Agent adapters rather than general-purpose vendor SDKs.
- Model-specific interpretation quality and compatible-gateway transformations remain external behavior when the transmitted canonical history is intact.
- General configuration-contract relocation for non-LLM modules remains outside this Change.

Follow [Development Workflow](../../../governance/development-workflow.md).
