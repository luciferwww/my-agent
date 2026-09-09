# Module Spec: Approval Lifecycle

## Status

- **Status:** Accepted
- **Delivery:** Implemented and Validated
- **Version:** 0.1
- **Date:** 2026-09-01
- **Validation Date:** 2026-09-01
- **Owner:** 项目所有者
- **Related Plan / ADR:** [AF-04 Characterization and Fitness Plan](../roadmap/af-04-characterization-fitness-plan.md) CH-06；[Target Architecture](target-architecture.md) §8.4

项目所有者于 2026-09-01 接受本 Spec v0.1，并批准对应 Approval Lifecycle Architecture Slice 进入 Delivery。该 Slice 已于同日完成实现和验证；隐藏固定 120 秒 timeout-deny 仅作为 CH-06 迁移前证据保留，不再是生产行为。

## Purpose

将人工 Tool Approval 从“固定 120 秒后自动拒绝”改为 response-or-abort：未响应的审批保持 pending，不被解释为用户拒绝；用户明确决策、Turn Abort、Shutdown 或当前调用的交互能力失效时，审批以可分类结果恰好终结一次。

## Scope

- 移除 `TurnInteractionManager` 的默认 120 秒 timer、`defaultTimeoutMs` 配置和 timeout-deny settlement；
- 让每个 pending approval 观察对应 Turn 的 `AbortSignal`，并在 Shutdown 时先终结等待再等待 Turn convergence；
- 区分 approved、denied、aborted、unavailable 和 failed，不用 denied 代替系统生命周期结果；
- 将 interaction 结束通知从 expiry-only 语义改为携带明确 outcome 的 closure 语义；
- 同步 CLI、WebSocket、HTML client、测试和活跃架构文档；
- 保留 Application Tool Policy 的 deny、allowlist 和无 current-call approval capability 时 fail-closed 行为。

## Non-goals

- 不增加 `Allow all`、`Always allow`、approve-for-session 或持久授权；
- 不设计 Host-specific approval deadline、倒计时、延期或 expiry 策略；
- 不改变 allow/deny pattern、配置合并或 Tool 可见集合；
- 不增加 pending approval 跨进程持久化或断线重放；
- 不修改 Tool execution timeout、Hook deadline、Provider timeout 或 Shutdown convergence deadline；
- 不借本 Slice 完成完整 Tool/Hook/Policy ownership 重构。

## Boundaries and Dependencies

| Concern | Owner | Dependency / boundary |
|---|---|---|
| Tool Policy decision | Application Tool Policy | 仍只返回 deny、allow 或 requiresApproval；不拥有交互 timer |
| Approval pending lifecycle | Turn Interaction/Application boundary | 接收 request、Turn signal 和 Channel delivery result；恰好一次 settlement |
| Turn Abort / Shutdown | RuntimeApp Turn orchestration | 创建和触发 signal；Shutdown 必须先 Abort pending Turn work，再等待 in-flight convergence |
| Presentation and origin availability | Channel Adapter | 呈现请求、报告初始 delivery failure 和已投递 origin 的失效；不决定 Tool Policy |
| Tool outcome | Runner / Turn Execution | approved 才执行；denied/unavailable/failed 产生分类后的未执行 Tool Result；Turn Abort 终结 Turn |

`AbortSignal` 是生命周期输入，不进入可序列化的 Channel request，也不得由 Channel 创建或替换。Channel 只报告它拥有的 Transport/presentation 事实。

## Public Contract

以下联合类型冻结语义，不冻结最终命名或文件位置；实施 PR 可按现有命名习惯调整标识符，但不得合并 outcome：

```typescript
export type ApprovalResult =
  | { outcome: 'approved' }
  | { outcome: 'denied'; reason: 'user' | 'user_cancelled' }
  | { outcome: 'aborted'; reason: 'turn' | 'shutdown' }
  | {
      outcome: 'unavailable';
      reason: 'origin_missing' | 'delivery_failed' | 'origin_disconnected';
    }
  | { outcome: 'failed'; message: string };

export interface ApprovalRequestOptions {
  request: Omit<ApprovalRequest, 'id'>;
  signal: AbortSignal;
}

export type ApprovalClosedMessage = {
  type: 'approval_closed';
  id: string;
  outcome: 'aborted' | 'unavailable' | 'failed';
  reason: string;
};
```

Approval request 和 `approval_requested` WebSocket payload 不再包含 `timeoutMs`。`TurnInteractionOutcome` 不再包含 `expired`。现有 `sendInteractionExpired`、`sendApprovalExpired` 和 `approval_expired` 必须由携带 `aborted | unavailable | failed` outcome 的通用结束通知替代；旧 expiry-only 路径在同一 Slice 删除，不长期双写。

