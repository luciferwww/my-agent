# 代码结构调整建议

> 状态：非权威建议，待讨论；不授权实现
> 日期：2026-11-11
> 读者：项目维护者
> 范围：目录结构、模块职责、契约归属与依赖约束

本文基于当前源码及架构文档的静态阅读，提出可分步采用的结构改进方向。它不替代 Current Architecture、Accepted ADR、稳定 Specification 或已接受的 Change，也不是缺陷清单。

目录和命名均为候选方案，不代表已批准的目标结构。涉及模块边界或契约所有权的实施，应依照 [Development Workflow](../governance/development-workflow.md) 单独确认设计与范围。

## 1. 总体结论

现有 `core / runtime / builtins / extension / platform / hosts` 顶层划分基本合理，不建议整体重排，也不建议立即拆成更多 npm packages。

最有价值的方向是：先减少 Runtime 内部的职责集中，再纠正少数契约的概念归属，最后通过目录与架构测试固定已经明确的边界。单纯搬文件不是架构改进的验收条件。

| 顺序 | 建议 | 收益 | 主要注意事项 |
|---|---|---|---|
| 1 | 拆出 Settings 的模型测试与展示投影 | 独立变化原因清晰，减少理解成本 | 保持保存、应用、回滚的事务主线集中 |
| 2 | 提取 Session 消息调度 | 降低 RuntimeApp 的状态复杂度 | FIFO 与 steering 必须继续共用一个队列主人 |
| 3 | 分离应用能力契约与 Channel 契约 | 更准确表达能力所有权 | 避免制造通用 shared/types 模块 |
| 4 | 明确 Core 的基础设施边界 | 让目录、原则与实际依赖一致 | 不为架构纯度抽象所有 I/O |
| 5 | 收敛 Runtime 子目录并增强边界测试 | 提高导航与规则可执行性 | 随职责提取推进，不单独发起大搬迁 |

## 2. 保留的结构

- 保留现有顶层模块划分，以及 Runtime 对组合、执行编排和生命周期的协调职责。
- 保留 Builtins 与独立 Extension packages 的区分，不强求统一成一种物理目录。
- 保留 Task Tool 通过窄的 `SubagentDelegationPort` 委托执行的边界，不让 Tool 接管 Child 生命周期。
- 保留 [AgentPolicyState](../../src/runtime/policy/agent-policy-state.ts) 对 applied Agent registry、Tool policy、Agent Settings 投影与 diagnostics 的内聚管理；不因 Settings 拆分再建立一份 Agent 状态主人。
- 保留源码旁的单元测试；跨模块集成与架构测试按各自目的组织。
- 保留模块所属的配置与类型定义，不集中到一个全局 types/config 目录。

证据：[架构总览](../architecture/overview.md)、[架构原则](../governance/architecture-principles.md)、[Task Tool](../../src/builtins/tools/task/task-tool.ts)。

## 3. 优先拆分 SettingsManager 的独立职责

### 现状与动机

[SettingsManager](../../src/runtime/settings/settings-manager.ts) 同时负责请求分派、更新串行化、revision、关闭准入、LLM 保存与应用回滚、模型测试，以及不同设置 section 的展示投影。模型测试还拥有独立的超时、取消、临时 Unit 和 generation pin 清理流程。

Agent section 已由 [AgentPolicyState](../../src/runtime/policy/agent-policy-state.ts) 生成，SettingsManager 补充 revision、表单及 model availability。这不是所有展示逻辑仍集中在一个类中的状态；建议应保留已有的职责分离。

其余职责的变化原因仍不同：增加一个 LLM 或 Extension 设置展示字段，不应要求修改者理解模型测试资源的收敛逻辑。

### 建议边界

```text
runtime/settings/
├── SettingsManager.ts     # 准入、串行更新、revision、关闭协调与更新事务
├── model-test.ts          # 模型测试、超时、取消与资源清理
├── section-views.ts       # LLM/Extension 展示、凭据元数据与 restart 状态
└── index.ts
```

