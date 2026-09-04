# AF-07 Architecture Decision Spec

## 1. 状态

- **状态：** Accepted
- **版本：** 0.1
- **日期：** 2026-09-04
- **所有者：** 项目所有者
- **父计划：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) AF-07
- **语言与术语约定：** [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)
- **决策输入：** [Target Architecture](target-architecture.md)、[AF-05 Provider/Model Resolution Spike Results](af-05-provider-model-resolution-spike-results.md)、[AF-06 Extension Framework Spike Results](af-06-extension-framework-spike-results.md)
- **现有决策：** [ADR-001 Tool Result Closure and Recovery](adr-001-tool-result-closure-and-recovery.md)、[ADR-002 Context Budgeting and Compaction Recovery](adr-002-context-budgeting-and-compaction-recovery.md)
- **相关约束：** [Architecture Principles](architecture-principles.md)、[Domain Glossary](domain-glossary.md)
- **工作流：** [Development Workflow](../development-workflow.md)

本 Spec 只定义 AF-07 的四项长期架构决策及其证据、边界和接受条件。它不修改 production，不冻结 Module API，也不授权 Architecture Slice 或 Foundation Gate 整体通过。

项目所有者于 2026-09-04 接受本 Spec v0.1 及 §12.1 的范围、证据纪律、四份 ADR 输出和完成条件，并授权起草 ADR-003 至 ADR-006。该接受不等于接受任一 ADR，也不授权 production、Module Spec、Architecture Slice、full Legacy inventory 或 Foundation Gate 整体通过。

## 2. 单一目标

### AF07-Q01

如何把 AF-05 与 AF-06 已接受的 disposable Spike evidence，以及 Target Architecture 已接受的目标边界，收敛为最少且足够的长期 ADR，使后续 Slice 能明确遵守迁移方向、事实所有权、Runtime Composition 和 Legacy 退出规则，同时不把 Spike shape 提升为 production Contract？

## 3. 范围

AF-07 只产生以下四份 ADR：

1. `ADR-003`：渐进架构迁移，而非整体重写；
2. `ADR-004`：Provider/Model identity 与 Model Facts ownership；
3. `ADR-005`：Extension/Module/Registry Composition 与 Runtime lifecycle；
4. `ADR-006`：Legacy 文档与 Compatibility 退出策略。

四个主题对应父计划 AF-07 的最小要求。若评审发现第五个独立、长期且难以回退的决策，必须先由项目所有者批准扩大 AF-07 范围，不得顺带增加 ADR。

## 4. 输入与证据规则

### 4.1 权威输入

| 输入 | AF-07 用途 | 不代表 |
|---|---|---|
| Target Architecture | 提供已接受的目标边界、责任和迁移方向 | production 已实现 |
| AF-04 Characterization/Fitness | 保护 current Runner、Session、Tool、Channel、Abort 等行为基线 | Target Contract 已实现 |
| AF-05 Results | 支持 Provider/Model resolution、Facts provenance、per-Turn binding 与单向 Compatibility | 最终 Provider API、全部 Facts precedence 或真实 Provider compatibility |
| AF-06 Results | 支持统一 Extension API 方向、immutable Snapshot、generation pin、instance lifecycle 与 failure containment | production API、真实第三方兼容、跨平台 filesystem 或 hot code replacement |
| ADR-001 | 保持 Tool Result closure、controlled Abort 与 unknown recovery 的既有权威决策 | Extension lifecycle 或 Compaction policy |
| ADR-002 | 保持 context budgeting、overflow correction、Compaction、Session commit 和 observer settlement 的既有权威决策 | 完整 Provider/Model ownership ADR 的替代品 |

### 4.2 证据纪律

每份 ADR MUST：

- 区分 Current Fact、Accepted Target Decision、Spike Evidence 和 Deferred 事项；
- 标明适用的 Architecture Principle ID 及对应验证证据；
- 只把 AF-05/AF-06 实际支持的结论写成决策依据；
- 记录至少两个现实选项、选择理由和负面后果；
- 明确是否 supersede 既有 ADR；没有明确接受的替代关系时必须写 `None`；
- 不复制 disposable fixture 的 TypeScript type、coordinator 或目录结构；
- 不以 root regression 绿色替代架构论证。

## 5. ADR-003：渐进架构迁移，而非整体重写

