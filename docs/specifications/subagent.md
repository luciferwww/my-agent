# Subagent Specification

> Status: Stable Authority
> Contract status: Implemented and Validated where not superseded
> Verified: 2026-09-14
> Authority: Stable base Subagent contract

## Scope

The `task` Tool delegates one same-process, blocking Child subtask. This specification owns base profile/context behavior, depth capability, isolated Session/prompt assembly, blocking execution, Parent-facing Tool output, and best-effort terminal cleanup.

Model selection, Parent validation, independent Child resolution, identity, route/generation inheritance, and terminal failure categories belong to [Subagent Model Resolution](subagent-model-resolution.md). Parallel, batch, background, detached, handoff, and team behavior are excluded and remain deferred.

## Profile and capability

```ts
interface SubagentProfile {
  id: string;
  description: string;
  agentDir: string;
  model: 'inherit' | ModelReference;
  tools?: { allow?: string[]; deny?: string[] };
  maxLlmCalls?: number;
}
```

Child profile identity and role come from configuration plus context files. Each Child context file replaces the corresponding Parent file; missing Child files fall back to Parent. A missing Child directory behaves as an anonymous/general-purpose Child using Parent context.

Unknown LLM-supplied profile names fall back to `general-purpose` with a warning. Invalid configured profiles fail configuration/startup validation.

Depth is encoded in the Child Session key and derives role/capability. Default policy prevents recursive `task` use beyond the allowed depth.

## Execution contract

```text
Parent task Tool
  -> profile lookup/fallback
  -> depth check
  -> Runtime delegation
  -> isolated Child Session and prompt setup
  -> blocking Child execution
  -> normalized Tool Result
  -> terminal cleanup
```

The Child does not inherit Parent conversation history. Child execution is blocking and Tool Calls in one Runner response remain sequential. Different root sessions may execute independently under Runtime admission.

Terminal outcomes are `ok`, `error`, `aborted`, and `max_llm_calls`. Parent-facing Tool content carries Child text or a normalized failure, not internal IDs or raw Usage. `max_llm_calls` may include partial text. Parent Abort reaches Child through the delegation signal.

Cleanup after terminalization is best-effort and does not change the selected terminal outcome. Child events use the common Agent-event/Fanout plane with explicit correlation.

## Tool policy

An explicit Child allow list replaces the Parent allow list; Child deny adds to Parent deny. Depth capability can remove `task` regardless of profile policy. All Tool execution still follows [Tools and Hooks](tools-and-hooks.md).

## Acceptance scenarios

Cover general-purpose and named profiles; partial Child context with Parent fallback; missing Child directory; unknown profile fallback; invalid profile; depth limit; blocking return; isolated Session; best-effort cleanup; Parent Abort; normalized Child failures; distinct event correlation; sequential execution; and no detached work.

## Ownership and evidence

Current behavior is described by [Runtime](../architecture/runtime.md) and [Runner](../architecture/runner.md). Evidence: [Subagent core](../../src/core/subagent), [Runtime orchestration](../../src/runtime/subagent-orchestration.ts), [Task Tool](../../src/core/tools/builtin/task/task-tool.ts), and related unit/integration tests.
