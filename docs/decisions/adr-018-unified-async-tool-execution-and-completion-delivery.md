# ADR-018: Unified Async Tool Execution Framework

> Status: Accepted
> Decision date: 2026-09-30
> Amendment accepted: 2026-10-01
> Delivery accepted: 2026-10-02
> Owner: Project owner
> Related Plan/Specification: [Async Tool Use Plan](../changes/archive/async-tool-use/plan.md), [Async Tool Use Specification](../changes/archive/async-tool-use/specification.md)
> Supersedes: [ADR-017](adr-017-session-message-queue-and-steering-claim.md) decisions 7 and 16 only while a Turn owns accepted async executions; its one-FIFO and atomic-claim decisions remain

## Context

Runner currently implements Tool invocation as an inline direct-await loop: it persists an Assistant Tool Call, directly awaits the complete Tool implementation, persists one terminal Tool Result batch, and only then checks steering. A long or nonresponsive Tool therefore prevents the active Turn from consuming later user input.

The architectural problem is not that some special Tools need a background option. The existing direct-await invocation framework must be replaced for every newly admitted Tool by one Host-owned async execution framework. Tool implementations may continue returning final Promises; Runner must stop owning those Promises through inline `await`.

Leaving the Provider Tool Call unpaired while inserting steering is not portable. The approved Spike found that Copilot Relay gpt-5.4 rejected this history with HTTP 400 for both Chat Completions and Responses. Hiding the pending group in a separate control projection worked, but creates a second history projection and difficult merge/recovery semantics.

A second shape was tested successfully on Chat Completions, Responses, and a Messages-compatible endpoint:

1. the original Tool Call receives one `accepted + executionId` result;
2. the Host retains the real execution;
3. steering uses the normally closed conversation;
4. execution completion is injected as a trusted ordinary context notification;
5. the Host automatically continues the Model.

Gemini CLI independently implements the same durable separation for background execution: the original Tool Call closes with a PID/background result, while later completion enters a `background_completion` injection and can trigger the parent Model.

## Decision drivers

- Replace the existing Runner direct-await Tool invocation framework.
- One Provider-neutral execution lifecycle for all Tools.
- Steering must be processable while an accepted execution remains active.
- No Provider-specific control flow in Runner.
- No second terminal result for an already closed Provider call ID.
- Final execution outcome must reach the Model without mandatory polling or collect calls.
- One execution owner must arbitrate completion, cancellation, deadlines, persistence, delivery, and Turn settlement.
- Existing one-FIFO steering ownership and Provider adapter boundaries should remain.

## Options considered

1. Keep the original Tool Call pending and use a separate control projection. This preserves one call-to-final-result semantic but adds control-history merge, recovery, and compaction complexity.
2. Close the original call with `accepted`, then require the Model to call `wait` or `collect`. This uses ordinary Tool pairing but makes result delivery depend on polling and can move the same blocking problem into `wait`.
3. Close the original call with `accepted`, retain execution in a Turn coordinator, and inject a trusted Host completion notification before automatically continuing the Model.
4. Directly append steering after an unpaired Tool Call. This is provider-dependent and was rejected by both tested Relay OpenAI protocols.

## Decision

Adopt option 3 as the Provider projection of a unified async execution framework, and replace the current direct-await invocation path.

