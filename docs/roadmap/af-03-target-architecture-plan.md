# AF-03 Target Architecture Execution Plan

## 1. 文档状态

- **状态：** Accepted
- **版本：** 1.0
- **日期：** 2026-08-28
- **所有者：** 项目所有者
- **父计划：** [Architecture Foundation Plan](architecture-foundation-plan.md) AF-03
- **前置工件：** [Architecture Principles](../architecture/architecture-principles.md)、[Domain Glossary](../architecture/domain-glossary.md)
- **目标产物：** `docs/architecture/target-architecture.md`

本计划管理 AF-03 的执行过程和检查项。它不替代 Target Architecture，不提前接受 AF-05/AF-06 的假设，也不授权生产迁移。

## 2. 目标与退出条件

### 2.1 目标

形成一份可评审的 Target Architecture，明确逻辑边界、依赖、所有权、关键调用流、Lifecycle 和迁移边界，为 AF-04 测试保护线、AF-05/AF-06 Spike 及后续 Architecture Slice 提供共同骨架。

### 2.2 总体退出条件

- [ ] Target Architecture 使用 Domain Glossary 中的规范词汇；
- [ ] AP-01 至 AP-13 均有设计映射或明确的不适用说明；
- [ ] Foundation Plan 中 AF-03 的全部“必须覆盖”项可追踪到目标文档章节；
- [ ] Foundation Plan 中 AF-03 的全部验收项具有 Target Architecture 文档证据，或明确记录后续 Spike 的 Hypothesis、实验输入、成功条件和停止条件；
- [ ] 未经证据确认的边界标记为 Hypothesis/Open Question，不写成当前实现事实；
- [ ] AF-04 Characterization/Fitness Test 输入清单完成；
- [ ] AF-05 和 AF-06 Spike 输入、成功条件与停止条件边界完成；
- [ ] 独立架构评审无 Critical/High 阻断项；
- [ ] 项目所有者确认 Target Architecture 并晋升为 `Accepted`。

## 3. 范围

### 3.1 范围内

- Domain、Application、Infrastructure、Composition 的职责和依赖方向；
- Stable Core、Port、Adapter、Runtime Builder 和 RuntimeApp 边界；
- Provider/Model Resolution 的逻辑组件、事实来源和调用方向；
- Extension、Runtime Module、Contribution、Registry 和 Registry Snapshot 边界；
- Tool、Hook、Channel 的注册、解析和执行关系；
- Config Namespace、Schema、Extension Capability 和 Resource Ownership；
- Event、Error、Lifecycle、启动、排空、回滚与 Shutdown 责任；
- Parent Turn、Subagent Turn、Tool、Channel 和 Extension 变更的关键调用流；
- Legacy/Compat 单向依赖和 Slice 迁移接缝；
- AF-04/05/06 的证据需求和开放问题。

### 3.2 非目标

- 修改生产代码、目录或公共类型；
- 实现 Characterization/Fitness Tests；
- 执行 Provider/Model 或 Extension Framework Spike；
- 冻结未经 Spike 验证的具体 API、Schema 或并发算法；
- 设计 Marketplace、远程下载、任意热加载、沙箱或分布式 Event Bus；
- 为每个未来 Provider、Channel 或 Extension 设计完整实现；
- 让全部 Slice 1–6 提前达到 Definition of Ready。

## 4. 执行规则

1. Phase 按顺序推进；同一时间只允许一个 Phase 为 `In Progress`；
2. Check Item 只有在目标文档或评审记录中有可定位证据时才能勾选；
3. 文档事实取证优先使用已验证 Current Architecture、实现文档和现有 Characterization Tests；必要代码取证只服务于当前边界，不做全仓扫描；
4. 发现当前实现与已 `Accepted` 原则冲突时，记录为迁移输入，不在 AF-03 中静默修改原则或生产代码；
5. 外部 SDK、并发、排空、回滚或资源释放无法由文档/现有测试确认时，转为 AF-05/AF-06 的可证伪 Hypothesis；
6. Mermaid 图必须提供 ASCII fallback，并表达相同边、所有权和调用顺序；
7. 每个 Phase 完成后同步本计划状态，不批量预勾选未来工作。

