# Runtime Steering and Runner Configuration Plan

> Status: Completed and Accepted
> Date: 2026-09-21
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Runtime Steering and Runner Configuration Specification](runtime-steering-and-runner-configuration-specification.md)
> Research input: [Runtime Steering 与 Runner 配置设计草稿](../../../research/runner-configuration-and-steering-design-draft.md)
> Decision: No new ADR proposed; this Change applies existing Runtime/Runner ownership and module-owned leaf configuration principles.
> Authorization: Delivery approved by the project owner on 2026-09-21.

## 1. Outcome

Replace the misplaced Runner steering mode with one Runtime-owned global
steering switch, make the Runner Model-call budget optional with no default
limit, preserve the existing one-call FIFO steering batch, and prevent steering
accepted near normal Turn completion from being silently lost.

## 2. Current state

- `runner.inTurnMessageMode: 'steer' | 'followup'` combines a Runtime admission
  policy with Runner execution configuration.
- `maxLlmCalls=12` exists both in Platform defaults and as a hidden Runner
  fallback.
- Runtime drains all steering visible at a safe boundary; Runner persists the
  messages separately and uses one continuation Model call for the batch.
- After Runner's final inbox read and before Runtime cleanup, a message can be
  classified and broadcast as steering but then removed without injection or a
  later Turn.
- `run_end.result.stopReason='max_llm_calls'` already exposes an explicit limit
  stop to clients, but HTML and CLI do not present a dedicated notice.

## 3. Scope

- Add Agent-level `runtime.steeringEnabled: boolean`, default `false`.
- Remove `runner.inTurnMessageMode` without an alias, migration reader, conflict
  rule, or field-specific compatibility error.
- Move the Runtime leaf configuration Contract and steering default to the
  Runtime module.
- Move the Runner leaf configuration Contract to the Runner module.
- Change `runner.maxLlmCalls` to an optional positive integer with no hardcoded
  default or Runner fallback.
- Retain explicit per-run and Subagent `maxLlmCalls` overrides.
- Preserve distinct FIFO steering messages and one continuation Model call for
  each ready batch.
- Add one Runtime-owned normal-completion handoff that promotes unread steering
  to ordinary queued Turns without duplicate `user_message` emission.
- Preserve original message identity, order, route context, and explicit launch
  overrides when promoted.
- Keep existing pending-steering discard behavior for Abort, thrown execution
  failure, Shutdown, and explicit `max_llm_calls`; a returned Provider
  `stopReason='error'` remains a completed Runtime result and uses the normal
  handoff.
- Let HTML and CLI use the existing `run_end.result.stopReason` to display a
  generic configured-limit notice without changing `RunResult`.
- Update focused tests, Fitness rules, Current Architecture, and stable
  Specifications.

## 4. Non-goals

- Channel-level or per-message `steer` versus `queue` selection.
- A dedicated Turn Coordinator or Conversation Scheduler module.
- Steering attachments.
- Concatenating multiple steering submissions.
- Interrupting an active Model request or Tool call.
- Soft budgets, automatic budget growth, Continue interaction, cost budgets,
  elapsed-time budgets, or hidden emergency fuses.
- New `RunResult`, Runtime Event, Agent Event, or Channel wire fields.
- Changing explicit Abort, Shutdown, thrown-failure, or Subagent outcome
  semantics beyond adapting to an absent parent Model-call limit.
- Migrating configuration ownership for Memory, Prompt, Context, Compaction,
  Subagent, Tool, or Logger modules.

## 5. Readiness gates

- [x] Current Runtime routing, queue, cleanup, and Runner injection paths are
  verified from source and focused tests.
- [x] External Agent behavior for steering batching and Model-call limits is
  recorded in the Research Draft.
- [x] Runtime ownership of steering policy/default is decided.
- [x] Runner ownership of Model-loop configuration is decided.
- [x] The public configuration shape and default behavior are decided.
- [x] Compatibility is decided: no old-field path.
- [x] Steering batch representation is decided: distinct FIFO messages, one
  continuation call.
- [x] Normal completion handoff is decided: promote to next-Turn FIFO.
- [x] Abort and explicit-limit disposition is decided: preserve discard.
- [x] Limit presentation is decided: existing stop reason, no result expansion.
- [x] The project owner accepts this Plan.
- [x] The project owner accepts the Specification.
- [x] The project owner explicitly approves Delivery.

## 6. Delivery slices