先提取模型测试，再提取 LLM/Extension 展示投影。LLM 保存 → 应用 → 判断是否回滚仍由一个更新事务主人协调，不机械拆成多个 Manager。模型测试模块拥有其活动测试和临时资源；SettingsManager 只协调准入、关闭和汇总结果，不重复保存这些状态。

AgentPolicyState 继续拥有 Agent 投影与 applied policy。SettingsManager 协调其准备 → 持久化 → 发布顺序；不要把 Agent 投影重新集中到 `section-views.ts`，也不要仅因它被 Settings 调用就将整个 Policy 模块归入设置目录。

现有 section 数量不足以证明需要通用 `SettingsSectionProvider` 注册框架。继续使用明确的 section 分支可以接受；未来若新增 section 确实造成重复，再评估抽象。

### 验收条件

- 外部 Settings 请求、错误、revision、凭据隐藏和展示语义不变。
- 更新仍串行，load 仍等待更新完成，不暴露暂态候选。
- Agent Policy 先准备、成功持久化后才发布；保存失败不改变 applied policy，动态保存不误应用等待重启的其他 defaults 或全局执行策略。
- Agent Settings 仍只编辑 enablement 与 Tool allow/deny；Context 保持只读，执行和展示共用 startup definition snapshot，不新增按任务读盘或文件监听。
- 共享策略保存后刷新相关只读投影，不改变其他 section 的 revision；受影响 Channel 的编辑器不丢弃其他未保存草稿。
- Agent Policy 更新不引入 Provider generation、资源 retirement 或取消机制。
- 只有确认未发布的 LLM 应用失败才允许按现有契约回滚；未知发布结果不擅自回滚。
- 超时或取消请求不等于临时资源已经释放；实际收敛前保留资源与 pin。
- 模型测试可通过窄依赖独立测试，SettingsManager 不再包含测试执行细节。

## 4. 提取 Session 消息调度，而不是拆成两条队列

### 现状与动机

[RuntimeApp](../../src/runtime/RuntimeApp.ts) 同时持有每 Session FIFO、运行状态、steering waiter、请求完成门、执行树、交互路由与关闭状态。入队、下一轮调度与 steering claim 分布在同一个大类的不同区段。

最自然的提取单位是“一个 Session 内待处理消息的消费协调”，而不是泛化的任务调度框架。

### 建议边界

候选 `SessionMessageScheduler` 统一拥有每 Session 的待处理 FIFO、忙闲调度状态、steering claim/waiter，以及待处理消息的 drop 操作。RuntimeApp 继续负责启动 Turn、捕获 generation、请求完成、事件发送与全局关闭协调；运行中执行的取消控制器也不因本次提取迁入调度模块。

FIFO 与 steering 是同一批已接受消息的两种消费方式，必须继续由一个模块拥有。不要引入独立 steering 队列，也不要让 RuntimeApp 和 Scheduler 各自维护可独立变化的忙闲事实。调度器通过窄的启动回调或明确的返回结果衔接 RuntimeApp，不接收整个 RuntimeApp。

Scheduler 只协调消息消费，不捕获或缓存 Agent Policy、Profile registry，也不因消息入队就提前固定执行策略。策略选择保留在现有 Runtime/Task 准入路径，不能因提取模块改变动态设置的生效时点。

### 验收条件

- 同一 Session 最多一个 Turn，不同 Session 保持可并发。
- 普通执行与 steering 不重复消费、不丢消息；不兼容消息保留既有顺序语义。
- 只有消息真正开始执行时才分配相应 Turn 资源，继续遵循现有请求与路由契约。
- 保持 Root 准入和 Child profile selection 的策略捕获时点；新 Child 使用最新 applied shared Tool defaults 加自身 override，不继承 Parent 捕获的 Tool policy 或 named-parent-specific denies，已准入 Turn 的策略不被后续保存替换。
- Task lookup 保持 explicit disablement 拒绝与 unavailable definition fallback 的区别。
- Abort、Shutdown、steering 唤醒和请求 terminal 的既有行为有确定性测试覆盖。
- RuntimeApp 不再直接修改队列内部集合；调度模块不依赖具体 Provider 或设置持久化。