1. Every newly admitted Tool uses one Provider-neutral, per-Turn async execution framework. There is no Tool opt-in, background-only variant, or retained synchronous invocation path.
2. Runner submits admitted calls to the framework and enters a serialized Turn event loop. It no longer directly awaits Tool implementation Promises.
3. The framework owns execution registry, scheduling, Promise settlement, execution controllers, activity clocks, cancel/deadline races, terminal arbitration, completion delivery, and Turn settlement.
4. Provider adapters do not own or observe execution state.
5. Decode, Tool resolution, interceptors, validation, policy, and approval remain admission. Calls rejected during admission receive their existing immediate correlated terminal result and no execution ID.
6. Successful admission creates a unique execution ID and establishes Host ownership before persisting an `accepted` receipt for the original call ID.
7. The accepted receipt closes the Provider Tool Call. It is a distinct execution record projected to Provider wire, not a terminal `ToolResultBlock`, execution success, or one of the terminal execution outcomes.
8. Tool implementations may remain Promise-based. The framework owns their Promises and independently waits for execution settlement, ready steering, Abort, activity/deadline expiry, and shutdown.
9. User steering does not cancel an execution by default. A Model-selected cancel action targets the execution scope; Root Abort still cascades.
10. A real terminal outcome is `success`, `failed`, or `aborted`. Unknown crash/recovery state remains internally distinguishable and must not claim confirmed cancellation or side-effect rollback.
11. Terminal facts are persisted before result delivery. The original call ID never receives a second Tool Result.
12. Undelivered terminal facts become trusted `HostTaskCompletion` context records. Ready completions may piggyback on an otherwise-permitted steering call; otherwise the Host automatically invokes the Model once after the Turn execution registry is empty, batching every outstanding completion. No collect call is required.
13. Host completion records are structurally distinguished from user input. Provider adapters may encode them as ordinary user-role wire messages, but no user-authored text can acquire trusted Host origin.
14. Chat Completions, Responses, Messages, and future protocols share the same Core events and canonical history. Wire grouping and role/content encoding remain adapter/projection responsibilities.
15. Runtime continues to own the per-Session FIFO. It adds a wake signal for potentially compatible steering; atomic claim remains the ownership transition.
16. An empty transient steering check does not close a Turn while accepted executions or undelivered completions remain. The final empty claim regains ADR-017 terminal meaning only after framework settlement.
17. Model invocations for steering and completion delivery are serialized. Events arriving during an invocation are persisted/queued and delivered at a later permitted steering call or the final batched completion call, never through concurrent Parent Model calls.
18. A normal Turn ends only when no accepted execution, cancellation convergence, terminal persistence, Host completion delivery, or eligible steering claim remains. Root Abort persists a structural abort fact, starts no later Model call, and leaves trailing Host completions for the next non-aborted user Turn.
19. The cutover is atomic. There is no production sync Tool path, no per-Provider Runner branch, and no feature-flagged dual lifecycle.
20. If an in-process Tool ignores Abort beyond cancellation grace while the event loop remains responsive, Framework persists `outcome_unknown`, moves the existing execution entry with its Promise, slot and generation pin to Runtime quarantine, disables that Tool registration for new admission, and lets the Turn converge without claiming implementation termination.
21. Quarantine absorbs late settlement and forbids further state mutation or delivery. Direct Node/native/remote side effects and synchronous event-loop blocking remain outside the termination guarantee.
22. Supervision and lifecycle are represented structurally: exclusive Turn/quarantine registry membership identifies the supervisor, absence of an implementation handle means `Tool.execute` was not invoked, Promise callbacks create terminal candidates, and persisted terminal/Host/Assistant records express outcome and delivery. No duplicate ownership, settlement or delivery enum is maintained.
23. The 1–N Tool Uses emitted by one LLM call are concurrent by definition, but Framework creates no separate group lifecycle record. Each call is independently admitted, supervised and terminalized. Terminal facts update UI/History independently; the automatic completion-only Model call waits for all active Turn executions and batches outstanding completions. A dependent call must wait for prerequisite HostTaskCompletion and a later LLM call.
24. One execution's failure, cancellation or quarantine does not cancel another Tool Use from the same LLM call. Root Abort remains Turn-wide; an explicit Model cancel targets one execution.
25. Public UI creates a pre-admission requested card before approval. `approval_requested` correlates by `callId`; only successful admission emits accepted `tool_use` with `executionId`.
26. Quarantine reuses the existing execution entry and resources. Framework wins terminal arbitration and persists the unknown outcome, then synchronously moves the entry from the Turn registry to the Runtime quarantine registry without an extra entry, slot, pin, lease or handoff-status field. Persistence or registry-invariant failure leaves the Turn entry active and fails closed.
27. An accepted execution not invoked because Root Abort/startup interruption wins derives public/Host `aborted` from its sealed execution outcome; its Hook-only canonical `not_executed` observation cannot remap public status to error.
28. Disabled Tool-registration state is process-local, is never restored from Session, and is cleared only by Host process restart in this Change.
29. The System Prompt defines same-call Tool Uses as independent concurrent work and requires dependencies to be emitted only after HostTaskCompletion. Prompt guidance expresses Model intent; per-execution supervision enforces concurrency without a group entity.
30. Concurrency means invoking each accepted Tool without awaiting previously invoked Tool Promises; it does not claim worker-thread parallelism.
31. `task` remains a one-Child Tool. Multiple Subagents run concurrently only by emitting multiple same-response `task` calls through the common Framework; no Subagent batch input, internal `Promise.all`, aggregate result, or second scheduler is introduced.
32. Runtime owns eight process-global Tool execution slots as a non-configurable first-delivery constant rendered into the System Prompt. Each call independently reserves one slot when otherwise admissible or receives immediate unavailable; there is no capacity queue or hidden serialization.
33. Running, cancelling and quarantined implementations occupy slots. Normal Promise settlement releases after its callback captures the terminal candidate; persistence and delivery do not consume execution capacity. Quarantine retains the existing slot until real settlement or Host process exit.
34. First delivery uses non-configurable Host constants: five-minute idle, one-hour total execution, and ten-second cancellation grace. Activity refreshes only idle. Tool definitions expose no timeout hint.
35. Framework admission is per call: Runner creates and owns one admission state per Tool Call and calls `submit(call, context)` as each becomes admissible. Same-Turn `before_tool_call` chains serialize in Provider order; after that stage, validation/policy/approval may progress independently. The original Assistant response is a Runner-owned Provider pairing barrier that projects accepted/immediate results in call order; there is no array-form submit API.
36. Finite `maxLlmCalls` acquires one shared future-call reserve as soon as a Model response contains Tool Calls. Pending admission, incomplete Provider pairing and all active executions retain that reserve. Steering cannot consume it; the final completion-only call waits for admissions/pairing to close and the Turn registry to empty. A last-allowed Model response cannot start Hooks, approval or Tool execution.
37. Root Abort persists `turn_aborted`, prevents all later Model invocations in that Turn, appends terminal Host completions after execution convergence, and leaves them for the next non-aborted user Turn. Recovery never mistakes this for failed completion consumption.
38. Foreground `exec` remains Framework-owned through process exit. `background: true` hands off after spawn/registration; `yieldMs` hands off only when its threshold wins while the process is still running. After handoff ProcessRegistry owns the process, Framework releases its slot, later process exit produces no second Host completion, and normal Host shutdown performs bounded cleanup.
39. Activity comes only from observable implementation progress: foreground exec output, Child lifecycle, MCP progress, or explicit Extension reports. Framework creates no synthetic heartbeat.
40. Framework `hasUnsettledWork()` reports execution-owned work only. Runner combines it with pending admissions, pairing barriers, claimed steering and active Model calls in `hasTurnOwnedWork()`, and its event loop waits for admission completion. Root Abort must close each unresolved call as `not_executed`.
41. ProcessRegistry is bounded by fixed first-delivery constants: eight starting/running managed processes, the newest 1 MiB of combined output per process with explicit truncation metadata, and 32 retained terminal records. Active records are never evicted.
42. Managed process records are Session-owned. Process operations require matching Session identity; fork inherits none, Session deletion and Host shutdown terminate owned processes, normal Turn completion and post-handoff Turn Abort do not, and restart restores none.
43. Within one Turn, before-hook chains for different calls cannot overlap. This preserves interceptor ordering/reentrancy while allowing an earlier call to await approval without blocking later post-Hook admission.
44. If the last allowed Model call emits Tool Calls, Runner persists the Assistant record with structural `turnStopReason: 'max_llm_calls'`, starts no Hook/approval/execution and appends one paired unavailable result per call. Recovery repairs a missing result batch but never auto-invokes the Model or duplicates results; the next user Turn projects the paired exchange in protocol-valid Chat, Responses or Messages form.

