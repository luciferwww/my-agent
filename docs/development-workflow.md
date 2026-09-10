# Development Workflow

## 1. 文档状态

- **状态：** Accepted
- **版本：** 1.1
- **日期：** 2026-09-10
- **所有者：** 项目所有者
- **适用范围：** my-agent 的代码、测试、架构、文档和实验性变更

本文档是开发流程的唯一权威来源。`CONTRIBUTING.md` 只提供贡献入口，模板只定义工件结构；发生冲突时以本文档和已 `Accepted` 的 ADR、Spec 为准。

**v1.1 修订：** 明确局部事实不确定性应优先自行取证，决策性不确定性必须暂停确认；增加多步骤工作的成功标准及变更可追溯性要求。

## 2. 基本原则

1. 先分类工作，再决定是否需要 Plan、Spec、ADR 或 Spike；
2. 修改前确认范围，未经批准不扩大目标或改变架构；
3. 架构文档在实现阶段是设计依据，代码证据推翻设计时暂停并重新决策；
4. 第一处实质修改后立即运行最小、可证伪的聚焦验证；
5. 修复根因，保持变更局部，不顺带重构无关代码；
6. Reviewer 意见先核实和分级，再决定采纳、修改采纳或拒绝；
7. 新权威路径建立后及时删除被替代路径，Compatibility 必须有到期日；
8. 文档、测试和实现共同构成完成证据；
9. 可以通过代码、测试、运行证据或权威文档消除的局部不确定性，应优先自行取证，不因普通事实问题中断工作；
10. 每个实质修改必须可追溯到已确认需求、验收条件、缺陷证据，或由本次修改直接产生的必要清理；不引入未经当前证据证明的抽象、配置或运行路径。

## 3. 工作分类

| 类型 | 适用场景 | 最低工件 | 批准要求 |
|---|---|---|---|
| Small Change | 局部、低风险、行为边界不变的维护 | 明确需求或 Issue | 范围确认 |
| Defect | 已有行为偏离已确认契约或预期 | 复现证据和回归测试 | 修复范围确认 |
| Documentation | 不改变生产行为的文档修正 | 文档变更说明 | 权威事实变化时需所有者确认 |
| Architecture Slice | 改变模块边界、依赖方向、公共契约或生产权威路径 | Plan Item + Accepted ADR/Spec | 项目所有者批准进入 Delivery |
| Architecture Spike | 关键未知无法由静态分析或小型测试消除 | Accepted Spike Spec | 项目所有者批准实验 |

工作分类不由改动行数决定。一个很小的公共契约变化仍可能是 Architecture Slice；大批机械文档修正也可能只是 Documentation。

## 4. 工件选择

### Plan

用于跨阶段目标、顺序、Gate、风险和退出条件。Plan `Accepted` 表示批准执行，不表示实现完成或 Gate 已通过。

### ADR

满足任一条件时需要 ADR：

- 决策长期有效且难以回退；
- 改变依赖方向、权威事实来源或公共架构边界；
- 多个可行方案存在重要取舍；
- 替代已 `Accepted` 的架构决策。

### Module Spec

公共 API、Event、并发、生命周期、错误语义、资源所有权或跨模块契约变化时需要 Module Spec。

### Spike

以下未知会影响架构结论时，先执行 Spike：

- 外部 SDK、Provider Metadata 或协议行为；
- 并发、取消、排空、关闭或资源释放；
- 无法仅靠设计证明的扩展边界；
- 失败会迫使架构或迁移顺序改变的假设。

Spike 代码默认可丢弃。结论记录在 Spike Results，只有证据支持的结论才可进入 ADR 或 Spec。

## 5. 状态与责任

| 工件 | 状态流 | 批准者 |
|---|---|---|
| Plan | `Proposed -> Accepted -> Superseded | Cancelled` | 项目所有者 |
| Plan Item | `Not Started -> In Progress -> In Review -> Completed` | 项目所有者确认完成 |
| ADR | `Proposed -> Accepted -> Superseded` | 项目所有者 |
| Module Spec | `Draft -> In Review -> Accepted -> Implemented -> Validated` | 项目所有者接受设计和验证结果 |
| Spike | `Draft -> Accepted -> Executing -> Provisional Pass | Failed -> Completed` | 项目所有者批准执行并确认 Results |

Plan Item 可使用 `Blocked`、`Deferred`、`Cancelled`。ADR 可使用 `Rejected`、`Deprecated`。状态必须写在对应工件中；评审结论和批准通过文档变更及 Git 历史留证。

## 6. Definition of Ready

Small Change 和 Documentation 只需明确范围、事实来源和验证方式。Architecture Slice 进入实现前必须满足：

- [ ] 关联 Plan Item 和用户可观察结果明确；
- [ ] 非目标和变更边界明确；
- [ ] 关联 ADR、Spec 已 `Accepted`；
- [ ] 外部 SDK、Metadata、生命周期或并发未知已完成 Spike；
- [ ] 模块所有权和依赖方向明确；
- [ ] Compatibility、Feature Flag 和旧路径删除条件明确；
- [ ] 聚焦测试、契约测试和更广验证范围明确；
- [ ] 不存在会使结论失真的未解决 Blocker。

未达到 Ready 的 Architecture Slice 不进入 Delivery，也不通过在旧路径增加特例规避未知。

## 7. 实施流程

