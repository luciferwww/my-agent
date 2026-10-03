# Unified Async Tool Execution Framework Specification

> Status: Implemented, Validated, Accepted, and Archived
> Date: 2026-09-30
> Owner: Project owner
> Related Plan/Decision: [Plan](plan.md), [ADR-018](../../../decisions/adr-018-unified-async-tool-execution-and-completion-delivery.md)
> Evidence: [Spike Results](spike-results.md)
> Authorization: 项目所有者于 2026-10-01 根据最终复审重新接受本 Specification，并批准进入 Delivery
> Delivery: ATU-1 至 ATU-6 已完成并通过最终门禁；项目所有者于 2026-10-02 确认验收并归档

## 1. Purpose and observable outcome

本 Change 用一个统一的 Async Tool Execution Framework 替换 Runner 当前 inline `await executeCanonicalToolCall()` 的调用框架。所有新接纳的 Tool 均通过 Framework 执行；不存在 sync/async Tool 分类、Tool opt-in、后台特例或旧 direct-await fallback。

当一个 Tool 长时间运行时，当前 Turn 仍能处理和回复 steering。普通提醒或进度询问不取消执行；明确转向可请求取消当前 execution。Tool 真实结束后，Host 自动把 `success | failed | aborted` 终态交给 Model 并继续，不要求用户再发消息或 Model 轮询。

用户看到同一个 Tool task 从 accepted/running 更新到终态。History reload 保持同一生命周期和期间对话顺序；accepted 不被改写成早已成功。

## 2. Scope

- complete replacement of Runner's direct-await Tool invocation path;
- all-Tool unified async execution path after admission;
- per-Turn coordinator, execution IDs, activity, cancel/deadline and terminal arbitration;
- staged per-call admission with ordered before-hook chains and a response-local Provider pairing barrier;
- wakeable steering with existing Runtime FIFO claim ownership;
- accepted receipt and trusted Host completion persistence/projection;
- one shared Model-call reserve, batched automatic continuation and Root-Abort non-consumption;
- foreground/background/yield exec integration with ProcessRegistry handoff and shutdown cleanup;
- Provider adapters, recovery, compaction, public events and task-card History presentation.
- four-state terminal Tool Result persistence/presentation and inline Approval controls.

## 3. Non-goals

- unowned detached work, durable external job resumption, or automatic side-effect replay; explicit `exec(background=true)` is a process-local managed resource owned by ProcessRegistry, while Runtime quarantine is allowed only as nonconvergence failure containment;
- mandatory collect/wait Tool calls;
- dependency-DAG scheduling, implicit resource-conflict inference, or unbounded cross-call parallelism;
- dependency inference between Tool Calls in one Assistant response;
- hard-kill guarantees for in-process JavaScript, remote services, or MCP implementations;
- progress percentage/content inference from activity timestamps;
- Provider-specific Runner paths or a legacy synchronous execution fallback;
- changing Tool output into trusted instructions.

## 4. Boundaries and dependency direction

Core dependency direction is:

```text
Runtime FIFO wake/claim
        ↓
Runner → AsyncToolExecutionFramework → Tool projection / Tool implementation
  ↓                ↓
Session        execution facts
  ↓
Model Invocation canonical history
  ↓
Provider adapter wire encoding
```

Runtime wakes and atomically transfers steering but does not execute Tools. The Framework owns execution resources but does not encode Provider requests. Session persists structural facts without interpreting Tool text. Provider adapters cannot import Runner/Framework or mutate lifecycle state. Channels consume public structural events/History and cannot infer state from content strings.

### 4.1 Framework replacement invariant

Production has exactly one post-admission Tool invocation path:

```ts
interface AsyncToolExecutionFramework {
  submit(
    call: AdmittedToolCall,
    context: TurnExecutionContext,
  ): Promise<ExecutionAcceptedReceipt>;

  waitForNextEvent(signal: AbortSignal): Promise<TurnExecutionEvent>;
  cancel(executionId: string, reason: ExecutionCancelReason): Promise<void>;
  hasUnsettledWork(): boolean;
}
```

The exact implementation names may follow repository conventions, but the boundary is mandatory:

- `submit` establishes ownership for one admitted call and returns its accepted receipt; it does not wait for terminal Tool output;
- Tool implementation Promises are created and held by the Framework;
- `hasUnsettledWork()` reports Framework-owned execution work only: accepted/running/cancelling implementations, terminal persistence/delivery and quarantine transfer;
- Runner waits on Framework, steering, and Abort events, never directly on an implementation Promise;
- no Tool definition selects a synchronous path;
- no existing builtin, MCP Tool, extension Tool, or `task` Tool bypasses the Framework after admission.

Runner creates one admission state per Tool Call after emitting `tool_call_requested` events in Provider order. Within the Turn, complete `before_tool_call` Hook chains enter one FIFO and run in Provider call order; Hook handlers for different calls do not overlap. Once a call leaves that Hook stage, its validation, policy and approval proceed independently, then Runner calls `submit(call, context)` immediately when admitted. One pending approval therefore does not block later calls after their ordered Hook stage.

The original Assistant response remains a Provider pairing barrier: Runner records each accepted/immediate result by `callId`, then projects the complete result set in original call order before another Model invocation. Pending admissions and an unresolved pairing barrier are Runner-owned Turn work; they are not registered with Framework and do not change `framework.hasUnsettledWork()`. This response-local barrier is not a persisted execution group and does not delay already admitted Tool implementations.

Runner owns the composite terminal predicate:

```ts
function hasTurnOwnedWork(): boolean {
  return pendingAdmissions.size > 0
    || pairingBarriers.size > 0
    || framework.hasUnsettledWork()
    || hasClaimedSteering
    || hasActiveModelCall;
}
```

The serialized Turn event loop waits on admission-task completion in addition to Framework, steering and Abort wakes. Pending admission/pairing retain the shared Model-call reserve and prevent Turn settlement or completion-only continuation even when Framework has no accepted execution.

