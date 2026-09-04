# AF-06 Extension Framework Spike Spec

## 1. 状态

- **状态：** Accepted
- **版本：** 0.1
- **日期：** 2026-09-03
- **所有者：** 项目所有者
- **建议时间盒：** 3 个工作日；5 个工作日硬停止
- **父计划：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) AF-06
- **语言与术语约定：** [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)
- **权威目标：** [Target Architecture §6](target-architecture.md#6-extensionmodulecontribution-and-registry)、[§7](target-architecture.md#7-registry-snapshot-and-lifecycle-transactions)、[§8](target-architecture.md#8-runtime-call-flows-and-ownership)、[§10](target-architecture.md#10-verification-and-acceptance-matrix) 与 [Appendix C](target-architecture.md#appendix-c-af-06-extension-framework-spike-input)
- **行为与 Fitness 基线：** [AF-04 Characterization and Fitness Execution Plan](../roadmap/af-04-characterization-fitness-plan.md)
- **相关约束：** [Architecture Principles](architecture-principles.md)、[Domain Glossary](domain-glossary.md)
- **工作流：** [Development Workflow](../development-workflow.md)

项目所有者于 2026-09-03 接受本 Spec v0.1 及 §16 的实验边界、证据矩阵、时间盒和停止条件，并授权执行 disposable AF-06 Spike。该接受不授权 production Extension Framework、Runtime Builder、Registry、动态 reload、文件 watcher、AF-07、Architecture Slice、公共 Contract 或生产目录迁移。

## 2. 单一问题

### AF06-Q01

在不修改 production graph、不复制 `RuntimeApp`/`AgentRunner` 执行循环、不授予 Service Locator 或 Runtime 私有状态访问权的条件下，一个位于 production graph 外的 disposable Extension Framework，能否让 Builtin Runtime Module 与 External Extension 通过同一受限 Extension API 原子贡献 Channel、Tool、Hook、Provider 和独立 Config Namespace，并通过版本化不可变 Registry Snapshot、Turn-tree generation pin、单候选/单 retiring generation/单 pending latest 协调、有界失败清理与唯一实例级 Lifecycle Owner，实现确定性的启动隔离、运行中 enable/disable、旧工作排空和 Shutdown？

## 3. 假设

### AF06-H01

可以。一个外部测试聊天软件 Extension、一个 Builtin fixture、typed projections、instrumented Extension instance、手动推进的 deadline/barrier 和 target-shaped Registry/Lifecycle harness 足以在 production graph 外验证：

1. Descriptor、Schema identity、安装边界和冲突顺序可在执行 Extension code 前确定；
2. Builtin 与 External 的差异只存在于 source acquisition，之后使用同一注册、校验、Snapshot 和 Lifecycle 机制；
3. 一个 External Extension instance 可以原子组合 proprietary WebSocket Channel、平台 Tool、Hook、Provider、Config 与 typed platform identity；其内部长期对象由 Extension 自己管理，Framework 和消费者不可取得或关闭；
4. Extension 与消费者只能取得显式 typed projection、Extension Capability 或 current-call Channel Capability，不能取得 Registry mutation、任意 service token、全局 Config 或 Runtime 私有状态；
5. published Snapshot 不可变，Root 捕获与 publish 具有单一线性化结果，Child 继承 Parent generation；
6. pre-publish failure、supersession 和 same-identity duplicate no-op 不污染 current Snapshot；duplicate 在 candidate start 前 warning/ignore，失败清理不收敛时残留可归属且阻断后续 reload；
7. publish 后旧 generation 独立 retirement，不回滚新 Snapshot；generation pin、drain、Abort convergence、Extension instance stop 和 pending latest 均有界且可观察；
8. Shutdown 与 publish 具有单一线性化结果；Framework 只编排 Extension/Module instance 的 stop，不管理其内部连接、缓存、SDK client、认证状态或限流器，并聚合可归属的实例级残留。

`AF06-H01` 汇总 Target Architecture 的 `P3-H01..P3-H05` 与 `P4-H01..P4-H07`。只有 §9 的 12 个 canonical evidence group 全部产生支持证据且没有命中 §11 Stop Condition 时，Results 才可建议 `Provisional Pass`。

### 3.1 假设到证据的追踪

| Target Hypothesis | 直接证据 | 共享证据 |
|---|---|---|
| `P3-H01` Descriptor/discovery/order | `P3-E01` | `P3-E04`、`P4-E06` |
| `P3-H02` staging/ownership handoff | `P3-E02` | `P3-E05`、`P4-E02` |
| `P3-H03` one API/typed projections | `P3-E03` | `P3-E02`、`P3-E05` |
| `P3-H04` Config Namespace/Schema | `P3-E04` | `P3-E01`、`P4-E02` |
| `P3-H05` typed platform Capability | `P3-E05` | `P3-E02`、`P3-E03` |
| `P4-H01` Root capture/Child inherit | `P4-E01` | `P4-E04`、`P4-E07` |
| `P4-H02` pre-publish containment | `P4-E02` | `P3-E02`、`P4-E03` |
| `P4-H03` latest-wins/no-op/pending | `P4-E03` | `P4-E02`、`P4-E05` |
| `P4-H04` drain/Abort convergence | `P4-E04` | `P4-E05`、`P4-E07` |
| `P4-H05` post-publish failure | `P4-E05` | `P4-E04`、`P4-E07` |
| `P4-H06` dynamic conflict winner change | `P4-E06` | `P3-E01` |
| `P4-H07` bounded Shutdown | `P4-E07` | `P4-E02`、`P4-E04`、`P4-E05` |

- **Supported：** 直接证据通过，相关共享证据没有反例；
- **Falsified：** 至少一个直接实验观察到明确反例；
- **Inconclusive / Blocked：** timebox、环境或 Stop Condition 阻止形成正反证据。

单项 `P3-E*`/`P4-E*` 失败不自动证伪全部 Target Hypothesis。Results 必须逐项 disposition，不能用 aggregate suite 绿色替代证据追踪。

## 4. 可解锁与不解锁的决策

### 4.1 支持时可作为输入

若 required evidence 成立，Results 可以为以下工作提供执行证据：

- AF-07 的 Extension/Module/Registry 与 Runtime Composition ADR；
- Slice 3/4 的启动期 immutable Snapshot、统一 Extension API、typed projection、Config Namespace、Capability 与 ownership handoff Module Spec；
- Slice 5 的动态 enable/disable、Turn pin、Reload Transaction、Generation Retirement 与 Shutdown Module Spec；
- Foundation Gate 中“Extension Framework Spike 有 Results，关键 Hypothesis 通过”及动态启停/Snapshot/排空/回滚 evidence item 的后续 Owner decision；
- Target Architecture `P3-H01..P3-H05`、`P4-H01..P4-H07` 和 `OQ-04..OQ-06` 的 evidence-backed disposition。

### 4.2 不解锁

本 Spike 即使支持假设，也不自动决定或授权：

- production TypeScript API、目录、Descriptor/Schema 格式、Error union、deadline 数值或锁实现；
- production dynamic reload、文件 watcher、Extension code reload/unload、Marketplace 或第三方平台兼容承诺；
- 同一 Extension 的运行中版本替换、多实例并存，或由 Framework 管理 Extension 内部长期对象；
- 修改 `RuntimeApp`、`AgentRunner`、`bootstrap.ts`、Config public Contract 或中央类型联合；
- 多代并行 retirement、分布式 Registry、通用事务框架、通用 scheduler、Event Bus、DI Container 或 Service Locator；
- AF-07、任一 Architecture Slice、生产迁移或 Foundation Gate 整体通过。

## 5. 当前证据边界

AF-06 必须明确区分 current production facts 与 disposable target evidence：

- current composition 由 [`bootstrapRuntime()`](../../src/runtime/bootstrap.ts#L68-L180) 直接构造中心对象图；失败路径没有 target rollback stack，CH-12 保留该差距；
- current [`RuntimeToolBundle`](../../src/runtime/types.ts#L11-L16) 暴露可变集合，FT-07 将其锁定为迁移输入，而不是 immutable Snapshot 实现；
- current Channel 注册和启动仍由 [`RuntimeApp`](../../src/runtime/RuntimeApp.ts#L277-L315) 与 [`startChannels()`](../../src/runtime/RuntimeApp.ts#L386-L396) 直接管理，CH-07 保留 partial start 无 rollback 的现状；
- current `AgentRunner` 使用实例级 Hook registrations 和一个可替换 Tool executor；它没有 Turn-pinned Hook/Tool projection；
- current Config 是中央 `AgentDefaults`，没有 Extension Namespace/Schema 两阶段加载；
- current Root/Child tracking 没有 Registry generation pin；current Shutdown 也不是 Target 的 staged bounded retirement/Shutdown；
- FT-05 在 production Extension roots 出现前明确为 not applicable；FT-06/07/08 只提供当前边界和 inventory 保护，不证明 AF-06 Hypothesis。

因此 AF-06 必须使用 disposable target-shaped acquisition、Registry、pin、transaction、retirement 和 Shutdown coordinator。它可以复用 current `AgentRunner` 的真实 Tool loop、现有 core-owned Tool/Hook/Channel contracts 和 deterministic test patterns，但不得把 current `RuntimeApp` 包装成 Target Runtime Builder，也不得声称 current production 已实现动态机制。

## 6. 实验范围与最小结构

实验代码若获授权，只能位于 `test-fixtures/architecture-spikes/af-06/**`，建议保持以下职责分离；文件名和 disposable type shape 不构成 production proposal：

1. `contracts/`：最小 Descriptor、Extension registration、四类 Contribution、typed projection、Config Namespace/Schema identity、Capability、Snapshot、实例级 Lifecycle 与 diagnostic shape；
2. `acquisition/`：fixture Agent Home 的 direct-child discovery、安装边界校验、预先声明的规范目录键、Descriptor/Schema stage-one 校验和 controlled stage-two loader；
3. `registry/`：per-unit staging、确定冲突、immutable Snapshot、atomic current pointer、单 candidate、单 retiring generation 和单 pending latest slot；
4. `lifecycle/`：Extension/Module instance 的 creator rollback ownership、atomic handoff ledger、manual deadline、generation pin、retirement、Shutdown 和 attributable residual report；不查看或管理 Extension 内部对象；
5. `turn-tree/`：只表示 Root capture、Child inheritance、pin release 和 Abort tree；不得实现 Session queue、LLM/Tool loop、第二个 Runtime 或 scheduler；
6. `fixtures/external-chat/`：一个位于 `runtime/` 外的 External chat Extension，通过 proprietary in-memory WebSocket protocol 贡献 Channel、平台 Tool、Hook 和 Config；内部 connection/auth/rate-limit sentinel 只由该 Extension 管理，用于证明消费者不可取得且 `stop()` 被调用一次；
7. `fixtures/builtin/`：通过同一 registration API 提供四类 Contribution 的 Builtin Runtime Module；Provider 仅为 independent Fake projection，不访问真实 Provider；
8. `runner-bridge/`：一个静态 Tool dispatcher 和一个只注册一次的 `before_tool_call` dispatcher，按 `turnId` 取得已 pin 的 narrow projection；真实 `AgentRunner` 不按 Extension/source/generation 分支，也不为每代替换 Runner Factory；
9. 一个按 `P3-E01..P3-E05`、`P4-E01..P4-E07` 排列的 `.spike.ts` suite，以及 fixture-local TypeScript/Vitest config。

### 6.1 单一外部 Extension 要求

`P3-E02` 与 `P3-E05` MUST 使用同一个 External chat Extension 实例。该 fixture 必须同时提供：

- proprietary WebSocket Channel Contribution，但 Transport 完全为 deterministic in-memory fake；
- typed platform message identity；
- 依赖 current-call Channel Capability 的 proprietary Tool action；
- 至少一个具名 Hook Contribution；
- 独立 Config Namespace 与版本化 Schema identity；
- 一个只由 Extension 内部管理的长期对象 sentinel；Framework 只观察 Extension instance 的 `start()`/`stop()`，不读取该对象的共享、引用或关闭细节；
- required/optional startup Extension Capability 和 present/missing current-call Channel Capability 分支。

不得为每个 Contribution 建立互不相关的“Extension”来回避原子 staging 或 Capability 边界。

### 6.2 目录顺序候选

在执行 `P3-E01` 前，Results 必须冻结一个不依赖 OS locale 或原始枚举顺序的 fixture-local规范目录键候选及 expected winner table。建议候选把可接受安装目录限制为规范 lowercase ASCII 名称，按 code-unit lexicographic order 比较，并把路径分隔符、absolute path、`.`/`..`、非规范 case 和 normalization collision 作为静态拒绝样例。

该候选只验证“可定义稳定最小规则”的可行性，不冻结 production 命名规则，也不能仅凭 Windows execution 声称真实跨平台 filesystem 行为已验证。Results 必须保留这一 evidence boundary。

## 7. 非目标

- 修改或迁移任何 production source、production test seam、public export、dependency、package metadata 或 lockfile；
- 构建可复用 production framework、通用 plugin SDK、真实 WebSocket server/client 或真实 Provider Adapter；
- 重新扫描或热加载 Extension code、文件 watcher、自动安装、签名、sandbox、Marketplace、进程隔离或 security hardening；
- 验证第三方 Node module loader、真实 OS credential、真实 rate limiter、真实 socket pool 或跨进程资源协调；
- 验证或规定 Extension 内部长期对象的共享、引用计数、依赖图或关闭顺序；
- 复制 `RuntimeApp` queue/Fanout/Session persistence、`AgentRunner` LLM/Tool loop 或 Subagent orchestration；
- 决定 public Hook scheduling、Config Schema 标准、Descriptor serialization、deadline 默认值、Host signal/exit code 或用户界面；
- 修复 CH-07、CH-12、FT-05/06/07/08 记录的 current production gaps；
- 增加与 12 个 canonical evidence group 重复、但不提高可证伪性的 test。

## 8. 方法

### 8.1 执行顺序

1. 在 Results 中冻结环境、commit/branch、Target Hypothesis mapping、目录顺序/冲突 winner table、state invariants、instance/pin/slot counters、request terminal-result table 和 failure injection matrix；
2. 创建 fixture-local TypeScript/Vitest isolation，并证明 root build/test 不发现 `.spike.ts`；
3. 先建立 `P3-E02`/`P3-E05` 共用 External chat fixture，验证一个 Extension 的原子组合、内部对象不泄漏和 Capability 边界；
4. 完成 `P3-E01`、`P3-E03`、`P3-E04` 的 acquisition、one API、typed projections 和 Schema evidence；
5. 以同一 immutable Snapshot/ownership ledger 建立 `P4-E01` 的 generation capture/pin；
6. 逐步加入 pre-publish coordination 与 duplicate no-op (`P4-E02`/`P4-E03`)、retirement (`P4-E04`/`P4-E05`)、dynamic conflict (`P4-E06`) 和 Shutdown (`P4-E07`)；
7. 每个首个可证伪场景通过后才扩大到对应 table-driven failure matrix；
8. 记录 canonical matrix、反例、Stop Conditions、current gaps、限制和 cleanup 顺序；
9. Results review 前保留 disposable fixture；Owner 接受 Results 后按 §14 删除整个 fixture，再验证 cleanup，最后才可将 AF-06 晋升为 `Completed`。

### 8.2 确定性控制

- 所有并发交错使用 deferred barrier、显式状态 gate 和手动推进的 logical deadline；不得使用 wall-clock sleep 判断顺序；
- atomic publish 用单一同步 commit point 表示；测试必须在 barrier 两侧分别观察，不得假设 Promise 调度顺序；
- Extension instance start/stop、pin、Abort、entry execution、projection access、request terminal result 和 slot transition 都使用 scenario-local counter/ledger；不记录 Extension 内部对象 membership；
- forbidden-access evidence 必须使用 fixture-local TypeScript compiler API 对 compile-negative sample 断言 diagnostics code/location，并用 TypeScript AST 扫描 registration、validation、Registry、consumer 和 Runner bridge 的 forbidden import、member access、arbitrary token lookup、concrete source identity branch 与 Transport downcast；source acquisition 是唯一允许区分 Builtin/External 的边界；一个故意包含各类违规的 positive-control fixture 必须产生冻结的 diagnostics，删除违规后正式 fixture 才可归零；只记录初始值为 0 的 counter 不构成证据；
- cleanup failure 是场景结果，不得在 `afterEach` 静默吞掉；
- 每个 permutation 必须有预先冻结的 expected result；不得观察后修改 winner 或 failure classification；
- table-driven case 可以共享 setup 和 instrumentation，但每个 canonical ID 必须保留独立、可定位的 assertion/result row。

Request terminal result 按请求角色固定，不允许场景执行后再选择类别：

| 请求情形 | 唯一 terminal result |
|---|---|
| 自身 candidate 在 publish 前失败且 cleanup 收敛 | `rejected` |
| 被较新请求覆盖 | `superseded`；后续 cleanup failure 不改写该结果 |
| 因 candidate cleanup 或 retirement 不收敛而未开始的 latest/pending/future request | `blocked` |
| Shutdown 取消尚未 publish 的 reload request | `shutdown/cancelled` |

已 publish 请求的成功结果不因后续 retirement failure 改写；同 identity duplicate enable 返回带 warning 的 `no-op`，且不创建 candidate instance。

### 8.3 current component 的允许用法

- `AgentRunner` 只在成功执行路径证明静态 Tool dispatcher 和一次注册的 `before_tool_call` dispatcher 可以消费 Turn-pinned projection；不得修改 Runner 或复制其 loop。AF-06 不收集或评价任何 `after_tool_call` pass evidence；current `after_tool_call` 是 detached 行为，Target 要求的 awaited `allSettled` 尚未验证，必须作为独立 current gap 留给后续 production Contract；
- current Tool/Hook/Channel types 只作为可复用 Contract 输入；不声称其 shape 是最终 Extension Contract；
- temporary Session fixture 只能写 OS temporary directory，并在场景结束后递归清理；
- disposable turn-tree harness 只管理 generation capture/inheritance/pin/Abort，不模拟消息历史、LLM 调用、Tool rounds、Fanout 或队列策略。

## 9. Canonical evidence matrix

### 9.1 Phase 3 静态组合与边界

| ID | Target | 最小实验 | 必须观察 | 反例 |
|---|---|---|---|---|
| `P3-E01` | `P3-H01` | valid/missing-field/path-escape/loose-script/nested candidate；重复 External ID；External/External 与 Builtin/External Contribution conflict；重复 Builtin Extension ID；Builtin/Builtin Contribution identity conflict；排列原始 acquisition order | 仅 valid direct child 进入 loader；静态拒绝的 entry execution count 为 0；Builtin 胜出；External 按冻结目录键 first-wins；后续 External 整组隔离且 warning 含 winner/loser/identity/order；重复 Builtin ID、Builtin Contribution conflict 和其他无效 Builtin 各有独立 assertion/result row，均在清理后阻止 Snapshot publish；全部 acquisition permutations 得到相同结果 | 必须执行入口才能判定最小安全性；路径逃逸；结果依赖 filesystem/registration/request order；部分 External 发布；任一 invalid/duplicate/conflicting Builtin 后仍 publish |
| `P3-E02` | `P3-H02` | 对共用 External chat fixture 在 load、Channel/Tool/Hook/Provider registration、Config/Capability validation、instance start/readiness、ownership handoff 两侧注入失败 | handoff 前 creator 保持 rollback ownership；handoff 后唯一 Extension-instance Owner 可定位；失败清理只调用该 instance 的 `stop()` 且恰好一次；失败单元零部分 Contribution/实例残留；其他 valid unit 的 Snapshot 相同；Framework/消费者无法取得 Extension 内部对象 | Snapshot 污染；无 Owner/多 Owner；重复 `stop()`/实例泄漏；Framework 开始管理内部对象；无关 unit 结果改变；fixture 必须位于 `runtime/` 或读取 Runtime 私有状态 |
| `P3-E03` | `P3-H03` | Builtin/External 通过同一 API 注册 Tool/Hook/Channel/Provider；各 consumer 只取得对应 typed projection；Runner 使用静态 Tool 与 `before_tool_call` dispatcher；TypeScript compiler API 执行一个 compile-negative positive-control fixture，AST 扫描 acquisition 之后的完整路径，deliberate denial probe 触发 runtime refusal | source acquisition 是唯一 source-specific branch；之后 registration/validation/Registry/consumer/Runner 无来源分支；四类均可消费；positive control 的 forbidden import/member/token lookup/source branch/downcast 产生冻结 diagnostics，正式 fixture 对同一规则为 0；denial probe 被拒绝且不产生 side effect；无法取得 mutation、无关 projection、RuntimeApp private state 或 arbitrary token | acquisition 之后仍按来源分支；任一 kind 需要独立 registry、`get(any token)`、中央 Extension union、Runner branch 或 per-generation Runner Factory；检查器抓不到 positive control；只靠未触发/初始为 0 的 counter 宣称 denial |
| `P3-E04` | `P3-H04` | 两个 Extension 使用重名字段；同一 Extension 覆盖 supported/obsolete/future Schema identity、显式 migration 成功/失败、Schema content failure | namespace 不冲突；静态版本拒绝 entry execution count 为 0；supported/migrated 得到同一 validated namespace input；拒绝整组隔离且可诊断；Extension 只见自身 config | 先执行入口才能发现 identity/version；依赖 load side effect；复制第三方字段到中央 Config；泄漏全局 Config；无 migration path 时不 fail closed |
| `P3-E05` | `P3-H05` | 在 P3-E02 的同一 fixture 注入 required/optional startup Extension Capability，以及 present/missing current-call Channel Capability；typed identity 驱动 proprietary action | required 缺失整组隔离；optional 缺失只产生预定义且原子验证的 degraded unit；typed identity 与 present current-call Capability 足以成功执行一次可区分的 proprietary action；调用期缺失只拒绝/降级当前调用且 action count 不增加；无 Snapshot mutation、Channel downcast、Transport payload 或全局 current Channel | present identity/Capability 仍无法执行 action；校验失败后部分发布；缺 Capability 仍执行 action；需要 Service Locator、payload downcast、global Channel 或 Snapshot mutation |

### 9.2 Phase 4 Snapshot 与 Lifecycle

| ID | Target | 最小实验 | 必须观察 | 反例 |
|---|---|---|---|---|
| `P4-E01` | `P4-H01` | barrier 强制 Root capture 与 publish commit 两种先后；N Root 运行时 publish N+1，publish 后从 N Root 创建 Child，同时创建新 Root | capture/commit 只有一个线性化结果；N tree 全部使用 N；新 Root 使用 commit 后 current；全部 projection 不混代；pin 恰好释放一次且直到 tree 终止才归零 | Root 无确定 generation；Child 使用 N+1；同一 tree 混代；pin 提前/重复释放 |
| `P4-E02` | `P4-H02` | prepare、Config/Capability validation、instance start、readiness、Snapshot build、pre-commit failure；candidate Abort/stop 收敛、失败、不收敛 | candidate 不接 ingress；current/ingress 不变；正常 cleanup 对 candidate instance 恰好调用一次 `stop()`；自身失败 request 返回 `rejected`；cleanup 不收敛时记录 candidate/Extension ID/Owner/stop error，未开始的 latest/pending request 返回 `blocked` 并清空 slots；future reload 返回 `blocked` 且不启动 candidate；Shutdown 只做一次有界重试 | current 污染；request 返回 success/no-op/错误类别或永久等待；实例残留不可归属；failure 后仍启动 reload；在残留 candidate 外启动替代 candidate |
| `P4-E03` | `P4-H03` | prepare/validate 与 ready/commit barrier 上提交 A/B/C；superseded cleanup 不收敛；重复提交与 current 同 identity 的 enable request；N retirement 边界提交 D/E/F | supersede/commit 单一结果；每个被覆盖 request 以自己的 request ID 返回 `superseded`，后续 cleanup failure 不改写；受不收敛 cleanup 阻断且未开始的 latest/pending 返回 `blocked`；duplicate request 在 candidate start 前 warning/ignore 并返回 `no-op`，不创建 instance、generation 或 retirement；retirement 期间仅一个 pending latest，旧 pending 返回 `superseded`；不存在第二 retiring generation | request/slot 悬挂、错绑 request ID 或误报 success/no-op；已 publish 撤销；duplicate 启动第二 instance 或产生 generation/retirement；pending 与 retirement 同时启动；多代 retirement |
| `P4-E04` | `P4-H04` | N 中启用一个 External chat Extension instance；分别运行 short、Abort-responsive、nonresponsive Turn tree；明确 publish disable 该 Extension 的 N+1 candidate，并推进 drain/Abort-convergence deadline | External chat Contributions 在 N+1 全部不可见；已 pin 的 N tree 继续使用 N，Extension instance 在 pin 释放前保持启动；short/Abort-responsive tree 释放 pin 后只调用一次 Extension `stop()`；任一 N pin 不收敛时 instance 不被强制停止，残留包含 generation/Extension ID/Owner/blocking tree；一个新 N+1 Root 在 N drain/nonconvergence 期间仍被接受并正常完成 | disable 后 N+1 仍可见被禁用 Contribution；旧 work/instance 提前失效；新 N+1 Root 被拒绝、取消或 Abort；有 pin 时强制 `stop()`；无限等待；instance/pin 残留不可归属 |
| `P4-E05` | `P4-H05` | 复用 disable/retirement matrix；另在 pins 归零后注入 Extension instance `stop()` 失败，并在 success/failure barrier 提交 pending reload | N+1 始终 current，已 publish request 保持 success；有 pin 时不调用 `stop()`；stop failure 不回滚 N+1；structured retirement failure 包含 generation、Extension ID、Lifecycle Owner 和 stop error；尚未开始的 pending request 以自己的 request ID 返回 `blocked` 并清空；future reload 返回 `blocked`；Shutdown 有界重试且一次成功后不重复 stop | 回滚 N+1 或改写已 publish request；有 pin 时停止 instance；stop error 被吞掉/不可归属；pending 返回 success/no-op、错绑或悬挂；第二 retirement、多 Owner 或重复成功 stop |
| `P4-E06` | `P4-H06` | enable 排序更靠前且与 current External 冲突、但 identity 不同的 unit；另注入 Builtin/External conflict | candidate result 在 publish 前列出 winner、连带退出/retire 的完整 unit 和 warning；Builtin 始终胜出；裁决不使用 request arrival order；Extension 原子发布 | 隐式挤出；到达顺序裁决；warning 不可审计；部分 Extension 发布 |
| `P4-E07` | `P4-H07` | candidate/current/retiring/failed-retirement 与 publish commit barrier 各触发 Shutdown；使用已存在的 Builtin/External instances 验证 Framework 按启动依赖逆序调用 instance `stop()`，并注入 nonresponsive tree、candidate cleanup failure 和 instance stop failure | Shutdown/commit 单一线性化结果；停止新 Root/reload；pending 以自己的 request ID 返回 `shutdown/cancelled`；candidate Owner 仅有界重试；有 pin generation 的 Extension instance 不被强制停止并逐项报告；可停止的 Extension/Module instances 按启动依赖逆序 stop，每个 instance 至多成功一次；一个失败不阻止其他可安全停止的独立 instance；无新 candidate | deadlock/无限等待；有 pin 时强制 stop；实例停止顺序错误；重复 stop；孤立 published generation；跳过可安全停止的独立 instance；错误覆盖、错误 terminal category 或 Shutdown 中启动 candidate |

### 9.3 证据合并纪律

为避免重复测试：

- `P3-E02` 与 `P3-E05` 使用一个 integrated External fixture 和同一组 instance lifecycle counters；
- `P3-E01` 与 `P3-E04` 可以共用 acquisition permutation table，但必须分别断言 static execution 与 Schema/Namespace 结果；
- `P4-E02` 与 `P4-E03` 可以共用 candidate lifecycle matrix；
- `P4-E04` 与 `P4-E05` 可以共用 retirement matrix；
- `P4-E06` 复用 `P3-E01` 的冻结 conflict oracle；
- `P4-E07` 复用 lifecycle instrumentation，但 Shutdown/commit linearization 必须有独立 canonical evidence；
- Spec 不规定 test 数量。一个 table-driven test 可以覆盖多个 case，但不能用同一非区分 assertion 同时宣称多个 Hypothesis 通过。

## 10. 成功与评估规则

### 10.1 `Provisional Pass` 必要条件

- `P3-E01..P3-E05` 与 `P4-E01..P4-E07` 全部 Pass；
- `AF06-ST01..AF06-ST10` 均未命中；
- External/Builtin source acquisition 后使用同一 registration/validation/Snapshot path；
- published Snapshot 及 typed projections 不可修改，Root/Child tree 不混代；
- pre-publish failure 零 partial publish，post-publish failure 不回滚 committed Snapshot；
- 每个 Extension/Module instance 只有一个 Lifecycle Owner；每个 start/stop 和 pin acquire/release 可计数且不会重复成功；
- Framework 在 partial-start rollback、normal retirement 和 Shutdown 中只编排 instance-level stop；Extension 内部对象的共享和关闭顺序不属于 Framework evidence；
- Service Locator、全局 Config、Runtime private state、concrete Channel/Transport downcast 和 central source branch 均为 0；
- 所有 request/slot 都以正确 request ID 获得场景规定的 terminal result，无 wall-clock liveness、静默残留或未归属 error；
- production、public Contract、dependency、package/lockfile 与 production test seam 均无变化；
- fixture TypeScript、isolated suite、AF-04 protection line、root regression、lint、build 和 `git diff --check` 按 §13 记录。

### 10.2 非通过结果

- 观察到明确反例时，对对应 Hypothesis 标记 `Falsified`；
- timebox、环境或 Stop Condition 阻断时标记 `Inconclusive / Blocked`；
- 不得通过增加 production seam、宽松 retry、延长 timeout、跳过 cleanup、减少 failure cases 或引入通用 framework 把失败改写为通过；
- 结果可以部分支持 12 个 Target Hypothesis，但 `AF06-H01` 只有在全部 canonical evidence 成立时才可标记 `Supported / Provisional Pass`。

## 11. 失败与停止条件

以下任一条件立即停止扩大实验，记录已收集证据并进入 Owner/Architecture Review：

- **AF06-ST01：** 需要修改 production source、public Contract、production test seam、dependency、package metadata 或 lockfile；
- **AF06-ST02：** 必须复制 `RuntimeApp` queue/Fanout/Session/Shutdown loop、`AgentRunner` LLM/Tool loop，或引入第二个 Runtime/scheduler 才能成立；
- **AF06-ST03：** Extension 必须取得 Service Locator、arbitrary token、全局 Config、RuntimeApp private state、具体 Channel/Transport payload 或中央类型联合修改；
- **AF06-ST04：** 最小 Descriptor/Schema/path safety 必须执行 Extension 入口后才能判断，安装路径可逃逸，或稳定冲突顺序只能依赖 OS/filesystem/registration/request order；
- **AF06-ST05：** staging/reload failure 产生 partial Contribution visibility，published Snapshot 可变，Root/Child tree 混代，或 capture/publish 无法形成单一线性化结果；
- **AF06-ST06：** Extension instance ownership 无法唯一归属，generation pin 存在时必须强制 stop，成功 instance 会重复 stop，或残留无法关联到 generation/Extension ID/Owner/blocking tree；
- **AF06-ST07：** non-converged candidate/retirement 后仍必须接受新 reload、启动额外 candidate 或形成第二 retiring generation；
- **AF06-ST08：** 测试只能依赖 wall-clock sleep、扩大 timeout、非确定性 retry 或吞掉 cleanup failure 才能通过；
- **AF06-ST09：** 必须从单一 Windows run 推导未被 pure rule/permutation evidence 支持的跨平台 filesystem 结论；
- **AF06-ST10：** 到达 5 个工作日硬停止，或在 3 个工作日建议时间盒结束时仍没有足以 disposition 当前 canonical group 的证据。

停止不等于强行判定全部 Target Architecture 错误。Results 必须指出反例影响的 Hypothesis、仍支持的边界、需要 Owner 决策的选项和禁止继续建设的原因。

## 12. 必须保留的证据

Spike Results 至少保留：

1. repository commit/branch、OS、Node、npm、TypeScript、Vitest 和关键 dependency 版本；
2. 实际 fixture 文件清单、production import/reference absence 和 root test-discovery isolation；
3. `P3-E01..P3-E05`、`P4-E01..P4-E07` 的独立结果、精确 test locator 和 Stop Condition disposition；
4. 冻结的目录 normalization/order/conflict winner table及 acquisition permutations；
5. Descriptor/Schema/version/migration/static-rejection matrix 与 entry execution counters；
6. Contribution/projection/source mapping、positive-control compile-negative diagnostic code/location、acquisition 之后 fixture/bridge 的 AST scan，以及 deliberate denial probe 的无副作用结果；
7. Extension instance ownership handoff、start/stop、Abort、pin、generation、candidate/retiring/pending slot，以及按 request ID 记录的 terminal result counters；
8. Root/publish/Child linearization、pre-publish failure/latest-wins/no-op、retirement、dynamic conflict 与 Shutdown branch matrix；
9. 每个 failure injection 的 current Snapshot、published generation、candidate residue、retirement residue、pending disposition 和 structured diagnostics；
10. current production gaps、deviations、反例、limitations、unresolved risks 和不被 Spike 冻结的 TypeScript shape；
11. network/secret/paid-call counters，以及 package/lockfile/production diff evidence；
12. Owner acceptance 后的 disposable cleanup 和 cleanup validation record。

Results 不得只记录“suite passed”。任何不在 retained matrix/counter 中的行为不得被写成已验证结论。

## 13. 验证计划

以下命令只在 Spec 获接受并执行 Spike 后运行。

### 13.1 首个可证伪场景

```text
npx tsc --noEmit -p test-fixtures/architecture-spikes/af-06/tsconfig.json
npx vitest run --config test-fixtures/architecture-spikes/af-06/vitest.config.ts -t "P3-E02|P3-E05"
npx vitest run --config test-fixtures/architecture-spikes/af-06/vitest.config.ts -t "P4-E01"
npx vitest run --config test-fixtures/architecture-spikes/af-06/vitest.config.ts -t "AF06-PROBE-SHUTDOWN-PUBLISH"
```

首个场景只验证 integrated Extension、generation linearization，以及一个非 canonical 的 Shutdown/publish 顺序探针能否以 deterministic harness 表达；该探针不表示 `P4-E07` Pass。完整 `P4-E07` 只在 `P4-E02..P4-E05` 所需 lifecycle 状态成立后执行。

### 13.2 完整 Spike evidence

```text
npx vitest run --config test-fixtures/architecture-spikes/af-06/vitest.config.ts
npx tsc --noEmit -p test-fixtures/architecture-spikes/af-06/tsconfig.json
```

fixture-local Vitest config 只能 include `.spike.ts`；root config 不得发现该 suite。fixture TypeScript config 不进入 production build。

### 13.3 AF-04 保护线

```text
npm test -- src/architecture-fitness/ft-05-extension-capability.test.ts src/architecture-fitness/ft-06-change-locality.test.ts src/architecture-fitness/ft-07-registry-snapshot.test.ts src/architecture-fitness/ft-08-contract-inventory.test.ts
npm test -- src/core/runner/AgentRunner.test.ts src/runtime/RuntimeApp.test.ts -t "CH-04|CH-07|CH-08|CH-10|CH-12"
```

这些检查只证明 current behavior/fitness baseline 未被 accidental change 破坏，不替代 AF-06 canonical evidence。FT-09 的 narrow active-document manifest 当前不枚举 Spike Specs/Results，因此它不能单独证明本 Spec 已被治理；本 Draft 不夹带修改该 manifest。

### 13.4 Repository 收口

```text
npm run lint
npm test
npm run build
git diff --check
```

完整回归只在 Spike evidence 收口和接受后 cleanup 各运行一次，除非失败需要在未修改工作树下确认是否 transient；不得把反复全量运行当作 canonical evidence。

## 14. 约束与清理

- 使用仓库现有 Node 22.x、TypeScript、Vitest 和依赖；不得新增 package；
- 不读取 credential、API key 或其他 secret，不访问网络，不产生费用，不启动长期 background process；
- proprietary WebSocket、Provider、platform action、deadline 和 filesystem order 均为 deterministic fixture；不得声称真实第三方兼容或真实 OS portability；
- temporary Agent Home/Session 只能位于 OS temporary directory，并在每个场景后递归清理；
- 每个 test 后释放 barrier、Abort listener、pin、slot 和 disposable Extension instance；cleanup failure 必须使场景失败；
- Extension 内部长期对象只由 Extension 自己管理；Framework、consumer、Snapshot 和 Registry 不取得对象引用、membership 或关闭权；
- published Snapshot 不可为测试清理而原地修改；Framework 只通过 instance Owner 和 generation pin 决定何时调用 Extension `stop()`；
- fixture 不进入 production export，不成为后续 Slice 的复制起点，不使用生产 symbol 命名制造已接受 API 的印象；
- Results review 前保留 disposable fixture；Results 被 Owner 接受后删除整个 `test-fixtures/architecture-spikes/af-06/**`，除非 Owner 单独批准保留窄 Contract fixture；
- 删除 fixture 后运行 cleanup validation并记录结果，之后才能把 AF-06 状态晋升为 `Completed`。

## 15. 输出

AF-06 至少产生：

1. `docs/architecture/af-06-extension-framework-spike-results.md`；
2. 对 `AF06-H01`、`P3-H01..P3-H05`、`P4-H01..P4-H07` 和 `P3-E01..P3-E05`/`P4-E01..P4-E07` 的 evidence-backed disposition；
3. AF-07 与 Slice 3/4/5 Module Spec 可使用、但不冻结接口的 responsibility、state、failure 和 ownership建议；
4. current production gap 与 deferred public Contract/deadline/platform/portability risk 清单；
5. disposable experiment cleanup record；
6. 父计划 AF-06、Target status 和 Foundation Gate evidence items 的 evidence-based更新方案。

Results 不得把 fake chat Extension、in-memory protocol、Windows execution 或 target-shaped harness 表述为 production readiness、真实第三方兼容、跨平台 filesystem 证明或 Foundation Gate 整体通过。

## 16. Spec 接受决策

本 Spec 晋升为 `Accepted` 前，项目所有者需确认：

- [x] `AF06-Q01` 与 `AF06-H01` 是单一、可证伪且足以回答 AF-06 的实验边界；
- [x] `P3-E01..P3-E05` 与 `P4-E01..P4-E07` 完整对应 Target Hypothesis，全部通过才可建议 aggregate `Provisional Pass`；
- [x] `P3-E02`/`P3-E05` 使用同一个 External chat fixture，且证据合并纪律不会制造重复、不可区分测试；
- [x] 接受 disposable target-shaped Registry/Lifecycle/Turn-tree harness，不把 current `RuntimeApp` 包装成 Target implementation，也不复制 Runtime/Runner loop；
- [x] 接受 current `AgentRunner` 仅由静态 generic Tool/Hook dispatcher验证 no central/source branch，不声称 current Runner 已支持 Snapshot；
- [x] 接受规范目录键只作为纯规则/排列候选，单一 Windows run 不构成真实跨平台 filesystem 证明；
- [x] 建议 Timebox 为 3 个工作日、5 个工作日硬停止；
- [x] production、public Contract、dependency、lockfile 和 production test seam 均不可修改；
- [x] Results review 前保留 disposable fixture，Results 接受后默认删除；
- [x] 接受本 Spec 只授权 disposable AF-06 Spike，不授权 AF-07、Architecture Slice、production dynamic reload 或 Foundation Gate 整体通过。

## 17. 当前状态

AF-05 已完成并为 Provider/Model Hypothesis 提供 Owner-accepted disposable evidence。AF-06 Spec 已于 2026-09-03 获项目所有者接受；[AF-06 Extension Framework Spike Results](af-06-extension-framework-spike-results.md) 的 `Provisional Pass` 也于 2026-09-03 获项目所有者接受。mandatory disposable cleanup 和 cleanup validation 已完成，AF-06 已晋升为 `Completed`。该完成只更新 AF-06 evidence，不表示 Foundation Gate 整体通过，也不自动授权 AF-07 或 production work。