WebSocket closure notification 固定使用 `approval_closed` schema。它只表示未获得人工决策的终结；approved/denied 仍由提交请求的本地 UI 立即落状态，不额外发送 closure message。`reason` 使用对应 `ApprovalResult` 的稳定 reason，不使用面向日志的任意错误文本；failed 的诊断详情通过既有错误/日志边界提供。

Channel 的 request delivery 操作必须同步返回 accepted/unavailable，或抛出可映射为 failed 的异常。accepted 只表示本地 adapter 已接受呈现，不表示用户已批准，也不承诺远端 delivery acknowledgment。

Channel 必须能按 interaction ID 报告已投递 origin 后续失效。WebSocketChannel 只在当前逻辑 client socket 真正断开时报告 `origin_disconnected`；被相同 `clientId` 新连接取代的旧 socket 晚到 close 继续按现有规则忽略。由于本版本不做 pending request 重放，新连接接管不能恢复旧 approval。

相同 `clientId` replacement 已在旧 socket close 前成为当前逻辑 origin 时，旧 close 不产生 unavailable；如果新 UI 未保留旧 interaction ID，该 request 继续 pending，直到用户通过仍持有该 ID 的 UI 响应、Turn Abort 或 Shutdown。自动重放和 page-reload 恢复留给未来独立设计。

## Behavior

### Normal decision

1. Policy 返回 `requiresApproval`；
2. Runtime/Runner 将当前 Turn signal 与 request 一同交给 interaction lifecycle；
3. Channel 接受并呈现 request；
4. 用户提交 allow 或 deny；
5. manager 原子移除 pending entry 和 Abort listener；
6. allow 返回 approved 并执行 Tool；deny 返回 denied 并产生未执行 Tool Result；
7. late response 被忽略并记录诊断，不改变已完成结果。

### No response

只要用户未决策、Turn signal 未 Abort、Runtime 未 Shutdown 且 origin capability 未报告失效，request 保持 pending。经过 120 秒或任意 elapsed time 不产生状态变化、Tool 执行或自动 deny。

### Turn Abort and Shutdown

Turn Abort 触发 signal 后，manager 以 `aborted/turn` 终结对应 pending approval 并通知 Channel 关闭 UI。Runner 观察同一 signal，按既有 Turn Abort 语义结束，不把该 Tool 记录为用户拒绝。

Shutdown 必须遵循以下顺序：停止新 ingress，触发 active Turn signals，使 pending approval settlement，等待 in-flight Turn convergence，再停止 Channel。`TurnInteractionManager.close()` 只作幂等兜底并返回 `aborted/shutdown`，不得返回 timeout 或 user deny。

### Capability unavailable or failure

- request 创建时没有 current-call approval capability：沿用 Policy fail-closed，不创建 pending entry；
- route 在请求前消失或 Channel 拒绝 delivery：返回 unavailable；
- WebSocket origin 在 pending 期间断开且未被同 `clientId` 活跃 replacement 接管：返回 unavailable；
- Channel adapter 抛出非可用性错误：返回 failed；
- unavailable/failed 都不授权 Tool，也不伪装为用户 deny。

## Lifecycle and Resource Ownership

每个 pending entry 最多拥有一个 Abort listener 和 Channel origin binding，不拥有 timer。任意终态必须在一个原子 settlement helper 中完成：先从 pending map 删除，再解除 listener/origin binding，最后 resolve Promise 和发送 closure notification。重复、竞态或 late settlement 不得二次 resolve。

Root 与 Child Turn 都必须使用实际执行 Turn 的 signal。Child approval 不得只依赖 parent `turnId` 路由推断取消；父 signal 的既有级联必须直接到达 Child Runner 和对应 approval wait。

在目标 Slice 3 将 approval I/O 直接归还 Runner 前，本 Slice 允许一个窄的过渡契约：给 `BeforeToolCallPayload` 增加 `signal?: AbortSignal`，`AgentRunner` 只透传本次执行收到的 `RunParams.signal`，Runtime approval hook 再将同一 signal 传给 `ApprovalRequestOptions`。不得用 `turnId` 查询全局 AbortController，也不得让 Channel 创建 signal。后续 Runner-owned approval I/O 落地时删除这项过渡 Hook 字段。

Channel stop、Runtime close 和初始化失败不得遗留 pending Promise、readline prompt、socket interaction ID 或 listener。

## Errors and Concurrency