### 4.2 Model-authored concurrency contract

The System Prompt defines one Provider-neutral planning rule:

```text
Tool concurrency rules:

- Tool calls emitted by the same LLM call may run concurrently and must not
  depend on another's output or side effects.
- When one call depends on another, emit only the prerequisite call. Wait for
  its HostTaskCompletion before emitting the dependent call in a later
  assistant response.
- An accepted tool result confirms Host ownership only. It is not final output
  and must not be used as business data.
- Emit at most 8 Tool Calls in one response. This is a hard Host upper bound,
  not a guarantee that all 8 slots are currently free. A capacity-rejected
  call may be retried later.
```

Framework does not create or persist a separate execution-group entity. The existing LLM call/Assistant message already defines which 1–N Tool Uses were planned together. Each Tool Use is independently admitted, identified, supervised, terminalized and delivered. Framework invokes accepted implementations without awaiting sibling Promises. It does not infer hidden dependencies or reorder same-call Tools into serial execution.

Provider configuration enables multiple Tool Calls where supported. Chat, Responses and Messages adapters preserve their required same-call Tool Result pairing; protocol capability switches do not create a second Core execution policy.

The `task` Tool follows the same rule without a Subagent-specific concurrency wrapper:

- one `task` invocation delegates exactly one isolated Child;
- several independent Children are expressed as several `task` calls in the same Assistant response;
- Framework starts those Tool executions concurrently and supervises each Promise independently;
- each Child retains its own session/turn/tool-call identity, transcript isolation, depth capability, events, usage and cleanup;
- results remain one independently persisted terminal fact per `task` execution;
- `task` does not accept a `children` array, call `Promise.all` internally, aggregate Child outcomes, or own a second scheduler.

Subagent-specific context firewalls and lifecycle contracts remain; only concurrency ownership moves to the common Framework.

### 4.3 Global execution-slot capacity

Runtime owns one process-global constant:

```ts
const MAX_TOOL_EXECUTION_SLOTS = 8;
```

It is not configurable in this Change. The constant is shared by every Session, Turn and Tool kind and is rendered into System Prompt concurrency guidance. Current free capacity is dynamic and is not promised to the Model.

One slot is held from successful reservation until pre-start terminalization or Promise settlement:

- reserved/starting executions;
- running executions;
- cancelling executions;
- Runtime-quarantined executions until the Promise settles or the Host process exits.

Capacity admission is independent when each Tool Use becomes otherwise admissible:

1. each call completes decode, interceptors, validation, policy and approval;
2. an otherwise-admissible call atomically tries to reserve one slot without waiting;
3. insufficient capacity gives only that call immediate canonical `unavailable`, with no execution ID;
4. successful reservation permits one durable accepted record and immediate implementation invocation;
5. accepted-record persistence failure releases that reservation and starts no implementation;
6. processing another Tool Use never waits for a sibling implementation Promise.

There is no capacity queue or silent serialization. Same-call Tools may therefore contain both accepted and unavailable results. A later Model continuation may retry an unavailable Tool. Quarantine retains the already-held execution slot; it does not acquire a second slot or release the slot merely because the Turn ends.

For normally settled work, the slot releases after the Promise callback captures and normalizes its terminal candidate; persistence, Hooks and Host-completion delivery do not consume execution capacity. An accepted call that never invokes `Tool.execute` releases its reserved slot when it terminalizes.

## 5. Public and structural contracts

### 5.1 Execution identity, state, and supervision

Every admitted invocation receives one immutable `executionId`, distinct from Provider `callId`.

```ts
type ExecutionOutcome =
  | 'success'
  | 'failed'
  | 'aborted'
  | 'outcome_unknown';

interface ExecutionAcceptedReceipt {
  readonly executionId: string;
  readonly status: 'accepted';
}
```

No terminal record means the execution has no outcome yet; there is no separate `none` value. The terminal record's `ExecutionOutcome` is immutable once written.

Completion delivery is also structural rather than an enum:

- terminal record absent: nothing can be delivered;
- terminal record present and Host completion absent: append is pending;
- Host completion present: it must not be appended again;
- a following Assistant response proves the Host completion entered Model history.
- a same-Turn `turn_aborted` fact explains why trailing Host completions intentionally have no consuming Assistant yet.

Implementation lifecycle and supervision are represented structurally rather than by duplicated state properties:

- an accepted entry with no implementation handle has not invoked `Tool.execute`;
- an entry in the Turn execution registry is Turn-supervised;
- an active entry in the Runtime quarantine registry is quarantine-supervised;
- absence from both registries means supervision resources have been released;
- every unsettled implementation belongs to exactly one active supervisor.

Promise fulfillment and rejection callbacks produce a terminal candidate containing the returned value or thrown error. The callback branch is not retained as a separate status after terminal arbitration; the canonical outcome, payload/error diagnostics, and persistence state contain the information later consumers need.

For a quarantined execution, the implementation Promise may remain unresolved while outcome is already sealed as `outcome_unknown`. A late fulfillment/rejection is logged directly by the quarantine observer, removes the quarantine entry, and releases the quarantine pin, but cannot change outcome or delivery history.

The receipt is deterministically serialized as the original call's Provider-facing Tool Result content. It confirms Host ownership only. It does not mean the implementation started, produced side effects, or succeeded.

Session and canonical Model input represent this receipt as a distinct execution-accepted record/item. It is not a four-state terminal `ToolResultBlock`. Provider projection alone emits the protocol's matching Tool Result/output item needed to close the original call.

Unknown, malformed, denied, unavailable, invalid, and approval-denied calls fail during admission through existing immediate correlated terminal results and never receive an execution ID.

### 5.2 Tool contract additions

```ts
interface ToolExecutionContext {
  readonly executionId: string;
  readonly signal: AbortSignal;
  readonly reportActivity: () => void;
  // Existing identity fields remain.
}

interface Tool {
  execute(
    input: Readonly<Record<string, unknown>>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionOutput>;
}
```

