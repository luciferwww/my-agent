# Unified Built-in LLM Provider Plan

> Status: Archived and Validated
> Date: 2026-09-20
> Accepted: 2026-09-20
> Validated: 2026-09-20
> Archived: 2026-09-20
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-016: Unified Built-in LLM Provider](../../../decisions/adr-016-unified-builtin-llm-provider.md)
> Specification: [Unified Built-in LLM Provider Specification](builtin-llm-provider-specification.md)
> Validation record: [Validation](validation.md)
> Research input: [Built-in LLM Provider Design Draft](../../../research/builtin-llm-providers-design-draft.md)
> Authorization: Delivery approved and closeout accepted by the project owner on 2026-09-20.

## 1. Outcome

Replace the single-protocol `anthropic-compatible` builtin with one optional `builtin` Provider that connects to one configured API prefix, exposes an explicitly configured model Catalog, and internally routes each model to its configured Anthropic Messages, OpenAI Responses, or OpenAI Chat Completions Client.

The Change also removes ambiguous public output-token controls, adds bounded `${ENV_VAR}` resolution for `apiKey`, publishes known model capabilities to clients, and makes inbound attachment admission atomic.

## 2. Scope

- Optional top-level `llm.defaultModel` and `llm.builtin` configuration.
- Empty Built-in model Catalogs for staged configuration without Client creation or network I/O.
- Built-in-owned configuration contracts, semantic validation, and operational defaults, composed but not duplicated by Platform Configuration.
- A reusable project configuration boundary: modules own leaf contracts and behavioral defaults while Platform Configuration owns application-document composition; this Change applies the pattern only to LLM.
- Minimal Built-in model registration using `modelId`, `protocol`, and optional `displayName`.
- Shared exact-string `${ENV_VAR}` resolution for Built-in and Copilot Relay `apiKey`.
- One Built-in Provider with an internal model-to-Protocol routing Port.
- Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions Clients.
- Conservative Context fallback and three-state Tool/Media capability semantics.
- Optional model capability projection through the Runtime Catalog and WebSocket DTO.
- Atomic attachment validation and explicit failure behavior.
- Removal of the public output-token configuration, policy, override, resolved limit, and invocation request fields.
- Preservation of the existing Provider ABI and Model Invocation Error V1 envelope.
- Runtime composition, tests, documentation, and authority transfer.

## 3. Non-goals

- Dynamic `/models` discovery for the Built-in Provider.
- Automatic Provider or Protocol fallback.
- Multiple endpoints or credentials inside one Built-in Provider.
- Per-model credentials.
- OAuth, cloud identity, signed requests, or credential rotation.
- Runtime capability probing.
- General-purpose Anthropic or OpenAI SDK parity, unused vendor endpoints, and speculative protocol abstractions.
- Automatic retry after removing Tools or Media.
- A general-purpose interpolation language for arbitrary configuration strings.
- Removal of Copilot Relay's existing `$env` / `$secret` compatibility.
- Relocation of existing non-LLM Runner, Memory, Prompt, Tool, Context, Compaction, or Subagent configuration contracts and defaults.

## 4. Readiness gates

- [x] ADR-016 is `Accepted`.
- [x] The Unified Built-in LLM Provider Specification is `Accepted`.
- [x] The project owner explicitly approves Delivery.
- [x] Model capability defaults and unknown-capability behavior are decided.
- [x] Output-token behavior is decided.
- [x] Empty-config startup and default-model behavior are decided.
- [x] Provider ABI compatibility is decided.
- [x] Error ABI compatibility is decided.
- [x] Base URL ownership is decided.
- [x] Attachment failure atomicity is decided.
- [x] Focused and final validation commands are approved.

## 5. Delivery items

