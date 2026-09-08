# ADR-005：Extension/Module/Registry Composition 与 Runtime Lifecycle

## 状态

- **状态：** Accepted
- **日期：** 2026-09-04
- **所有者：** 项目所有者
- **关联计划 / Spec：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) AF-07、[AF-07 Architecture Decision Spec](af-07-architecture-decision-spec.md)
- **证据输入：** [Target Architecture §6](target-architecture.md#6-extensionmodulecontribution-and-registry)、[§7](target-architecture.md#7-registry-snapshot-and-lifecycle-transactions)、[§8](target-architecture.md#8-runtime-call-flows-and-ownership)、[AF-06 Extension Framework Spike Results](af-06-extension-framework-spike-results.md)
- **相关既有决策：** [ADR-001 Tool Result Closure and Recovery](adr-001-tool-result-closure-and-recovery.md)、[ADR-002 Context Budgeting and Compaction Recovery](adr-002-context-budgeting-and-compaction-recovery.md)
- **适用原则：** AP-04、AP-05、AP-08、AP-09、AP-10、AP-11、AP-12，见 [Architecture Principles](architecture-principles.md)
- **Supersedes：** None

项目所有者于 2026-09-04 接受本 ADR。后续工作遵循 [Development Workflow](../development-workflow.md) 的批准和状态规则；本次接受不冻结 production Extension API，也不授权 Runtime Composition Slice。

## 背景

当前 Tool、Hook、Channel、Provider 和 Subagent 装配分散在 bootstrap、RuntimeApp、Runner setter 与具体脚本中。Builtin 能力通常通过中央列表或 concrete branch 接入，External Extension 尚无统一 staging、Config、Capability、Snapshot 和 lifecycle boundary。把更多特例继续加入 RuntimeApp/Runner 会扩大 coupling；用 Service Locator 则会隐藏依赖和资源 ownership。

AF-06 disposable Spike 已在 production graph 外验证：Builtin/External 可以在 acquisition 后使用相同 registration/staging path；一个 External Extension 可以原子贡献 Channel、Tool、Hook、Provider 和独立 Config；consumer 可以只使用 typed projections；immutable Snapshot、Turn generation pin、enable/disable、failure containment、retirement 与 bounded Shutdown 可以用 instance-level lifecycle ownership 表达。

AF-06 不冻结 production API、filesystem portability、真实第三方 protocol、deadline/lock/error shape，也没有证明 current detached `after_tool_call` 符合 Target settlement。

## 决策驱动因素

- 新 Provider/Channel/Tool/Hook 不要求修改 Runtime/Runner central branch；
- Builtin 与 External 在注册后使用同一机制；
- 一个 Extension 的 Contributions 必须原子接受或隔离；
- consumer 只取得职责所需 projection/Capability；
- published Snapshot 在一个 Turn 内保持内部一致；
- lifecycle unit 有唯一 Owner，Extension 内部对象保持 opaque；
- dynamic change failure 不污染 current 或回滚已发布 Snapshot；
- 不引入 general plugin container、scheduler 或 internal resource graph。

## 备选方案

### 方案 A：继续维护每种能力的中央列表和独立 Registry

Tool、Hook、Channel、Provider 各自注册、发布和管理生命周期；Builtin 由 central switch 特殊处理。

局部实现简单，但跨类 Extension 无法原子验证，Snapshot generation 会分裂，新 Extension 仍需修改多个中央路径。

### 方案 B：通用 Plugin Container / Service Locator

Extension 以任意 token 注册 service，Framework 跟踪 service dependency、sharing、reference count 和 close order。

它提供高度通用性，但会泄漏 Runtime private capability，模糊 Contract 与 ownership，并迫使 Framework 管理 Extension 内部对象。AF-06 明确没有证明也不需要这种复杂度。

### 方案 C：统一 Extension staging + immutable Snapshot + instance lifecycle

Builtin/External 在 acquisition 后使用同一受限 API，按 unit 原子 staging；一个 Builder 发布 cross-kind immutable Snapshot，consumer 获取 narrow projections；Framework 只编排 Extension/Module instance lifecycle。

该方案提供统一边界，同时让 Extension 自己管理内部资源。

## 决策

选择 **方案 C：统一 Extension staging + immutable Snapshot + instance lifecycle**。

### Acquisition 与统一注册

- Builtin Module 由 Composition Root 显式提供；External Extension 从已配置 Agent Home 的规范 installation boundary 发现并经静态 Descriptor validation/Loader；
- Builtin/External 差异只存在于 acquisition；进入 registration 后，两者使用相同 Extension API、Contribution Contracts、staging validation 和 Snapshot Builder；
- Extension 注册到私有 per-unit staging collector，不直接修改共享 Registry；
- 首批 Contribution Kind 为 Tool、Hook、Channel、Provider；它们共享一个 Extension system，但各自具有 core-owned Contract；
- 新实例不需要修改 central type union；新增新的平台级 Contribution Kind 必须先有明确 Contract/projection，不允许 `register(any)`。

### Unit 原子性、Config 与 Capability

- 一个 Extension/Module 的 Contributions、identity、Config Namespace、required startup Capability 和 cross-contribution consistency 作为一个 unit 校验；
- External unit 的 Descriptor/load/register/validation 失败时整组隔离并报告；invalid required Builtin 或 required startup capability 可以使启动失败；
- 冲突使用 deterministic acquisition rule，不能依赖 filesystem enumeration 或 registration call order；
- Extension 只看到自己的 validated Config Namespace；
- execution 时只获得 Contract 声明且经 Composition/Policy 授予的 typed context/Capability，不获得 Runtime private state、global Config 或 Service Locator。

具体 Descriptor fields、Schema API、目录规范化算法、warning/error shape 和 Capability interface 由后续 Module Spec 冻结。

### Registry Snapshot 与 consumer boundary

- 只有一个 authoritative Registry Builder 和一个 internally consistent immutable Snapshot；
- Tool/Hook/Channel/Provider Registry 只是同一 Snapshot 的 narrow typed projection，不独立 publish/version；
- RuntimeApp、Runner、Model Resolver 和 Builder 只接收职责所需 projection，不接收 mutable Registry、staging collector、Loader 或其他 Extension private object；
- Snapshot publication 是 commit point；publish 前失败保持 current 不变，publish 后 retirement failure 不回滚新 Snapshot；
- Root Turn 在 dequeue/start transition 捕获 current generation，Child 继承 Parent generation；queued request 不提前 pin Snapshot。

### Runtime 与 Composition 分责

Runtime Builder/Composition 负责 discovery、load、create、validation、dependency wiring、start、handoff、Snapshot publish、retirement 和 instance-level stop coordination。RuntimeApp 负责 queue、Turn tree、routing、Snapshot capture、Abort、Fanout 和 process Shutdown orchestration。Runner 只消费 Turn-pinned Tool/Hook/Provider-facing execution inputs，不发现 Extension、加载 Config 或拥有 process resource。

### Instance lifecycle ownership

- 每个 accepted Extension/Module instance 是一个 lifecycle unit，并有唯一 lifecycle ownership record；
- Framework/Builder 按 dependency order start、按 reverse order调用 instance `stop()`；
- Extension instance 自己创建、共享、引用和关闭内部 connection、cache、SDK client、authentication state、rate limiter 或 Transport；
- Framework、Registry、Snapshot 和 consumer 不取得这些内部对象的 membership、reference count、semantic ownership 或 close authority；
- consumer 持有 Contribution binding 不获得关闭 instance 的权力；
- generation pin 未归零时不得停止该 generation 仍需的 instance。

### Static 与 dynamic delivery boundary

- Slice 1 把 startup-configured readonly Provider projection 接入 Model Resolution；Slices 3/4 把同一 Snapshot 的 Tool/Hook/Channel projections 与 Extension/Module instance lifecycle 接入 production consumption；文件变化通过 restart 生效；
- Slice 5 在独立 Module Spec 接受后才交付 runtime enable/disable、candidate transaction、atomic publish、single retiring generation、pending latest、drain/Abort 和 bounded Shutdown；
- 同 identity 已 active 的 enable request 在 candidate start 前 warning + `no-op`，不启动第二个 instance；
- pre-publish candidate failure 保持 current 并有界 cleanup；cleanup nonconvergence 可归属且阻断后续 reload；
- post-publish retirement nonconvergence 保持新 Snapshot，保护 pinned instance，并阻断 pending/future reload，Shutdown 只做有界重试。

明确排除 file watcher、arbitrary hot code loading、in-place code upgrade、same-identity running version replacement、multi-instance coexistence、多代并行 retirement、general scheduler、DI Container、Service Locator 和 Framework-managed internal object graph。

### 与 ADR-001/ADR-002 的 Authority 边界

本 ADR 不重新定义：

- ADR-001 的 Tool Call/Result closure、controlled Abort、unknown recovery 或 replay；
- ADR-002 的 context budgeting、Provider overflow correction、Compaction、Session commit、retry 或 observer settlement。

AF-06 只用静态 Tool dispatcher 和 awaited `before_tool_call` 提供 Runner bridge evidence；current detached `after_tool_call` 未构成 pass evidence。Tool transformation、ordering、settlement 和 failure taxonomy 必须由后续 Tool/Hook Module Spec 决定。

## 原则与验证映射

| 原则 | 本决策约束 | 后续验证 |
|---|---|---|
| AP-04 | Builtin/External 共享注册与 lifecycle | common Contract suite、change-locality test |
| AP-05 | 一个 immutable Snapshot 与 generation pin | FT-07、immutability、old/new Turn integration |
| AP-08 | typed Capability，无 Service Locator | denial type tests、Extension contract tests |
| AP-09 | lifecycle/failure 由 Spec 与 Contract 保护 | Slice 3–5 Module Specs、failure matrix |
| AP-10 | instance-level unique Owner | partial startup、drain、idempotent/reverse stop tests |
| AP-11 | Composition 构建，Runtime 编排 | responsibility/dependency tests、real caller migration |
| AP-12 | 不推广 disposable shape 或预建 marketplace | AF-06 boundary review、unused abstraction review |

## 后果

### 正面

- 新 Extension/Module 不再要求 central Runtime/Runner branch；
- cross-kind Contributions 共享原子 validation 和 version boundary；
- Turn 不观察混合 Registry generation；
- Extension private resource ownership 保持封装；
- dynamic failure 具有明确 commit、rollback 与 residual 语义；
- production rollout 可以先 static integration，再独立交付 dynamic lifecycle。

### 负面

- Builder 需要显式 staging、diagnostic、dependency 和 cleanup responsibility；
- consumer 必须从当前 mutable bundle 迁移到 projections；
- runtime dynamic change 需要 Turn pin、retirement gate 和 bounded failure handling；
- External Extension 隔离和 required Builtin failure 需要不同 startup policy；
- 后续 Module Specs 必须冻结多个公共 Contract，不能直接复制 Spike harness。

## Deferred

本 ADR 不冻结 TypeScript API、directory/module layout、Descriptor/schema fields、normalization algorithm、lock/queue primitive、deadline、Error/Event shape、Host signal、persistence、real Provider/WebSocket compatibility 或 cross-platform filesystem behavior。不决定 same-identity replacement、multi-instance、marketplace、watcher 或 internal resource sharing policy。

## 迁移与回滚

1. Slice 3 Module Spec 冻结 Tool/Hook Contribution、projections、policy 和 awaited lifecycle contract；
2. 迁移 Builtin Tool 和一个 External test Extension，删除 central Tool list/setter path；
3. Slice 4 Module Spec 冻结 Channel Contribution、typed capability 和 startup lifecycle；
4. 迁移 CLI/WebSocket Builtin 与一个 External Channel，删除 scripts 的 concrete registration path；
5. Slices 3/4 只发布 startup Snapshot；rollback 通过完整旧/新 startup path 或版本回滚；
6. Slice 5 Module Spec 冻结 Builder、generation、reload request result、retirement、Shutdown 和 residual contracts；
7. Slice 5 迁移 composition caller 后删除 RuntimeApp post-bootstrap assembly 和 duplicate lifecycle ownership；
8. 任何 rollback 都必须选择完整 generation/path，不在 Turn 内混合 Snapshot 或强停 pinned instance。

## 后续事项

- [x] 项目所有者接受本 ADR（Owner：项目所有者；Plan Item：AF-07；2026-09-04）。
- [x] 起草并接受 Slice 3 Tool/Hook Module Spec（Owner：项目所有者；Plan Item：Slice 3；2026-09-08）。
- [ ] 起草并接受 Slice 4 Channel Module Spec（Owner：项目所有者；Plan Item：Slice 4）。
- [ ] 起草并接受 Slice 5 Runtime Composition Module Spec（Owner：项目所有者；Plan Item：Slice 5）。