`reportActivity()` is bound to the current execution and accepts no ID, timestamp, text, percentage, or payload. Parent/Runner code cannot report on a Tool's behalf. One monotonic Host clock sets `startedAt` and `lastActiveAt` from the same read when implementation execution begins; every accepted activity replaces `lastActiveAt`. Activity refreshes only the idle deadline.

Timeout policy is fixed and Host-owned in this Change:

```ts
const TOOL_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const TOOL_TOTAL_TIMEOUT_MS = 60 * 60 * 1_000;
const TOOL_CANCELLATION_GRACE_MS = 10 * 1_000;
```

These values are not configurable and are not Tool hints. Tool, Extension, MCP adapter, Model and `reportActivity()` cannot override, disable or extend them.

- idle starts when `Tool.execute()` is invoked and expires five minutes after the last accepted `reportActivity()`;
- total starts from the same `startedAt` and expires after one hour regardless of activity;
- idle or total expiry requests execution-local cancellation;
- cancellation grace starts when any idle/total/user/Model/Root cancellation signal is first issued;
- a real settlement within ten seconds follows normal terminal arbitration;
- otherwise Framework seals `outcome_unknown` and transfers the existing entry to Runtime quarantine as defined in section 8.

#### 5.2.1 Activity sources

Activity must represent observed implementation progress; Framework does not generate timer heartbeats:

- foreground `exec` reports each stdout/stderr chunk;
- `task` reports Child Model/tool lifecycle events that prove the delegated run advanced;
- an MCP adapter reports protocol progress notifications when the server emits them;
- an Extension Tool calls its bound `reportActivity()` when its own operation advances;
- a builtin or adapter with no observable progress source reports nothing and is subject to the five-minute idle deadline.

Activity emitted after completion or ProcessRegistry handoff is ignored. Output volume is not persisted as activity history, and repeated activity cannot extend the one-hour total deadline.

#### 5.2.2 Managed process boundary

First delivery uses fixed, process-global bounds:

```ts
const MAX_MANAGED_PROCESSES = 8;
const MAX_EXEC_CAPTURE_BYTES = 1_048_576;
const MAX_TERMINAL_PROCESS_RECORDS = 32;
```

These values are not configurable in this Change. Background and yield modes reserve one managed-process slot before spawn; capacity failure spawns nothing and returns an explicit failed Tool result. The slot is released when the process reaches a terminal status. Foreground mode does not consume managed-process capacity.

Exec capture retains only the newest 1 MiB of combined stdout/stderr as a byte-bounded tail plus a monotonic truncated-byte count. ProcessRegistry does not also retain an unbounded duplicate chunk list. When more than 32 terminal records exist, it evicts the oldest terminal record; active records are never evicted. Active capacity, output bytes and terminal retention have separate bounds.

Every `exec` invocation enters the common Framework, but an explicitly managed OS process has its own lifecycle:

- foreground mode keeps the Tool Promise pending until process exit and reports stdout/stderr activity;
- `background: true` waits for successful spawn and ProcessRegistry registration, then returns a final successful Tool result containing `runId`;
- `yieldMs` behaves as foreground until completion or the threshold; if the threshold wins and the process is still running, it atomically exposes the existing ProcessRegistry entry, transfers process ownership, and returns `runId`;
- before background/yield handoff, Root Abort belongs to the Tool execution and terminates the child;
- after handoff, the Tool execution is terminal, its Framework slot is released, and later Turn Abort does not terminate the managed process;
- process exit after handoff updates ProcessRegistry only; it does not emit another Tool result or Host completion;
- `process status/log/kill` operates on the returned `runId`;
- normal Host shutdown boundedly terminates and waits for managed processes; Host crash has no cleanup guarantee, and restart does not recover the in-memory registry.

Every ProcessRegistry record carries its owning `sessionId` and creating `turnId`. `process list/status/log/kill` receives the caller's Tool context and can access only records whose `sessionId` matches; cross-Session lookup returns the same not-found result as an unknown `runId`. Session fork does not copy ownership. Normal Turn completion and post-handoff Root Abort leave the process running, while Session deletion and Host shutdown boundedly terminate all affected active processes before removing their records.

ProcessRegistry handoff is an explicit managed-resource result, not a synchronous Tool bypass, nonconvergence quarantine, or general detached-job protocol.

### 5.3 Terminal completion

```ts
interface HostTaskCompletion {
  readonly executionId: string;
  readonly toolName: string;
  readonly status: 'success' | 'failed' | 'aborted';
  readonly content: string;
}
```

The Framework creates exactly one terminal fact and at most one Host completion record per `executionId`; the execution ID is also the idempotency key. A real completion wins a cancellation race. A duplicate identical write is ignored; a conflicting terminal fact or Host completion is an explicit invariant failure.

Crash/restart may produce internal `outcome_unknown`. Its Model/UI projection uses `aborted` with neutral content explaining lost supervision; it must not claim user cancellation, implementation stop, side-effect rollback, or safe retry.

The same projection applies to a live execution transferred to the Runtime quarantine registry after cancellation grace expires. Quarantine membership is not an execution outcome or proof that implementation code stopped.

### 5.4 Trusted Host message

Session adds a structural Host-origin message/record carrying `HostTaskCompletion`. User input cannot create this role/type through Channel intake. Model Invocation retains Host origin until a Provider adapter encodes it.

Provider wire may use an ordinary user role because current protocols lack a Host role. The rendered envelope:

- identifies a fixed Host lifecycle type;
- serializes identity/status separately from Tool content;
- labels Tool content untrusted data;
- never parses user-authored tags back into trusted origin;
- never reuses the original `callId` as a second Tool Result.

### 5.5 Wakeable steering source

Runtime replaces the claim-only callback with a source that separates notification from ownership:

```ts
interface SteeringMessageSource {
  claimReady(): ChatMessage[];
  waitUntilPotentiallyReady(signal: AbortSignal): Promise<void>;
}
```