## 5. Phase 0：输入基线与追踪矩阵

**目标：** 固定 AF-03 的权威输入、事实边界和章节骨架。

### Check Items

- [ ] 建立 AF-03 必须覆盖项到 Target Architecture 章节的追踪矩阵；
- [ ] 建立 AP-01 至 AP-13 到设计章节和验证方式的追踪矩阵；
- [ ] 列出可作为 Current Fact 的文档与测试证据，并记录各自状态；
- [ ] 列出存在冲突或过期风险的文档，只作为取证输入而非权威事实；
- [ ] 建立术语检查清单，禁止用 Config、Facts、Policy 或 Snapshot 相互代称；
- [ ] 创建 `docs/architecture/target-architecture.md` 骨架，状态为 `Draft`；
- [ ] 记录 AF-03 的初始 Open Questions、Assumptions 和 Deferred 项。

### Exit Gate

- [ ] 每个父计划必覆盖项都有唯一目标章节；
- [ ] 每条原则都有预期设计证据和后续验证类型；
- [ ] 没有把未验证文档整体当作 Current Architecture。

## 6. Phase 1：逻辑边界与依赖方向

**目标：** 定义四个逻辑边界、Stable Core 和 Composition 的责任图。

### Check Items

- [ ] 定义 Domain 拥有的概念、不变量和禁止依赖；
- [ ] 定义 Application 拥有的用例、Policy、Port 和禁止依赖；
- [ ] 定义 Infrastructure Adapter 的 SDK/Transport/Store 隔离责任；
- [ ] 定义 Composition Root、Runtime Builder 和具体实现选择责任；
- [ ] 定义 Runtime 与 Runtime Composition 的差异；
- [ ] 给出现有主要模块到目标逻辑边界的候选映射；
- [ ] 标记需要迁移而不是立即重排的当前目录；
- [ ] 绘制源码依赖图和 ASCII fallback；
- [ ] 明确允许边、禁止边和由 core-owned Port 实现的依赖倒置；
- [ ] 证明不需要通用 DI Container 或 Service Locator。

### Exit Gate

- [ ] Stable Core 不依赖具体 Provider/Channel SDK、Store 或 Composition；
- [ ] Runtime/Runner/Composition 的职责没有重叠所有权；
- [ ] 依赖图可以直接转化为 AF-04 Fitness Test 候选。

## 7. Phase 2：Model Resolution 架构

**目标：** 定义 Provider/Model 身份、事实、策略、解析和执行消费边界。

### Check Items

- [ ] 定义 Provider、Provider Connection、Protocol 的所有权和关联方式；
- [ ] 定义 Model Reference、Descriptor、Policy、Request Override 的来源；
- [ ] 定义 Model Catalog 和事实来源追踪责任；
- [ ] 定义 Model Resolver 的输入、输出、失败和保守 fallback 边界；
- [ ] 定义 Resolved Model 的不可变内容和 per-turn 生命周期；
- [ ] 定义用于模型调用的 core-owned Port 与 Provider Adapter 关系；
- [ ] 明确 Runner 只消费 Resolved Model，不加载 Config 或推断 Model Facts；
- [ ] 绘制 Parent Turn Model Resolution 调用流与 ASCII fallback；
- [ ] 绘制 Subagent 使用独立 Model Reference 的调用流与 ASCII fallback；
- [ ] 标记 Model Catalog 合并优先级等必须由 AF-05 验证的 Hypothesis。

### Exit Gate

- [ ] Connection、Facts、Policy 和 Request Override 不共享含糊所有权；
- [ ] Model 切换同时切换 Port、Protocol、Endpoint 和 Model Capability facts；
- [ ] AF-05 可以从本文档直接提取最小实验和失败条件。

## 8. Phase 3：Extension Framework 静态骨架

**目标：** 定义 Builtin/External 共用的贡献、注册、能力和配置边界。

### Check Items

