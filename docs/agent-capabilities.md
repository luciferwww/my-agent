# my-agent Capability Summary

> Status: Dated Capability Summary — Non-authoritative
> Updated: 2026-09-09
> Authority: [Current Architecture](architecture/current/overview.md) owns current boundaries and flows; source/tests prove implementation behavior.

This page summarizes reader-facing capabilities. It deliberately avoids duplicating complete contracts, configuration schemas, event unions, or algorithms. Follow each section's Current Architecture link for authoritative details.

## 1. Runtime and Agent execution

- Runtime Builder assembles immutable generations and publishes complete replacements atomically.
- Root Turns capture one generation; Child Turns inherit their Parent generation.
- Messages are serialized per session, while different sessions can execute independently.
- In-turn text can enter the steering inbox and is consumed at Runner-defined injection points.
- User Abort and bounded Shutdown propagate through Runner, Provider invocation, Tools, and tracked Subagents.
- Runner executes the canonical model/Tool loop, closes every accepted Tool Use with one result, and emits correlated lifecycle events.

Current authority: [Runtime](architecture/current/runtime.md), [Runner](architecture/current/core_runner.md)

## 2. Model and Provider boundary

- Each root or Child Turn resolves a canonical Provider/model binding from its captured Provider projection.
- Resolution validates identity, connection, fact provenance, output limits, Tool support, and requested media capabilities.
- Runner consumes a Provider-neutral invocation port and frozen `ResolvedModel`; it does not select Providers or import SDK wire types.
- The included production adapter supports Anthropic streaming, canonical Tool conversion, normalized errors, and configurable endpoint deployment.

Current authority: [Model Resolution](architecture/current/core_model_resolution.md), [Model Invocation and Provider Adapter](architecture/current/adapter_llm.md)

## 3. Tools and approval

Builtin capabilities include:

- workspace-scoped file listing, reading, writing, editing, and patching;
- glob file search and regular-expression content search;
- HTTP(S) page fetch;
- foreground, yielded, and background command execution;
- background process listing, output inspection, status, and termination;
- Memory search/get/write when the optional Memory module is available;
- blocking `task` delegation when Subagents are enabled.

Tool definitions use one canonical schema and are validated before execution. Application deny/allow policy and an explicit current-call approval capability fail closed when user interaction is unavailable. Generation-bound Tool Hooks can intercept or observe calls without becoming mutable authorization state.

Current authority: [Tools](architecture/current/core_tools.md), [Builtin Tools](architecture/current/core_tools_builtin.md)

## 4. Prompt and workspace context

- System prompts support full, minimal, and none modes.
- Prompt composition can include identity, time, behavior/safety rules, project context, workspace information, Memory guidance, and available Subagents when applicable.
- Context Hooks prepend dynamic user context in deterministic registration order.
- Workspace initialization manages `.agent/` context resources; explicit-directory loading and runtime workspace loading have distinct contracts.
- Context files are bounded and may be truncated; Runtime owns caching and reload timing.

Current authority: [Prompt](architecture/current/core_prompt.md), [Workspace](architecture/current/core_workspace.md)

## 5. Session, context budgeting, and Memory

- Sessions persist append-only JSONL transcripts with tree-shaped parent links and an active leaf.
- Runner repairs supported incomplete history states and keeps Tool Use/Result protocol closure.
- Context management prunes Tool Results, applies aggregate budgeting, and can compact history into a persisted summary before retry.
- The optional Memory module indexes Markdown chunks and combines vector and keyword retrieval when embeddings are available.
- Embedding failure can degrade search to keyword-only; Memory startup failure does not prevent the core Runtime from starting.

Current authority: [Session](architecture/current/core_session.md), [Runner](architecture/current/core_runner.md), [Memory](architecture/current/core_memory.md)

## 6. Subagents

- An active Parent Turn can delegate through the blocking `task` Tool.
- Builtin `general-purpose` and configured profiles can choose inherited or explicit Provider/model references.
- Child execution has an isolated session and prompt, its own LLM-call budget, inherited generation/Abort/route context, and tracked lifecycle events.
- Profile Tool allow/deny policy is applied to the Child Tool projection.
- Child completion returns a final Tool Result to the Parent and releases tracked Child state.

Current authority: [Runtime](architecture/current/runtime.md), [Model Resolution](architecture/current/core_model_resolution.md)

## 7. Channels, interactions, and multi-client delivery

- Included Channel modules provide interactive CLI and WebSocket transports; Runtime can also be driven programmatically.
- WebSocket supports multiple clients and sessions, same-session event delivery, origin-routed interactions, and client replacement on reconnect.
- `user_message` is broadcast after input assembly and before queued/steering routing; queued `run_start` correlates through `originMessageId`.
- Tool approval is routed only to the originating interaction transport and has classified denied, unavailable, failed, and aborted outcomes.
- CLI and WebSocket can request active-Turn Abort; queued requests dropped before start close through request-scoped events.

Current authority: [Channel](architecture/current/adapter_channel.md), [Runtime](architecture/current/runtime.md)

## 8. Image media

- Inbound messages can contain ordered text and image blocks.
- The Core Media pipeline validates supported MIME declarations against bytes, enforces item/count/aggregate limits, reads dimensions, and optimizes large images.
- One rejected image does not fail the whole message; structured drop reasons remain available to Runtime.
- Channel broadcasts contain attachment summaries rather than raw base64.
- Model Resolution verifies image capability before Runner invocation.

Current authority: [Media](architecture/current/core_media.md), [Channel](architecture/current/adapter_channel.md)

## 9. Configuration, logging, reload, and shutdown

- Configuration resolves hardcoded defaults, workspace file values, per-agent values, environment overrides, and caller overrides in defined precedence order.
- The Config Wizard updates governed configuration branches while preserving unrelated top-level content.
- Named logging supports level filtering, console/file adapters, startup buffering, and bounded adapter close.
- Reload builds and validates a complete candidate generation before publication; in-flight Turn trees remain pinned to their captured generation.
- Shutdown rejects new work, bounds active work/resource close, and reports residual failures.

Current authority: [Configuration](architecture/current/platform_config.md), [Observability](architecture/current/platform_logger.md), [Runtime](architecture/current/runtime.md)

## 10. Current limitations

The repository does not currently claim:

- HTTP/REST/SSE or external-platform Channels;
- Channel authentication, multitenancy, or fine-grained session authorization;
- WebSocket replay buffers or disconnected-event replay;
- automatic Provider/model fallback after resolution or invocation failure;
- hard steering that interrupts an in-flight model or Tool call;
- detached/background or same-round concurrent Subagents;
- PDF/document/CLI attachment input or a cross-Turn attachment library;
- a globally enforced queue capacity, request expiry, or cross-session concurrency ceiling;
- a stable package-root import contract for external library consumers.

Future proposals and Plans are not current capabilities until delivered and reflected in Current Architecture.