### 5.1 必须回答的问题

1. 为什么保留已 Characterized 的 Runner、Session、Channel、Tool、Abort 基线并渐进迁移，而不是 clean-slate rewrite？
2. Slice 1–6 的默认顺序何时可以改变？
3. 新旧路径并存期间的唯一允许依赖方向是什么？
4. 一个 Slice 何时才算迁移完成，而不是只增加一层 facade？
5. production rollback 如何工作，同时避免永久双权威路径？

### 5.2 最低决策边界

ADR-003 至少固定：

- 使用父计划 Slice 1–6 的渐进迁移顺序；只有新的 `Accepted` evidence 先更新父计划后才能改变；
- 保留 current behavior protection，除非独立 `Accepted` ADR/Spec 明确改变；
- 只允许 `Legacy/Public input -> Compatibility Adapter -> New Authoritative Core`；
- 新核心不得依赖 Legacy/Compatibility；
- 每个 Slice 至少迁移一个真实 production caller，并删除旧路径或留下有 Owner、到期 Slice 和删除条件的 Compatibility；
- Slice 完成后 rollback 依赖版本或发布回滚，不承诺永久 runtime 双路径。

ADR-003 不决定具体 Provider Facts、Registry Contract、Tool closure 或 Compaction semantics。

## 6. ADR-004：Provider/Model identity 与 Model Facts ownership

### 6.1 必须回答的问题

1. Provider identity、Model identity、Provider Connection、Model Descriptor、Model Facts、Model Policy 和 Resolved Model 分别由谁拥有？
2. Config、Provider Integration、Model Resolution、Runner 和 Compatibility 各自能做什么、不能做什么？
3. Provider/Model 切换如何原子绑定 Port、Protocol、Endpoint/Deployment、Capability 和执行限制？
4. 哪些 execution-critical Facts 缺失时必须 fail closed？
5. Parent/Child Turn 如何分别解析并保持 per-Turn immutable binding？
6. AF-05 只验证了哪些 Facts precedence，哪些仍由后续 Module Spec 决定？

### 6.2 最低决策边界

ADR-004 至少固定：

- Provider Integration 解释 Provider Connection 和 Provider-produced Model Facts；
- Model Resolution 拥有 Descriptor 来源校验、Policy 应用和 immutable per-Turn Resolved Model 的形成；
- Model Policy 约束允许选择，不伪造 Provider Facts；
- Config 只加载、校验和提供输入，不成为 Model Facts owner；
- Core/Runner 不按 Provider name 或 Model string 猜测上下文限制和 Capability；
- legacy static config 只经单向 Compatibility Adapter 进入新解析路径；
- 成功解析必须把 identity、Port、Protocol、Endpoint/Deployment、Capabilities 和必要限制绑定为内部一致的结果；
- AF-05 对 source precedence 的直接证据只推广到实际验证的 `effectiveContextLimit`；不得声称已经冻结 `maxOutputTokens`、Tool Use 或全部 Capability Facts 的最终 precedence。

### 6.3 与 ADR-002 的关系

ADR-004 MUST 明确：

- 不 supersede、修改或复制 ADR-002；
- context budgeting、Provider overflow correction、Compaction decision、Session commit、retry 与 observer lifecycle 继续由 ADR-002 管理；
- 如 ownership 表述与 ADR-002 冲突，ADR-004 在进入 `Accepted` 前必须显式解决，不得通过较新文件静默覆盖。

## 7. ADR-005：Extension/Module/Registry Composition 与 Runtime lifecycle

### 7.1 必须回答的问题

1. Builtin Module 与 External Extension 在 source acquisition 后共享什么机制？
2. Discovery/Loader、registration、staging、Snapshot publish、retirement 和 Shutdown 分别由谁负责？
3. RuntimeApp、Runner 与消费者如何只取得 narrow typed projection，而不是 mutable Registry 或 Service Locator？
4. Framework 管理什么 lifecycle，对 Extension 内部对象明确不管理什么？
5. startup-only Snapshot 与 Slice 5 runtime enable/disable 的交付边界如何分开？
6. conflict、candidate failure、generation pin、retirement failure 和 Shutdown nonconvergence 的最低语义是什么？

### 7.2 最低决策边界

ADR-005 至少固定：