- [ ] 定义 Extension 与 Runtime Module 的共同点和不同点；
- [ ] 定义 Contribution 的分类、校验和实现绑定边界；
- [ ] 定义 Tool、Hook、Channel Registry 的逻辑责任；
- [ ] 定义启动期只读 Registry Snapshot 的生成和消费关系；
- [ ] 定义 Builtin Module 与 External Extension 使用同一注册路径；
- [ ] 定义 Extension Config Namespace 和 Schema 所有权选项；
- [ ] 定义 Extension Capability 授予和受限运行上下文；
- [ ] 定义平台专有消息标识和 Channel Capability 的隔离方式；
- [ ] 定义 Extension 私有资源可共享范围，禁止注册为全局 Service Locator；
- [ ] 绘制跨 Channel/Tool/Hook 测试 Extension 的静态组合图和 ASCII fallback；
- [ ] 标记 Config Schema、Capability 和 Lifecycle 接口形状为 AF-06 待验证项。

### Exit Gate

- [ ] 新 Extension 不要求修改 Runtime、Runner、Bootstrap 或中央类型联合；
- [ ] Builtin/External 的差异不泄漏到 Contribution 消费者；
- [ ] Slice 3/4 只使用启动期只读 Snapshot，未提前开放生产动态变更。

## 9. Phase 4：动态 Registry 与 Lifecycle 契约

**目标：** 定义必须由 AF-06 验证的动态变更、安全和资源所有权契约。

### Check Items

- [ ] 定义 Registry Snapshot 的版本和不可变性不变量；
- [ ] 定义 Turn 捕获 Snapshot 的时点和使用范围；
- [ ] 定义 Extension 变更事务的校验与原子发布边界；
- [ ] 定义进行中 Turn 使用旧 Snapshot、新 Turn 使用新 Snapshot 的一致性要求；
- [ ] 定义启用、停用和 Contribution 更新失败的回滚结果；
- [ ] 定义旧工作排空与按策略取消的决策点；
- [ ] 定义 Extension、Module 和共享资源的唯一 Lifecycle Owner；
- [ ] 定义部分启动失败、重复关闭和 Shutdown 逆序释放；
- [ ] 绘制 enable、disable、failure rollback 和 shutdown 调用流及 ASCII fallback；
- [ ] 明确 AF-06 验证完整机制，Slice 5 才实现并开放生产运行时变更；
- [ ] 将无法由设计确认的并发/资源问题转换为 AF-06 Hypothesis 和停止条件。

### Exit Gate

- [ ] 一个 Turn 不可能观察到混合版本 Contribution；
- [ ] 失败后当前 Snapshot 可继续使用且无部分资源残留；
- [ ] AF-06 可以从本文档直接提取场景、注入点和预期结果。

## 10. Phase 5：Runtime 调用流与迁移边界

**目标：** 用端到端调用流验证分层，并映射 Slice 1–6 的迁移接缝。

### Check Items

- [ ] 绘制一个完整 Turn 从 Channel 入站到结果 Fanout 的调用流；
- [ ] 绘制 Tool Definition 解析、Tool 执行和 Tool Result 返回流；
- [ ] 绘制 Channel 注册、start/stop 和 optional Channel Capability 流；
- [ ] 绘制 Subagent 委派、独立 Model Resolution、Usage/Event/Abort 返回流；
- [ ] 绘制 Runtime 启动、部分失败清理和 Shutdown 流；
- [ ] 为 Event、Error、Abort、并发和资源释放指定唯一所有者；
- [ ] 检查简单调用链，移除无业务价值的机械转换层；
- [ ] 为 Slice 1–6 标记新增权威路径、Compatibility 和删除边界；
- [ ] 明确 RuntimeApp 最终只保留队列、Turn、路由、Fanout 和 Shutdown 编排；
- [ ] 明确 Legacy/Compat 只能单向进入新核心；
- [ ] 记录 Current 类型到目标术语的迁移，不在 AF-03 执行重命名。

### Exit Gate

- [ ] Turn、Tool、Channel 和 Subagent 四类调用流均支持边界验收；
- [ ] 每个长生命周期资源都有一个创建和释放责任；
- [ ] 每个 Slice 都能指向真实调用方和旧路径删除条件。