| Item | Status | Scope | Exit condition |
|---|---|---|---|
| BLP-0 Contract acceptance | Completed | Review and accept Plan, ADR, and Specification | All readiness gates required for Delivery are checked |
| BLP-1 Core and configuration | Completed | Module-owned Built-in config/defaults, top-level composition, legacy field removal, API-key environment references, output-token contract removal, capability semantics, Catalog DTO | Config, resolution, invocation, and Catalog contract tests pass |
| BLP-2 Built-in Provider | Completed | Internal routing Port, three Protocol Clients, model registration, error normalization | Provider and Client contract tests pass |
| BLP-3 Runtime and Channel integration | Completed | Optional Unit composition, default selection/fallback, atomic attachments, HTML capability UX | Runtime, WebSocket, CLI, attachment, and integration tests pass |
| BLP-4 Cutover and authority transfer | Completed | Remove old Anthropic assembly, update current/stable docs, full validation and independent review | Final gates pass and owner accepts closeout |

Only one delivery item may be `In Progress` at a time. Advancing an item requires the preceding exit condition.

## 6. Compatibility and cutover

- The public Provider selection remains `{ providerId, modelId }`.
- `ProviderProjectionEntry` remains unchanged; Built-in multi-Protocol routing is private to its `ModelInvocationPort`.
- Model Catalog capability fields are additive and optional.
- Model Invocation Error V1 keeps its protocol, version, categories, and diagnostics envelope. `diagnostics.request.maxTokens` becomes optional.
- Copilot Relay keeps its existing Provider identity, endpoint behavior, and `$env` / `$secret` configuration compatibility.
- Legacy Agent-level `model` and `llm` configuration is rejected after cutover; no dual production configuration path remains.
- Existing public output-token request/configuration fields, including legacy `llm.maxTokens`, are removed rather than retained as aliases.
- No Feature Flag or permanent compatibility branch is introduced.

## 7. Validation strategy

### BLP-1 focused validation

- Agent configuration loader and bootstrap tests.
- Ownership/Fitness checks preventing Built-in code from importing Platform Configuration and preventing duplicate Built-in defaults in `platform/config/defaults.ts`.
- Contract consistency checks for established naming, shared domain types and discriminants, optionality, immutable projections, boundary-specific serialization, and error shapes.
- API-key environment-reference tests, including missing, empty, malformed, and non-credential strings.
- Credential-source tests proving Protocol Clients neither read ambient vendor credential variables nor synthesize authentication when `apiKey` is absent.
- Model Resolver tests for plain fact values and unknown versus explicit Tool/Media capabilities.
- Invocation/error contract tests proving output-token field removal and diagnostic compatibility.
- Catalog serialization tests for unknown versus explicit capabilities.

### BLP-2 focused validation

- Built-in Provider Catalog, routing, freezing, and unknown-model tests.
- Shared Client contract tests for text, system, history, Tools, Media, streaming, usage, stop reasons, Abort, malformed streams, and normalized errors.
- Protocol-specific request-shape tests, including authentication, required headers, one-attempt retry behavior, Anthropic's internal `4,096` fallback, and omitted OpenAI output limits.

### BLP-3 focused validation

- Optional Built-in composition and empty-config startup.
- Available, unset, and unavailable default-model states plus Server fallback.
- Atomic single- and multi-attachment failures with proof that no Provider call occurs.
- HTML attachment enablement for known, unknown, and unsupported image capability.
- Runtime reload and generation consistency.

### Final gate

- `npm test`
- `npm run test:integration`
- `npm run test:fitness`
- `npm run lint`
- `npm run build`
- `npm run verify:websocket-host`
- Independent code review of the complete diff

## 8. Stop conditions

Pause Delivery and return to design review if implementation requires:

- changing the public Provider ABI instead of using the internal routing Port;
- a second production LLM configuration path;
- an LLM-only configuration ownership or composition mechanism that cannot serve as the project-wide module pattern;
- a duplicate or differently named representation of an existing project domain type, identifier, status, reason, error category, or wire value;
- generic interpolation of non-credential configuration;
- dynamic capability probing or automatic model discovery;
- silent Tool/Media removal or automatic semantic retry;
- an incompatible Model Invocation Error version;
- Provider-specific behavior in AgentRunner.

## 9. Completion

After validation and owner acceptance:

1. update Current Architecture and stable Specifications with implemented facts;
2. add a validation record;
3. mark Plan items completed;
4. archive this Change;
5. retain the research draft only as non-authoritative design history.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