- Builtin 与 External 只在 acquisition 不同；之后使用相同 Contribution、staging、validation 和 Snapshot path；
- 一个 authoritative Builder 生成 internally consistent immutable Registry Snapshot；
- consumer 只取得职责对应的 typed projection 或显式 Capability；
- Composition 负责创建、校验、启动和 handoff lifecycle units；RuntimeApp/Runner 消费结果，不成为 Extension service registry；
- Framework 只编排 Extension/Module instance 的 `start()`/`stop()`；Extension 自己拥有并清理内部 connection、cache、SDK client、authentication、rate limiter 等对象；
- Snapshot 原子发布，进行中的 Root/Child Turn tree 固定到捕获的 generation；
- Slices 3/4 只接入 startup-only readonly Snapshot；Slice 5 在独立 Module Spec 接受后才实现 runtime transaction、retirement 和 enable/disable；
- same identity duplicate 为 warning/no-op，不启动第二个 instance。

ADR-005 MUST 明确排除 file watcher、arbitrary hot code loading、same-identity running version replacement、multi-instance coexistence、Framework-managed internal object graph、general DI Container 和 Service Locator。

### 7.3 与 ADR-001/ADR-002 的关系

ADR-005 不重新定义：

- ADR-001 的 Tool Call/Result closure、controlled Abort、unknown recovery 或 replay；
- ADR-002 的 context budgeting、Compaction、overflow correction 或 observer settlement。

AF-06 没有提供 `after_tool_call` Target settlement evidence；该 Contract 继续由后续 Tool/Hook Module Spec 决定。

## 8. ADR-006：Legacy 文档与 Compatibility 退出策略

### 8.1 必须回答的问题

1. 什么条件使文档或 production path 成为 Legacy？
2. 哪些 Accepted ADR/Results 应作为历史权威保留，而不是因“旧”删除？
3. Legacy 文档迁移到 successor authority 前必须保留什么信息？
4. Compatibility Adapter 必须记录哪些 Owner、期限、验证和删除信息？
5. 每个 Slice 如何证明 `Legacy_end < Legacy_start`？
6. Legacy migration inventory 由什么独立 Gate artifact 承载和审查？

### 8.2 最低决策边界

ADR-006 至少固定：

- Legacy 由 authority/status 判断，不只由文件年龄或目录判断；
- 被替代文档退出 active authority，并链接 successor；Git history 保存不再需要的过程细节；
- 长期 ADR 和有价值 Results 通过状态表达历史，不自动移入 Legacy 或删除；
- production 旧代码不进入长期 `src/legacy/` 备份；
- Compatibility 必须单向、显式、最小、有 Owner、有到期 Slice/Review date、有 caller list、测试和删除条件，且不接收新功能；
- Slice 完成时删除旧路径，或把剩余 public boundary 明确降级为到期 Compatibility；
- 删除 Compatibility 后只通过版本/发布回滚，不保留隐藏双路径。

ADR-006 只决定 policy 和 inventory 最低字段，不执行全仓文档分类，也不包含完整 Legacy migration inventory。该 inventory 仍是独立 Foundation Gate artifact。

## 9. 非目标与 Deferred

AF-07 不决定或实施：

- production TypeScript API、exact interface、directory/module layout 或 export surface；
- Provider Contract schema、全部 Model Facts precedence、Catalog merge 或 Client Pool 实现；
- Registry lock、queue、transaction primitive、deadline 数值、Error union、Event field 或 persistence format；
- 真实 Provider、WebSocket、第三方平台或跨平台 filesystem compatibility；
- same-identity runtime version replacement、multi-instance、marketplace 或 arbitrary code loading；
- Subagent concurrency、Batch、Background、Detached、Handoff 或 Agent Team；
- Session persistence redesign、general workflow engine、DI Container 或 Service Locator；
- Module Spec、Architecture Slice implementation、production migration 或 full Legacy inventory；
- 批量翻译、整理或重写既有 architecture documents。

## 10. 执行顺序

1. 项目所有者接受本 Spec；
2. 起草 ADR-003 至 ADR-006，初始状态均为 `Proposed`；
3. 对四份 ADR 执行一次联合 consistency review，再分别 disposition；
4. 修正证据越界、重叠 authority、未解释冲突和 missing consequences；
5. 项目所有者分别接受、拒绝或要求修订每份 ADR；
6. 只有四份必要 ADR 均为 `Accepted`，AF-07 Plan Item 才可标记 `Completed`；
7. AF-07 完成后只重新评估 Foundation Gate；未满足全部 Gate item 前不得启动 production Slice。