## 11. Phase 6：验证映射与架构评审

**目标：** 检查完整性、可验证性和迁移可执行性，并决定是否接受 Target Architecture。

### Check Items

- [ ] 完成 AF-03 必须覆盖项追踪矩阵并清除缺口；
- [ ] 完成 AP-01 至 AP-13 设计/验证矩阵；
- [ ] 为 AF-04 输出 Characterization 行为清单；
- [ ] 为 AF-04 输出 Fitness Test 规则清单和预期失败样例；
- [ ] 为 AF-05 输出 Provider/Model Hypothesis、最小实验和停止条件；
- [ ] 为 AF-06 输出 Extension Framework Hypothesis、最小实验和停止条件；
- [ ] 检查 Mermaid 与 ASCII 图语义一致；
- [ ] 检查所有核心术语均来自 Domain Glossary；
- [ ] 检查 Current Fact、Target Decision、Hypothesis 和 Deferred 明确区分；
- [ ] 执行独立架构评审，将 Findings 逐项标记为接受、修改后接受或拒绝，并记录理由；
- [ ] 修复所有 Critical/High 阻断项并重新评审；
- [ ] 项目所有者确认剩余风险和 Deferred 项；
- [ ] 将 Target Architecture 晋升为 `Accepted`；
- [ ] 同步父计划 AF-03 状态、Foundation Gate 和文档索引。

### Exit Gate

- [ ] Foundation Plan 的 AF-03 验收项全部有 Target Architecture 文档证据；需 Spike 验证的项仅形成 Hypothesis、实验输入、成功条件和停止条件，不计为 Spike Results；
- [ ] 无 Critical/High 未解决 Finding；
- [ ] Target Architecture 已 `Accepted`，但 AF-05/AF-06 未验证项仍明确标记为 Hypothesis；
- [ ] 未授权任何生产 Architecture Slice 提前进入 Delivery。

## 12. 需求追踪矩阵

| 类型 | Foundation Plan AF-03 要求 | Check Item | Exit Gate | 目标证据 |
|---|---|---|---|---|
| 必须覆盖 | 模块职责与依赖方向 | Phase 1：四边界职责、候选映射、允许/禁止边 | 依赖图可转化为 Fitness Test 候选 | 边界表、依赖图、允许/禁止边 |
| 必须覆盖 | Provider/Model Resolution | Phase 2：来源、Resolver、Resolved Model、Parent/Subagent 流 | AF-05 可直接提取实验和失败条件 | 组件责任与 Parent/Subagent 调用流 |
| 必须覆盖 | Extension/Module/Contribution/Registry | Phase 3：共同机制、Contribution 分类、Registry 责任 | Builtin/External 差异不泄漏给消费者 | 静态组合图、注册与配置边界 |
| 必须覆盖 | Snapshot/事务/原子切换/排空/回滚 | Phase 4：Snapshot 不变量、事务、排空、回滚 | 无混合版本且失败无部分资源残留 | 动态流、不变量、AF-06 输入 |
| 必须覆盖 | Runtime Builder 与 RuntimeApp | Phase 1/5：职责拆分、启动、Turn、Shutdown | Runtime/Runner/Composition 无重叠所有权 | 责任表、启动/Turn/Shutdown 流 |
| 必须覆盖 | Tool/Hook/Channel 注册 | Phase 3/5：Registry 责任与端到端流 | Builtin/External 共用注册和生命周期边界 | Registry 关系和端到端调用流 |
| 必须覆盖 | Config Namespace 与 Schema | Phase 3：Namespace 与 Schema 所有权选项 | AF-06 可提取 Config 验证 Hypothesis | 所有权选项和 AF-06 Hypothesis |
| 必须覆盖 | 私有资源/受限上下文/平台能力 | Phase 3/4：Extension Capability、资源作用域、Lifecycle Owner | 无 Runtime 私有状态或 Service Locator 依赖 | Capability、资源作用域和 Lifecycle |
| 必须覆盖 | Event/Error/Lifecycle/Resource Ownership | Phase 4/5：所有者、失败、关闭与释放顺序 | 每个长生命周期资源有唯一责任 | 所有权表、失败和关闭流 |
| 必须覆盖 | Legacy/Compat | Phase 5：单向依赖、迁移接缝、删除边界 | 每个 Slice 指向真实调用方和删除条件 | 单向依赖、Slice 迁移/删除边界 |
| 必须覆盖 | 关键调用流和关闭顺序 | Phase 2/4/5：Model、Registry、Turn、Shutdown 流 | 四类调用流支持边界验收 | Mermaid + ASCII 调用流 |
| 验收 | Turn/Tool/Channel/Subagent 调用流验证分层 | Phase 5：四类完整调用流 | 四类调用流均支持边界验收 | 调用流与 Phase 6 评审记录 |
| 验收 | 跨 Channel/Tool/Hook External Extension | Phase 3/4：静态组合、能力、资源和动态契约 | 新 Extension 不修改核心且无部分资源残留 | 组合图与 AF-06 实验输入 |
| 验收 | 旧/新 Registry Snapshot 一致性 | Phase 4：捕获时点、切换和并行不变量 | 一个 Turn 不观察混合版本 | 不变量与 AF-06 验证场景 |
| 验收 | 无业务价值的机械转换层 | Phase 1/5：边界和调用链审查 | Runtime/Runner/Composition 无重叠所有权 | 调用链审查记录 |
| 验收 | Stable Core/Infrastructure Adapter 边界 | Phase 1：依赖倒置、Port 与 Adapter | Stable Core 不依赖具体集成 | 依赖图与 Fitness Test 输入 |
| 验收 | 无通用 Service Locator | Phase 1/3：显式 Port 与 Extension Capability 映射 | Extension 不依赖 Runtime 私有状态 | 显式依赖检查与 AF-06 输入 |

