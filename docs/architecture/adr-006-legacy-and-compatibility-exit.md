# ADR-006：Legacy 文档与 Compatibility 退出策略

## 状态

- **状态：** Accepted
- **日期：** 2026-09-04
- **所有者：** 项目所有者
- **关联计划 / Spec：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) AF-07、[AF-07 Architecture Decision Spec](af-07-architecture-decision-spec.md)
- **证据输入：** [Target Architecture §9.2–§9.5](target-architecture.md#92-单向-compatibility-与禁止依赖)、[Development Workflow](../development-workflow.md)、[AF-05 Provider/Model Resolution Spike Results](af-05-provider-model-resolution-spike-results.md)、[AF-06 Extension Framework Spike Results](af-06-extension-framework-spike-results.md)
- **适用原则：** AP-06、AP-07、AP-09、AP-12、AP-13，见 [Architecture Principles](architecture-principles.md)
- **Supersedes：** None

项目所有者于 2026-09-04 接受本 ADR。后续工作遵循 [Development Workflow](../development-workflow.md) 的批准和状态规则；本次接受只确认 policy，不执行 full Legacy inventory、批量文档移动或 production deletion。

## 背景

仓库中同时存在 Current Fact Candidate、Target Architecture、Proposal、Implementation record、Accepted ADR/Spec、Results 和历史设计。文件较旧不等于没有价值，文件位于 `docs/architecture/` 也不自动表示它仍是 active authority。若不建立明确退出规则，新实现可能继续引用旧设计，维护者也可能为同一事实同步多份文档。

production migration 同样会产生旧 Config、public API、composition path 和 Feature Flag。把旧代码长期复制到 `src/legacy/` 或永久保留双路径，会让新核心反向依赖旧语义；立即删除所有旧入口又可能破坏 caller 和回滚能力。

AF-05 已验证 legacy static LLM input 可以单向映射到 New Core；AF-06 的 disposable fixture 已按 Results 保留结论并删除代码。这些 evidence 支持“边界兼容、结论留档、临时代码退出”，但不等于已经完成全仓 Legacy inventory。

## 决策驱动因素

- 每个事实和 production behavior 只有一个 active authority；
- 历史价值与当前权威必须区分；
- public caller migration 需要短期 Compatibility，但不能永久拥有业务事实；
- deletion 必须可审查，避免丢失独有信息；
- Git history 保存过程细节，不在 source/docs 中维护永久备份；
- Foundation Gate inventory 与长期 policy 分责；
- 每个 Slice 必须证明 Legacy 净减少。

## 备选方案

### 方案 A：永久保留所有旧文档和 `src/legacy/` 实现

旧文件全部保留，仅在名称或目录中标记 Legacy；新旧实现长期并存。

该方案降低删除焦虑，但形成重复 authority、持续同步成本和反向依赖风险。目录标签不能阻止新代码继续调用旧路径。

### 方案 B：新权威路径建立后立即批量删除旧内容

一旦 Target/新模块存在，就删除旧设计、旧 API 和旧实现。

该方案快速收口，但可能在 current facts、caller、未完成事项和历史 rationale 迁移前丢失可用信息，也不适合需要短期 public compatibility 的阶段。

### 方案 C：按 authority 分类、单向 Compatibility、inventory 驱动退出

先把 current facts、长期 decision、active work 和 execution evidence 迁移到各自 authority；旧文档退出 active entry 并指向 successor；production caller 经到期 Compatibility 迁移，满足删除条件后移除旧路径。

该方案需要维护 inventory 和 review，但能同时保证可追踪性与最终删除。

## 决策

选择 **方案 C：按 authority 分类、单向 Compatibility、inventory 驱动退出**。

### Legacy 判定

Legacy 由 authority 与 status 判断，不只由年代、文件名或目录判断：

- 已被新的 Current Architecture、Accepted ADR/Spec 或 Plan/Results 分责替代，且不再应指导新实现的文档属于 Legacy candidate；
- 被替代 production path、旧 Config/API mapping 和临时 Feature Flag 属于 code Compatibility/Legacy candidate；
- `Accepted` ADR、具有长期价值的 Spike Results 和仍活跃的 Plan 不因年代较久自动成为 Legacy；
- Target document 不是 Current implementation；Current facts 必须有代码、测试或运行 evidence；
- Proposal/Implementation record 未经接受不得作为新实现权威。

### 文档迁移与删除

Legacy 文档按以下状态推进：

`Pending -> Migrating -> Migrated -> Reviewed -> Deleted`

标记 `Migrated` 前必须确认：

1. current fact 进入唯一 Current Architecture；
2. long-lived decision 进入 ADR；
3. unfinished work 进入 Plan；
4. execution evidence 进入 Results 或 test mapping；
5. active inbound links 已更新；
6. 独有信息已迁移、明确舍弃或由仍保留的 historical authority 承担。

被替代文档退出 active docs index，并链接 successor/status。必要时可暂时移动到 `docs/legacy/` 并冻结；Review 确认无独有价值后删除。Git history 是最终历史记录，不要求永久保留文件副本。

### Production Compatibility

迁移期间只允许：

`Legacy Public API / Config Caller -> Compatibility Adapter -> New Authoritative Core`

Compatibility 只做参数、默认值、返回值和错误映射；不得拥有 Model Facts、Policy、Registry、lifecycle、Turn state、resource 或新功能。New Core、Extension 和新 Fake 不得依赖 Compatibility/Legacy；Compatibility 不从主 barrel 作为推荐 API 导出。

每个 Compatibility entry 必须记录：

- source path/API/config 与 target authority；
- Owner 和受影响 caller list；
- 保留原因与映射行为；
- Feature Flag 或发布 rollback strategy（如适用）；
- 默认值、观测信号与 rollback trigger（如使用 Flag）；
- 到期 Slice 或 Review date；
- deletion conditions；
- focused/contract/regression validation。

Slice 完成时必须删除被替代 production path，或把剩余 public boundary 明确降级为符合上述字段的 Compatibility。Compatibility 删除后只通过版本/发布回滚，不保留 hidden environment flag、reverse dependency 或 implicit dual path。

### Legacy 净减少

每个 Slice 必须满足：

$$
Legacy_{end} < Legacy_{start}
$$

计数口径由该 Slice 的 accepted inventory 明确，至少覆盖被替代 production paths、Compatibility entries 和本 Slice触及的 Legacy documents。只增加 facade、Adapter 或 Registry 而未迁移 caller、删除旧路径，不算完成。

### Inventory authority

ADR-006 只决定 policy 和字段。完整 Legacy migration inventory 是独立 Foundation Gate artifact，不嵌入本 ADR。它至少包含：

| 字段 | 目的 |
|---|---|
| artifact/path 与类别 | 唯一定位 document、code path、API、Config 或 Flag |
| current status/authority | 区分 active、candidate、Compatibility、historical authority |
| successor/target | 指向新权威入口 |
| unique-value disposition | 迁移、保留或舍弃独有信息的理由 |
| inbound callers/links | 确定迁移影响 |
| Owner | 负责 review/删除 |
| target Slice/review date | 防止无限延期 |
| deletion conditions | 可判定退出标准 |
| validation | 证明迁移和删除未破坏行为 |

Inventory 由 Foundation Gate 独立接受并持续由各 Slice 更新；ADR 不承担易变的全仓清单。

## 原则与验证映射

| 原则 | 本决策约束 | 后续验证 |
|---|---|---|
| AP-06 | 一个 active authority/production path | inventory、caller/path audit、FT-04/FT-09 |
| AP-07 | Compatibility 单向、最小、到期 | FT-04、dependency/export audit、expiry review |
| AP-09 | public mapping/deletion 有 Contract evidence | focused/contract/regression tests |
| AP-12 | 不为历史保留永久 abstraction | unused path/adapter review、real caller evidence |
| AP-13 | Current/Target/Spec/Results/Legacy 可区分 | FT-09、status/link audit、migration inventory |

## 后果

### 正面

- 新实现有唯一权威入口；
- Legacy 删除前不会遗漏 current fact、decision 或 active work；
- public Compatibility 可追踪、可测试且有期限；
- Accepted ADR/Results 的历史价值不会因清理被误删；
- 每个 Slice 都需要交付实际收敛，而非只增加抽象。

### 负面

- Foundation Gate 和每个 Slice 都需要维护 inventory；
- 文档移动/删除前需要 inbound link 和 unique-value review；
- public caller 未迁移完成时必须承担短期 Compatibility 测试成本；
- 删除日期可能受 external caller 影响，但必须显式延期，不能静默永久化。

## Deferred

本 ADR 不执行全仓 inventory，不分类或移动具体旧文档，不删除 production code，不设一个通用的固定天数期限，也不决定每个 public API 的 deprecation policy。具体 entries、Owner、到期 Slice/date 和 tests 由 Foundation Gate inventory 与对应 Slice Spec 冻结。

## 迁移与回滚

1. Foundation Gate 建立并接受完整 Legacy migration inventory；
2. Slice 开始前从 inventory 冻结受影响旧路径、caller、links 和 deletion conditions；
3. 先迁移 facts/decision/work/evidence，再移动或删除 document；
4. production caller 经单向 Adapter 迁移，新功能只进入 New Core；
5. Contract/Regression evidence 成立后删除 old path/flag/adapter；
6. 删除后 rollback 通过版本/发布回滚；若恢复旧版本，其旧路径仍受当时版本契约约束，不成为当前新架构的第二 authority；
7. Slice 6 完成唯一 Current Architecture、active-link audit 和剩余 Legacy closeout。

## 后续事项

- [x] 项目所有者接受本 ADR（Owner：项目所有者；Plan Item：AF-07；2026-09-04）。
- [x] 建立并接受独立 [Legacy Migration Inventory](legacy-migration-inventory.md)（Owner：项目所有者；Plan Item：Foundation Gate；2026-09-04）。
- [ ] 每个 Slice Spec 冻结其 Compatibility entries 和 deletion conditions（Owner：对应 Slice Owner；Plan Item：Slice 1–6）。
- [ ] Slice 6 执行最终 Current Architecture 与 Legacy closeout（Owner：对应 Slice Owner；Plan Item：Slice 6）。