`waitUntilPotentiallyReady` only wakes the Framework event loop; it cannot dequeue, bind, or skip FIFO entries. `claimReady` preserves ADR-017's atomic largest-compatible-prefix transfer and emits binding events.

### 5.6 Public events and History

```ts
type ToolResultStatus = 'success' | 'error' | 'denied' | 'aborted';

interface ToolResult {
  readonly content: string;
  readonly status: ToolResultStatus;
}

interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly status: ToolResultStatus;
}
```

These shapes represent terminal presentation only. An execution-accepted record never receives `status: 'success'` and is never converted into `ToolResultBlock`.

The persisted Assistant Tool Call remains the request fact for every Model call. Public lifecycle behavior is:

- after persisting the Assistant response, Runner emits one pre-admission `tool_call_requested` per call in Provider order; it contains `callId`, Tool name and request input and creates the live card;
- an admitted execution emits one `tool_use` event only after Host ownership exists; it contains both `callId` and `executionId`;
- its accepted Provider closure does not emit public `tool_result`;
- the execution emits exactly one public terminal `tool_result` after its outcome is sealed, including live `outcome_unknown` quarantine;
- a call rejected before admission uses the requested card and emits one immediate terminal `tool_result` with `callId` and no `executionId`, so malformed, unknown, denied, or invalid Model calls remain visible and correlated.

No consumer parses accepted JSON or completion text. Public terminal status is derived from the owning execution/admission fact, never by mapping an observer Hook result back into public state:

| Owning fact | Terminal status |
|---|---|
| accepted execution outcome `success` | `success` |
| accepted execution outcome `failed` | `error` |
| accepted execution outcome `aborted` | `aborted` |
| accepted execution outcome `outcome_unknown` from recovery or quarantine | `aborted` |
| pre-admission canonical `denied` | `denied` |
| pre-admission canonical `failed`, `invalid_input`, `unknown_tool`, `unavailable`, or `not_executed` | `error` |

An accepted Tool whose implementation is not invoked because Root Abort/startup interruption wins has one mandatory cross-surface mapping:

| Axis/surface | Required value |
|---|---|
| implementation handle | absent; `Tool.execute` was never invoked |
| execution outcome | `aborted` |
| reason | `start_interrupted` |
| `after_tool_call` canonical result | `not_executed` |
| Host completion status | `aborted` |
| public Tool Result status | `aborted` |

The Hook's `not_executed` is an observer projection and cannot be fed through the pre-admission mapping to produce public `error`.

Unknown values fail explicitly and never default to success. Realtime events and persisted History use the same mapped status. Provider adapters omit this local terminal status unless their existing protocol already carries an equivalent field.

History presents one task lifecycle keyed by `executionId`. It may fold accepted and Host completion records into one task card, but persisted Model history retains the accepted receipt and later Host completion as separate chronological facts. Internal completion messages do not render as user-authored chat bubbles.

Web/CLI keep lifecycle phase separate from terminal status. Accepted/running/approval-waiting are phases, not terminal result statuses. Cross-page History reconstruction retains content, status, call ID and execution ID; it never infers status from content or changes a realtime failure into success.

### 5.7 Inline Approval

Only a real `approval_requested` event adds Allow/Deny controls to the corresponding pre-admission `tool_call_requested` card. Approval does not create a separate card and is never reconstructed from History.

- The controls remain visible in the collapsed Tool Call; expanded details use the transformed input from `approval_requested`.
- `approval_requested` must contain `approvalId`, `sessionId`, `turnId`, and pre-admission `callId`; no `executionId` exists yet.
- Correlation uses the structural `callId`. It never guesses by Tool name, queue position, or last rendered card.
- Ambiguous or missing correlation reports an explicit client protocol error.
- Selection prevents duplicate submission and sends the existing `approval_resolve` request.
- A locally successful send hides controls optimistically but does not claim server acknowledgement or Tool success.
- Send failure restores a usable state when connected; disconnect disables/clears pending controls and never auto-retries.
- Ordinary Allow/Deny has no invented acknowledgement. Existing `approval_closed` events close by Approval ID.
- Deny emits the authoritative terminal `status: 'denied'` against the requested card and never emits accepted `tool_use`.
- Allow closes the approval phase; successful admission durably records accepted ownership before emitting `tool_use` with `executionId`, and Framework execution later emits its terminal result.

## 6. Behavior and invariants

### 6.1 Admission and accepted closure

For each complete Model Tool Call, Runner creates an admission state covering decode/resolution, before interceptors, transformed-input validation, policy and approval. A rejection returns the existing immediate result. `before_tool_call` chains are serialized per Turn in Provider order; after each chain finishes, that call's remaining admission may overlap sibling approvals/execution. Provider result projection waits for every call from that Assistant response to have one accepted/immediate result.

The event order for an approval path is fixed:

```text
Assistant Tool Call persisted
→ tool_call_requested(callId)
→ before interceptors / validation / policy
→ approval_requested(approvalId, callId, transformed input)
→ approval_resolve
→ denied tool_result(callId)
   or execution accepted record persisted → tool_use(callId, executionId)
```

The steering guarantee starts only after Host ownership and accepted closure. Admission and approval must retain their current bounded/fail-closed contracts, but an unclosed call cannot be sent to the Model with steering on Providers that reject this history. This Change does not claim that steering is Model-consumable while manual approval or a before interceptor is still unresolved.

After one call completes admission and capacity reservation, Runner submits it immediately. The Framework:

1. allocates execution ID and child AbortController;
2. persists that execution's accepted record;
3. returns the accepted receipt for the original call ID;
4. invokes `Tool.execute()` without awaiting another Tool Use's Promise.

All Tool Calls from one Assistant response still require a correlated Provider result batch before the next Model invocation. That wire-pairing requirement is not an execution-group lifecycle. Accepted implementations may already be running or terminal while another same-call Tool is awaiting approval; steering and Host completion remain queued until every original call has a paired accepted/immediate result. Root Abort aborts the active Hook/Approval, closes every unresolved admission as `not_executed`, completes the pairing barrier, and starts no new implementation.