## 13. 产物

AF-03 完成时至少产生：

1. `docs/architecture/target-architecture.md`；
2. AF-03 必须覆盖项追踪矩阵；
3. AP-01 至 AP-13 设计/验证矩阵；
4. AF-04 Characterization/Fitness Test 输入清单；
5. AF-05 Provider/Model Spike 输入；
6. AF-06 Extension Framework Spike 输入；
7. 独立评审结果和已处理 Findings；
8. 更新后的 Documentation Index 与 Architecture Foundation Plan。

这些追踪矩阵和输入清单可以作为 Target Architecture 的附录维护，避免创建无独立生命周期的碎片文档。

## 14. 停止与升级条件

出现以下任一情况时暂停当前 Phase，并进入 Architecture Review：

- 必须让 Domain/Application 依赖具体 Provider/Channel SDK 才能表达现有行为；
- 保留 Runner/Session/Channel 基线会迫使复制执行循环或持久化语义；
- Extension 只能通过 RuntimeApp 私有状态或 Service Locator 工作；
- Registry 无法在一个 Turn 内提供一致 Snapshot；
- Lifecycle 无法确定资源创建者、排空责任或释放顺序；
- Model Facts 无法与 Provider Connection、Policy 或 Request Override 分离；
- 一个简单调用流需要多层无业务语义的机械转换；
- 新证据要求改变已 `Accepted` Architecture Principles 或 Foundation Slice 顺序。

Architecture Review 必须选择：修订当前 Phase、提出 ADR、转为 Spike、更新父计划，或取消该架构方向；不得通过增加 Legacy 特例绕过。

## 15. 状态记录

| Phase | 状态 | 完成日期 | 证据/备注 |
|---|---|---|---|
| Phase 0：输入基线与追踪矩阵 | Not Started |  |  |
| Phase 1：逻辑边界与依赖方向 | Not Started |  |  |
| Phase 2：Model Resolution 架构 | Not Started |  |  |
| Phase 3：Extension Framework 静态骨架 | Not Started |  |  |
| Phase 4：动态 Registry 与 Lifecycle 契约 | Not Started |  |  |
| Phase 5：Runtime 调用流与迁移边界 | Not Started |  |  |
| Phase 6：验证映射与架构评审 | Not Started |  |  |