- 用户决策、Abort、origin disconnect 和 adapter failure 竞争时，首个成功从 pending map 移除 entry 的事件获胜；
- 同一 ID 的后续事件只记录 debug/warn，不改变 Tool Result、Turn outcome 或 Event；
- 不同 Turn 的 approval 独立；一个 origin disconnect 只终结绑定到该逻辑 origin 的 pending requests；
- approval wait 本身不重试、不自动重发、不变更 Policy；
- 日志必须记录 interaction ID、Turn ID、Session key 和 settlement outcome，但不得把 unavailable/aborted 记录为 denied；
- elapsed time 可用于观测日志或 metrics，但不能驱动本版本状态转换。

## Security and Capabilities

- 未收到 approved 前 Tool 不执行，因此无限人工等待不扩大权限；
- 无 current-call capability、delivery failure 和 disconnect 均 fail closed；
- `originClientId` 仍只用于定向交互，不能作为授权主体或 durable permission；
- `Allow all`、`Always allow` 等授权范围需要独立 Threat Model、Policy Contract 和审计语义，本 Spec 不预留隐式开关。

## Compatibility and Migration

1. 先扩展 approval wait 的 Turn signal 和 classified result tests；过渡期由 `BeforeToolCallPayload.signal` 直接透传 Root/Child 的实际执行 signal；
2. 替换 manager timer、expiry callback 和 close-as-timeout；
3. 更新 Runtime mapping 与 Shutdown 顺序，证明 pending approval 不阻塞 close；
4. 更新 CLI/WebSocket adapters，增加 delivery/unavailable 和 outcome-aware closure；
5. 更新 `clients/html/chat.html`，删除 timeout 展示并处理新的 closure outcome；
6. 将 `scripts/test-runtime-multichannel-integration.ts` 的 timeout-success 场景改为“120 秒后仍 pending，随后 Abort/Shutdown 收口”；
7. 更新 CH-06 测试：旧 fake-timer timeout-deny 断言替换为 pending + explicit Abort；
8. 同步活跃 Channel/Current Architecture 文档；旧 `docs/architecture/v1.0/**` 仅作为 Slice 6 disposition 候选，不保留为 Current authority，并在逐项 unique-value Review 后按最终 disposition 处理；
9. build 重新生成 `dist/` 时验证输出，但不手工编辑生成文件。

本 Slice 不保留 `defaultTimeoutMs`、approval `timeoutMs`、`reason: 'timeout'`、`Denied by timeout` 或 expiry-only adapter API。若发现外部未迁移消费者，必须在 Delivery 中停下并由 Owner 决定版本化兼容；不得静默长期双轨。

## Acceptance and Validation

- [x] fake timers 推进超过 120 秒后 approval 仍 pending，Tool 未执行且没有 deny/expiry Event；
- [x] allow 和 deny 各自恰好 settlement 一次，late response 无效；
- [x] Root Turn Abort 和 Child Turn 级联 Abort 都能立即终结 pending approval；
- [x] Runtime Shutdown 在 pending approval 场景可完成，不等待人工输入且不报告 timeout/user deny；
- [x] request 前 capability 缺失、delivery failure 和 WebSocket origin disconnect 分别返回 unavailable；
- [x] WebSocket 同 client replacement 的 stale close 不错误终结新连接拥有的 request，且 superseded socket 不能提交决策；
- [x] CLI pending prompt 在 Abort/Shutdown 后关闭且不接受 late input；
- [x] HTML client 不显示虚假倒计时，并能按 closure outcome 或 origin disconnect 关闭对应 UI；
- [x] CH-06 focused tests 和多 Channel integration 通过；
- [x] 相关 Runtime、Runner、CLI、WebSocket tests 通过；
- [x] `npm run lint`、`npm test` 和 `npm run build` 通过；
- [x] `git diff --check` 通过，活跃文档不再把默认 timeout-deny 描述为目标行为。

验证证据：Node.js v22.22.2（仓库 `engines.node` 与 `.nvmrc` 要求）下 `npm test` 为 63 files / 670 tests 全部通过；Approval 直接影响测试为 137/137，多 Channel integration 为 3/3；`npm run lint`、`npm run build` 与 `git diff --check` 均通过。VS Code `runTests` 宿主使用 Node 20 时会因 `better-sqlite3` ABI 115/127 不匹配失败，因此全仓门禁以仓库要求的 Node 22 终端结果为准。

## Open Questions

无。Host-specific deadline、可恢复 pending approval 和持久/会话级授权均作为未来独立设计，不阻断本 Spec 的接受。