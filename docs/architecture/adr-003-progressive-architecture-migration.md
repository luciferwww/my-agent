# ADR-003：采用渐进架构迁移而非整体重写

## 状态

- **状态：** Accepted
- **日期：** 2026-09-04
- **所有者：** 项目所有者
- **关联计划 / Spec：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) AF-07、[AF-07 Architecture Decision Spec](af-07-architecture-decision-spec.md)
- **证据输入：** [Target Architecture](target-architecture.md)、[AF-05 Provider/Model Resolution Spike Results](af-05-provider-model-resolution-spike-results.md)、[AF-06 Extension Framework Spike Results](af-06-extension-framework-spike-results.md)、[AF-04 Characterization and Fitness Execution Plan](../roadmap/af-04-characterization-fitness-plan.md)
- **适用原则：** AP-06、AP-07、AP-09、AP-11、AP-12、AP-13，见 [Architecture Principles](architecture-principles.md)
- **Supersedes：** None

项目所有者于 2026-09-04 接受本 ADR。后续工作遵循 [Development Workflow](../development-workflow.md) 的批准和状态规则；本次接受不授权 production migration 或 Architecture Slice。

## 背景

当前系统已经具有可工作的 Runner、Session、Tool、Channel、Abort、Compaction 和 Subagent 路径。AF-04 已通过 Characterization/Fitness 固定重要 current behavior 和依赖边界；AF-05 与 AF-06 则在 production graph 外证明 Model Resolution 与 Extension/Registry 目标边界可以渐进引入，而不要求复制 Runner/Runtime loop 或整体替换现有系统。

风险不在于是否能设计一个更整洁的新系统，而在于迁移时同时改变行为、依赖、数据和生命周期，导致无法区分架构缺陷与迁移回归。长期保留新旧两套权威实现同样不可接受，因为事实、修复和测试会分叉。

## 决策驱动因素

- 保留已 Characterized 的用户行为、Session 数据和错误语义；
- 每个阶段都能由真实 caller、Contract/Fitness tests 和删除条件验证；
- 新权威路径建立后，旧路径必须净减少；
- Compatibility 只能单向进入新核心，不能成为第二套业务实现；
- 回滚必须可执行，但不能形成永久 runtime 双路径；
- 不为尚未授权的并发、marketplace 或 arbitrary hot loading 扩大重构。

## 备选方案

### 方案 A：整体重写后一次切换

在平行目录重建 Runtime、Runner、Session、Provider 和 Extension 系统，完成后一次切换。

该方案表面上减少迁移适配，但会同时重开已稳定的执行语义、持久化兼容、Abort、Tool closure 和 lifecycle 问题。AF-05/AF-06 没有提供推倒 current baseline 的证据，也没有证明平行系统能更安全地替代真实 caller。

### 方案 B：按 Slice 渐进迁移并及时删除旧路径

保持 current behavior protection，按父计划 Slice 1–6 建立新权威边界；每个 Slice 迁移真实 caller，Compatibility 仅在边界单向映射，并在完成时删除旧路径或记录有期限的例外。

该方案增加阶段性迁移纪律，但能把风险限定到可验证的局部边界，并让失败回到最近的稳定版本。

### 方案 C：长期保留新旧双实现并按请求切换

同时维护旧路径和新路径，通过 Feature Flag、环境变量或请求级选择长期路由。

该方案便于短期回退，但会产生两个事实来源、两个修复入口和长期测试矩阵，违反 AP-06/AP-07，也使“迁移完成”失去可判定标准。

## 决策

选择 **方案 B：按 Slice 渐进迁移并及时删除旧路径**。

### 迁移顺序