Framework does not await an invoked implementation before admitting/invoking another eligible Tool. Their asynchronous work and Promise settlement are concurrent. This is Promise concurrency, not worker-thread/CPU parallelism: each `execute()` synchronous prefix still blocks that event-loop turn, and a synchronous event-loop block prevents other starts and Framework supervision.

Each execution sets its own `startedAt = lastActiveAt` when its implementation is invoked; idle and total execution deadlines begin independently at that point. There is no pending-start queue or start deadline.

### 6.2 Waiting and steering

After persisting accepted receipts, Runner does not automatically call the Model merely to acknowledge acceptance. It waits for:

- compatible steering wake;
- one or more execution terminals;
- execution cancel/deadline transitions;
- Root Abort or Shutdown;
- Model budget/Turn terminal constraints.

On steering wake, Runner atomically claims and prepares the FIFO prefix. Normal steering is persisted and sent with all previously unprojected accepted receipts. The Model may reply without stopping execution. Repeated steering repeats this path.

Messages requires accepted Tool Results to be in the next user message after the Tool Calls. Projection therefore combines the accepted blocks and the first steering or Host completion text into that user message. Chat and Responses encode the same canonical chronology using their native Tool Result items. This is projection behavior, not a Runner state branch.

An empty claim while execution remains pending does not close steering or the Turn.

### 6.3 Completion delivery

Execution outcome sealing follows this order:

1. unique owner seals a normal terminal outcome or the explicit `outcome_unknown` nonconvergence fact;
2. Session persists terminal Host fact;
3. existing `after_tool_call` observers receive exactly one canonical result and settle under their current independent timeout/Abort rules;
4. the terminal is ready for Model delivery after observer settlement;
5. Runner appends each ready trusted Host completion at an allowed serialized Model safe point;
6. the following Assistant response establishes that the appended completions entered canonical Model history.

No collect call is required. Terminal facts persist independently as executions settle, and public UI/History may update immediately. Model delivery is batched:

- an otherwise-permitted steering Model call includes all ready, not-yet-appended Host completions;
- without such a steering call, a completion-only Model call waits until the Turn execution registry is empty, then appends all outstanding Host completions in canonical terminal-record order and invokes the Model once;
- a ready completion never waits for a same-response sibling before persistence or UI publication; only the automatic completion-only Model continuation uses the all-active-executions barrier.

Observer failure cannot mutate the terminal fact or Host completion. Runner still waits for observer settlement before the next Model invocation, preserving the stable Tools and Hooks contract.

Hook projection is explicit:

- normal settled execution receives its canonical success/failed/aborted result and actual `implementationStarted`;
- the quarantined execution receives canonical `outcome_unknown` with `implementationStarted: true`;
- an accepted execution not invoked because Root Abort/startup interruption wins receives canonical `not_executed`, `implementationStarted: false`, and reason `start_interrupted`;
- observers run once per call after its fact is durable and cannot convert unknown/not-executed into another outcome.

If completion occurs during a steering Model call, it waits. The steering response is persisted first because that Model did not know the result; the completion is included in a later permitted steering call or the final batched completion call.

### 6.4 Event ordering and concurrency

Runner's serialized Turn event loop and canonical Session append path provide ordering; no second sequencer entity is introduced. Parent Model calls never overlap. Events appended before one call are projected in Session order; events arriving during a call wait for the next safe point.

Tool implementations emitted by one LLM call run concurrently once individually admitted. Framework does not concurrently invoke Parent Model calls; Model continuation remains serialized.

One execution's failure, cancellation or quarantine does not cancel another Tool Use from the same LLM call. The Prompt contract says those calls are independent. Each execution keeps its own controller, deadlines and terminal fact. Root Abort remains the only Turn-wide signal; an explicit Model cancel targets the selected execution.

### 6.5 Turn settlement

A Turn cannot finish while any of these exists:

- pending Tool admission or an unresolved Provider pairing barrier;
- accepted/running/cancelling execution;
- terminal fact not durably persisted;
- terminal Host completion not appended to canonical history;
- Model call consuming an appended Host completion;
- eligible steering already claimed but not persisted/consumed.

Runner evaluates these conditions through `hasTurnOwnedWork()`, not Framework state alone.

A quarantined execution no longer blocks its original Turn only after the outcome-unknown fact and Host completion are durable and the existing execution entry has moved to the Runtime quarantine registry. Once the Turn execution registry is empty, the final atomic steering claim regains ADR-017 terminal meaning. A non-empty claim continues the same Turn; an empty claim permits terminal commit.

Root Abort is the exception to Model-consumption waiting. It starts no further steering or completion Model call. After every admitted execution is terminal or quarantined and Hooks settle, Runner appends outstanding Host completions to canonical history, releases the shared completion-call reserve, and ends the aborted Turn without a consuming Assistant response. The next non-aborted user Turn projects those trailing Host completions before the new user message.

When Root Abort is observed, Session first persists one structural `turn_aborted` fact for that Turn. Recovery reads this fact to distinguish intentional non-consumption from a failed Model invocation; it is not Provider-visible content or a delivery-state enum.

### 6.6 Model-call budget

With finite `maxLlmCalls`, the shared reserve is acquired when a Model response contains one or more complete Tool Calls, before any Hook, approval or execution starts. Pending admissions, the Provider pairing barrier and all later active executions share that one reserved Model call. Additional calls/executions do not reserve additional calls. Ordinary steering can consume only calls above that single reserve.

If the Model emits Tool Calls after consuming the last available call and no future call can be reserved, Runner persists that Assistant Tool Call record with structural `turnStopReason: 'max_llm_calls'`. No Hook or approval starts, none of those calls is admitted or executed, and Runner appends one complete paired Tool Result batch containing canonical `unavailable` with no execution IDs, then ends the Turn without another Model invocation. The stop reason is metadata on the Assistant record, not a separate lifecycle enum.