四份 ADR 可以作为一个 review set 起草，但 status 与 Owner decision 独立记录。任一 ADR 被拒绝时，不把其他 ADR 自动标记失败；Foundation Gate 的“必要 ADR 已 `Accepted`”保持未完成，直到缺口解决。

## 11. ADR 共同结构

每份 ADR 至少包含：

- 状态、日期、Owner、关联 Plan/Spec 和 `Supersedes`；
- 背景与证据边界；
- 决策驱动因素；
- 备选方案；
- 决策；
- 正面与负面后果；
- 验证依据；
- migration、rollback 与 deletion boundary；
- Deferred 和后续事项；每项 follow-up 必须有 Owner 或链接到明确 Plan Item。

ADR 不新增 implementation design 章节，不用 pseudo-production interface 制造已冻结 Contract 的印象。

## 12. 接受与完成条件

### 12.1 本 Spec 接受条件

- [x] 四个 ADR 主题完整对应父计划 AF-07，且没有额外决策范围；
- [x] 每个 ADR 的必须回答问题和最低决策边界足以判定是否完成；
- [x] ADR-004 明确保留 ADR-002 authority；
- [x] ADR-005 明确保留 ADR-001/ADR-002 authority，并保留 `after_tool_call` Contract gap；
- [x] AF-05/AF-06 evidence 未推广到未验证的 production API 或兼容承诺；
- [x] Legacy inventory 保持独立 Gate artifact，不塞入 ADR-006；
- [x] production、Module Spec、Architecture Slice 和 full Foundation Gate 未获授权。

### 12.2 AF-07 完成条件

- [x] ADR-003、ADR-004、ADR-005、ADR-006 均由项目所有者标记为 `Accepted`；
- [x] 每份 ADR 明确证据、备选方案、后果、Deferred 和 supersession relationship；
- [x] 每份 ADR 标明适用的 Architecture Principle ID 和验证证据，follow-up 均有 Owner 或链接的 Plan Item；
- [x] 四份 ADR 之间不存在重叠 authority 或未解释冲突；
- [x] 没有复制 disposable Spike shape 或冻结后续 Module Spec 细节；
- [x] 父计划、文档索引和 Foundation Gate 的“必要 ADR”item 按实际状态同步；
- [x] 文档 diagnostics、local link audit 和 `git diff --check` 通过；
- [x] 剩余 Gate gaps 明确保留，不声称 Foundation Gate 整体通过。

## 13. 验证

AF-07 是 documentation-only work：

1. 对本 Spec 和四份 ADR 运行文档 diagnostics；
2. 校验相对文件链接和 heading fragment；
3. 校验 `Status`、`Supersedes`、Owner、evidence 与 Deferred wording；
4. 检查 ADR-004/005 未静默覆盖 ADR-001/002；
5. 检查没有 production implementation、Foundation Gate completion 或真实兼容性 overclaim；
6. 运行 FT-09 documentation governance；
7. 运行 `git diff --check`。

不要求用全量 production regression 证明 ADR 正确；若文档治理或 repository closure 需要更广验证，在 AF-07 完成前按父计划记录实际结果。

## 14. 输出

AF-07 最多产生：

1. `docs/architecture/adr-003-progressive-architecture-migration.md`；
2. `docs/architecture/adr-004-provider-model-identity-and-facts-ownership.md`；
3. `docs/architecture/adr-005-extension-registry-runtime-composition.md`；
4. `docs/architecture/adr-006-legacy-and-compatibility-exit.md`；
5. 本 Spec、父计划和 docs index 的状态/链接同步。

Legacy migration inventory、Module Spec、production code、test fixture 和 dependency change 不属于本输出。

## 15. 当前状态

AF-05、AF-06 与 AF-07 均已 `Completed`。项目所有者于 2026-09-04 接受 ADR-003 至 ADR-006；四份 ADR 均为 `Accepted`，完成条件与 Foundation Gate 已按实际状态复评。Foundation Gate 仍缺少下一执行 Slice 的 Definition of Ready 和独立 Legacy migration inventory，因此未整体通过；production 修改、Architecture Slice 和 full Legacy inventory 仍需分别批准。