## Consequences

### Positive

- Tool execution no longer blocks intake and ownership of steering.
- Runner has one invocation framework instead of inline execution plus special async exceptions.
- Provider pairing remains legal without a separate pending-call control history.
- Final results reach the Model automatically in a bounded batch without mandatory polling.
- Execution state, Provider messages, UI cards, and Turn terminal state have explicit owners.
- Provider differences stay in projection/encoding rather than `runAttempt`.
- The design matches a verified external background-execution pattern.
- Noncooperative asynchronous Tools have an explicit bounded-wait policy without falsifying termination.
- Models can express parallel and dependent work using existing Assistant response boundaries without a Provider-specific dependency schema.
- Eight global slots prevent steering or multiple Sessions from creating unbounded Tool Promises without reintroducing a wait queue.

### Negative

- Every Tool invocation moves to a new scheduler/event-loop architecture.
- The original Provider Tool Result changes meaning from final execution result to accepted submission receipt.
- Session must persist execution identity, terminal facts, and trusted completion records.
- History/UI must combine an accepted receipt and later completion into one user-facing task lifecycle without rewriting what the Model saw.
- Runtime needs a wakeable steering source rather than claim-only polling.
- Compaction, recovery, shared Model-call budget, batched async completion, managed process handoff, and nonconvergent Tools need new rules.
- Quarantined Promises, slots and generation pins may remain until real settlement or Host restart, and direct in-process side effects cannot be revoked.
- The Model must plan same-call independence correctly; Framework cannot infer hidden data or side-effect conflicts, and synchronous Tool prefixes can still block the event loop.
- Capacity rejection may require a later Model retry and quarantined executions can permanently reduce available slots until settlement or restart.
- Managed process capacity can reject background/yield work; bounded output and terminal eviction mean old process logs/records may be truncated or unavailable.
- Fixed timeout constants require a future accepted Change if deployment-specific tuning becomes necessary.
- Existing Tool Result status work must distinguish accepted acknowledgement from terminal presentation status.

