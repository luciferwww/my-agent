# Subagent Specification

> Status: Stable Authority
> Contract status: Implemented and Validated
> Verified: 2026-11-04 (ancestor retention, recursive Parents and event routing)
> Authority: Stable base Subagent contract

## Scope

The `task` Tool delegates one same-process, blocking Child subtask. This specification owns base profile/context behavior, depth capability, isolated Session/prompt assembly, blocking execution, Parent-facing Tool output, and best-effort terminal cleanup.

Model selection, Parent validation, independent Child resolution, identity, route/generation inheritance, and terminal failure categories belong to [Subagent Model Resolution](subagent-model-resolution.md). Sibling Tool-call concurrency belongs to [Tools and Hooks](tools-and-hooks.md). Batch, background, detached, handoff, and team behavior are excluded and remain deferred.

## Profile and capability

```ts
interface SubagentProfile {
  id: string;
  description: string;
  agentDir: string;
  model: 'inherit' | ModelReference;
  tools?: { allow?: string[]; deny?: string[] };
}
```

Configured Child profile identity and role come from `agents.list[]`; Runtime
projects the supported configured-Agent fields into the internal
`SubagentProfile`. An omitted public `model` becomes internal `"inherit"`.
Configured Agent Context belongs under `<agentHome>/agents/<agentId>/`. Each
Child context file replaces the corresponding Parent file; missing Child files
fall back to Parent. A missing Child directory behaves as an
anonymous/general-purpose Child using Parent context.

Unknown LLM-supplied profile names fall back to `general-purpose` with a warning. Invalid configured profiles fail configuration/startup validation.

Depth and capability derive from explicit Parent/Child execution context rather than Session identity. `agents.maxSubagentDepth` is global, while effective `task` Tool policy controls whether an individual Agent can delegate. Every Child Turn independently applies global `agents.maxLlmCallsPerTurn`; profiles cannot override Runner policy and do not inherit Parent remaining capacity. Each accepted Child receives a fresh canonical `sessionId` and a root-only transient Transcript with caller provenance. It has no Session Store entry, never appears in get/list, and is removed at terminal cleanup or subsequent startup recovery. Runtime removes `task` beyond the allowed depth.

## Execution contract

```text
Parent task Tool
  -> profile lookup/fallback
  -> depth check
  -> Runtime delegation
  -> isolated transient Child Transcript and prompt setup
  -> blocking Child execution
  -> normalized Tool Result
  -> terminal cleanup
```

The Child does not inherit Parent conversation history. Each `task` execution blocks only its own Tool Call. Independent sibling `task` calls in one Runner response execute concurrently under the process-wide Async Tool Execution Framework; the Parent's next Model call still waits for every accepted sibling to terminalize or be isolated. Each sibling has an independent execution signal, Child identity, route, tree membership, terminal events, and cleanup.

All Agent kinds share Runner's initial-input identity contract: preserve an
incoming `originMessageId`, or assign one before `run_start` when absent, and
persist that ID as the input's `messageId` across compaction retries. Child
execution does not require a separate identity generator. Internal retry may
append a new source entry, but identical input copies in each ancestor are
retained once per source Session, Turn and messageId. Abort or source-tail
cleanup does not retract the submitted input from ancestor display history.

Terminal outcomes are `ok`, `error`, `aborted`, and `max_llm_calls`. Parent-facing Tool content carries Child text or a normalized failure, not internal IDs or raw Usage. `max_llm_calls` may include partial text. Parent Abort reaches every Child through its Framework-derived execution signal, while execution-local cancellation affects only the corresponding Child.

Cleanup after terminalization is best-effort and does not change the selected terminal outcome. Child events use the common Agent-event/Fanout plane with explicit correlation.

Each descendant's committed presentation facts are also retained in every
ancestor Transcript, without entering ancestor model Context or extending
Child lifetime. Runtime captures the delegating Assistant anchor, awaits start
retention before the visible start event, and registers the resolved Child as
an active Parent for recursive delegation. Recursive Parents preserve the
captured registry/approval authority and effective Child model, use their
merged context files, and register descendants with the existing root-tree
supervisor.

End retention completes before the terminal event and tree release.
Presentation persistence is not best-effort Fanout or cleanup: start/end
write failures reject delegation explicitly, with acquired resources and tree
membership still released. Safe message/Tool facts already written in
ancestors remain readable after Child cleanup.

The existing presentation route also captures immutable ancestor Session IDs
and the owning Root Turn ID before start becomes visible. Runtime uses that
Root's pinned Channel generation for lifecycle and native Child events,
including recursive descendants. The route and tree membership remain until
terminal persistence and terminal Fanout delivery settle; transport failures
remain isolated from execution. The bundled client renders these events and
retained History recursively in fixed Parent Tool Call slots, including text,
Thinking, nested Tools and existing Approval actions. It no longer opens an
independently subscribed Child viewer. Root subscription and ancestor History
are sufficient; read-only Child APIs, lifecycle and TTL ownership are unchanged.
LLM-call Tool groups are independent per source Session, including nested
Children. Actual realtime call boundaries and marked Assistant History entries
define groups, not round equality; groups default to expanded and completion
does not collapse them. Overall Change closeout remains pending.

## Tool policy

An explicit Child allow list replaces the Parent allow list; Child deny adds to Parent deny. Depth capability can remove `task` regardless of profile policy. All Tool execution still follows [Tools and Hooks](tools-and-hooks.md).

## Acceptance scenarios

Cover general-purpose and named profiles; partial Child context with Parent fallback; missing Child directory; unknown profile fallback; invalid profile; depth limit; blocking return; concurrent sibling execution; isolated Sessions; independent cancellation and cleanup; Parent Abort; normalized Child failures; distinct event correlation; and no detached work.

## Related authority

Current implementation boundaries are described by [Runtime](../architecture/runtime.md) and [Runner](../architecture/runner.md). [Subagent Model Resolution](subagent-model-resolution.md) owns Child resolution and terminalization.
