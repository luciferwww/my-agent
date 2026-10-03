# Unified Async Tool Execution Framework Plan

> Status: Completed, Validated, Accepted, and Archived
> Date: 2026-09-30
> Accepted: 2026-10-02
> Archived: 2026-10-02
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-018](../../../decisions/adr-018-unified-async-tool-execution-and-completion-delivery.md)
> Specification: [Async Tool Use Specification](specification.md)
> Evidence: [Spike Results](spike-results.md)
> Research: [Async Tool Use Design Draft](../../../research/async-tool-use-design-draft.md)
> Authorization: 项目所有者于 2026-10-01 批准进入 Delivery，并于 2026-10-02 确认最终验收通过

## 1. Outcome

以统一 **Async Tool Execution Framework** 完整替换 Runner 当前的 direct-await Tool 调用框架。所有新接纳的 Tool 都通过同一 framework submit、调度、监督、取消、终态仲裁和交付；不保留普通同步 Tool、特殊后台 Tool或 Provider 专用执行路径。

原 Model Tool Call 在 Framework 接受执行所有权后收到一次 `accepted + executionId` 回执；真实执行由当前 Turn 的 framework 监督。用户可在执行期间 steering，终态通过可信 Host 完成通知自动交付给 Model。Turn 只在执行、取消、结果持久化、完成通知和 steering 全部收敛后结束。

Tool implementation API 可以继续返回最终 Promise；被替换的是 Runner 对 Promise 的 inline ownership 和 direct `await executeCanonicalToolCall()` 控制流。Chat Completions、Responses、Messages 的协议差异只存在于 history projection / Provider encoder，不进入 Framework 或 Runner 调度。

```text
Before:
Runner → await executeCanonicalToolCall() → terminal Tool Result → steering

After:
Runner → AsyncToolExecutionFramework.submit()
       → Turn event loop races steering / execution terminal / cancel / deadline / abort
       → batched automatic Host completion delivery after active executions converge
```

## 2. Problem and evidence

- 当前 [Runner](../../../../src/core/runner/AgentRunner.ts) 在 Tool 循环中直接 await 完整执行，完成后才检查 steering。
- 当前 [Runtime](../../../../src/runtime/RuntimeApp.ts) 只提供同步 claim 回调；新消息无法唤醒正在等待 Tool 的 Runner。
- Relay Chat/Responses 实测拒绝未配对 Tool Call 后直接追加 steering；仅将调用隐藏在控制投影虽可用，但历史合并复杂。
- Relay Chat/Responses 和 SiliconFlow Messages 均已通过：accepted 闭合、期间 steering、普通 Host completion、自动 Model continuation。
- Gemini CLI 固定源码链证明后台 handle 先闭合原调用、完成后普通消息注入并条件触发父模型是实际生产模式。

证据只证明请求形态和有界控制机制；不证明任意不合作扩展可强制停止，也不授权生产修改。

## 3. Scope

- Async Tool Execution Framework API、execution registry、concurrent Promise scheduling and Turn supervision。
- Runtime-owned global Tool execution slots with per-execution non-waiting reservation。
- Core execution ID、accepted receipt、终态、activity、fixed Host deadlines、cancel 和 trusted completion contracts。
- Runner integration that removes direct Tool Promise awaits and drives a serialized Turn event loop。
- Runtime FIFO wake signal plus existing atomic steering claim。
- Session persistence、reload/recovery、History projection 和 compaction protection。
- Provider-neutral Host completion message and Chat/Responses/Messages encoders。
- public events、CLI/Web History task lifecycle presentation and Extension API changes。
- Root Abort、single-execution cancel、idle/total deadline、shutdown and late-result arbitration。
- Four-state terminal Tool Result、History/UI lifecycle and inline Approval migration。
- `task` remains one Child per Tool Call; multiple same-response `task` calls use the same Framework Promise concurrency instead of a Subagent-specific batch wrapper。
- Per-call incremental admission and response-local Provider pairing barrier; no array-form submit API。
- Foreground/background/yield exec integration, ProcessRegistry ownership transfer and Host shutdown cleanup。
- Concrete activity sources for foreground exec, task, MCP and Extension Tools; no synthetic heartbeat。
- Pending admission/pairing-barrier Turn gating and same-Turn ordered before-hook chains。
- Fixed ProcessRegistry capacity/output/retention bounds and Session-scoped process access/cleanup。

## 4. Non-goals

- 不支持无所有者 detached execution 或持久化外部 job 恢复；显式 `exec(background=true)` / `yieldMs` handoff 由 ProcessRegistry 负责，nonconverged Tool Promise 只允许转移到 Runtime quarantine。
- 不要求 Model 使用 collect/wait 轮询结果。
- 不允许同一 Provider call ID 接收 accepted 和终态两个结果。
- 不承诺撤销已发生的外部副作用或任意 in-process Tool 的硬终止。
- 同一次 LLM call 输出的 1–N 个 Tool Uses 默认并发；不维护额外 group 实体。依赖调用必须由 Model 等待 HostTaskCompletion 后在后续 LLM call 中发出。
- activity 不携带百分比、文件数或正文，不允许 Parent 代报。
- 不为 Provider 在 Runner 增加分支，不保留旧 direct-await/sync 执行路径或 Feature Flag 双路径。
- 不把 Spike 的 tagged prompt 直接定为最终安全编码。
- accepted receipt 不是第五个 Tool Result terminal status。
- 不新增 `task` children array、Subagent batch aggregator 或第二套并发调度器。

