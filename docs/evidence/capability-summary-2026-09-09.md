# Capability Summary — 2026-09-09

> Status: Dated evidence — non-authoritative
> Snapshot date: 2026-09-09
> Current authority: [Current Architecture](../architecture/README.md)

This bounded reader summary records capabilities observed at the snapshot date. It is not maintained as a second current architecture.

- Runtime publishes immutable generations; root Turns capture one and Children inherit it. Sessions serialize locally while different sessions may run independently.
- Runner performs Provider-neutral Model/Tool loops, steering, context budgeting/Compaction, Tool closure, and correlated events.
- Model Resolution creates frozen Provider/model bindings with connection, fact, policy, output, Tool, and media validation; no automatic fallback is claimed.
- Builtin Tools cover workspace files/search, web fetch, foreground/background process control, optional Memory, and blocking Subagent delegation.
- Approval is current-call and origin-bound, with classified denial, unavailability, failure, and Abort outcomes.
- Prompt and Workspace compose bounded project/context resources; Session persists append-only tree-shaped JSONL history.
- Optional Memory supports hybrid retrieval and may degrade to keyword-only or fail without blocking core Runtime startup.
- Subagents run as blocking isolated Children with inherited generation/Abort/route context and independent Model binding.
- CLI and WebSocket provide included Channel transports, multi-client events, model Catalog selection, approvals, and Abort.
- Media accepts bounded text/image blocks, verifies and optimizes images, and prevents raw base64 Fanout.
- Configuration has defined defaults/file/agent/environment/caller precedence; Wizard preserves unrelated top-level content.
- Reload validates a full candidate before atomic publication; Shutdown is bounded and reports residuals.

Observed limitations included no REST/external-platform Channels, Channel authentication/multitenancy, disconnected replay, automatic model fallback, hard steering interruption, detached/concurrent Subagents, document attachments, global queue cap/expiry, or stable package-root API contract.

Follow the current topic indexes for all present-day facts; later delivery may supersede this snapshot.
