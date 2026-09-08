# Channel Module Spec

## 状态

- **状态：** Accepted
- **版本：** 0.2
- **日期：** 2026-09-08
- **所有者：** 项目所有者
- **Plan Item：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) Slice 4
- **关联 ADR / Spec：** [ADR-003](adr-003-progressive-architecture-migration.md)、[ADR-005](adr-005-extension-registry-runtime-composition.md)、[ADR-006](adr-006-legacy-and-compatibility-exit.md)、[Approval Lifecycle Spec](approval-lifecycle-spec.md)、[Tool 与 Hook Module Spec](tool-hook-module-spec.md)
- **证据输入：** [Target Architecture §8.5](target-architecture.md#85-channel-contributioncapability-与-lifecycle)、[Target Architecture §9.3](target-architecture.md#93-slice-16-迁移与删除边界)、[AF-04 Characterization / Fitness Plan](../roadmap/af-04-characterization-fitness-plan.md)、[Legacy Migration Inventory](legacy-migration-inventory.md)

本 Spec 遵循 [Development Workflow](../development-workflow.md)。它只为 Slice 4 建立新的 Channel Module 权威文档，不要求同步历史 Channel design、v1.0 文档或 Current Architecture 候选；这些文档的 authority/link 清理仍属于 Slice 6。项目所有者于 2026-09-08 接受 CM-OD-01..05 的全部推荐方案并接受完整 Spec。该接受不包含 production 修改、dependency 安装、commit、push 或 Slice 4 Delivery；进入 production Delivery 仍需单独明确授权。

## 1. 目的与用户可观察结果

Slice 4 建立唯一的 startup-configured Channel Module 路径：

- CLI、WebSocket Builtin 与 External Test Channel 通过同一 `RuntimeContributionUnit` registration/staging path 提供 Channel；
- Channel factory、identity 与 provenance 在 startup candidate 中校验，成功启动后才进入最终 immutable `RegistrySnapshot` 的 Channel projection；
- RuntimeApp 只消费窄的 routing/capability bindings，不保存 concrete Channel、factory、staging collector 或 lifecycle record；
- 单个 Channel 启动失败不会阻止其他独立 Channel 或无 Channel 的 core Runtime ready；
- 失败 Channel 的本次 partial resources 被清理，成功 Channel 在 Shutdown 时 close-once；
- Tool approval/interaction 只根据当前 Turn route 的 Channel capability 判定，不依赖进程曾启动过某个 Channel 的历史；
- 生产脚本不再直接 `new CliChannel()` / `new WebSocketChannel()`，也不再调用 `RuntimeApp.registerChannel()` / `startChannels()`。

用户可观察的 queue、Turn correlation、streaming、WebSocket protocol、CLI Ctrl+C、approval response-or-abort、Fanout、Abort 和 existing Shutdown ordering 除本 Spec 明确列出的 startup/failure 变化外保持不变。

## 2. 范围

- core-owned Channel Contribution、Channel Instance 与 narrow Runtime Binding contracts；
- `ExtensionRegistrationApi.registerChannel()`；
- startup candidate 中的 Channel factory projection、identity validation 与 unit 原子性；
- Channel create/start/rollback/handoff/stop lifecycle；
- final `RegistrySnapshot.channels` projection；
- CLI 与 WebSocket Builtin Channel Modules；
- 一个无外部 SDK/network 的 External Test Channel Extension fixture；
- RuntimeApp route context 从 concrete `Channel` 改为 narrow Channel binding；
- current-call interaction/approval capability binding；
- Channel outbound target 与 `onAgentEvent` observer 的 failure-isolated Fanout；
- CH-07 partial startup failure 的目标迁移；
- Channel stop failure 进入现有 Shutdown diagnostics/report；
- 迁移三个 production scripts 和相关 Runtime integration callers；
- 删除 API-E01 到期的 production concrete registration/start path。

## 3. 非目标

- dynamic enable/disable、reload、file watcher、candidate replacement、generation retirement、pending-latest 或 atomic runtime switching；
- Slice 5 的完整 Runtime Builder、两阶段 bounded Shutdown、overall Host deadline、force exit 或 protected pin retirement；
- marketplace、Extension filesystem discovery、Descriptor/module format 或 arbitrary hot loading；
- production 第三方聊天软件 SDK 接入；External Test Channel 只证明 Contract 和 change locality；
- generic DI Container、Service Locator、`register(any)`、string capability map 或 framework-managed Extension internal object graph；
- 多个同 identity Channel instance、per-Channel restart/stop/start 控制或运行期 health recovery；
- 新 Event Bus、durable delivery、outbound retry、receipt ledger 或 exactly-once network delivery；
- 重设计 `requestId` / `turnId` / `originMessageId` correlation；
- 修改 WebSocket wire protocol、CLI 文案/渲染或附件 pipeline；
- `Allow all`、`Always allow` 或 session/persistent approval；
- 同步、移动或删除历史/Legacy Channel 文档。

## 4. Verified Current Baseline

当前实现已具备可工作的 Adapter 与 Runtime behavior，但 assembly/lifecycle 仍有多条权威路径：

1. `src/adapters/channel/types.ts` 同时承载 Channel transport、optional interaction/approval 与 lifecycle contract；
2. `RuntimeApp.create()` 建立共享 mutable Channel array 和 Fanout closure；
3. `RuntimeApp.registerChannel()` 绑定 inbound、interaction、approval 与 Abort hooks；
4. `RuntimeApp.startChannels()` 使用 `Promise.all` 启动 concrete instances，任一失败会 reject，已启动 sibling 不 rollback，且 retry 因 flag 变成 no-op；
5. `RuntimeApp.stopChannels()` 对所有已注册而非仅成功启动的 Channel 调用 `stop()`；
6. `routeContextByTurn` 保存 concrete Channel reference；
7. `scripts/cli.ts`、`scripts/server.ts`、`scripts/websocket.ts` 直接构造、注册和启动 CLI/WebSocket；
8. Slice 3 `RegistrySnapshot` 只有 Provider、Tool、Hook projections，没有 Channel projection；
9. `CliChannel.start()` 当前把 readline 主循环作为长运行 Promise，`WebSocketChannel.start()` 则在 server listening 后返回，二者 readiness/completion 语义不一致；
10. 没有 production External Chat Channel；已有 external-chat fitness fixture 只有 identity，不是 lifecycle proof。

AF-04 已把上述行为固定为 migration baseline。Slice 4 替换 assembly 与 lifecycle authority，不在旧路径上增加第二套 registry 或 compatibility branch。

## 5. Ownership 与依赖方向

| 概念 | 权威 Owner | 禁止责任 |
|---|---|---|
| Channel Contribution / Instance / Runtime Binding contract | Stable Core / Channel Contract | Provider SDK、RuntimeApp private state、global Config |
| CLI/WebSocket transport implementation | Channel Adapter | queue、Turn identity、Tool policy、Session ownership |
| Builtin/External Channel Module | Runtime Module / Extension | 直接启动 transport、直接修改 RuntimeApp |
| registration/staging/final projection | Registry Builder | 执行 Turn、处理 client protocol |
| create/start/rollback/handoff/stop records | Channel lifecycle coordinator / Composition | 暴露 concrete instance 给 RuntimeApp |
| inbound correlation、queue、Turn route、Abort、semantic Fanout | RuntimeApp | concrete Channel construction、transport start |
| connection/client audience/local send semantics | Channel Adapter | core Runtime 存活决策、跨 Channel Fanout |
| current-call interaction capability | 当前 Turn route binding | global “any Channel supports approval” flag |
| process signal 与最终退出 | Runtime Host / existing CLI host behavior | Runtime library 直接发明新的 exit policy |

依赖方向：

```text
Builtin Channel Module / External Test Extension
  -> core-owned Channel Contribution contract
  -> startup Registry staging
  -> Channel lifecycle coordinator
  -> final immutable Channel projection
  -> RuntimeApp narrow routing/capability bindings

CLI/WebSocket Adapter
  -> core-owned Channel Instance contract
  -> node readline / ws transport
```

Stable Core 与 RuntimeApp 不导入 `ws`、`CliChannel` 或 `WebSocketChannel`。External Channel 不导入 RuntimeApp。

## 6. Canonical Channel Contracts

本节冻结语义，不冻结最终文件布局。实现可以拆分 `core/channel`、`runtime/channel-lifecycle` 与 Adapter files，但不得建立第二套权威 Contract。

### 6.1 Identity

- `unitId` 继续遵循 Slice 3 的 `^[A-Za-z0-9_-]{1,64}$`；
- Channel `contributionId` 在 startup candidate 中全局唯一，并使用同一 identity profile；
- 一个 Contribution 在一个 startup generation 只创建一个 Channel instance；
- Runtime-visible `channelId` 等于 `contributionId`，不允许 factory 返回另一个 identity；
- conflict resolution 继续使用 Builtin-first、External deterministic order，不依赖 registration call order；
- 新增同名不同配置 instance 不属于 Slice 4。

### 6.2 Channel Contribution

推荐最小逻辑形状：

```ts
interface ChannelContribution {
  readonly id: string;
  create(): ChannelInstance;
}

interface ExtensionRegistrationApi {
  registerTool(tool: Tool): void;
  registerHook<K extends HookName>(contribution: HookContribution<K>): void;
  registerChannel(contribution: ChannelContribution): void;
}
```

Slice 4 的静态 acquisition 入口为：

```ts
interface RuntimeAppOptions {
  readonly contributionUnits?: readonly RuntimeContributionUnit[];
}
```

Composition 将现有 Builtin Tool units 与调用方显式提供的 startup-only units 合并后，只执行一次 staging。三个 production scripts 通过 `contributionUnits` 传入 CLI/WebSocket Builtin Module；External Test Extension 使用同一入口。该入口不扫描 filesystem、不动态 reload，也不允许 RuntimeApp instance 在 ready 后追加 unit。

约束：

- `registerChannel()` 只记录 factory，不调用 `create()` / `start()`；
- factory 所需的 validated module config 与 private dependencies 在 Module acquisition 时由 closure 捕获；
- factory 不接收完整 `AppConfig`、RuntimeApp、Registry、Service Locator 或 arbitrary capability map；
- `create()` 可以抛出 classified startup failure，但不能开始接收入站消息；
- Contribution object、factory identity 和 provenance 在 staging 后冻结；
- Module 可同时贡献其他 kinds，但 Channel startup 失败时必须遵守 §8 的 unit 原子性。

Slice 4 不建立 generic Config Schema framework。`createCliChannelModule(config, dependencies?)` 与 `createWebSocketChannelModule(config, dependencies?)`（逻辑名称）在返回 `RuntimeContributionUnit` 前同步校验 transport-local config；production dependencies 仅允许对应 Adapter 构造所需的 I/O/transport dependency，test dependency 仅允许 deterministic fake。unit provenance 由外层 `RuntimeContributionUnit.id/source/orderKey` 提供，Contribution 不能覆盖。External config validation 属于 acquisition boundary；本 Slice 的 External fixture 直接取得已验证 typed config。

### 6.3 Channel Instance

推荐 canonical Instance 语义：

```ts
interface ChannelInstance {
  readonly id: string;
  send(event: AgentEvent): void;
  onMessage(handler: (request: ChannelRunRequest) => Promise<void>): void;
  readonly interaction?: ChannelInteractionTransport;
  bindAbortHooks?(hooks: AbortHookBindings): void;

  /** Resolve only when transport is ready to accept input. */
  start(): Promise<void>;
  /** Settle when the started transport naturally closes or stop completes. */
  readonly completion: Promise<ChannelCompletion>;
  /** Idempotent and safe after partial start. */
  stop(): Promise<void>;
}

type ChannelCompletion =
  | {
      readonly outcome: 'closed';
      readonly reason: 'input_closed' | 'transport_closed' | 'stopped';
    }
  | {
      readonly outcome: 'failed';
      readonly phase: 'startup' | 'runtime' | 'shutdown';
      readonly error: Error;
    };
```

Contract requirements：

- `start()` 表示 readiness，不表示 transport 的整个运行期；
- `completion` 与 readiness 分离，解决 CLI 和 WebSocket 当前语义不一致；
- `stop()` 在 create 后、partial start 后、successful start 后均安全，并由 lifecycle owner 最多调用一次；
- Adapter 内部 stop 可以幂等，但 Framework 不以重复 stop 作为正常控制流；
- post-start unexpected completion 只使该 Channel degraded，不使 core Runtime failed，也不修改当前 Snapshot；
- post-start automatic restart 留给后续设计；
- canonical Runtime path 只使用通用 `interaction` capability，不再对 `interaction` / legacy `approval` 两套接口分支；
- Adapter barrel 如需保留旧 type name，只能 re-export 同一个 core-owned Contract，不能复制类型或语义。

Lifecycle terminal rules：

| State / race | Required result |
|---|---|
| `create()` throws | no instance/completion exists；unit enters create failure |
| instance created | `completion` already exists and is pending before `start()` |
| `start()` rejects before readiness | instance settles `failed/startup`；coordinator invokes rollback `stop()` once |
| `completion` settles before `start()` fulfills or before handoff | treat as startup failure；exclude unit and rollback |
| `start()` fulfills while `completion` remains pending | instance is eligible for atomic ownership handoff |
| natural close after handoff | first terminal settles `closed/input_closed` or `closed/transport_closed` |
| unexpected transport error after handoff | first terminal settles `failed/runtime` |
| `stop()` requested while pending | successful stop settles `closed/stopped` unless another terminal outcome already won |
| post-handoff `stop()` rejects while pending | settle `failed/shutdown` and report the same failure under resource `channel:<id>` |
| natural close / failure / stop race | first terminal outcome wins；`completion` settles exactly once；cleanup still runs once |
| rollback `stop()` rejects | preserve original startup failure and add a separate rollback diagnostic |

`completion` result is immutable。`stop()` fulfillment does not overwrite an already-settled natural/failure outcome。

### 6.4 Narrow Runtime Binding

成功 handoff 后，RuntimeApp 只取得不含 factory/lifecycle 的 immutable binding：

```ts
interface ChannelRuntimeBinding {
  readonly id: string;
  send(event: AgentEvent): void;
  readonly interaction?: Pick<
    ChannelInteractionTransport,
    'sendInteractionRequest' | 'sendInteractionClosed'
  >;
}
```

Inbound、interaction response/unavailable 与 Abort hooks 在 ownership handoff 前由 coordinator 绑定到窄 Runtime ingress callbacks。RuntimeApp：

- 不调用 `create()` / `start()` / concrete `stop()`；
- 不读取 contribution source 或 Adapter class；
- 不保存 `ChannelInstance`；
- `routeContextByTurn` 只保存 `ChannelRuntimeBinding` 与 `originClientId`；
- 只在 origin binding 声明 `interaction` 时提供 current-call approval capability；
- 无 origin 或无 interaction 时保持 fail-closed `unavailable`。

## 7. Registration、Staging 与 Snapshot

### 7.1 Per-unit atomic staging

在现有 Tool/Hook staging 上加入 Channel collector：

1. 校验 unit identity/source/order；
2. 收集 Tool、Hook、Channel Contributions；
3. 校验各 kind identity、factory/function shape 与 local duplicates；
4. 校验 cross-unit global conflicts；
5. 整组进入 startup candidate 或整组拒绝。

Invalid Builtin registration/schema 继续 fail-fast。Invalid External registration 整组隔离并产生 `UNIT_INVALID` / `UNIT_CONFLICT` diagnostics，且不调用任何 Channel factory。

### 7.2 Candidate 与 final Snapshot

Slice 4 仍只有一个 startup generation，不实现运行期切换。Registry build 分为内部 candidate 与 final publication：

```text
acquire units
  -> atomic registration/staging candidate
  -> create/bind/start candidate Channel instances
  -> rollback failed units
  -> finalize accepted cross-kind units
  -> publish one immutable RegistrySnapshot
  -> open Runtime ingress and emit app_ready
```

最终 `RegistrySnapshot.channels` 只包含已成功启动并完成 ownership handoff 的 `ChannelRuntimeBinding`。Factory、concrete instance、completion resolver 和 lifecycle record 不进入 consumer projection。

**Cross-kind publication invariant：** 一个 unit 的 Tool、Hook、Channel Contributions 只有在该 unit 的所有 Channel instances 都达到 readiness、`completion` 仍 pending 且 ownership handoff 成功后，才一起出现在唯一 startup Snapshot。任一 create/start/pre-handoff completion/handoff/rollback failure 都使该 unit 的所有 kinds 对 consumer 不可见。测试必须用 deferred start barrier 证明 Channel starting 期间 Tool/Hook 尚不可观察。

Snapshot publish 前的 Runtime ingress 保持关闭。实现可使用 startup-only closed gateway 解决构造顺序，但不得缓存/执行早到的 Root request、发布半成品 Snapshot 或建立第二个 mutable Channel registry。

### 7.3 Slice 4 startup entrypoint 与 `app_ready`

`RuntimeApp.create(options)` 在 Slice 4 保留为唯一 public startup composition facade，冻结以下顺序：

1. 合并 defaults 与 `options.contributionUnits`，执行 candidate staging；
2. 创建 startup-only closed Channel ingress gateway 与 target-isolated Fanout；
3. 创建/bind/start candidate Channel instances；
4. rollback failed units，finalize/publish 唯一 startup Snapshot；
5. 用 final Snapshot、Channel runtime bindings、completion observer 和 shutdown-convergence handoff Port 构造 RuntimeApp instance；
6. 将 closed gateway 一次性 attach 到该 RuntimeApp 并永久 seal；
7. 由 `RuntimeApp.create()` composition facade 发出唯一 `app_ready` 后返回。

`bootstrapRuntime()` 不再提前发 `app_ready`，也不向 caller 暴露可运行的半成品 Runtime。zero-Channel path 经过同一顺序并发布 empty Channel projection。

`app_ready` 有意增加一个 additive field：

```ts
{
  type: 'app_ready';
  // existing fields remain unchanged
  channelIds: string[];
}
```

`channelIds` 只包含 successful handoff 的 Channel IDs，按 final projection deterministic order 排列；startup-failed/rolled-back IDs 不出现，zero-Channel 时为 `[]`。这是本 Slice 唯一新增的 `app_ready` compatibility change。

这里的 static `RuntimeApp.create()` 只是 Slice 5 前的 composition facade；RuntimeApp instance 本身不 acquisition/stage/create/start concrete Channel。

### 7.4 Channel projection

推荐逻辑形状：

```ts
interface ChannelProjection {
  readonly bindings: readonly ChannelRuntimeBinding[];
  resolve(id: string): ChannelRuntimeBinding | undefined;
}

interface RegistrySnapshot {
  readonly id: string;
  readonly providers: readonly ProviderProjectionEntry[];
  readonly tools: ToolProjection;
  readonly hooks: HookProjection;
  readonly channels: ChannelProjection;
  readonly diagnostics: readonly RegistryStartupDiagnostic[];
}
```

`resolve()` 是 pure lookup。Projection 不暴露 mutation、factory、start/stop 或 instance ownership。

## 8. Startup、Failure、Rollback 与 Handoff

### 8.1 Startup algorithm

- 各独立 accepted unit 的 Channel instances 可以并行 create/start；
- 同一 unit 的多个 Channel 共享 unit-level acceptance boundary；
- 在 `start()` 前完成 inbound、interaction response/unavailable 与 Abort binding；
- `start()` fulfilled 表示 transport ready；
- unit 内所有 Channel ready 后才原子 transfer lifecycle ownership；
- successful bindings 进入 final Snapshot；
- final Snapshot 与 startup diagnostics 完成后才发 `app_ready`；
- zero Channel 是合法 ready 状态。

### 8.2 Failure policy

不存在 required Channel，也不存在 required External Extension：

- create/start failure 不阻止其他独立 Channel unit；
- unit 内一个 Channel 失败时，该 unit 的所有已创建/已启动 sibling 都 rollback；
- failed unit 的 Tool/Hook/Channel Contributions 均不进入 final Snapshot；
- coordinator 对每个实际创建的 instance 调用一次 `stop()` 以清理 partial resources；
- cleanup rejection 与原始 start error 分别记录，不覆盖 root cause；
- Builtin Channel startup failure 与 External Channel startup failure 都是 degraded startup，不升级为 core Runtime fatal；
- invalid Builtin registration 或非 Channel required core dependency failure仍 fail-fast；
- Slice 4 adapters 必须保证 `stop()` settles；通用 bounded non-convergence policy 延后到 Slice 5。

结构化 startup diagnostic 至少包含：

```ts
interface ChannelStartupDiagnostic {
  readonly phase: 'create' | 'start' | 'rollback';
  readonly unitId: string;
  readonly contributionId: string;
  readonly source: ContributionSource;
  readonly message: string;
}
```

Diagnostics 必须进入 startup result/`RegistrySnapshot.diagnostics`，并产生可定位 warning。不得包含 secret、raw token 或 arbitrary serialized error object。

### 8.3 Post-start completion

- natural completion 或 transport failure settles `completion` once；
- completion 不动态删除 Snapshot binding，也不触发自动 restart；
- binding 后续 send 按 Adapter local unavailable semantics no-op/throw，Runtime Fanout 负责隔离；
- CLI EOF 的 completion 继续允许 CLI host 请求 graceful `app.close()`；
- WebSocket process signal policy继续由现有 Host script 负责；
- Runtime library 不调用 `process.exit()`。

为保持 CLI host 行为，Slice 4 必须提供：

```ts
interface ChannelCompletionObserver {
  waitForChannelCompletion(id: string): Promise<ChannelCompletion>;
}
```

`RuntimeApp.waitForChannelCompletion(id)` 只委托该只读 capability：同一 ID 的重复调用共享同一个 terminal Promise；successful start 后可观察 natural close、runtime failure 或 explicit stop；startup-failed Channel 返回已结算的 `failed/startup`；未知 contribution ID reject `CHANNEL_NOT_FOUND`。它不暴露 instance、`stop()` 或 restart。CLI script await `cli` completion，若为 natural input close 则调用 graceful `app.close()`；startup/runtime failure 进入现有 host fatal path。最终 Host/Runtime Composition API 收敛属于 Slice 5。

### 8.4 Slice 4 lifecycle bridge

Slice 4 只引入一个 startup-only `ChannelLifecycleSet`（逻辑名称）：

- startup coordinator 在 create/start 阶段临时拥有 concrete instances；
- successful handoff 后，`ChannelLifecycleSet` 成为唯一 lifecycle record owner；
- LifecycleSet 为每个已通过 staging 且进入 activation 的 contribution 建立 normalized completion record；create/start/pre-handoff failure 产生已结算的 `failed/startup` record，rollback 后丢弃 concrete instance 但保留该 immutable record；invalid registration 因未进入 activation，不建立 record；
- RuntimeApp instance 只取得 `ChannelRuntimeBinding[]`、`waitForChannelCompletion()` observer 与 `ChannelShutdownHandoff` Port；
- RuntimeApp 在自身 ingress/Turn/interaction convergence 和 final caller-facing Fanout 完成后，只向 `ChannelShutdownHandoff.runtimeConverged()` 提交一次 convergence 通知并等待结果；
- LifecycleSet 收到通知后自行决定 eligible instances，执行 close-once/all-settled 并返回 Channel lifecycle report；RuntimeApp 不选择 stop target、不调用 concrete `stop()`、不取得 instance list；
- Slice 5 将该 set 纳入完整 Runtime Builder ownership，不需要迁移 Channel Contract 或保留第二 set。

```ts
interface ChannelShutdownHandoff {
  runtimeConverged(): Promise<ChannelLifecycleReport>;
}
```

该 Port 表达 accepted Target 的 `RuntimeApp -> Builder: convergence report` 边界，不把 lifecycle coordination 转移给 RuntimeApp。

禁止在此 bridge 中加入 generation、reload、dependency graph、retirement、deadline scheduler、file watcher 或 dynamic mutation。`ChannelLifecycleSet` 不是 provisional general Runtime Builder。

### 8.5 Zero-Channel behavior

- `RegistrySnapshot.channels.bindings` 是 frozen empty array，`resolve()` 总是 `undefined`；
- `app_ready` 正常发出并包含空的 started Channel IDs；
- direct/library `runTurn()` 保持可用；
- Channel-origin current-call interaction capability 不存在并 fail-closed；
- `close()` 跳过 Channel stop 且不报告失败；
- `waitForChannelCompletion(unknownId)` reject `CHANNEL_NOT_FOUND`；
- zero-Channel 本身不产生 degraded diagnostic。

## 9. Shutdown

Slice 4 只收敛 Channel-owned lifecycle，不重做完整 Shutdown：

1. RuntimeApp 继续停止接收新工作并收敛当前 Turn；
2. RuntimeApp 完成 pending interaction settlement 和 final terminal Fanout 后，提交一次 `runtimeConverged()`；
3. lifecycle coordinator/recorded owner 只停止成功 handoff 的 instances，每个最多一次；
4. stop 使用 `allSettled` 隔离 sibling failure；
5. coordinator 返回 Channel lifecycle report；RuntimeApp 只把结果并入现有 `RuntimeShutdownReport.failed`，resource label 为 `channel:<id>`；
6. pending interaction 仍按 existing response-or-abort contract settle；
7. 重复 `close()` 共享同一过程。

两阶段 deadline、non-converged worker/pin、reverse dependency graph 和 Host overall deadline 均留给 Slice 5。

## 10. Builtin Channel Modules

### 10.1 CLI Builtin Module

`createCliChannelModule(options)`（逻辑名称）捕获现有 CLI typed config 并注册一个 `id = 'cli'` 的 Channel Contribution：

- stdin/readline 与 stdout rendering behavior 保持；
- blank input、handler error、Tool preview、user-message echo rules 保持；
- approval 使用 canonical interaction capability；
- Ctrl+C active Abort/queue drop 与 double-Ctrl+C exit behavior 保持；
- `start()` 改为 readline ready 后 resolve；主循环 terminal state 进入 `completion`；
- EOF 后 CLI host 观察 completion 并调用 graceful close。

Slice 4 不重新设计 `process.removeAllListeners('SIGINT')` 的既有 CLI host assumption。

### 10.2 WebSocket Builtin Module

`createWebSocketChannelModule(options)` 捕获现有 WebSocket typed config 并注册一个 `id = 'websocket'` 的 Channel Contribution：

- `hello`、`run_turn`、interaction response、`abort_turn` wire behavior 保持；
- client identity replacement、session audience、origin disconnect、subagent parent audience 与 protocol errors 保持；
- `start()` 在 server listening 后 resolve；
- `completion` 在 server close/unexpected terminal failure 后 settle；
- partial listen failure 可由 `stop()` 安全清理；
- 不把 `ws` type 泄漏到 Core、Registry 或 RuntimeApp。

### 10.3 Production scripts

三个 production scripts：

- 只选择并传入 Builtin Channel Module；
- 不 import concrete `CliChannel` / `WebSocketChannel`；
- 不调用 `registerChannel()` / `startChannels()`；
- 可保留 Host-owned argument/env parsing、console banner、SIGINT/SIGTERM 与 final `process.exit()`；
- CLI script 通过 completion observer 保持 EOF graceful close；
- WebSocket scripts 在 Runtime create resolved 时可认为 server ready。

## 11. External Test Channel Extension

Slice 4 添加一个无第三方 SDK、无网络、deterministic 的 External Test Channel unit。它必须：

- `source = 'external'`；
- 使用同一 `registerChannel()`；
- 经同一 identity/conflict/staging/start/handoff/stop path；
- 至少暴露 inbound、outbound 和 optional interaction 中两项；
- 维护一个 Extension-private sentinel/resource，Framework 不读取其成员或直接 close；
- 证明 normal start/stop、start failure rollback、sibling isolation 与 close-once；
- 证明加入 External Channel 不要求修改 RuntimeApp concrete branch；
- 不声称实现任何真实聊天软件 protocol。

## 12. Routing、Interaction 与 Fanout Preservation

### 12.1 Inbound 与 queue

保持：

- 同 Session Root Turn 串行、跨 Session 可并发；
- queued message 在 dequeue 前不调用 Runner；
- steering 只绑定入站时 active Turn；
- `sessionKey`、`clientId`、`originMessageId`、`turnId` correlation；
- active Abort + same-session queue drop、cross-session isolation；
- unread steering 在 Turn terminal 后清理，不转成下一 Root request；
- child events 映射回 parent audience。

Channel lifecycle 只改变 ingress binding 来源，不建立第二 scheduler。

### 12.2 Current-call interaction capability

- Turn route 保存 origin binding + `originClientId`；
- approval-required Tool call 只查询该 route 的 `interaction`；
- process 内其他 capable Channel 不得为当前 route 提供隐式 global fallback；
- origin missing/disconnected/delivery failed -> `unavailable`；
- Turn Abort/Shutdown -> `aborted`；
- user allow/deny -> submitted decision；
- late response 被忽略，settlement exactly once；
- authorization policy 不在 Channel Hook 或 startup history 中表达。

### 12.3 Fanout

- RuntimeApp 对 final `ChannelProjection.bindings` 做 direct semantic Fanout；
- 每个 target send 独立 `try/catch`，一个失败不影响 sibling、不改变 Turn result；
- `onAgentEvent` observer 同样 failure-isolated，只产生 diagnostic；
- 不引入 Event Bus、retry 或 delivery ledger；
- Channel Adapter 继续负责其内部 client audience 和 local serialization。

`onAgentEvent` 在 Slice 4 仍是 synchronous observer Contract。Runtime 对每个事件独立调用并捕获同步 throw；failure 只通过 Logger diagnostic 报告，至少包含 event type 和 sanitized message，不递归发另一个 Runtime Event。observer failure 不阻止 Runner start、不改变 Turn result、不影响后续 event。Async/thenable observer 不在本 Slice 支持范围，调用方不得依赖其 settlement。

## 13. Compatibility 与删除策略

API-E01 的 production callers 均在 repository 内可迁移，因此推荐 Slice 4 不保留 RuntimeApp Channel assembly compatibility：

- 删除 public `RuntimeApp.registerChannel()`；
- 删除 public `RuntimeApp.startChannels()` / `stopChannels()`；
- 删除 RuntimeApp 的 mutable concrete Channel array 和 `channelsStarted`；
- 删除 `MessageRouteContext.originChannel: Channel`；
- 删除三个 production scripts 的 concrete Channel construction；
- Runtime tests 与 integration scripts 改为贡献 Test Channel Module，不得反向使用旧 API 测试新路径。

2026-09-08 compatibility audit 未发现受支持的 external caller：package 声明的 root `dist/index.js` / `dist/index.d.ts` 不存在，且无 `exports`、publish contract、README/example package API、package-name import、sibling-workspace caller 或 tracked external consumer。`src/runtime/index.ts` 与 local ignored `dist/runtime/*.d.ts` 确实导出/声明这些 methods，旧架构文档也称其为 public API；这些证据说明它们是 TypeScript public surface，但未形成可工作的 package-root contract。基于已知 caller inventory，Slice 4 将其作为显式授权的 repository-internal breaking deletion，不保留 compatibility。该结论不声称未知外部消费者绝不存在；Delivery 前若发现 committed external caller，必须停止并重新决定 deprecation/compatibility，不得静默保留第二 authority。

允许：

- CLI/WebSocket Adapter unit tests 直接构造 concrete Adapter，以验证 transport-local behavior；
- adapter barrel 临时 re-export core-owned type alias，但不得成为第二份 Contract；
- `RuntimeApp.create()` 在 Slice 4 仍可作为调用 startup coordinator 的薄 composition entry，完整 Runtime Builder API 在 Slice 5 收敛；
- `RuntimeApp.close()` 可暂时提交注入的 `ChannelShutdownHandoff.runtimeConverged()` 并等待 lifecycle report，但不能选择 stop target、取得 instance list 或拥有 concrete stop authority。

不引入 Feature Flag。回退通过 commit/release rollback，不保留完整旧/新双路径。

Legacy 口径：`Legacy_start = 1`（API-E01），Slice 4 完成时要求 `Legacy_end = 0`。

## 14. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-CM-01 | Core owns one Channel Contribution/Instance/Binding contract；Core/Runtime 不 import concrete adapter 或 `ws` |
| AC-CM-02 | `registerChannel()` participates in the same per-unit atomic staging as Tool/Hook |
| AC-CM-03 | final startup Snapshot contains immutable successful Channel bindings and no factory/lifecycle authority |
| AC-CM-04 | CLI、WebSocket Builtin 和 External Test Channel 使用同一 staging/start/handoff/stop path |
| AC-CM-05 | `start()` means readiness；`completion` separately represents natural/terminal closure |
| AC-CM-06 | one Channel/unit startup failure rolls back that unit, reports structured degraded diagnostics, and does not block independent/zero-Channel Runtime ready |
| AC-CM-07 | only successfully handed-off instances stop，each close-once；sibling stop failures are isolated and reported |
| AC-CM-08 | RuntimeApp stores only narrow bindings；route context contains no concrete Channel/lifecycle record |
| AC-CM-09 | current-call approval/interaction depends only on origin route capability and remains response-or-abort/fail-closed |
| AC-CM-10 | CH-01/02/05/06/07/09 routing、queue、Fanout、approval 与 Abort target behaviors pass |
| AC-CM-11 | `onAgentEvent` observer failure no longer prevents sibling Fanout or Runner start |
| AC-CM-12 | production scripts contain no concrete Channel construction or old registration/start calls |
| AC-CM-13 | public `RuntimeApp.registerChannel/startChannels/stopChannels` production authority is removed without a second path |
| AC-CM-14 | WebSocket wire and CLI observable behavior remain compatible except normalized readiness/completion lifecycle |
| AC-CM-15 | no dynamic reload/generation retirement、general lifecycle graph、Event Bus、Service Locator or real external chat SDK is introduced |

## 15. Verification Plan

### 15.1 Contract / Registry

- valid Builtin/External Channel contribution staging；
- invalid identity、missing factory、duplicate local/global identity；
- mixed-unit registration atomicity；
- final projection immutability；
- failed External Channel unit removes all unit contributions；
- zero Channel Snapshot；
- no factory/start execution during registration。

### 15.2 Lifecycle failure injection

- create failure；
- start failure before readiness；
- one unit with a started sibling then another contribution fails；
- rollback stop rejection preserves root failure and records cleanup diagnostic；
- independent success survives sibling unit failure；
- successful binding close-once；
- stop failure isolated and reported；
- natural completion once；
- CLI EOF completion；
- WebSocket listening readiness and close completion。

Tests use deferred barriers/fakes，不使用 real external service、paid Provider 或 wall-clock sleeps。

### 15.3 Runtime integration

- inbound through Builtin/Test contribution reaches existing queue/Runner；
- same-session serialization and cross-session concurrency；
- origin route interaction only；
- origin disconnect/unavailable/Abort；
- multi-target Fanout and observer failure isolation；
- child audience routing；
- active Abort + queued drop；
- Shutdown stops only started bindings and reports failures；
- `app_ready` occurs after final Channel startup settlement。

### 15.4 Change-locality / Fitness

- FT-01：Stable Core/Runtime 不 import concrete Channel SDK；
- FT-02：`ws` 只在 WebSocket Adapter allowlist；
- FT-05：External Channel 不 import RuntimeApp/Config loader/Service Locator；
- FT-06：新增 External Channel fixture 不修改 RuntimeApp concrete branch；
- FT-07：Runtime consumer 只取得 readonly Channel projection；
- FT-08：Channel public Contract 有 positive/negative surface coverage；
- repository-wide deterministic audit：旧 `RuntimeApp.registerChannel` / `RuntimeApp.startChannels` / `RuntimeApp.stopChannels` definitions、exports 和所有 callers 为零；三个 production scripts 不再直接 `new CliChannel` / `new WebSocketChannel`。只有 CLI/WebSocket Adapter-local unit tests 可直接构造 concrete Adapter；Builtin Module factory 中的唯一 concrete construction 是新权威路径，不计 Legacy；
- focused tests、full Vitest、lint、build、document diagnostics 和 `git diff --check`。

## 16. Definition of Ready

- [x] Plan Item、目的、范围和非目标已起草；
- [x] Target Architecture、ADR-005、AF-04 和 Slice 3 Snapshot 提供 authority/evidence；
- [x] current production callers、lifecycle gap 和 tests 已定位；
- [x] 不需要新 Spike：现有 CLI/WebSocket 与 AF-06 fixture 已证明所需 primitives；
- [x] 项目所有者确认 §18 的五项 Proposed Decisions（全部按推荐方案接受，2026-09-08）；
- [x] independent Spec review 无未解决 Critical/High/Medium blocker（2026-09-08）；
- [x] 项目所有者接受完整 Spec 并将状态改为 `Accepted`（2026-09-08）；
- [ ] 项目所有者在接受 Spec 后另行批准 Slice 4 production Delivery。

DoR 完成前不得修改 production code、公共 Contract、dependency 或 legacy entry points。

## 17. Definition of Done

- [ ] AC-CM-01..15 均有自动化证据；
- [ ] CLI、WebSocket Builtin 与 External Test Channel contract suites 通过；
- [ ] final startup Snapshot/`app_ready` 只反映 successful Channel bindings；
- [ ] CH-05 observer isolation 与 CH-07 startup rollback 通过；
- [ ] routing、queue、approval、Abort、WebSocket protocol、CLI regressions 通过；
- [ ] API-E01 residual 为零；
- [ ] focused/contract/integration/regression/Fitness/lint/full tests/build/docs/diff checks 通过；
- [ ] 本 Spec 与必要的 active Plan status 同步；不批量同步历史/Legacy 文档；
- [ ] independent implementation review 无未解决 blocker；
- [ ] 项目所有者接受验证结果并确认 Slice 4 完成。

## 18. Accepted Decisions

项目所有者于 2026-09-08 接受 CM-OD-01..05 的全部推荐方案。

### CM-OD-01：移除旧 RuntimeApp Channel API

**推荐：接受删除，不保留 compatibility。** 2026-09-08 package/export/declaration/README/example/workspace caller audit 只发现 repository-internal relative imports、generated subpath declarations 和旧设计表述，没有 working package-root entry 或 external consumer。已知 production 与 integration callers 均可迁移到 Module Contribution；保留 startup-only adapter 会延长第二 assembly authority。若 Delivery 前出现新的 committed external caller evidence，则本决定自动回到 owner review。

### CM-OD-02：统一 readiness 与 completion

**推荐：`start()` 只表示 ready，新增 readonly `completion`。** 这是让 Builder 在 `app_ready` 前确认 startup、同时保持 CLI EOF graceful close 的最小模型。不要把 long-running task、readiness callback 和 stop promise 混为一体。

### CM-OD-03：Factory config 由 Module closure 捕获

**推荐：factory 零参数创建 instance。** CLI/WebSocket Module factory 接收 typed config，Contribution factory 捕获已验证 config；不把完整 Config 或 generic factory context 暴露给 Extension。

### CM-OD-04：External Channel 只做 deterministic test fixture

**推荐：不接真实聊天 SDK。** Slice 4 证明 External Contribution、lifecycle、failure isolation 与 change locality 即可；真实平台协议应由独立 feature/spec 引入。

### CM-OD-05：CH-05 observer failure isolation 同 Slice 4 收口

**推荐：收口。** Runtime Channel Fanout 已逐 target 隔离，但 `onAgentEvent` observer 仍可阻止 Runner。将 observer 作为另一个只读 Fanout target 并隔离失败，是完成 Target Fanout semantics 的局部修复，不需要 Event Bus。

## 19. Open Questions

若 CM-OD-01..05 按推荐接受，则无 blocking Open Question。Delivery 若发现以下任一事实，必须停止并回到项目所有者：

- CLI 无法在不改变 Ctrl+C/EOF user-visible behavior 的情况下分离 readiness/completion；
- External unit Channel startup failure无法在 final Snapshot publication 前保持 cross-kind atomicity；
- RuntimeApp 必须重新取得 concrete Channel/lifecycle owner 才能完成 current route interaction；
- 已知 repository 外 public caller 要求保留 `registerChannel/startChannels` compatibility；
- Channel cleanup 需要 bounded non-convergence、dynamic generation 或 general lifecycle dependency graph 才能安全完成；
- 实现需要新增 production dependency、真实聊天 SDK、Service Locator 或 Event Bus。