## 5. Ownership

| Owner | Responsibility |
|---|---|
| Core Tools | execution context activity/cancel surface and implementation final Promise; `task` delegates one Child per invocation |
| Async Tool Execution Framework | execution registry, identity, exclusive supervision membership, Promise concurrency, independent settlement, activity clocks, cancel/deadline races and completion delivery |
| Runner | submit admitted calls, drive Model/Framework event loop, canonical persistence order, serialized steering/completion continuation |
| Runtime | Session FIFO, compatible-prefix atomic claim, wake notification, global execution-slot accounting/reservation, Root Abort/Shutdown cascade, quarantine registry and disabled Tool-registration admission block |
| Session | accepted/Host completion structural records, reload, recovery, branch/History/compaction preservation |
| ProcessRegistry | post-handoff exec background/yield process ownership, fixed active/output/terminal bounds, Session-scoped status/log/kill, Session deletion and bounded Host-shutdown cleanup |
| System Prompt / Model Invocation / Provider adapters | same-call concurrency/dependency rule; canonical Host message and accepted receipt to protocol wire; no execution lifecycle |
| Channels / Extension API | one task lifecycle, four-state terminal presentation, inline Approval and control; no status inference from text |

The Framework may be implemented under Core Runner ownership, but it must be an explicit module with its own contract and tests, not more branches inside the existing monolithic `runAttempt()` body. Runtime must not execute Tools; Provider adapters must not observe Promises or Framework state.

## 6. Delivery slices

| Item | Status | Work | Exit condition |
|---|---|---|---|
| ATU-1 | Completed | Accept ADR/Spec; define single-call Framework API, pending-admission/pairing gate, ordered before-hook stage, fixed Host policy, structural records, supervision invariants, shared completion reserve, Root-Abort boundary and Tool activity surface | exact mapping/failure matrix and persistence validation tests accepted |
| ATU-2 | Completed | Implement staged per-call admission, Framework registry/Promise scheduler/event source, Runtime per-execution slot reservation/quarantine and replace Runner direct-await execution | same-call calls leave ordered Hook stage then progress independently; no array submit, capacity queue or inline Tool await |
| ATU-3 | Completed | Implement accepted and Host completion canonical projection for Chat/Responses/Messages; provider contract tests | all encoders preserve legal pairing and trusted origin; no Provider-specific Runner branch |
| ATU-4 | Completed | Implement reload/recovery, de-duplication, compaction protection, max-call budget and multi-call behavior | crash/retry/late result/compaction tests prove no replay, loss or double delivery |
| ATU-5 | Completed | Migrate public events, four-state Tool Result, Extension/activity API, bounded Session-scoped ProcessRegistry handoff/cleanup, CLI/Web task card and inline Approval | accepted/running/terminal lifecycle, managed processes and approval controls are consistent live and after History reload |
| ATU-6 | Completed | Cross-boundary regression, independent review and authority synchronization | targeted/full gates and manual smoke pass; old direct-await production framework removed; owner accepted outcome |

No item remains In Progress. ADR and stable Specification retain authority; all Delivery slices are complete, the project owner accepted the outcome on 2026-10-02, and this Change is archived.

## 7. Readiness and blockers

- [x] Provider pairing problem reproduced with real requests.
- [x] Unified accepted + Host completion shape tested across three protocol forms.
- [x] External production pattern traced end to end.
- [x] Ownership direction and no-dual-path requirement confirmed by project owner.
- [x] ADR-018 accepted.
- [x] Reopened Specification re-accepted by the project owner on 2026-10-01.
- [x] Noncooperative direction selected: Abort grace, outcome_unknown, Runtime quarantine entry transfer and Tool-registration disablement; no false stop claim.
- [x] Reopened detailed contract reviewed and accepted: Runner-owned admission/pairing gate, Framework-only execution work predicate, ordered before-hook stage, single-call submit, batched completion budget, Root-Abort and max-budget non-consumption, bounded Session-scoped ProcessRegistry, activity sources, Hook projection, quarantine transfer and Approval event order.
- [x] Multi-call concurrency semantics selected: 1–N Tool Uses from one LLM call run concurrently without a maintained group entity; dependency waits for HostTaskCompletion and a later LLM call.
- [x] Host capacity semantics selected: global slots reserved per execution without waiting; capacity failure affects only that Tool Use.
- [x] Slot limit selected: process-global non-configurable `MAX_TOOL_EXECUTION_SLOTS = 8`, rendered into System Prompt; quarantines retain slots.
- [x] Deadline policy selected: fixed Host constants idle 5 minutes, total 1 hour, cancellation grace 10 seconds; no Tool hint or configuration override.
- [x] Model-call budget selected: one shared reserve, ready completions may piggyback on steering, and the completion-only call waits for all active executions.
- [x] Root-Abort delivery selected: no later Model call; persist `turn_aborted` and trailing Host completions for the next non-aborted Turn.
- [x] Exec ownership selected: foreground remains Framework-owned; background/yield hand off to ProcessRegistry; Host shutdown performs bounded cleanup.
- [x] Activity sources selected: real exec output, Child lifecycle, MCP progress and Extension reports only; no synthetic heartbeat.
- [x] Admission gate selected: pending admissions and incomplete Provider pairing retain the shared reserve and block Turn settlement; Root Abort closes every gap.
- [x] Before-hook concurrency selected: complete chains serialize per Turn in Provider order; post-Hook validation/policy/approval proceed independently.
- [x] ProcessRegistry bounds selected: 8 active managed processes, newest 1 MiB output per process, 32 retained terminal records.
- [x] ProcessRegistry ownership selected: Session-scoped access; fork inherits none; Session deletion and Host shutdown clean up; restart restores none.
- [x] Project owner approves Delivery.