When only the reserve remains, the completion-only call waits for all admissions to close, the Provider pairing barrier to resolve and the Turn execution registry to become empty; it then consumes the reserve with every paired result and outstanding Host completion. Later unclaimed steering stays queued for the next Turn. Root Abort first closes admissions/pairing, then releases the reserve without invoking the Model.

## 7. Lifecycle and resource ownership

The Async Tool Execution Framework creates one Turn-scoped execution registry and disposes it with that Turn. Each entry contains the implementation handle, controller, activity clocks, deadlines, cancel state and terminal arbitration needed while the execution is active.

Root Abort cascades to every Turn-owned Tool execution. Per-execution cancel does not abort the Parent Turn. Normal Turn completion cannot detach a Tool execution. Runtime quarantine is the only supervision transfer for an unresolved Tool Promise. Managed exec handoff transfers an OS-process resource only after the Tool invocation has produced its final `runId` result; it is not an unresolved Tool execution.

The Host monotonic clock is authoritative for durations and deadlines. Persisted wall-clock timestamps are diagnostics/order evidence and are not used to reconstruct elapsed timeout budgets after restart.

## 8. Failure, Abort, deadline, and concurrency semantics

- Cancel request transitions accepted/running execution to cancelling and signals only its controller.
- Cancel acceptance is not terminal. Actual success/failed completion may still win before cancellation converges.
- Idle expiry requests cancel using `lastActiveAt`; total deadline is independent and cannot be refreshed.
- Root Abort stops an admission/start barrier not yet released and requests cancel for every active execution.
- Root Abort persists `turn_aborted` before appending trailing Host completions and forbids every later Model invocation in that Turn.
- Failed persistence cannot produce a success-shaped Host completion or public terminal event.
- A terminal persisted but not yet delivered is delivered on recovery without re-executing the Tool.
- An accepted execution with no terminal after process loss becomes outcome-unknown recovery; Tool execution is never replayed automatically.
- Tool output remains untrusted content even inside a trusted Host envelope.

### 8.1 Nonconvergence quarantine

When a running in-process Tool ignores Abort:

1. Framework transitions it to cancelling, aborts its execution-local signal, and waits the configured cancellation grace.
2. A real implementation settlement during grace wins and follows normal terminal arbitration.
3. If grace expires, terminal arbitration reserves `outcome_unknown`. If a real completion already won, normal terminalization continues.
4. Session persists `outcome_unknown` with reason `execution_nonconverged`. Persistence failure leaves the existing Turn entry intact, publishes no completion, and follows the normal explicit Session failure/retry path.
5. After persistence, Framework synchronously moves that same entry from the Turn registry to the Runtime quarantine registry. The Promise observer, occupied slot and existing Runtime generation pin move with the entry; no second entry, slot, pin, lease or handoff-status field is created. The Tool registration is disabled for new calls until Host restart.
6. Public UI and the next serialized Model safe point receive neutral `aborted` completion stating that supervision stopped waiting but implementation termination and side-effect rollback are unconfirmed.
7. The existing Promise callbacks absorb any late fulfillment/rejection. Late settlement is boundedly logged, removes the quarantine entry and releases its slot/pin, but cannot replace the sealed outcome, write Session, publish events, deliver another completion, restore the Tool registration, or resume the Turn.
8. Other Tool Uses from the same LLM call continue independently and do not affect this execution's quarantine transfer or completion delivery.

The registry move contains no `await` or external callback boundary. A missing/mismatched source entry is an invariant failure: retain all reachable resources, publish no additional fact, block new admission, and report the failure explicitly. Host-completion append failure after the move is recovered from the persisted terminal fact without replaying the Tool.

Quarantine entries retain their occupied slots and generation pins until Promise settlement or Host process exit. The eight-slot limit therefore also bounds quarantined executions; no separate quarantine capacity or count exists.

Disabled Tool-registration state is process-local. It is not written to Session, reconstructed from History, or cleared by late settlement. In this Change, Host restart is the only recovery path. Restart removes old in-process executions and pins while persisted outcome/history remains available under normal Session recovery.

Moving an entry to quarantine stops accepting its activity callbacks and all Framework state mutation, but it cannot revoke direct Node.js, native-addon, remote-service, or already-issued external side effects. Synchronous code that blocks the event loop also prevents timers, Abort handlers and quarantine transfer from running; recovery from that class requires an external isolation/watchdog boundary and is not guaranteed by this Framework.

Turn convergence therefore means the Turn execution registry has no remaining entry. It does not mean quarantined implementation code was physically terminated.

## 9. Persistence, recovery, and compaction

Persistence must structurally retain:

- call ID ↔ execution ID ↔ Tool name;
- accepted receipt and ordering;
- unique terminal fact, including a nonconvergence/recovery reason when applicable;
- at most one Host completion record keyed by execution ID;
- one `turn_aborted` fact when Root Abort suppresses completion consumption;
- `turnStopReason: 'max_llm_calls'` on a final Assistant Tool Call record whose paired immediate Tool Results are intentionally left without a consuming Assistant.

Activity clocks, controllers, slots, generation pins, Turn/quarantine registry membership and disabled Tool registrations are process-local runtime state and are not persisted.

New writers use the unified async format atomically. This is a clean-format cutover: persisted Tool Result blocks require terminal `status`, while accepted receipts and Host completions require their new structural record types. A Session containing legacy Tool Result blocks without required status is rejected through existing Session data-invalid paths; no default success, content inference, automatic rewrite, or dual reader is allowed.

Recovery rules:

1. terminal exists and Host completion exists: do not append either again;
2. terminal exists but Host completion is missing: append exactly one Host completion keyed by execution ID;
3. accepted exists without terminal after process loss: persist outcome-unknown recovery, append neutral aborted Host completion, do not replay;
4. trailing Host completions belong to a `turn_aborted` Turn: do not invoke the Model during recovery; preserve them for the next non-aborted user Turn;
5. an Assistant Tool Call record carries `turnStopReason: 'max_llm_calls'`: never run Hook/approval/Tool for those calls; append any missing unavailable result batch exactly once, do not duplicate an existing batch, and preserve the paired exchange for the next user Turn without invoking the Model;
6. trailing Host completions have no following Assistant and no intentional non-consumption marker because invocation failed: preserve them and retry Model consumption without duplication;
7. conflicting IDs/status fail closed through Session data error paths.

Compaction treats the Assistant Tool Calls plus their paired accepted/immediate result batch as an atomic exchange. Undelivered Host completion, `turn_aborted`, a `max_llm_calls`-marked Assistant exchange, and trailing Host completions without a consuming Assistant are non-prunable. After consumption by a later Turn, compaction may summarize Model-facing text while persisted execution facts and History terminal status remain intact.

## 10. Provider projection

The canonical sequence is identical:

```text
Assistant Tool Calls from one LLM response
matching execution-accepted records projected as Provider Tool Results
zero or more steering exchanges, optionally carrying ready Host completions
one batched completion-only message after Turn executions converge
Assistant continuation
```

Root Abort is the exception: trailing Host completions remain in canonical history without an automatic Assistant continuation and are projected with the next non-aborted user Turn.

`max_llm_calls` is the other intentional non-consumption case. On the next user Turn:

- Chat Completions projects the existing assistant `tool_calls`, exactly one matching `role: tool` unavailable result per call, then the new user message;
- Responses projects each existing `function_call` and exactly one matching `function_call_output`, then the new user input;
- Messages combines the existing unavailable `tool_result` blocks and new user text into the required next user message after the assistant `tool_use` blocks.

Projection never creates a second unavailable result. The new Turn's Model invocation consumes the already paired trailing exchange under its own call budget.

- Chat Completions uses assistant `tool_calls`, matching `role: tool` accepted results, and user-role Host messages.
- Responses uses `function_call`, matching `function_call_output` accepted results, and user-role Host messages.
- Messages uses assistant `tool_use`; the next user content contains every accepted `tool_result` block followed by first steering/completion text; later Host messages use user-role text.

Provider adapters must ignore internal presentation fields, preserve call IDs, and never send an orphan or duplicate Tool Result. Runner supplies canonical records and has no protocol switch.

## 11. Security and capabilities

- Only Core/Session code can create trusted Host completion records.
- Channel user input, Tool output, Hook output, Extension events, and restored plain text cannot set Host origin.
- Provider rendering escapes/serializes Tool content as data and uses a fixed instruction declaring it untrusted.
- Execution IDs are opaque, non-secret correlation values and the idempotency key for Host completion.
- Events and logs exclude credentials and boundedly summarize large Tool output.
- A Tool cannot report activity for another execution or choose Host deadlines.
- Managed process lookup is Session-scoped; a caller cannot list, inspect, read output from or kill another Session's process.
- Exec output is byte-bounded before storage or Tool-result rendering; truncation is explicit and never exposes discarded content.

## 12. Clean cutover

Delivery is a clean runtime cutover: every newly admitted Tool uses the Framework. No feature flag, sync fallback, per-Provider lifecycle, or dual writer is retained.

Session reader/writer, History, fork, pruning, compaction, public events, Extension API, CLI and Web migrate in the same delivery before the writer is enabled. Public `ToolResult.isError` is replaced by required four-state `status`; no production dual-read/write alias remains.

Provider accepted receipts and Host completion messages change Model wire chronology as defined in section 10. Local terminal `status` and Approval UI state are not added to Provider wire. Existing Approval request/resolve/closed protocol remains unchanged.

## 13. Acceptance and validation

Required tests include:

- admission rejection vs accepted ownership;
- one call, 1–N concurrent same-call Tools, and a dependent call emitted only after prior HostTaskCompletion;
- per-execution slot reservation success/failure, mixed same-call outcomes, accepted persistence rollback, normal release and quarantine slot retention;
- repeated steering while execution pending;
- completion before/after/during steering calls;
- one shared Model-call reserve across multiple independently settling executions, batched final delivery, and queued steering preservation;
- independent cancel, Root Abort, idle/total deadlines, late real completion;
- Root Abort with no later Model invocation, durable `turn_aborted`, trailing completion recovery, and next-Turn consumption;
- exact 5-minute idle, 1-hour total and 10-second cancellation-grace boundaries under a monotonic fake clock; activity refreshes idle only;
- foreground exec output, Subagent lifecycle, MCP progress and Extension activity sources; no synthetic heartbeat;
- foreground/background/yield exec ownership handoff, post-handoff Abort behavior, process exit, explicit kill and Host shutdown;
- ProcessRegistry active capacity, byte-bounded output, terminal-record eviction, Session isolation, fork and Session-deletion cleanup;
- pending admission/pairing-barrier Turn gate and reserve retention;
- Framework-only `hasUnsettledWork()` versus Runner `hasTurnOwnedWork()` composition and admission-task wake;
- same-Turn before-hook serialization with independent post-Hook approval;
- cooperative and noncooperative implementations;
- cancellation-grace settlement vs expiry, quarantine entry transfer, Tool-registration disablement and late fulfillment/rejection isolation;
- persistence failure at accepted, terminal, Host append, and Assistant append;
- reload cases in section 9, no Tool replay, no duplicate Host completion;
- compaction with pending/delivered Host records;
- Chat/Responses/Messages exact request bodies and negative orphan checks;
- Runtime FIFO wake without claim, compatible-prefix binding and terminal empty claim;
- public events, CLI/Web live card, History reload/fork/pagination;
- all four terminal statuses live and after reload, cross-page pairing, empty content and repeated same-name calls;
- inline Approval collapsed/expanded controls, transformed input, duplicate prevention, deny/allow, Abort/Allow All/Shutdown/disconnect/error cleanup;
- security attempts to forge Host messages;
- shutdown and retained request-generation pin behavior;
- focused Unit/Integration/Fitness, lint/build, document checks and independent review.