默认遵循 [Architecture Foundation Plan §11](../roadmap/architecture-foundation-plan.md#11-生产迁移路线) 的 Slice 1–6 顺序。只有新的 `Accepted` ADR、Spike Results 或已完成 Slice evidence 证明依赖变化时，才可先更新父计划、验收、验证和删除条件，再调整顺序。不能在 implementation 中静默改序。

Slice 1–5 默认不并行；同时最多一个 production Architecture Slice。Documentation、Defect 和 Small Change 不得穿透当前 Slice 的边界。

### 当前行为与新权威路径

- Characterization tests 在目标 Contract 接管前保护 current behavior，不把 current implementation 偶然细节升级为长期设计；
- 新能力只进入新权威路径；
- 迁移期间唯一允许方向是 `Legacy/Public input -> Compatibility Adapter -> New Authoritative Core`；
- 新 Core、Registry Snapshot、Resolved Model、Extension 和新测试 Fake 不得反向依赖 Compatibility/Legacy；
- 不能以 facade 包住旧实现后把 facade 声称为新权威路径。

### Slice 完成语义

一个 Slice 只有在以下适用条件成立时才可完成：

1. 已迁移至少一个真实 production caller；
2. 新 Contract 与可观察行为通过 Spec 定义的验证；
3. 被替代路径已删除，或剩余 public boundary 被降级为具有 Owner、到期 Slice/Review date、caller list、测试和删除条件的 Compatibility；
4. 新代码不依赖 Legacy/Compatibility；
5. Legacy 在该 Slice 结束时净减少；
6. ADR、Spec、Results、Plan Item、Current Architecture 和文档索引按实际状态同步。

只增加 Registry、Adapter、interface 或 wrapper 而未迁移 caller、删除旧路径，不算完成。

### 回滚

- Slice 实施/发布窗口可以用有 Owner、默认值、观测信号、触发条件和删除 Slice 的 Feature Flag 在**完整旧路径**与**完整新路径**之间切换；
- Flag 不得在一次 Turn 或原子操作中混合新旧事实；
- Slice 完成后删除迁移 Flag 和被替代路径；
- 完成后的回滚通过版本或发布回滚，不保留隐藏环境变量、反向依赖或永久 runtime switch；
- rollback 不得破坏已接受的数据、Tool Call/Result、Session 或 lifecycle 不变量。

## 原则与验证映射

| 原则 | 本决策约束 | 后续验证 |
|---|---|---|
| AP-06 | 一个概念只有一个新权威路径 | caller/path inventory、删除审计、FT-04/FT-09 |
| AP-07 | Compatibility 单向且到期 | dependency fitness、public export audit、Compat inventory |
| AP-09 | 行为变化先有明确 Contract | Module Spec acceptance matrix、Contract/Integration tests |
| AP-11 | Composition 与 Runtime 职责分离 | Runtime/Builder responsibility tests、dependency scan |
| AP-12 | 只引入已有 evidence 支持的抽象 | ADR/Spec review、真实实现/Fake/Spike evidence |
| AP-13 | Current、Target、Active Work、Legacy 分责 | FT-09、status/link audit、Legacy inventory |

## 后果

### 正面

- 每次迁移只改变一个可验证边界；
- current baseline 在新 Contract 接管前保持可比较；
- 新旧事实不会长期分叉；
- 每个 Slice 都有明确退出和删除条件；
- production rollback 与长期 architecture authority 分离。

### 负面

- 短期需要维护边界 Compatibility 和更细的验证矩阵；
- 部分目标结构要跨多个 Slice 才能完整出现；
- 每个 Slice 必须投入 caller migration 和删除工作，不能只建设新抽象；
- 调整顺序需要先更新权威文档，降低了临时实现自由度。

## Deferred

本 ADR 不决定 Provider/Model ownership、Extension/Registry lifecycle 细节、Tool closure、Compaction、具体 Module API、目录布局、Error/Event shape、deadline、锁或持久化格式。它也不授权 Subagent concurrency、Batch、Background、Detached、Handoff、Agent Team、marketplace、arbitrary hot loading 或 Session rewrite。

## 迁移与删除

1. AF-07 完成后重新评估 Foundation Gate；
2. 每个 Slice 在 Delivery 前接受独立 Module Spec 并满足 Definition of Ready；
3. Slice 实施时先建立受保护的新边界，再迁移真实 caller；
4. Contract/Fitness/Regression evidence 成立后删除被替代路径；
5. 未删除 Compatibility 必须进入独立 inventory 并在到期 Slice Review；
6. Slice 6 合并 Current Architecture 并完成 Legacy 文档收口。

## 后续事项

- [x] 项目所有者接受本 ADR（Owner：项目所有者；Plan Item：AF-07；2026-09-04）。
- [x] AF-07 完成后重新评估 Foundation Gate（Owner：项目所有者；Plan Item：Foundation Gate；2026-09-04）。
- [ ] 每个 Architecture Slice 在 Delivery 前接受对应 Module Spec（Owner：项目所有者；Plan Item：Slice 1–6）。