## 8. Validation strategy

- Framework Unit: execution-only `hasUnsettledWork()`, ordered same-Turn before hooks, independent post-Hook approval/capacity, slot reservation/release, Promise concurrency, 5m idle/1h total/10s grace fake-clock boundaries, activity sources, cancel/complete races, structural terminal/delivery records, registry supervision invariants, quarantine transfer, late-result isolation, Root Abort and shutdown.
- Runner contract: composite `hasTurnOwnedWork()`, pending admission/pairing wake, steering wake/claim, completion during Model call, all-active completion batching, one shared budget reserve, last-call Tool rejection, canonical append ordering, terminal gate, Usage and events.
- Session: new records, `turn_aborted`, final Assistant `turnStopReason: 'max_llm_calls'`, missing/unavailable result-batch repair, disk reload, invalid data, fork, tail recovery, terminal-without-delivery, accepted-without-terminal, exactly-once projection.
- Provider: actual request bodies for Chat Completions, Responses, Messages and Relay; legal same-call and next-Turn max-budget Tool Result pairing, concurrency prompt projection, Host message origin not leaked as user authority.
- Compaction: accepted pair atomicity, undelivered completion retention, delivered completion summarization, no replay.
- Channel/Process: pre-admission requested card, callId-correlated deny/allow event sequences, accepted/running/success|error|denied|aborted, reload consistency, process-local disabled-registration restart behavior, foreground/background/yield ownership, 8/1 MiB/32 bounds, Session isolation/fork/deletion, cancellation controls and no duplicate collect card.
- Security: user text cannot forge Host origin; malicious Tool output remains untrusted data; no credentials or hidden internal state in events.
- Final Gate: affected Unit/Integration/Fitness, `npm run lint`, `npm run build`, document links/whitespace, independent code review, bounded live conformance where explicitly authorized.

## 9. Authority synchronization and closeout

On accepted Delivery, update [Runner](../../../architecture/runner.md), [Session](../../../architecture/session.md), [Runner Turn Flow](../../../specifications/runner-turn-flow.md), [Tools and Hooks](../../../specifications/tools-and-hooks.md), [Abort](../../../specifications/abort.md), and affected Channel/Extension contracts. ADR-017 remains authority for FIFO ownership except the explicitly refined terminal boundary.

Spike scripts remain evidence and must not be imported by production code. Research remains source discussion and points to this Change; the Plan/Specification become the only active delivery contract.

## 10. Delivery validation record

Delivery completed on 2026-10-01 with these final gates:

- `npm run lint`: passed for the root package and both workspaces.
- Unit: 109 files, 1238 tests passed.
- Integration: 7 files, 22 tests passed.
- Architecture fitness: 13 files, 43 tests passed.
- `npm run build`: TypeScript build, Host build audit (348 files), and Relay verification (6 files, 92 tests) passed.

Independent review found and Delivery fixed six convergence/correlation defects before the final gates: fatal terminal-persistence convergence, retryable Session/process cleanup ordering, lazy shutdown cleanup under an expired deadline, lifecycle-aware fork leaf caching, per-call admission event publication, and inline Approval pending/disconnect handling. Targeted regression tests cover each corrected boundary.

Manual smoke validation on 2026-10-01 used the local Relay with an isolated Agent Home:

- CLI: a real Exec Approval was allowed, the card progressed through Tool use to successful result `ASYNC_CLI_SMOKE_OK`, and trusted completion automatically continued the Model to `ASYNC_CLI_SMOKE_DONE`.
- WebSocket browser: inline Approval showed the correct pending badge and composer gate; Allow progressed `Running → Succeeded`; Deny progressed to `Denied` without command output; both paths automatically continued the Model.
- Browser reload reconstructed the same `Succeeded` and `Denied` cards from persisted History.
- Disconnect during pending Approval removed decision controls, cleared the pending gate, displayed `Approval unavailable`, and reloaded as a persisted failed/unavailable completion without executing the command.

The disconnect smoke exposed and Delivery fixed one final presentation defect where the live card retained the stale `Approval required` badge after controls were closed. The WebSocket Channel regression suite (41 tests), `npm run lint`, and `npm run build` passed after the fix.