Bounded live Provider evidence from the Spike supports the design but is not a release gate for every environment unless separately authorized.

### 13.1 Required concurrency, nonconvergence and Approval matrix

| ID | Required evidence |
|---|---|
| C1 | Three Tool Uses from one LLM call independently persist accepted records and invoke all three `Tool.execute` functions before any deferred Promise settles, with independent execution IDs, controllers and clocks |
| C2 | A dependent call is absent from the first LLM output and appears only after prerequisite HostTaskCompletion in a later LLM call; Framework never infers or serializes hidden dependencies |
| C3 | Promise concurrency does not claim CPU parallelism: synchronous prefixes occupy the event loop while deferred work overlaps; an event-loop blocking prefix prevents other starts and remains outside recoverable guarantees |
| C4 | Disk reload independently recovers each accepted/terminal execution and delivers each undelivered completion exactly once without re-execution or a group record |
| C5 | Three same-response `task` calls delegate three isolated single Children concurrently through Framework; `task` contains no batch input/aggregator, and each result preserves its own call/execution/Child correlation |
| C6 | With two free slots and three otherwise-admissible same-call Tools, the two that reserve first start and the remaining call returns unavailable with no execution ID; no capacity wait state exists |
| C7 | A same-call denied/invalid result retains its reason while every otherwise-admissible Tool independently succeeds or fails slot admission when ready |
| C8 | One accepted-record persistence failure releases only that Tool's reserved slot and starts no implementation for it; independently accepted Tools continue |
| C9 | Quarantine transfers rather than duplicates its occupied slot; that slot remains unavailable through Turn completion and is released only by late settlement or Host restart |
| C10 | Same-Turn `before_tool_call` chains run one at a time in Provider order; after call A leaves its Hook chain and waits for approval, call B may finish its Hook chain, admission and execution |
| C11 | With only a pending admission or missing paired result, `framework.hasUnsettledWork()` may be false while Runner `hasTurnOwnedWork()` remains true, retains the shared reserve and blocks Turn settlement/final completion; admission completion wakes the event loop and Root Abort closes every gap |
| T1 | With no activity, idle cancellation fires exactly at 5 minutes; total has not fired |
| T2 | Activity just before idle expiry moves only idle to five minutes after that activity; total still fires exactly one hour after `startedAt` |
| T3 | Any cancellation source starts one 10-second grace window; real settlement before the boundary wins, while no settlement at the boundary starts quarantine handoff |
| T4 | Foreground exec stdout/stderr, Child lifecycle and MCP progress refresh idle; a silent implementation receives no synthetic heartbeat |
| N1 | For same-call A/B/C, B settles success, A later quarantines, and C remains running: A quarantine does not cancel or rewrite B/C |
| N2 | Two executions independently quarantine only after their own cancellation grace; late settlements cannot rewrite either outcome or produce duplicate delivery |
| N3 | If B and A terminal facts become ready while C remains active, UI/History update immediately but no completion-only Model call starts; after C terminalizes, one call carries B/A/C in canonical terminal-record order |
| N4 | `outcome_unknown` persistence failure retains the active Turn registry entry, slot and pin, publishes no completion, and follows explicit Session failure/retry behavior |
| N5 | Quarantine moves the existing entry with its Promise, slot and generation pin in one synchronous step; no duplicate resource or intermediate handoff state is created |
| N6 | Root Abort or startup failure before an accepted Tool invocation creates no implementation handle and leaves execution outcome/public/Host `aborted`, reason `start_interrupted`, and Hook result `not_executed` |
| B1 | Finite `maxLlmCalls` keeps one shared reserve regardless of active execution count; multiple terminal facts consume one final batched call |
| B2 | A last-allowed Model response that requests Tools persists its Assistant record with `turnStopReason: 'max_llm_calls'`, starts no Hook/approval/execution, appends exactly one unavailable result per call, and ends without another Model call |
| B3 | Reload repairs a missing `max_llm_calls` unavailable result batch exactly once, never duplicates an existing batch or invokes the Model, and the next user Turn produces exact Chat, Responses and Messages request bodies with legal pairing and the new user input |
| E1 | Foreground exec remains Framework-owned until exit; `yieldMs` transfers a still-running process to ProcessRegistry and returns `runId` without a second completion on process exit |
| E2 | `background: true` hands off after successful spawn; post-handoff Turn Abort leaves the process managed, while explicit kill and bounded Host shutdown terminate it |
| E3 | The ninth starting/running managed process is rejected before spawn; a terminal process releases active capacity |
| E4 | Combined stdout/stderr retains the newest 1 MiB with exact truncation metadata and no duplicate unbounded chunk store; the 33rd retained terminal record evicts only the oldest terminal record |
| E5 | `process list/status/log/kill` cannot observe another Session's runId; fork inherits none, Session deletion cleans up owned processes, and Host restart restores none |
| R2 | A `turn_aborted` Turn with trailing Host completions triggers no recovery Model call; the next non-aborted user Turn consumes them without duplication |
| A1 | `tool_call_requested → approval_requested(callId) → deny → denied tool_result`; no execution ID, accepted receipt, or `tool_use` is emitted |
| A2 | `tool_call_requested → approval_requested(callId) → allow → accepted record persisted → tool_use(callId, executionId)`; Allow alone never emits success and persistence failure emits no accepted `tool_use` |
| R1 | Host restart does not restore process-local disabled Tool registrations from Session; persisted outcome_unknown/aborted History remains and the Tool can be admitted in the new process |

## 14. Acceptance and authorization

The review gaps have closed contracts and the project owner re-accepted this Specification on 2026-10-01. The project owner authorized Delivery on the same date, accepted the validated outcome on 2026-10-02, and archived the completed Change.

Process authority: [Development Workflow](../../../governance/development-workflow.md).
