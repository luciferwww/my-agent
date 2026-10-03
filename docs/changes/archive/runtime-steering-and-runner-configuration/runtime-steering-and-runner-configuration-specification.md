# Runtime Steering and Runner Configuration Specification

> Status: Implemented, Validated, and Accepted
> Date: 2026-09-21
> Owner: Project owner
> Related Plan: [Runtime Steering and Runner Configuration Plan](plan.md)
> Research input: [Runtime Steering 与 Runner 配置设计草稿](../../../research/runner-configuration-and-steering-design-draft.md)
> Authorization: Delivery approved by the project owner on 2026-09-21.

## 1. Purpose and observable outcome

Agent configuration exposes one Runtime-owned boolean for active-Turn steering
and one optional Runner-owned Model-call budget. Normal completion never loses
accepted text steering: every message is injected into the active Turn or starts
one later FIFO Turn. Explicit termination continues to discard pending steering.

## 2. Scope

- Agent-level Runtime and Runner leaf configuration.
- Steering admission, ready-batch consumption, and terminal handoff.
- Optional Model-call budgeting.
- Existing `run_end` presentation for explicit Model-call limit completion.
- Configuration, Runtime, Runner, Channel correlation, and authority tests.

## 3. Non-goals

- Per-message or per-Channel delivery choice.
- Attachment steering.
- Active Model or Tool interruption.
- New scheduler or orchestration module.
- New Result/Event/wire fields.
- Soft or interactive budget extension.
- Configuration migration outside Runtime and Runner.

## 4. Boundaries and dependency direction

### 4.1 Runtime

Runtime owns:

- `RuntimeConfig`;
- the `steeringEnabled` behavioral default;
- active-Turn steering admission;
- per-Session normal queues and steering inboxes;
- message identity and origin routing retained at ingress;
- the normal terminal handoff;
- promotion into the existing queued-Turn path;
- Session serialization, Abort, Shutdown, and scheduling.

Runtime does not decide the safe injection point inside the Model/Tool loop.

### 4.2 Runner

Runner owns:

- `RunnerConfig`;
- explicit Model-call budget enforcement;
- the Provider-neutral Model/Tool loop;
- the safe points at which pending steering is read;
- ordered persistence and injection of a ready batch.

Runner does not load configuration, inspect Session busy state, classify Channel
input, own the normal queue, or decide whether new input targets the current or a
later Turn.

### 4.3 Platform Configuration

Platform Configuration imports and composes the Runtime-owned and Runner-owned
leaf Contracts/defaults. It owns physical document reading, top-level
composition, strict validation dispatch, precedence merging, immutable
projection, and application-document errors.

Runtime and Runner must not import Platform Configuration to define or obtain
these two leaf Contracts or their behavioral defaults. Existing unrelated
configuration-type dependencies are outside this Change. Platform must not
duplicate either module's fields, semantic validation, or behavioral defaults.

## 5. Public configuration Contract

```ts
interface RuntimeConfig {
  readonly steeringEnabled: boolean;
}

interface RunnerConfig {
  readonly maxLlmCalls?: number;
}

interface AgentDefaults {
  readonly runtime: RuntimeConfig;
  readonly runner: RunnerConfig;
  // existing module configs
}
```

### 5.1 Defaults

```ts
runtime: Object.freeze({
  steeringEnabled: false,
})

runner: Object.freeze({})
```

An omitted `maxLlmCalls` means no Model-call count limit. It does not mean 12,
zero, a Provider default, or an inferred budget.

### 5.2 Validation

- `runtime` and `runner` must be objects when present.
- `runtime.steeringEnabled`, when present, must be boolean.
- `runner.maxLlmCalls`, when present, must be a positive integer.
- Unknown fields inside either leaf object follow the general strict
  configuration error behavior.
- `runner.inTurnMessageMode` is not part of the Contract and receives no alias,
  migration, conflict rule, or field-specific compatibility branch.
- Agent defaults, per-Agent entries, environment overrides, and caller/CLI
  overrides retain the existing precedence model.
- Final Runtime and Runner projections are immutable.

### 5.3 Overrides

An explicit `RunTurnParams.maxLlmCalls` overrides the resolved Runner value for
that Root Turn. A Subagent profile's explicit limit overrides inheritance; an
omitted profile limit inherits the Parent's effective optional limit. If both
are absent, the Child has no Model-call count limit.

## 6. Steering admission

Runtime classifies accepted Channel text as steering only when:

1. `runtime.steeringEnabled === true`; and
2. the Session is still inside the active Turn's steering-admission phase.

Otherwise the input becomes an ordinary `QueuedChannelTurn`.

Steering remains text-only. Attachment validation and the existing
pure-attachment steering behavior are unchanged.

Every accepted steering item retains enough information to become queued work:

- accepted text;
- `messageId`;
- Session identity;
- origin Channel/client route context;
- explicit Model reference and per-turn Model-call override, when supplied;
- FIFO acceptance order.

The `user_message` event is emitted exactly once at admission. Its
`deliveryMode='steering'` records the initial admission decision; promotion does
not emit a second `user_message`.

## 7. Ready-batch behavior

At each Runner safe point:

1. Runtime atomically detaches the currently available per-Session steering
   batch.
2. The batch preserves acceptance order.
3. Runtime builds one user message per submitted steering item.
4. Runner persists and appends every message separately in the same order.
5. Runner issues one immediate continuation Model call for the complete batch.

Runtime and Runner do not concatenate steering text with newline delimiters.
Items accepted after a batch is detached belong to a later safe point or the
terminal handoff.

Provider wire adapters may perform protocol-required representation conversion
without changing canonical message identity, persistence, or order.