| Slice | Status | Outcome | Scope | Exit condition |
|---|---|---|---|---|
| RSC-0 Contract acceptance | Completed | The target Contract and delivery boundary are authorized | Review and accept Plan and Specification; explicitly approve Delivery | Completed 2026-09-21: Plan and Specification accepted; Delivery explicitly approved |
| RSC-1 Configuration ownership and cutover | Completed | Runtime and Runner own their leaf Contracts and defaults; Platform only composes them | `runtime.steeringEnabled`, optional `runner.maxLlmCalls`, strict leaf validation, old-field removal, default/fallback removal, caller and fixture migration | Completed 2026-09-21: 177 focused tests and TypeScript lint passed; no hidden 12-call fallback or old field remains |
| RSC-2 Steering terminal handoff | Completed | Every normally completed late steering message becomes one later queued Turn | Full pending input, one linearization point, normal promotion, FIFO/correlation/route preservation, Abort/failure/limit discard | Completed 2026-09-21: 72 focused Runtime tests passed, including FIFO promotion, correlation, routing, override, Abort, limit, Provider-error, and thrown-failure cases |
| RSC-3 Client presentation and authority transfer | Completed | Users can see explicit-limit completion and stable authority describes the implementation | HTML/CLI notice, Current Architecture and stable Specification updates, complete review and final validation | Completed and accepted 2026-09-21: automated gates, validation record, and owner closeout complete |

Only one Slice may be `In Progress`. Advancing a Slice requires the preceding
Exit condition.

## 7. Configuration cutover

The new Agent defaults shape is:

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

The default projection contains:

```ts
runtime: { steeringEnabled: false }
runner: {}
```

`runner.inTurnMessageMode` is not part of the new Contract. No Compatibility
Adapter recognizes it. Raw unknown fields continue through the general strict
configuration behavior rather than a special retired-field branch.

## 8. Validation strategy

### RSC-1 focused validation

- Runtime and Runner leaf Contract/default tests.
- Platform document parsing, strict leaf validation, default projection,
  per-Agent/environment/caller precedence, freezing, and unknown-field tests.
- Direct Runner tests proving omitted `maxLlmCalls` has no numeric cutoff and an
  explicit positive limit retains `max_llm_calls`.
- Runtime tests proving enabled, disabled, idle, and busy routing.
- Subagent tests proving an absent parent limit remains absent while a profile or
  caller limit remains effective.
- Fitness tests preventing Platform ownership or duplication of Runtime/Runner
  leaf Contracts/defaults.

### RSC-2 focused validation

- Existing ready-batch tests proving separate FIFO user messages and one
  continuation call.
- A controlled final-read race proving each accepted steering message is either
  injected once or promoted once.
- Promotion of multiple messages after any earlier queued items.
- Preservation of `originMessageId`, route context, explicit model reference,
  and explicit per-turn `maxLlmCalls`.
- No second `user_message` event during promotion.
- `run_start.originMessageId` correlation for a promoted message.
- New arrivals after the handoff route directly to the ordinary queue.
- Abort, thrown failure, `stopReason='aborted'`, `max_llm_calls`, and Shutdown
  preserve their existing discard behavior; a returned
  `stopReason='error'` follows normal handoff without retrying the Provider
  request.
- Cross-Session isolation and same-Session serialization.

### RSC-3 validation

- HTML and CLI presentation tests for `max_llm_calls`.
- Updated Configuration, Runtime, Runner Turn Flow, Channel/user-message, and
  Abort authority tests.
- `npm test`
- `npm run test:integration`
- `npm run test:fitness`
- `npm run lint`
- `npm run build`
- Environment smoke checks required by the changed client boundary.
- Independent review of the complete diff.

## 9. Stop conditions

Pause Delivery and return to design review if implementation requires:

- a new public Event, Result, Channel request, or wire field;
- a second queue or scheduler;
- attachment steering;
- changing Abort, Shutdown, failure, or explicit-limit discard semantics;
- a Compatibility path for `inTurnMessageMode`;
- moving unrelated module configuration;
- a dedicated orchestration module;
- loss or duplication of message identity, ordering, route context, or explicit
  launch overrides;
- more than one production steering admission path.

## 10. Closeout

- All Slices are completed.
- Current Architecture and stable Specifications own the delivered facts and
  Contract.
- The Research Draft is retained as non-authoritative evidence and links to the
  Active/Archived Change.
- The owner completes manual validation.
- Final gates run on the accepted final source state.
- A validation record documents executed checks and review disposition.
- The Change is archived and removed from the Active index.

Follow [Development Workflow](../../../governance/development-workflow.md).