这项涉及并发语义，应独立交付，不与 Settings 拆分或纯路径迁移混做。

## 5. 将应用能力契约从 Channel 中分离

### 现状与动机

[Channel 类型](../../src/core/channel/types.ts) 同时定义 Transport/Channel 契约、Settings、Model Catalog、Session 管理与观察等能力。SettingsManager 因而从 Channel 模块导入自己实现的 Settings 契约。

这些类型是 transport-neutral，并不因此就是 Channel 所有：Settings 是应用提供、Channel 消费的能力。这里主要是所有权表达问题，不直接证明存在运行缺陷。

### 建议边界

先将 `SettingsCapability`、`SettingsActionRequest`、`SettingsActionResult` 放入独立的应用设置契约模块。随后按实际引用评估 Model Catalog 的归属，不一次搬走所有 Channel 类型。

- Channel 保留实例、请求入口、路由、投递与交互适配契约。
- `ChannelRuntimeCapabilities` 继续组合各领域提供的能力。
- 通用能力不携带具体 Channel 的实现细节。
- [Extension API](../../src/extension/api/index.ts) 继续作为公共门面，尽量保持扩展使用的导出名称与入口稳定。

目标目录需在实施设计时确认。不要把全部共享契约集中进 `shared/types.ts`，也不要仅为移动几个接口创建 npm package。

### 验收条件

Settings 实现与非 Channel 调用者不再为通用设置能力依赖 Channel 模块；权威类型只有一份；Channel 仅导入并组合能力；公共 Extension API 的类型检查与构建验证通过。

## 6. 统一 Core 的含义，再选择性分离基础设施

### 现状与动机

当前 Core 既包含稳定契约和算法，也包含具体基础设施：

- [MemoryManager](../../src/core/memory/MemoryManager.ts) 创建 SQLite Store 与本地 embedding provider。
- [SessionManager](../../src/core/session/SessionManager.ts) 直接处理文件系统持久化。
- [图像优化](../../src/core/media/image-optimize.ts) 直接依赖 sharp。