## 8. Normal terminal handoff

### 8.1 Linearization

Runtime owns one synchronous per-Session transition from:

```text
accepting steering for active Turn
```

to:

```text
accepting only ordinary queued Turns
```

The transition occurs after Runner returns a result whose stop reason is neither
`aborted` nor `max_llm_calls`, and before Runtime releases the Session's
in-flight gate. This includes a returned `stopReason='error'`: Runtime already
treats that Provider result as completed. A thrown execution failure does not
enter this transition.

During that transition Runtime:

1. removes the active steering-admission marker;
2. atomically detaches all unread steering items;
3. converts each item, in order, to the existing `QueuedChannelTurn` shape;
4. creates the ordinary request gate required by the existing scheduler;
5. appends the promoted items to the existing per-Session FIFO;
6. releases the in-flight gate;
7. invokes the existing scheduler once.

No second scheduler, inbox, or execution path is introduced.

### 8.2 Ordering

- Steering already selected by Runner is injected once and is never promoted.
- Unread steering accepted before the transition is promoted once.
- Input accepted after the active marker is removed enters the ordinary queue
  directly.
- Items already present in the ordinary queue stay ahead of later promoted
  steering.
- Promoted items preserve their own FIFO order.
- Different Sessions remain isolated.

### 8.3 Correlation and routing

Promotion preserves the original `messageId`; the later
`run_start.originMessageId` references it. The promoted Turn uses the retained
origin route context and explicit launch overrides. Promotion does not emit a
second `user_message` and does not mutate the original event's
`deliveryMode='steering'`.

## 9. Explicit termination and failure

### 9.1 Abort

Explicit Abort preserves the current Contract:

- active work is signalled;
- unread Runtime steering is discarded;
- Runner-local drained but uninjected steering is discarded and logged;
- no promoted Turn is created;
- no new dropped-count Contract is added.

### 9.2 Explicit Model-call limit

When an explicit positive `maxLlmCalls` is reached:

- Runner returns the last `text` and `content`;
- `stopReason` is `max_llm_calls`;
- accumulated Usage and Tool rounds are retained;
- Runtime-local and Runner-local uninjected steering are discarded;
- no promoted Turn is created;
- no new Result or Event field reports a dropped count.

HTML and CLI use the existing `run_end.result.stopReason` to display a generic
configured-limit notice. The notice is not appended to Assistant content or
Session history.

### 9.3 Failure and Shutdown

Thrown execution failure and Shutdown preserve current pending-steering discard
and cancellation behavior. A returned `stopReason='error'` is not a thrown
failure and follows the normal terminal handoff in section 8. Normal promotion
is not a retry of the failed Provider request.

## 10. Lifecycle and resource ownership

- Runtime owns the mutable queue and inbox collections.
- A steering item exists in at most one of: Runtime inbox, Runner detached
  batch, or ordinary queue.
- Ownership transfer is destructive at each boundary and cannot duplicate an
  item.
- Runner persists only a batch it has accepted for injection.
- Runtime creates request gates only for items that become queued Turns.
- Queued cancellation and Shutdown continue through the existing request gate
  and `request_end` path.

## 11. Compatibility and migration

This is a direct cutover:

- add `runtime.steeringEnabled`;
- make `runner.maxLlmCalls` optional;
- remove `runner.inTurnMessageMode`;
- remove Platform's Runner field/default definitions;
- remove Runner's hidden 12-call fallback;
- update all fixtures and examples in the same delivery.

There is no dual production path or temporary compatibility owner.

## 12. Acceptance scenarios

### Configuration

- Empty Agent configuration resolves `runtime.steeringEnabled=false` and no
  `runner.maxLlmCalls`.
- Runtime and Runner leaf overrides follow all existing precedence stages.
- Invalid types, non-positive/non-integer limits, and unknown leaf fields fail
  with the existing configuration error shape.
- Runtime/Runner leaf projections and defaults are immutable.
- Runtime and Runner do not import Platform Configuration to define or obtain
  these leaf Contracts or defaults.
- Platform has no duplicate Runtime/Runner behavioral defaults.

### Model-call budget

- An omitted limit permits more than 12 successful Model calls.
- An explicit limit stops at the exact configured count with
  `max_llm_calls`.
- Per-run and Subagent overrides remain effective.
- Failed transport attempts are not reclassified as semantic Model rounds by
  this Change.
- HTML and CLI display a generic limit notice from the existing stop reason.

### Steering

- Disabled steering queues busy-Session input as a new Turn.
- Enabled steering injects text at the next safe point.
- Multiple ready messages remain separate, preserve FIFO, and cause one
  continuation call.
- Later arrivals form a later batch.
- A message racing normal completion is injected once or promoted once.
- Multiple promoted messages preserve order behind existing queued work.
- Promotion preserves message correlation, route context, and launch overrides.
- Promotion emits no duplicate `user_message`.
- Input after the terminal transition queues directly.
- Abort, explicit limit, thrown failure, and Shutdown do not promote steering.
- A returned Provider `stopReason='error'` follows the normal handoff and
  promotes unread steering without retrying the completed Turn.
- Cross-Session behavior remains isolated.

## 13. Required authority updates

Delivery must update:

- Current Architecture: Configuration, Runtime, Runner, Channels.
- Stable Specifications: Configuration, Runner Turn Flow, Multi-client User
  Messages, and Abort where clarification is required.
- Architecture Fitness tests for leaf ownership, retired field absence, and
  current authority.

No ADR update is required unless Delivery introduces a new module, changes the
accepted dependency direction, or cannot implement the single Runtime-owned
handoff.

Follow [Development Workflow](../../../governance/development-workflow.md).
