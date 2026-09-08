# Runtime Composition Module Spec

## 状态

- **状态：** Accepted
- **版本：** 0.2
- **日期：** 2026-09-08
- **所有者：** 项目所有者
- **Plan Item：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) Slice 5
- **关联 ADR / Spec：** [ADR-003](adr-003-progressive-architecture-migration.md)、[ADR-005](adr-005-extension-registry-runtime-composition.md)、[ADR-006](adr-006-legacy-and-compatibility-exit.md)、[Model Resolution Module Spec](model-resolution-module-spec.md)、[Subagent Model Resolution Module Spec](subagent-model-resolution-module-spec.md)、[Tool 与 Hook Module Spec](tool-hook-module-spec.md)、[Channel Module Spec](channel-module-spec.md)
- **证据输入：** [Target Architecture §7](target-architecture.md#7-registry-snapshot-and-lifecycle-transactions)、[Target Architecture §8](target-architecture.md#8-runtime-call-flows-and-ownership)、[AF-06 Extension Framework Spike Results](af-06-extension-framework-spike-results.md)、[Legacy Migration Inventory](legacy-migration-inventory.md)

本 Spec 遵循 [Development Workflow](../development-workflow.md)。项目所有者于 2026-09-08 授权在 Slice 4 checkpoint 后继续 Slice 5 planning，随后确认 RC-OD-01..07 的全部推荐方案并接受完整 Spec。该接受不包含 production Delivery、dependency 安装、commit、push 或 Slice 6；进入 production Delivery 仍需另行明确授权。

## 1. 目的与用户可观察结果

Slice 5 把 startup composition、运行中已加载单元的 enable/disable、Registry generation、Turn pin、retirement 和 Shutdown 收敛为一个权威 Runtime Composition 路径：

- Runtime Builder 构建并发布完整、跨 Provider/Tool/Hook/Channel 的 immutable Registry Snapshot；
- Root Turn 在真正开始时捕获一个 generation，Child Turn 继承 Parent generation，同一 Turn tree 不观察混合版本；
- 已加载 Runtime Unit 的 enable/disable 在 publish 前隔离失败，在 publish 后不因旧 generation retirement 失败回滚新 Snapshot；
- 任一时刻最多有一个 current generation、一个 retiring generation、一个 pre-publish candidate 和一个 pending-latest request；
- RuntimeApp 不再发现 Module、拼装 Task Tool、保存固定 startup Snapshot 或拥有 Channel/Module instance stop authority；
- Runtime Builder 聚合 RuntimeApp convergence 与 instance lifecycle 结果，返回唯一、结构化 Shutdown Report；
- 正常关闭有界；不响应 Abort 的 Turn 保留 generation pin，受保护 instance 不被强停；
- Builtin 与 External Unit 在 acquisition 后共享同一 staging、publish、retirement 和 stop 机制。

用户可观察的 Session queue 串行化、跨 Session 并行、Tool/Hook 顺序、Channel route/Fanout、approval、Subagent Parent/Child 语义、Provider wire behavior 和 Usage 归属，除本 Spec 明确列出的 generation、canonical intake、reload 与 bounded Shutdown 变化外保持不变。

## 2. 范围

- 一个 authoritative Runtime Builder 和一个 production composition path；
- 已取得、已加载 Unit 的 factory/instance、registration、readiness、ownership handoff 和 stop records；
- Provider/Tool/Hook/Channel cross-kind candidate 与 immutable Registry Snapshot；
- monotonic process-local generation 与 atomic current publication；
- Root capture、Child inheritance、Turn-tree pin 与 release-once；
- loaded Unit 的 enable/disable Reload Request、terminal result 和 latest-wins coordination；
- pre-publish cleanup、post-publish Generation Retirement、drain 与 Abort convergence；
- startup dependency order 与 reverse dependency stop；
- RuntimeApp convergence port、Builder lifecycle report 和 Host boundary；
- two-stage bounded Shutdown、public completion gate 与 late completion suppression；
- Provider projection/Model Resolver 的 per-generation consumption；
- Subagent Task Module 的最终 common-path assembly；
- CODE-E03 与 API-M01/API-M02 的到期迁移；
- production scripts、direct/library callers、WebSocket client/tests 和 integration scripts 的真实迁移；
- 对 startup-only `buildRegistrySnapshot()` wrapper、`ChannelLifecycleSet` 和 duplicate close authority 的删除。

## 3. 非目标

- filesystem watcher、运行中重新扫描 `<agent-home>/extensions`、任意代码热加载或重新执行 Extension entry；
- same-identity version replacement、in-place code upgrade、同 identity 多 instance 并存；
- 多个 retiring generation、并行 reload transaction、通用 scheduler 或通用 transaction framework；
- marketplace、安装/卸载、Descriptor filesystem format、Schema migration 或跨平台 discovery；
- general DI Container、Service Locator、arbitrary token lookup 或 Framework-managed Extension internal object graph；
- Runtime Builder 调度 Turn，或 Runner/Builder 建立第二个 queue；
- RuntimeApp、Runner 按 Provider/Channel/Extension concrete type 分支；
- 自动 Channel restart、health recovery、durable Event Store、exactly-once network delivery；
- 强停仍受 generation pin 保护的 instance；
- retirement failure 后的在线人工恢复 API；本 Slice 只 fail closed 并要求 restart/Shutdown；
- 重设计 Tool、Hook、Channel、Session、Prompt、Compaction 或 Subagent 业务语义；
- 批量同步、移动或删除历史/Legacy 文档；该工作保留到 Slice 6；
- Runtime library 自行调用 `process.exit()`。

## 4. Verified Current Baseline

Slice 4 checkpoint 后的 current production baseline：

1. `RuntimeApp.create()` 建立 Channel host/Fanout closure、调用 `bootstrapRuntime()`、取得 startup resources、完成 approval wiring 并发布 `app_ready`；
2. `bootstrapRuntime()` 同时负责 Config/Logger/Workspace/Session/Memory/Provider/Resolver/Runner/Subagent/Task/Contribution staging/Channel activation，责任边界过宽；
3. `RuntimeContributionUnit` 只有同步 `register()` recipe，没有可动态创建、readiness、handoff、dependency 或 instance-level stop Contract；
4. `stageRegistryCandidate()` 与 `finalizeRegistrySnapshot()` 已提供 startup candidate/final Snapshot primitives，但 `RegistrySnapshot.id` 固定为 `startup:1`；
5. `buildRegistrySnapshot()` 是 startup-only compatibility wrapper，仍被部分测试直接使用；
6. `ChannelLifecycleSet` 单独拥有成功 Channel stop，`RuntimeApp.close()` 又直接关闭 Session/Memory 等 disposables，存在 duplicate lifecycle authority；
7. `RuntimeResourceSet.registrySnapshot` 和 `ModelResolver` 固定在 startup generation；Parent 与 Child resolution 不能消费 generation-pinned Provider projection；
8. `SubagentExecutor` 通过 closure 读取稍后赋值的 startup Snapshot，Task Module 在其他 units 收集后由 bootstrap 追加；
9. Root queue item 没有稳定 `requestId`；queued request 在启动前只有 `originMessageId`，无法满足 request-only Shutdown terminal correlation；
10. `runTurnInternal()` 总是读取同一个 startup Snapshot，没有 generation capture/pin；Child record 也没有 generation；
11. `RuntimeApp.close()` 先 Abort active Root、无界等待全部 in-flight Promise，再关闭 interaction/Channel/disposables；不存在 graceful-drain deadline、Abort-convergence deadline、protected-pin residual 或 late semantic outcome sealing；
12. production scripts 各自拥有一次 signal guard 并直接 `process.exit()`，没有共享 overall Host deadline 或 second-force signal policy；
13. `RunTurnParams.model/maxTokens` 与 WebSocket 同名 fields 仍是 Compatibility Candidate，没有 canonical `ModelReference` / `RequestOverride` public boundary；
14. Slice 3/4 已删除 central Tool setter、RuntimeApp Channel lifecycle APIs 和 concrete production Channel construction；Slice 5 不得重新引入这些路径。

以上是迁移 baseline，不是目标 Contract。AF-06 已在 disposable graph 中验证 P4-E01..P4-E07；当前没有需要再次执行 Architecture Spike 的未决并发 primitive。

## 5. Ownership 与依赖方向

| 概念 | 唯一 Owner | 禁止责任 |
|---|---|---|
| acquisition input / loaded Unit catalog | Composition Root / Runtime Builder input | RuntimeApp 扫描 filesystem 或加载代码 |
| per-unit staging / conflict / candidate Snapshot | Runtime Builder | consumer 修改 Registry；Unit 部分发布 |
| current generation / candidate / retiring / pending slots | Runtime Builder | RuntimeApp/Runner 保存 mutable Builder state |
| Root/Child tree、capture、pin、queue、route、Abort | RuntimeApp | Builder 调度 Turn；Runner 捕获 current Snapshot |
| immutable Tool/Hook/Channel/Provider projection | Registry Snapshot | kind-specific registry 独立 publish/version |
| Model Resolution | generation-pinned resolver/projection | 共享 Resolver 原地换 Provider projection |
| Runtime Unit instance lifecycle | creator（handoff 前）/ recorded Owner（handoff 后） | Framework 管理 Unit 内部 connection/cache/SDK client |
| semantic Fanout 与 caller completion gate | RuntimeApp | Channel/Builder 改写 Turn outcome |
| aggregated lifecycle/Shutdown report | Runtime Builder | 单个 stop failure 跳过独立 eligible instance |
| signal、overall deadline、force exit | process Host | Runtime library 自行退出进程 |

目标依赖方向：

```text
Host / embedded caller
  -> authoritative Runtime composition entry
  -> Runtime Builder
       -> loaded Unit factories
       -> staging + lifecycle ledger
       -> immutable Registry generation
  -> RuntimeApp narrow dependencies
       -> Snapshot capture/pin port
       -> Runtime convergence port
       -> Channel completion/query port
  -> Runner / Resolver consume one Turn-pinned generation

Runtime Unit / Extension
  -> core-owned Contribution and Lifecycle contracts
  -> no RuntimeApp private state or arbitrary service lookup
```

RuntimeApp 不持有 Runtime Builder、mutable Registry、staging collector、Loader 或 lifecycle ledger。允许注入的 composition-facing对象必须是职责单一的窄 Port；持有 projection/binding 不产生 stop authority。

### 5.1 Non-Unit runtime resources

并非所有startup collaborator都强制伪装为Runtime Unit。Builder使用同一private ownership ledger记录以下process resources，并把结果聚合进Shutdown Report：

| Resource | Creator / handoff Owner | Shutdown order / contract |
|---|---|---|
| Logger adapters | Builder创建并保持process-resource Owner | 最后关闭；所有其他stop/report日志完成后调用一次`Logger.close()`；failure进入report |
| MemoryManager | Builder创建，成功后handoff给Builder process-resource record；RuntimeApp只持使用Port | Turn/pin convergence后、Logger前close once；startup partial failure由creator cleanup |
| SessionManager | Builder创建，RuntimeApp拥有Session语义；当前无process-level `close()` Contract | RuntimeApp先完成queue/Turn/temporary Child Session convergence；无虚构stop。未来若引入close，须记录为process resource |
| TurnInteractionManager | RuntimeApp内部Application resource | stop ingress后立即settle/close pending waits；在graceful drain前完成；不作为Unit instance |
| AgentRunner / Prompt builders / Context values | Builder构造的无close collaborators/immutable values | 无stop；引用在RuntimeApp/Builder close graph结束后释放 |
| Workspace initialization / loaded Context | startup operation/value | 无长期Owner或close；失败仅走startup rollback |

RuntimeApp不直接枚举/关闭Memory、Logger或Unit instances；它只关闭自己拥有的interaction/queue/Turn状态并向Builder返回convergence report。Builder按显式startup dependency记录停止Unit和process resources，不建立通用DI container。

## 6. Canonical Composition Contracts

本节冻结语义和必要 public discriminants；最终文件拆分可在 Delivery 中局部决定，但不得产生第二套权威 Contract。

### 6.1 Loaded Unit 与 instance

- acquisition 向 Builder 提供 deterministic loaded Unit catalog；每项具有稳定 `unitId`、`source`、`orderKey` 和 instance factory；
- Builtin/External 的差异只存在于 acquisition metadata 和已接受的冲突优先级；factory 之后使用同一 lifecycle/staging path；
- enable 只引用 catalog 中已加载的 `unitId`，不得触发 filesystem scan、dynamic import 或 entry re-execution；
- factory 每次只为一个 candidate 创建至多一个 instance；同 identity active 时在 factory 前返回 `no-op`；
- instance 在 private collector 上注册 Provider/Tool/Hook/Channel Contributions；Unit 仍按整体校验、接受、隔离和 retirement；
- instance 可以声明对其他 Unit 的显式 required dependency；未知、循环或被隔离的 required dependency 使该 candidate fail closed；
- startup 按 dependency topological order start，同层 deterministic order；stop 按 reverse dependency order；
- creator 在 handoff 前保留 rollback responsibility；handoff 后 ledger 中恰有一个 recorded lifecycle Owner；
- `stop()` 必须可重复调用但成功只记录一次；Builder 不读取或管理 instance 内部 resource membership。

每个 instance 在 lifecycle ledger 中具有稳定的 process-local `instanceId` 和以下单向状态：

```text
created -> starting -> ready -> handed-off -> stop-pending -> stopped
                                           \-> stop-failed
```

- publish 只允许引用已 `handed-off` 的 instance；handoff failure 仍是 pre-publish failure，由 creator cleanup；
- `stop-failed` 保留同一 Owner、error 与 residual，不回到 active，也不创建替代 instance；
- 正常 retirement 对一个 instance 至多发起一次 stop attempt；Shutdown 可对 eligible、unpinned 的 `stop-failed` instance 再发起一次有界 retry；
- repeated/concurrent Shutdown 共享同一 operation，不产生并行 retry；retry 成功进入 `stopped`，再次失败保留更新后的 residual；
- `stopped` 不再调用 `stop()`，也不能重新加入 candidate；后续 enable 必须由 factory 创建新 instance。

### 6.2 Registry Snapshot 与 generation

每个 published Snapshot 至少包含：

- process-local、从 `1` 开始单调递增的 integer `generation`；
- immutable Provider、Tool、Hook、Channel typed projections；
- accepted Unit identities 和用于 retirement/diagnostic 的 immutable provenance；
- publish 前形成的 immutable startup/reload diagnostics。

`RegistrySnapshot.id = startup:1` 被 `generation` 取代，不保留双重 identity。generation 不持久化、不跨进程比较，也不表示 Extension version。

Snapshot publication 是唯一 commit point：

- candidate 在 publish 前对 consumer 不可见；
- current pointer 的切换与新 Root capture 具有单一线性化先后；
- publish 前失败保持 current、ingress 和现有 pins 不变；
- publish 后 request 已成功，retirement failure 不回滚 current 或改写该结果；
- Tool/Hook/Channel/Provider 不得独立发布或拥有不同 generation。

### 6.3 Instance identity、generation membership 与 stop eligibility

generation 与 instance 不一一对应：candidate 对 identity/config/Contributions 均未变化的 Unit 复用 current instance及其 immutable bindings，不重新 create/start；发生 enable、disable、依赖变化或 conflict winner变化的 Unit才改变instance set。

Builder ledger为每个 handed-off instance维护不可变identity和当前 `generationMemberships` 集合：

- publish commit在同一critical operation中把N+1 membership加入复用/新增instances，并把current pointer切换到N+1；
- retirement完成或明确进入failed residual前，N membership仍可定位；
- Snapshot只保存immutable bindings/provenance，不保存stop handle；membership与stop authority只存在于Builder private ledger；
- Tool/Hook function binding、Provider invocation binding与Channel runtime binding均按所属Unit instance复用，不因Snapshot object变化复制lifecycle ownership；
- instance只有在不属于current generation、不属于candidate、所有引用它的old generation pins为零、且尚未成功stop时才eligible；
- shared instance只从retired generation移除membership，不能因N retirement而stop；其current N+1 membership继续保护它；
- protected membership不是Extension内部object reference count；Builder仍不检查instance内部资源。

retirement与Shutdown测试必须分别覆盖unchanged Provider、pure Tool/Hook Unit和active Channel Unit在N/N+1间复用、旧membership移除及零额外start/stop。

generation ledger状态为`current | retiring | retired | failed-residual`。Retirement finalization是coordinator内的单一同步operation：

- N pins归零后，shared instance只移除N membership；N+1 membership保持；
- N-only instance成功stop后移除N membership；无stop资源等价于成功no-op；
- 所有membership/stop obligations成功终结后，N进入`retired`，清除retirement gate并启动当时pending latest；
- 任一pin不收敛或N-only stop失败时，N进入`failed-residual`：已成功stop的instance立即清除mechanical stop obligation；shared/current instance只保留N的diagnostic membership；仍pinned instance保留protection membership；stop-failed instance保留唯一可由bounded Shutdown retry消费的stop obligation。pending latest返回`blocked`并清空，future reload永久`blocked`；
- `retired`是唯一打开下一次reload的retirement终态；`failed-residual`只由bounded Shutdown retry尝试清理，不重新开放reload。

### 6.4 Snapshot capture、publish 与 coordination Port

Runtime Builder内部拥有唯一的`CompositionCoordinator`语义边界。它不是通用scheduler；只串行化composition state machine命令并提供两个**同步、无`await`**的critical operations：

- `captureRootGeneration()`：检查ingress、读取current、在Builder ledger原子增加一个generation pin并返回immutable Snapshot/pin handle；
- `commitPublish()`：验证candidate全部instance已handoff，更新generation memberships，切换current并建立retiring state。

reload admission、candidate slot、pending-latest、retirement transition和Shutdown admission由同一private FIFO command tail/mutex串行；异步create/start/drain/stop在critical section外执行，完成后以带expected state/version的命令重新进入。critical operation中禁止调用user/Extension code、Fanout或任何Promise。

JavaScript event loop内，同步capture与同步publish不可交错：先进入者完整完成。Builder/coordinator只拥有current pointer、generation membership和pin count的机械账本；RuntimeApp是Root/Child tree membership以及pin acquisition/release时机的语义Owner。`captureRootGeneration()`是两者间唯一cross-boundary atomic operation：RuntimeApp在创建Root record时调用，coordinator同步登记一个generation pin并返回只允许RuntimeApp最终release的handle。Child只增加RuntimeApp内的tree member，不增加第二个Builder generation pin；最后一个tree member真实收敛时，RuntimeApp release该Root handle恰好一次。

Shutdown admission通过同一coordinator设置`closing`：

- `closing`先设置时，后续Root capture/reload admission拒绝；
- publish critical operation先开始时，publish完整commit，随后Shutdown把新generation纳入closing graph；
- pre-publish async candidate阶段收到Shutdown时，不进入publish，转candidate cleanup；
- Child registration不读取current；它只在RuntimeApp tree tracker中从active Parent pin增加tree member，因此不与publish竞争current pointer。

production-shaped barrier tests必须覆盖capture-before-publish、publish-before-capture、shutdown-before-publish、publish-before-shutdown和Child-after-publish五种顺序。

RuntimeApp 只取得以下语义能力：

- Root Turn 在 queue dequeue/start transition 原子捕获 current Snapshot 并建立 tree pin；
- Child Turn 从已登记 Parent record 继承完全相同的 Snapshot/generation；
- pin handle release 幂等，并在整个 Turn tree 最后一个成员真实收敛后恰好记账一次；
- RuntimeApp 可按 generation 查询并 Abort 仍持 pin 的 tree，并返回 blocking request/turn identities；
- Builder 只能经 Runtime convergence Port 请求 stop-ingress、drain、Abort 和 report，不访问 RuntimeApp private maps。

queued Accepted Request 不是 Turn，不捕获 Snapshot、不分配 `turnId`、不持 pin。caller input 被接受时必须分配稳定 `requestId`；Root 开始时再分配 `turnId` 并记录 correlation。

### 6.5 Canonical Parent intake

API-M01/API-M02 到期后，Parent/library/WebSocket 使用同一语义输入：

- optional `modelReference` 使用 core-owned `ModelReference`；
- optional `requestOverride.maxOutputTokens` 使用 Model Resolution 已允许的 Request Override；
- 删除 legacy `model` 和 `maxTokens` fields，不提供 alias、dual-read 或 Feature Flag；
- WebSocket wire 同步使用 `model_reference` 与 `request_override.max_output_tokens`；unknown legacy fields 按现有 strict validation 拒绝；
- queued item 保存 canonical input，不在 enqueue 时 resolve Model；
- Model Resolution 在 Root 捕获 generation 后使用该 Snapshot 的 Provider projection执行；
- Child 独立解析自己的 Model Reference，但必须使用 Parent-pinned generation。

### 6.6 Host/embedded composition control

authoritative composition entry返回一个`RuntimeHandle`，其中职责分离为：

- `application`：RuntimeApp的run/intake/query能力；不暴露enable/disable；
- `composition`：readonly `RuntimeCompositionControl`，只提供`enableUnit(unitId)`、`disableUnit(unitId)`并返回§9 Reload Result；
- `close(reason?)`：进入Builder-owned cooperative Shutdown并返回聚合report；
- Channel completion等Host查询通过独立readonly观察Port暴露，不授予lifecycle stop权。

control只接受loaded catalog中的`unitId`，不能传factory、Config、Contribution或arbitrary service。process Host、embedded caller与tests使用同一control；RuntimeApp/Runner/Channel不能自行调用reload。`RuntimeApp.create()`作为唯一convenience entry返回该handle并内部委托Builder；不再返回可直接拥有composition lifecycle的bare RuntimeApp。

## 7. Authoritative Startup Flow

Startup 顺序固定为：

1. Composition Root 读取/解析 process inputs，并构造 deterministic loaded Unit catalog；
2. Runtime Builder 建立 lifecycle ledger 和 RuntimeApp kernel 所需窄 Host/Port；此时 ingress closed；
3. 创建 Runtime-owned queue/Turn/Fanout/Session collaborators，但不向 RuntimeApp 注入 mutable Registry/Builder；
4. Builder 按依赖顺序创建、注册、校验并启动 startup Unit instances；External invalid unit 整组隔离，required Builtin/core composition failure fatal，Channel failure遵循 Channel Spec degraded semantics；
5. Provider、Tool、Hook、Channel 与 Task Module 全部在同一 candidate 内完成；不允许 publish 后追加 Task/Tool/Hook/Channel；
6. candidate readiness 完成后，creator把每个成功instance的唯一Owner record handoff给Builder ledger；handoff失败时不构建/publish Snapshot并由creator cleanup；
7. Builder只从全部已handoff bindings finalize generation `1` Snapshot，再通过`commitPublish()`原子更新memberships/current；publish之后不再执行可能失败的ownership handoff；
8. RuntimeApp 完成 route/approval/Fanout wiring；
9. 开放 Channel/Root ingress并产生一次 `app_ready`；`app_ready` 只反映 generation `1` final Snapshot；
10. 任一步失败按 creator/recorded Owner 逆序 cleanup，返回 attributable startup diagnostics，不留下 active ingress 或 unowned instance。

`RuntimeApp.create()`保留为现有caller的唯一convenience entry并返回§6.6 `RuntimeHandle`；它只能委托authoritative Builder，再由Builder构造内部RuntimeApp并注入最终窄dependencies。不得在该entry或返回后发现、追加、注册或启动Unit，也不得并列新增第二个`createRuntime()` production path。

focused startup test必须在handoff boundary注入failure，证明generation未发布、ingress未开放、creator cleanup恰好一次且其他已handoff instance由ledger逆序停止。

## 8. Turn Generation 与 Model/Task Consumption

- Root 的 linearization point 是从 per-session queue 取出并创建 active Root record 的同一个 critical transition；
- capture-before-publish 使用 N，publish-before-capture 使用 N+1，不允许 undefined/mixed state；
- Root 的 Tool/Hook/Provider-facing Model Resolution/Channel projection 全部来自同一 captured Snapshot；
- `ActiveParentTurn`/tree record增加`requestId`、`generation`、immutable Snapshot、tree pin handle、Provider/Tool/Hook projections和effective Model Reference；
- Child registration必须从matching active Parent record继承同一Snapshot和tree signal，先增加tree member再执行任何async setup；失败/Abort/finally release该member恰好一次；Root在最后一个tree member真实收敛时释放generation pin；
- `SubagentExecutor` 不使用稍后赋值的 closure 或全局 current getter；它接收 Child 的 inherited projections；
- Task Tool 通过 Runtime-owned Child Turn Port 注册为普通 Builtin Module；Builder 不知道 Subagent execution loop，RuntimeApp 不在 publish 后追加 Task Tool；
- per-generation Provider projection产生不可变 Model Resolver binding；不得 mutate shared `ModelResolver`；
- Turn public outcome 已 sealed 但 worker 尚未收敛时，pin 持续到真实 worker completion/finally，不能因 caller Promise 已结算而提前释放。

必须有真实Subagent integration：Parent在N执行，publish N+1后创建Child；Child的Provider resolve、Tool definition/execution和Hook均来自N，而同时启动的新Root使用N+1。

## 9. Reload Request 与 Terminal Result

### 9.1 Request

一次 request 只表达一个已加载 Unit 的 `enable` 或 `disable` intent：

- Builder 在接受时分配稳定 `requestId`；
- unknown Unit、required Builtin disable、invalid dependency change 在 candidate 前或 validation 阶段 `rejected`；
- enable current active identity 或 disable current absent identity 返回 warning + `no-op`；
- no-op 不创建 instance、candidate generation 或 retirement；
- request 不携带 arbitrary factory、Contribution、Config 或 service token。

### 9.2 Result union

每个 accepted request 必须恰好 settle 为以下一个 terminal outcome：

- `published`：新 generation 已原子发布；包含 previous/current generation、requested change、连带进入 retirement 的完整 Unit 集合和 warnings；
- `no-op`：desired state 已满足；包含 warning；
- `rejected`：自身 candidate 在 publish 前失败且 cleanup 收敛；current unchanged；
- `superseded`：在 publish 前被更新 request 覆盖；后续 cleanup failure 不改写此结果；
- `blocked`：因已记录 candidate cleanup/retirement nonconvergence 未开始；包含同一 attributable blocker；
- `shutdown/cancelled`：Shutdown 阻止尚未 publish 的 request。

所有结果携带 `requestId`。failure/result diagnostics 使用 stable category 和 structured fields，不把 Error message 作为 control flow。已 publish result 永不因 retirement/stop failure改写。

## 10. Reload Coordination 与 Atomic Publish

- 正常状态最多一个 active candidate；candidate 之外最多一个 latest request slot；
- active transaction 尚未进入 publish 时，新 request 替换 latest slot，被覆盖 request 立即获得 `superseded`；
- 当前 candidate 先 Abort/cleanup；只有 cleanup 在 candidate deadline 内收敛后，才从仍有效 current 执行 latest；
- candidate cleanup nonconvergence 保留 attributable residual，清空/settle slots，并在本进程内阻断 future reload；
- publish critical section 不可中断；进入 publish 后先完成 commit，再处理 Shutdown 或更新 request；
- publish 后旧 generation 成为唯一 retiring generation；reload transaction 本身完成；
- retiring 存在期间不启动 candidate，更新 request 只覆盖 sole pending-latest slot；
- retirement 成功后从当时 current 执行 pending latest；失败则 pending `blocked` 并清空，future reload `blocked`；
- dynamic conflict 复用 Builtin-first、External deterministic order；result 显式列出 winner、loser、连带 retirement 和 warning；
- 不允许 arrival order、registration call order 或 filesystem enumeration决定冲突。

## 11. Generation Retirement

publish N+1 后，N retirement 顺序固定为：

1. N 不再接受新 Root capture；已 pinned N trees 继续执行；
2. N+1 立即可接受新 Root，不因 N drain 阻塞；
3. 等待 N pins 到达 bounded retirement drain deadline；
4. deadline 到达后通过 Runtime convergence Port Abort N trees；
5. 在独立 bounded retirement Abort-convergence deadline 内等待真实 pin release；
6. pins 全部归零后，只停止不再被 current/其他 protected generation 使用的 eligible instances；
7. stop 按 reverse dependency order；一个 stop failure 不跳过依赖上独立且 eligible 的 instance；
8. 任一 pin 未收敛时保留 N Snapshot 所需 instances，不强停，并报告 generation/unit Owner/blocking request/turn；
9. stop 或 pin nonconvergence 不回滚 N+1，但使 retirement fail closed并阻断后续 reload；
10. unchanged instance 不因 generation 变化重复 start/stop。

每个 instance 的 successful stop 最多一次；Shutdown 可以对先前 failed/nonconvergent stop 做一次有界重试，但不得重复已成功 stop。

## 12. Two-stage Shutdown 与 Host Policy

### 12.1 Runtime/Builder cooperative Shutdown

重复 `close()` / Shutdown request 共享同一 Promise/result：

1. Builder 关闭 reload intake，清空 pending latest为 `shutdown/cancelled`；
2. publish 已进入 critical section 时先完成；否则 Abort/cleanup pre-publish candidate；
3. RuntimeApp 停止 Root/Child ingress；queued request 经 public completion gate 按 `requestId` 恰好结算一次，不伪造 `turnId`；
4. 所有 pending approval/interaction wait 立即 settle 为 shutdown/aborted；
5. Channel outbound/Fanout 暂时保持可用，active trees 获得 bounded graceful drain；
6. drain deadline 后 Abort remaining trees，并等待独立 bounded Abort convergence；
7. deadline 后仍未收敛的 caller outcome seal 为 `shutdown/non-converged`；late worker completion只记 diagnostic，不再产生第二个 terminal event/outcome；
8. RuntimeApp 返回 completed/aborted/non-converged trees、pins、queued settlement 和 Fanout failures；
9. Builder 在 caller-facing terminal Fanout 后，逆序 stop 所有无 pin eligible instances；Channels 在最终 terminal Fanout 后停止；
10. Builder 聚合 candidate/current/retiring/protected pin/instance stop结果，返回唯一 Shutdown Report。

### 12.2 Deadline policy

所有 deadline 使用monotonic clock，通过显式policy输入且测试使用deterministic manual clock/barrier，不使用wall-clock sleep。推荐production phase caps：

- candidate cleanup：5 秒；
- retirement graceful drain：30 秒；
- retirement Abort convergence：10 秒；
- Shutdown graceful drain：30 秒；
- Shutdown Abort convergence：10 秒；
- process Host overall cooperative window：60 秒，包含 candidate handling、两阶段 convergence、terminal Fanout、instance stop 和 report allowance。

60秒是Host cooperative policy cap，不承诺每个phase都取得完整独立预算。Shutdown开始时建立唯一absolute monotonic deadline；每个phase实际预算为`min(configured phase cap, overall remaining)`：

- 已运行的reload/retirement停止使用自己的后续完整预算并被纳入Shutdown remaining budget；
- candidate cleanup先消费至多5秒，剩余时间传给graceful drain；
- graceful drain、Abort convergence、terminal Fanout、eligible stop和report依次只消费remaining；
- remaining为零时不启动新的可选工作，把未完成candidate/pin/instance标记为attributable residual并向Host返回deadline-exhausted report；
- nonresponsive Promise以deadline race脱离等待，但其late settlement只能更新diagnostic/释放真实pin，不重开report；
- standalone reload/retirement未进入Shutdown时，分别使用其candidate 5秒、drain 30秒和Abort 10秒caps。

单元/embedded caller可以注入不同policy或overall deadline；值必须为有限正整数并在startup validation fail closed。Runtime library不因deadline到达强停protected instance或调用`process.exit()`。测试必须覆盖candidate、existing retirement、graceful drain、Abort convergence、Fanout和stop各阶段耗尽remaining budget。

### 12.3 Process Host

- 首次 SIGINT/SIGTERM 请求 cooperative Shutdown；
- 第二次 forceable signal 是明确的运维 override，可以立即结束 process；Host 尽力记录尚未结算 request/protected instance，但不得伪装成功；
- overall deadline 到达后 process Host 可以以失败 exit code 强制退出；
- CLI EOF/Channel completion 仍走 cooperative Shutdown；
- embedded/library caller只接收 Shutdown Report并自行决定后续。

### 12.4 Shutdown report completion gate

Builder为每次共享Shutdown operation维护独立的report completion gate。正常全部phase完成或overall deadline耗尽，两者竞争一次seal：

- seal时以当时ledger/runtime facts构建完整immutable report，明确`completed | deadline-exhausted` overall outcome；
- 所有尚未settle的candidate cleanup、Fanout、pin、stop Promise在report中成为known residual，含Owner/phase/identity；
- deadline seal后不启动新的optional Fanout/stop/retry，不等待nonresponsive Promise，并立即把同一sealed report返回Host/embedded caller；
- 已启动operation的late completion只能更新internal diagnostics和真实pin/lifecycle safety state，不修改sealed report、不重开Shutdown Promise、不发第二个semantic terminal event；
- report construction本身不调用user code且在coordinator同步snapshot facts后完成；Logger close只能使用remaining budget，超时则作为residual记录。

tests必须让terminal Fanout、instance `stop()`和candidate cleanup分别不响应，断言deadline时report仍settle一次、内容冻结且late completion不改写。

## 13. Public Completion Gate、Error 与 Diagnostics

- 每个 accepted caller request 具有一个 atomic public completion gate；completed、failed、aborted、queued shutdown 和 shutdown nonconverged竞争一次 terminal transition；
- 第一个 transition唯一地结算 caller Promise并产生最多一个 semantic terminal event；
- late worker只能更新 internal diagnostic，并在真实 finally 中释放 pin；
- `requestId` 从 intake 起存在；`turnId` 只在 Root/Child真实创建后存在；
- errors 至少分类为 startup staging/validation/readiness/publish、reload rejected/superseded/blocked、retirement drain/abort/stop、shutdown queued/nonconverged/stop；
- candidate/retirement/shutdown residual 至少含 generation（如有）、requestId（如有）、unitId、Owner、phase、blocking turn identities 和 normalized message；
- diagnostics 不能泄漏 Provider SDK/Channel transport private Error type、secret、Config namespace之外的值或 arbitrary internal object；
- single observer/Channel send failure保持隔离，并进入 report/diagnostic而不改写 Turn/Reload结果。

### 13.1 `requestId` 与 `originMessageId`

两者不互相替代：

- `originMessageId`继续标识Channel收到并fanout的`user_message`，保持既有message-to-run correlation；
- `requestId`标识一次caller-facing Root work acceptance与completion lifecycle；direct `runTurn()`和每个non-steering queued/follow-up item各有一个；
- accepted Channel message同时产生一个`originMessageId`和一个`requestId`并在queued item中保存一对一关联；
- active Turn期间到达并归类为steering的message有自己的`originMessageId`，但不是新Root request，不创建completion gate/requestId；它关联到当前active request；
- Root开始后取得`turnId`；queued abort/shutdown request从未取得`turnId`；Child具有自己的`turnId`但共享Parent Root `requestId`，并另保留parent-child identities；
- `requestId`加入Root start/execution correlation和唯一caller terminal event；`originMessageId`仍保留在现有user/run correlation fields。

queued/unstarted terminal的public mapping冻结为：

- Core/Application增加`AgentEvent`与`RuntimeEvent`的`request_end` variant：`{ type: 'request_end', requestId, originMessageId?, outcome: 'cancelled', reason: 'abort_queue_drop' | 'shutdown' }`；该variant永不携带`turnId`；
- RuntimeApp completion gate先seal，再按existing target-isolated Fanout把同一semantic event投递给Channel bindings和`onAgentEvent`，同时向`onEvent`投递Runtime variant；单target failure不改写gate；
- WebSocket Adapter映射为`{ type: 'request_end', request_id, origin_message_id?, outcome: 'cancelled', reason }`；unknown field仍按现有direction-specific protocol policy处理；
- CLI Adapter接收同一event并只结束/清除对应本地queued presentation，不伪造Turn output；无本地presentation时为silent no-op；
- affected migration surface固定为core/runtime Event unions、RuntimeApp queue/abort/shutdown、CLI/WebSocket Adapters、HTML client、Channel contract tests、Runtime intake/shutdown tests和queue/multichannel integrations；
- started Root仍使用existing Agent `run_end`和Runtime `turn_end` names并增加`requestId`；本decision不删除现有event identity。

### 13.2 Completion gate state machine

RuntimeApp是gate唯一Owner。每个Root request从`accepted -> started? -> terminal`单向转换：

- direct `runTurn()`返回的Promise就是该gate的caller settlement；
- Channel queue acceptance仍通过Channel protocol本地ack，最终结果通过semantic Fanout；
- 已started Root保留existing Runtime `turn_end` event name并扩展`requestId`、optional `originMessageId`和`completed | failed | aborted | shutdown_nonconverged` outcome；success分支继续携带现有result；failure/Abort分支携带canonical failure，不删除或双发`turn_end`；
- queued/unstarted request没有`turnId`，使用新增`request_end`，只携带`requestId`、optional `originMessageId`、`cancelled` outcome和abort/shutdown reason；一个Root request只产生`turn_end`或`request_end`之一；
- existing Runner/Agent `run_end`及其他execution events继续描述node-local执行并增加适用的request correlation，但不能作为第二个caller settlement；本Spec不重命名或删除`run_end`；
- `abortTurn()`丢弃的每个queued request分别gate-settle为`cancelled`且无`turnId`；`messages_dropped`只保留aggregate telemetry，不替代terminal events；
- Shutdown queued item同样逐项settle为`cancelled`并记录shutdown category；
- active success/failure/Abort/nonconvergence竞争compare-and-set；loser只记录late diagnostic；
- completion gate settlement不代表worker已真实收敛，tree pin仍由execution `finally`释放。

Contract tests必须覆盖direct与Channel queued success、resolution failure、Runner failure、active Abort、queued drop、queued Shutdown、nonconverged Shutdown和late success/failure，逐项断言一个Promise settlement（如适用），且恰有一个`turn_end`或request-only `request_end`。

## 14. Provider 与 Task Module 收敛

### 14.1 Provider

- `ExtensionRegistrationApi.registerProvider()`接收core-owned `ProviderProjectionEntry`作为Provider Contribution；entry `id`即contribution identity，必须符合全局identity profile，且`protocol`、`invocationPort`、`resolveConnection()`、`resolveModel()`满足已接受Model Resolution Contract；不得暴露SDK client或Adapter-private Error type；
- 同Unit/跨Unit Provider ID conflict与其他Contribution使用相同whole-unit validation、Builtin-first和External deterministic order；invalid External整组隔离，invalid/conflicting required Builtin fatal；
- Provider entry由其Unit instance在registration/readiness阶段建立；candidate只校验entry Contract、required startup capability、binding存在性和Unit lifecycle readiness，不调用`resolveConnection()`/`resolveModel()`预判Turn结果；lifecycle readiness/stop属于Unit instance，不由`ModelResolver`拥有；
- Builtin Anthropic通过Builtin Provider Module走common staging，SDK client/connection state由Module instance内部管理；
- bootstrap 不再独立传入 Provider array或直接构造 authoritative singleton Resolver；
- final Snapshot Provider projection必须包含发行版要求的Builtin Anthropic Provider Contribution；缺失使core composition fatal。已注册Provider的Connection或Model不可解析仍在Root/Child Model Resolution时、Provider网络调用前返回canonical Resolution Failure，不使Snapshot publish/startup失败；
- enable/disable可能改变 Provider projection，但已 pinned tree继续使用旧 generation的 Provider binding；
- Root/Child Model Resolution只接收 pinned Provider projection、Model Policy与 canonical Request Override；
- Runtime/Runner不新增 Provider-specific branch。

disable Provider时，candidate必须仍保留发行版要求的Builtin Provider Contribution并满足required Unit dependencies，否则request `rejected`且current不变；不在reload阶段解析default Connection/Model。Provider enable/disable/conflict tests必须覆盖registration failure、required Builtin removal、Turn-time connection/model failure、pinned N invocation与N+1新Root resolution。

### 14.2 Task Module

- Task Tool 是普通 Builtin Runtime Unit，与其他 Unit一起 staging/publish；
- 它只取得 typed Child Turn Port、Profile Registry view与Capability resolver，不取得 RuntimeApp object或Builder；
- Child Turn Port要求真实 active Parent，继承 Parent generation/signal/route，并由RuntimeApp跟踪 completion；
- Task Module不通过 mutable closure读取 current Snapshot；
- startup candidate完成前必须验证 required Child Turn Port，失败时遵循 Builtin fatal cleanup。

## 15. Lifecycle Report

Builder-facing report至少区分：

- startup accepted/isolated/fatal Units与diagnostics；
- current/candidate/retiring/pending state summary；
- Reload Request terminal results；
- Turn convergence：queued-cancelled、completed、aborted、nonconverged、protected pins；
- instance stop：completed、failed、skipped-protected；
- residual attribution与future-reload blocked reason；
- shutdown reason、started/finished时间和overall deadline outcome。

数组顺序使用generation、dependency order和ordinal identity确定，不依赖Promise settlement order。Report为readonly data，不暴露instance、Error private object、Registry mutation或stop handle。

## 16. Compatibility、Migration 与删除

### 16.1 Breaking policy

本 Slice不建立old/new双生产路径或migration Feature Flag。Rollback使用完整checkpoint/version rollback；不允许一个Turn内混合old/new Snapshot。

API-M01已由Subagent Model Resolution Spec明确延期到Slice 5 Review；API-M02在Legacy Inventory要求至少保留到Slice 4 Review，且Channel Spec只将“Slice 4不改protocol”列为当时非目标，并未禁止后续独立breaking decision。项目所有者若接受RC-OD-02，即构成API-M01 successor与API-M02 protocol-breaking的单独决策；接受后在Delivery中同步Inventory disposition。repository callers、HTML client、tests和scripts同一Delivery迁移；不保留deprecated alias。未知repository外consumer通过release notes说明breaking change，不在production内长期保留Compatibility。

### 16.2 Migration order

1. 建立Runtime Unit lifecycle、generation Snapshot、pin与manual-deadline Contract tests；
2. 建立authoritative Runtime Builder，先承接startup composition；
3. 统一Builtin Provider与Task Module staging，删除bootstrap post-assembly/shared Resolver closure；
4. RuntimeApp迁移到capture/pin与canonical intake；Parent/Child消费pinned projections；
5. 加入reload coordinator、candidate cleanup和atomic publish；
6. 加入retirement、blocked residual与reverse stop；
7. 加入two-stage Shutdown/public completion gate/Host policy；
8. 迁移production scripts、WebSocket/client/integration callers；
9. 删除duplicate startup Builder/lifecycle/close authority和到期legacy fields；
10. 更新active Spec/Plan/Inventory状态并执行完整验证。

### 16.3 Required deletions

Delivery完成前必须为零：

- `RuntimeApp.create()`中的Module discovery、Task post-assembly、Registry finalization或concrete instance startup；
- fixed `startup:1` Snapshot identity；
- production startup-only `buildRegistrySnapshot()` wrapper callers与wrapper本身；
- standalone `ChannelLifecycleSet` stop authority，或任何与Builder ledger重复的等价Owner；
- `RuntimeResourceSet`中的fixed mutable composition authority与shared startup-only Resolver；
- `SubagentExecutor`通过late-bound global/current Snapshot closure取projection；
- `RunTurnParams.model/maxTokens`、queue equivalents、WebSocket legacy fields及repository callers；
- RuntimeApp direct Module/Channel/Memory/Session instance close循环；
- production process Host的unbounded first-signal wait；
- CODE-E03 active mixed-responsibility entry。

deletion evidence必须包含production AST/text fitness和real caller integration，证明：`RuntimeApp.create()`只有delegation、没有第二composition entry；bootstrap不再单独构造Provider projection/Resolver或post-assemble Task；`buildRegistrySnapshot()` definition/callers为零；§16.3每个symbol/category均为零。migration matrix必须逐项列出current production/test/script/client caller、successor和删除test。

不在本Slice删除API-M04 deprecated LLM facade或历史文档；它们按accepted Inventory保留到Slice 6 Review。

## 17. Acceptance Criteria

- **AC-RC-01 Common startup：** Builtin/External units经同一Builder路径形成generation 1；无post-publish追加。
- **AC-RC-02 Atomic publish：** pre-publish每个failure boundary保持current/ingress不变并cleanup once；publish后retirement failure不回滚。
- **AC-RC-02a Handoff before publish：** handoff failure不发布generation；只有recorded Owner的binding进入final Snapshot。
- **AC-RC-03 Generation consistency：** barrier两种顺序均线性化；Parent/Child tree始终同一generation，新Root使用相应current。
- **AC-RC-04 Pin safety：** pin release exactly once且不早于真实tree收敛；caller outcome seal不提前释放pin。
- **AC-RC-05 Latest wins：** A/B/C和retirement D/E/F每个request获得正确terminal result；最多一个candidate/retiring/pending。
- **AC-RC-06 Duplicate/no-op：** same active enable与absent disable不创建instance/generation/retirement。
- **AC-RC-07 Dynamic conflict：** winner/loser/linked retirement/warning确定且可审计，Unit不部分发布。
- **AC-RC-08 Retirement progress：** short与Abort-responsive tree收敛；nonresponsive pin保护instance且N+1继续服务。
- **AC-RC-08a Shared instance：** unchanged Provider、Tool/Hook和Channel Unit跨N/N+1复用同一instance；N retirement不重复start/stop。
- **AC-RC-09 Stop failure：** published result保持成功；pending/future blocked；独立eligible instances继续逆序stop。
- **AC-RC-10 Provider generation：** Parent与Child通过pinned Provider projection独立resolve；publish race不切换running tree binding。
- **AC-RC-11 Task common path：** Task Tool在candidate内出现，通过Child Turn Port继承generation；RuntimeApp无后装配。
- **AC-RC-12 Canonical intake：** library/queue/WebSocket只接受ModelReference/RequestOverride；legacy fields零caller/零definition。
- **AC-RC-13 Completion gate：** queued、active、Abort、nonconverged与late completion每个caller最多一个terminal result/event。
- **AC-RC-14 Shutdown：** candidate/current/retiring/failed-retirement/publish barrier均有界；重复Shutdown共享result；protected instance不强停。
- **AC-RC-15 Host boundary：** first signal cooperative，second signal/overall deadline仅由process Host force；library不exit。
- **AC-RC-16 Ownership：** 每个instance恰有一个Owner；无duplicate successful stop；Framework不管理internal objects。
- **AC-RC-17 Change locality：** 新增第二个loaded External Provider/Channel/Tool/Hook unit不修改RuntimeApp、Runner或central type switch。
- **AC-RC-18 Deletion：** §16.3 residual为零，且Legacy/Compatibility计数严格下降。
- **AC-RC-19 Coordinator linearization：** capture/publish/reload admission/Shutdown由一个private coordinator串行；critical operations无`await`/user code且所有barrier顺序确定。

## 18. Validation Plan

### 18.1 Focused Unit / Contract

- `runtime-builder.test.ts`：startup staging、dependency order、unit atomicity、handoff与rollback；
- `registry-generation.test.ts`：monotonic generation、immutability、atomic current与publish commit；
- `turn-generation-pin.test.ts`：Root capture、Child inherit、release once、late worker pin；
- `reload-coordinator.test.ts`：failure matrix、latest-wins、no-op、pending/blocked/shutdown results；
- `generation-retirement.test.ts`：drain、Abort convergence、protected pin、reverse stop、stop-once；
- `runtime-shutdown.test.ts`：completion gate、manual deadlines、candidate/current/retiring/publish states、shared close result；
- Provider/Task common-path contract tests；
- canonical intake与WebSocket protocol tests；
- Provider registration/conflict/default-loss/disable与pinned-resolution tests；
- unchanged Provider/Tool-Hook/Channel instance generation-membership tests；
- request/origin identity与public completion-gate state-machine tests。

测试使用deferred Promise、barrier和manual deadline driver；禁止`setTimeout` sleep驱动race、扩大timeout或宽松retry掩盖failure。

### 18.2 Integration / Regression

- real `RuntimeApp` queue/dequeue与publish barrier；
- Parent running on N、publish N+1、post-publish Child仍使用N、新Root使用N+1；
- CLI/WebSocket External Channel across generation与terminal Fanout before stop；
- Runtime shutdown：queued request、approval wait、short/Abort-responsive/nonresponsive Tool/Provider/Child；
- production integration scripts：queue、shutdown、steering、multichannel、attachments、Subagent；
- existing Model Resolution、Runner Tool pipeline、Channel lifecycle、Runtime intake与Subagent suites。

### 18.3 Fitness / Static / Full

- FT-01 stable boundaries；
- FT-02 Provider/Channel SDK allowlist；
- FT-05 Extension capability与no concrete Runtime branches；
- FT-06 change locality；
- FT-07 generation Snapshot immutability/no Builder injection；
- FT-08 public Contract inventory；
- FT-09 active-document governance；
- repository exact residual scans for §16.3；
- static assertion：`RuntimeApp.create()`仅委托authoritative Builder、无第二composition entry、无separate Provider/Task assembly；
- `npm run lint`、`npm run build`、`npm test`、`git diff --check`；
- independent implementation review无未解决Critical/High/Medium blocker。

## 19. Definition of Ready

- [x] Plan Item、目的、范围和非目标已定位；
- [x] ADR-005/006、Target §7/§8、AF-06 Results与Slices 1–4 Specs提供authority/evidence；
- [x] current composition、pin、Provider/Task、reload和Shutdown gaps已定位；
- [x] AF-06 P4-E01..P4-E07已验证所需并发/lifecycle primitives，不需要新Spike；
- [x] 项目所有者确认§21 RC-OD-01..07 Proposed Decisions（全部按推荐方案接受，2026-09-08）；
- [x] independent Spec review无未解决Critical/High/Medium blocker（第三轮：`Ready with minor corrections`；minor corrections已应用，2026-09-08）；
- [x] 项目所有者接受完整Spec并将状态改为`Accepted`（2026-09-08）；
- [ ] 项目所有者在Spec checkpoint后另行批准production Delivery。

DoR完成前不得修改production code、public Contract、dependency、lockfile或legacy entry points。

## 20. Definition of Done

- [ ] AC-RC-01..19（含02a/08a）均有自动化证据；
- [ ] P4-E01..P4-E07的production equivalents通过；
- [ ] Provider/Tool/Hook/Channel共享一个generation Snapshot和publish point；
- [ ] Root/Child pin、reload、retirement与Shutdown failure matrices通过；
- [ ] canonical intake的library/queue/WebSocket real callers已迁移；
- [ ] §16.3 deletion residual为零；
- [ ] focused/contract/integration/regression/Fitness/lint/build/docs/diff checks通过；
- [ ] active Spec、Plan与Inventory状态同步，不批量同步历史/Legacy文档；
- [ ] independent implementation review无未解决blocker；
- [ ] 项目所有者接受验证结果并确认Slice 5完成。

## 21. Proposed Decisions

项目所有者于2026-09-08确认RC-OD-01..07，全部按以下推荐方案接受。

### RC-OD-01：一个production composition entry

**推荐：** 保留`RuntimeApp.create()`作为唯一public convenience entry，但返回职责分离的`RuntimeHandle { application, composition, close }`并内部只委托一个authoritative Runtime Builder；内部RuntimeApp接收Snapshot pin、convergence和Channel completion等窄Ports，不持有Builder或reload control。不得并列新增第二个`createRuntime()` production path。

**理由：** 满足CODE-E03删除条件，并用一次明确caller migration换取Application、dynamic composition与process lifecycle的可见分责；避免Facade与RuntimeApp两套production entry。

### RC-OD-02：API-M01/API-M02 breaking canonicalization

**推荐：** 本Slice直接把library/queue/WebSocket的`model/maxTokens`替换为`modelReference/requestOverride.maxOutputTokens`，不保留alias、dual-read或Feature Flag。

**理由：** 这些Compatibility已到期；继续保留会让generation-pinned Model Resolution仍依赖legacy vocabulary。repository外consumer风险通过release note处理，不建立永久双路径。

### RC-OD-03：仅动态切换已加载Unit

**推荐：** reload request只按catalog `unitId` enable/disable已加载factory；本Slice不做discovery、watcher、dynamic import、Schema migration或版本替换。

**理由：** 与Target/ADR-005/AF-06 evidence boundary一致，并把安全未知留在明确的后续需求。

### RC-OD-04：明确deadline caps、shared budget与Host force policy

**推荐：** 接受§12.2的5s candidate cleanup、30s drain、10s Abort convergence phase caps与60s Host overall absolute deadline；Shutdown各phase使用remaining budget，首次signal cooperative，第二次signal可force，embedded Runtime永不`process.exit()`。

**理由：** deadline阶段独立、可配置且可deterministic test；60s覆盖正常两阶段与report allowance，不把Host force误当unsafe instance stop授权。

### RC-OD-05：精确Reload result与single-slot coordination

**推荐：** 冻结`published | no-op | rejected | superseded | blocked | shutdown/cancelled`六类terminal outcome，以及one candidate/one retiring/one pending-latest约束。

**理由：** 直接承接已通过的AF-06 result matrix，避免悬挂Promise、结果改写和多代retirement。

### RC-OD-06：Provider与Task进入同一generation

**推荐：** Provider成为`ExtensionRegistrationApi`的正式Contribution kind，Builtin Anthropic经common Module staging；每generation建立immutable Resolver binding。Task Tool作为普通Builtin Unit，在candidate内通过typed Child Turn Port装配。

**理由：** 消除bootstrap的Provider special path、shared Resolver mutation风险和Task post-assembly closure，满足一个cross-kind Snapshot与CODE-E03退出条件。

### RC-OD-07：保留started terminal event并新增request-only terminal event

**推荐：** 不删除或重命名existing Runtime `turn_end`和Agent `run_end`。started Root的existing events增加`requestId`/outcome；queued/unstarted request新增无`turnId`的`request_end { requestId, originMessageId?, outcome: cancelled, reason: abort_queue_drop | shutdown }`，WebSocket使用对应snake_case wire fields。每个Root在每个public surface只产生一个terminal event。

**理由：** 满足Target对queued request-only settlement和public completion gate的要求，同时避免无必要地破坏既有started Turn event identity。接受本decision后，Delivery同步public Event Contract inventory、callers和migration tests。

## 22. Delivery Slices

接受Spec后建议按以下最小可验证顺序交付，不拆成长期双路径：

1. **S5-D1 Contracts/Builder startup：** lifecycle unit、dependency ledger、generation 1、authoritative startup；
2. **S5-D2 Turn pin/Provider/Task：** Root/Child pin、per-generation Resolver、Task common path、canonical intake；
3. **S5-D3 Reload/Retirement：** request union、candidate、publish、latest-wins、drain/Abort/stop；
4. **S5-D4 Shutdown/Host：** completion gate、two-stage deadlines、Host force boundary；
5. **S5-D5 Deletion/validation：** 删除duplicate paths，迁移全部callers，Fitness/full integration与active docs收口。

每个Delivery step首个实质修改后立即运行对应focused test。若实现证据推翻Accepted Contract、需要新增dependency、改变deadline/ownership/PR order或扩大到discovery/Legacy cleanup，停止Delivery并回到项目所有者决策。

## 23. Review History

2026-09-08首轮independent Spec review结论为`Not Ready`，提出7个High与3个Medium findings。Disposition：

- **接受并修正：** handoff-before-publish、single coordinator linearization、shared unchanged-instance memberships、Provider Contribution contract、Parent/Child pinned record、request/origin/completion gate、shared Shutdown deadline budget、stop-failed retry state和exact deletion tests；
- **修改后接受：** API-M01/API-M02 finding。Inventory并未禁止Slice 5变更；RC-OD-02本身作为所要求的separate protocol-breaking decision保留，并补充authority reconciliation与Delivery时Inventory同步条件；
- **拒绝：** 无。

修正后需再次独立review；在review无Critical/High/Medium blocker且项目所有者接受§21前，状态保持`Draft`。

2026-09-08第二轮independent Spec review结论为`Not Ready`，提出3个High、3个Medium和1个额外public-contract blocker。Disposition：

- **接受并修正：** Provider readiness恢复为Turn-time Connection/Model Resolution；明确RuntimeApp semantic pin ownership与Builder mechanical ledger；补齐Logger/Memory/Session/interaction等non-Unit resource Owners；定义Host/embedded composition control；冻结retirement finalization states；增加Shutdown report completion gate；
- **修改后接受：** terminal Event finding。保留existing `turn_end`/`run_end`，仅对started event增加request correlation，并为无`turnId`的queued/unstarted request新增`request_end`；作为RC-OD-07提交项目所有者接受；
- **拒绝：** 无。

修正后需第三次独立review；在review无Critical/High/Medium blocker且项目所有者接受§21前，状态保持`Draft`。

2026-09-08第三轮independent Spec review结论为`Ready with minor corrections`，无Critical/High/Medium blocker。三个minor findings均已接受并修正：冻结queued `request_end` Core/Runtime/WebSocket/CLI mapping与migration surface；区分failed-residual中的diagnostic/protection membership和remaining stop obligation；删除重复文案。Spec进入`In Review`，等待项目所有者确认§21 Proposed Decisions；该结论不授权production Delivery、commit或push。

项目所有者于2026-09-08确认RC-OD-01..07的全部推荐方案并接受完整Spec；状态晋升为`Accepted`。Spec已满足设计侧Definition of Ready，但production Delivery、dependency安装、commit、push和Slice 6仍未授权。