## Validation

The Provisional Spike evidence must retain:

- Chat Completions, Responses, and Messages live request evidence for accepted, steering, completion notification, and automatic continuation.
- direct-unpaired negative evidence for the two tested Relay OpenAI protocols;
- cancellation/completion race and noncooperative Promise tests;
- actual Provider encoder/request-body contract tests;
- persistence reload, delivery de-duplication, recovery, compaction, and Turn-terminal tests before Delivery can be validated.
- single-call incremental admission, Runner composite terminal gate, shared completion reserve, Root-Abort/max-budget non-consumption, next-Turn Provider projection, concrete activity sources, and exec foreground/background/yield ownership tests.

Live compatibility evidence is bounded to the tested services/models and does not prove official Anthropic or OpenAI direct behavior.

## Migration and rollback

Delivery migrates Tool execution, terminal status persistence, History/UI and inline Approval in one clean-format cutover. Legacy Tool Result blocks lacking the required terminal status are rejected rather than defaulted, inferred, or routed through a legacy runtime path.

Rollback before release removes the new coordinator and record types together. After new-format execution records are released, rollback requires an explicit reader/operational plan and cannot silently reinterpret accepted receipts as successful final results.

## Follow-up

- Deliver four-state terminal Tool Result and inline Approval as slices of the related Framework Change; `accepted` remains an execution acknowledgement rather than a fifth terminal status.
- Await explicit Plan/Delivery authorization before modifying production code.
- On implementation, update Runner, Session, Tools, Abort, and History authorities; do not update Current Architecture before behavior exists.

Process authority: [Development Workflow](../governance/development-workflow.md).