“产品核心功能”可以包含这些实现，但“独立于具体基础设施的稳定核心”不能默认包含它们。[AP-01](../governance/architecture-principles.md#ap-01-stable-core-does-not-depend-on-concrete-integrations) 采用后一种依赖约束；现有架构测试又显式分类部分 Infrastructure 和 Mixed 文件。建议将这种物理目录与逻辑边界的关系说明清楚，而不是仅凭目录名声称已实现严格分层。

### 建议边界

如继续按 AP-01 收敛，可先评估 Memory：它已有 `MemoryStore`、`EmbeddingProvider` 契约，适合把具体创建移到组合处或明确的适配器边界，核心检索与索引协调消费契约。

具体资源应仍由一个 Memory 生命周期单元创建和关闭，不能把内部对象全部摊给 Runtime Builder。Session 和 Media 等到出现独立验证、替换实现或部署隔离的实际收益后再拆；不为每个文件操作制造 Port。

### 验收条件

- 目录说明、Accepted 架构原则与依赖测试对同一边界给出一致解释。
- 若提取 Memory，核心协调可使用 Fake Store/Embedding 验证，不在核心入口实例化具体适配器。
- 部分创建失败和正常关闭仍只有一个资源主人，不改变降级与清理语义。
- 不增加没有实际独立测试价值的转发层。

## 7. 随职责提取收敛目录与边界测试

候选目录如下；只展示可能收敛的分组，并非完整目标树，也不要求立即移动所有文件：

```text
runtime/
├── RuntimeApp.ts
├── composition/          # Unit、registry、generation、reload
├── settings/             # 设置更新与模型测试
├── session/              # 已有 Session 协调与权限状态
├── scheduling/           # 消息队列与 steering 调度
└── turn-interaction/     # 已有交互管理
```

先确定职责，再搬文件；deadline、shutdown 等跨职责文件按实际主人定位，不为目录对称强行归组。AgentPolicyState 同样按执行策略所有权定位，不因提供 Settings 投影而强行并入 `settings/`。移动时保留同模块测试，更新相对导入、构建脚本及受影响文档。

[FT-13](../../src/architecture-fitness/ft-13-source-layout-convergence.test.ts) 已检查部分模块的公开入口，[边界规则](../../src/architecture-fitness/rules.ts) 维护了显式 Mixed 清单。每提取一个真实模块，就补充其公开入口和依赖方向约束：外部使用公开入口，内部允许直接引用内部文件；不要把所有跨文件导入都变成 barrel 导入。

Mixed 清单应用于解释和约束既有混合边界，不应成为新增耦合的默认豁免。无需在同一轮强行清零；按已确认的拆分逐步减少。

验收不是“文件已搬完”，而是调用者不再依赖模块内部状态、依赖规则能够拦截反向引用，且相关行为测试保持通过。

## 8. 建议推进方式

1. **先做 Settings 职责提取。** 优先模型测试，再做 LLM/Extension 展示投影；保留 AgentPolicyState 边界，不改变外部行为，不扩展设置功能。
2. **单独设计消息调度边界。** 先明确状态主人、回调边界和并发验收，再迁移代码。
3. **分离 Settings 契约归属。** 独立检查公共导出与模块依赖，不顺带重写 wire 协议。
4. **按证据决定 Core 收敛。** 先记录当前边界与期望差异，再决定是否提取 Memory 适配器，不预先承诺全 Core 重构。
5. **各步同步目录、架构测试与权威文档。** 不额外组织一次全仓库格式或命名迁移。

上述顺序是收益建议，不是已接受的交付计划。截至 2026-11-11，[Agent Management Specification](../specifications/agent-management.md) 与 [ADR-023](../decisions/adr-023-agent-definition-discovery-and-settings.md) 记录该功能已实现并验证、owner closeout 待完成。后续重构应以这些已交付契约为基线，不再将其视为尚未实现的前置功能，也不能借结构调整重新设计其行为。

本次复核发现 [Changes 索引](../changes/README.md) 仍写 implementation and validation pending，与上述交付记录不同步；该索引描述不能作为功能未实现的依据。实施前仍需复核最新源码、契约与 owner 决策。

### 验证策略

| 事项 | 最小验证 | 扩展验证 |
|---|---|---|
| Settings 拆分 | 现有 Settings 单测、新模块独立测试、先保存后发布与 pending-restart 字段保留 | startup Context 快照、共享投影与未保存草稿、关闭、超时、回滚、模型测试资源收敛 |
| 消息调度 | FIFO、跨 Session 并发、steering claim/wakeup、策略捕获时点 | 最新 Child policy、disabled/fallback、Abort/Shutdown、terminal、路由与 generation 生命周期回归 |
| 契约归属 | 类型检查、公开导出与边界测试 | Host/Extension 构建及受影响 Channel 测试 |
| Memory 边界 | Fake 契约测试、创建失败和清理测试 | 实际 Store 集成、降级与关闭回归 |
| 目录迁移 | 导入解析、architecture fitness tests | 构建及受影响的打包/资源审计 |

任何一步如果只是把共享可变状态藏到新类中，却没有明确唯一主人，应视为未达到结构改进目标。

## 9. 分析限制

本建议来自源码和文档的静态抽样阅读，不是全仓库依赖图审计，也没有证明当前实现存在上述行为缺陷。分析期间终端执行受权限模式限制，未运行测试、构建或自动依赖扫描；本文中的验收条件均是后续实施需要验证的目标，不是已通过的检查。

2026-11-11 复核覆盖了最新 SettingsManager、AgentPolicyState、RuntimeApp 的队列与策略相关位置、Runtime Builder、Task Tool、Channel 契约及架构测试规则，并对照 Agent Management Specification 与 ADR-023。五项建议方向与优先级保留，但 Settings 展示提取范围已收窄，交付状态和 Agent Policy 验收约束已更新。Specification 中记录的验证结果属于既有交付证据，不是本轮执行结果。

不能以本次观察替代实施前复核。若后续证据表明某项拆分增加了转发层、资源所有权歧义或测试耦合，应缩小或取消该项，而非为保持目录方案继续推进。