1. **确认事实：** 从失败行为、测试、目标文件或权威文档开始，形成一个可证伪的局部假设。可以由现有证据消除的不确定性应先自行调查；不得把可以直接核实的事实问题转交给项目所有者决策；
2. **确认范围与决策边界：** 说明拟修改内容、非目标和最低验证。多步骤工作应简要列出目标、验证方式和退出条件。若新证据会改变已接受的公共行为、架构边界、事实所有权、依赖方向或 Compatibility 策略，要求 undocumented/private dependency，产生多条生产运行路径，或实质增加复杂度和维护范围，必须列出证据、影响和可选方案，并在获得确认前暂停相关修改；
3. **执行首个小改动：** 使用最小、可逆、符合现有模式的修改验证假设；
4. **立即聚焦验证：** 首个实质修改后，不扩大范围，先运行最便宜的行为测试、相关测试或类型检查；
5. **局部迭代：** 验证失败时先修复同一范围；假设被推翻时回到最近的控制边界重新判断；
6. **更广验证：** 聚焦检查通过后，根据风险运行 Contract、Integration、Regression 和 Build；
7. **删除和同步：** 删除被替代路径，更新 Spec、ADR、Current Architecture、Plan Item 和文档索引；
8. **评审完成：** 核对验收、风险、Deferred 项和无关差异，再进入提交或合并。

实现发现已 `Accepted` 文档错误、依赖方向不成立或迁移顺序需要改变时，暂停实现并列出证据与选项。架构文档修订需单独确认；不得在代码提交中静默改变架构。

## 8. 验证要求

稳定命令以 `package.json` 为准：

```bash
npm run lint
npm test
npm run build
```

| 变更类型 | 最低验证 |
|---|---|
| Documentation | 文档诊断、链接检查、`git diff --check` |
| Small Change | 相关测试或聚焦行为检查 + `npm run lint` |
| Defect | 失败复现或回归测试 + 相关测试 + `npm run lint` |
| Public Contract | Unit/Contract Tests + 相关 Integration Tests + `npm run build` |
| Architecture Slice | Spec 中定义的聚焦、契约、集成和回归检查 + lint + build |
| Spike | Spike Spec 中定义的证据采集；不以生产测试全绿代替假设验证 |

不能运行某项检查时，必须记录原因、未覆盖风险和可执行的后续验证方式。不得用宽松重试或扩大超时掩盖确定性失败。

## 9. Definition of Done

适用项全部满足后，工作才可完成：

- [ ] 已确认的验收场景通过；
- [ ] 首个实质修改后已运行聚焦验证；
- [ ] 新增或变化的公共契约有测试；
- [ ] 该变更要求的 lint、测试和 build 通过；
- [ ] 至少一个真实调用方已迁移；
- [ ] 被替代生产路径已删除，或降级为有负责人和到期日的 Compatibility；
- [ ] 新代码不依赖 Legacy 或 Compatibility；
- [ ] ADR、Spec、Results、Current Architecture 和对应 Plan Item 状态已同步；
- [ ] 文档索引和 Legacy 迁移记录已更新；
- [ ] 没有未解释的 Diagnostics、无关重构或生成噪音；
- [ ] 每个实质修改都可追溯到已确认需求、验收条件、缺陷证据或本次修改直接产生的必要清理；没有预先抽象、无关优化或既有 dead code 清理；
- [ ] 剩余风险和 Deferred 项可追踪。

Documentation、Small Change 等不涉及真实调用方或 Compatibility 的工作按“适用项”执行，不需要人为制造对应产物。

## 10. Review 处理

每条 Reviewer 意见按以下方式处理：

1. 回到代码、测试或权威文档核实事实；
2. 标记为接受、修改后接受或拒绝；
3. 说明严重度、影响和理由；
4. 只实施已接受的最小修正；
5. 修正后重新运行能验证该意见的检查。

Reviewer 意见不是自动指令。Critical/High 问题通常阻断完成；Medium/Low 是否阻断由实际风险和当前 Gate 决定。

## 11. 文档与 Legacy

- `docs/architecture/` 存放当前实现事实、设计基线、Spec 和相关实施记录；每份文档自身的状态决定其权威性，在文档收敛完成前不得将整个目录默认视为已验证的 Current Architecture；
- `docs/roadmap/` 描述已批准或拟议的演进计划；
- ADR、Module Spec、Spike Spec 和 Results 使用 `docs/templates/` 中的模板；
- 旧文档先标记和迁移，再在独有信息、入站链接和替代文档确认后删除；
- Git 保存历史，不在 `src/legacy/` 或活跃文档中长期保留旧实现副本；
- 文档与代码可以分开提交，但对应工作在两者同步前不算完成。

## 12. Commit 与范围纪律

- Commit subject 和 body 只能使用英文；
- 一个提交只包含一个可解释的变更范围，不混入无关格式化或生成文件；
- 未经用户或项目所有者明确批准，不创建提交；
- 提交前检查 staged 文件，避免纳入工作树中的其他修改；
- 不重写、回退或覆盖不属于当前工作的用户改动；
- Architecture Foundation 等阶段里程碑应建立检查点，但不要求每个小改动单独提交。

## 13. 模板

- [ADR Template](templates/adr-template.md)
- [Module Spec Template](templates/module-spec-template.md)
- [Spike Spec Template](templates/spike-spec-template.md)
- [Spike Results Template](templates/spike-results-template.md)
