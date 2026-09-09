# Slice 6 Documentation and Legacy Closeout Spec

## 状态

- **状态：** Accepted
- **版本：** 0.4
- **日期：** 2026-09-09
- **所有者：** 项目所有者
- **Plan Item：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) Slice 6
- **关联 ADR / Spec：** [ADR-003](adr-003-progressive-architecture-migration.md)、[ADR-006](adr-006-legacy-and-compatibility-exit.md)、[Target Architecture](target-architecture.md)、[Legacy Migration Inventory](legacy-migration-inventory.md)
- **证据输入：** [Development Workflow](../development-workflow.md)、[Capability Inventory](../agent-capabilities.md)、[FT-09 Documentation Governance](../../src/architecture-fitness/ft-09-doc-governance.test.ts)、Slice 1–5 已完成 Specs、production source、tests 与 Git history

本 Spec 遵循 [Development Workflow](../development-workflow.md)。项目所有者于 2026-09-09 接受完整 Spec v0.3，随后分别授权 non-deleting S6-D1、S6-D2 Current Architecture 与 S6-D3 Active Navigation Delivery。S6-D2 实施审查发现原固定 13-page 结构遗漏当前 `core/model-resolution` 与 `core/media` ownership；项目所有者明确要求新结构以当前架构边界和读者需求为准，不迁就旧文档，并批准 v0.4 结构修订。S6-D4–D8、API-M04、其他 production code 修改、dependency 安装、commit 和 push 仍分别需要明确授权。

## 1. 目的与用户可观察结果

Slice 6 按 authority 和 unique value 收敛文档，不按年龄或目录批量清理：

- [Current Architecture Overview](current/overview.md) 成为唯一 Current Architecture 入口；同目录 topic files 分别拥有一类 verified current fact；
- [Root README](../../README.md)、[Documentation Index](../README.md) 和 [Capability Inventory](../agent-capabilities.md) 只承担产品入口、导航或 dated summary，不复制竞争性架构说明；
- Accepted ADR/Spec、active Plan 和 durable Results 保持各自 authority；Proposal、implementation narration 和 historical evidence 不再伪装成 Current；
- DOC-C01–C13、DOC-A01–A27、DOC-V01–V12 共 52 个 document candidates 逐项完成 fact、decision、unfinished work、evidence、inbound link 和 unique-value Review；
- 删除只发生在 successor 已建立、active inbound links 已迁移且 unique value 已明确处置之后；
- `docs/legacy/` 只在 retained artifact 需要稳定 locator 时使用，不成为批量归档或第二套 current docs；
- DOC-V10 的 verified Config Wizard successor 先建立，五个 production source references 后迁移，FT-09 已知 diagnostics 最终归零；
- API-M04 作为独立 public Compatibility batch；Document Delivery 不隐含 facade removal 授权。

最终读者从 Root README 或 Documentation Index 进入同一个 Current Architecture overview，并能区分 Current、Target、Decision、Contract、Plan、Results、Deferred Input 和 Historical Authority。

## 2. 范围

- 冻结 52 个 document candidates 的 path、successor、proposed disposition 和 validation；
- 建立一个 Current Architecture overview 与按当前模块边界扩展的 topic files；topic 数量不是兼容旧文档的固定条件；
- 依据 production source、tests 和 Slice 1–5 accepted/validated evidence 重写 DOC-C01–C13；
- 更新 Root README、Documentation Index 和 Capability Inventory；
- 逐项 Review DOC-A01–A27 与 DOC-V01–V12；
- 把 durable decision、unfinished work 和 execution evidence 分别迁入 ADR/Spec、Plan、Results/test mapping 或 Git history；
- 生成完整 disposition 与 inbound-link manifest；
- 修复 active links、anchors、status/successor metadata 和 production source Legacy references；
- 对确有 locator 价值的 retained historical/deferred artifact 选择性使用 `docs/legacy/`；
- 更新 Legacy Migration Inventory、Architecture Foundation Plan 和 documentation Fitness；
- 按逐文件 Gate 删除已迁移且无独有价值的 Legacy document；
- planning 中定义 API-M04 独立 removal gate。

## 3. 非目标

- Runtime、Provider、Runner、Channel、Tool、Hook、Session、Prompt、Memory、Workspace 或 Config production behavior 变更；
- 新产品能力、Subagent concurrency Delivery 或 Foundation freeze 解除；
- 按目录、文件名、版本或年龄批量删除；
- 把全部 candidate 搬入 `docs/legacy/`；
- 创建第二个 Current Architecture 文件或把所有 topic 内容复制进 overview；
- 重写 Accepted ADR/Spec 来迁就旧 design；
- 用 Capability Inventory、Root README 或 Documentation Index 承担 current fact authority；
- 未经单独授权删除 API-M04、修改 public exports 或迁移 production callers；
- dependency 安装、native rebuild；
- 本 Draft 阶段的 Document Delivery、commit 或 push。

## 4. Authority Model

### 4.1 冲突优先级

发生冲突时按以下顺序处理：

1. 已确认需求与 acceptance conditions，作为 agreed scope 和 desired outcome；
2. Accepted ADR；
3. Accepted/Validated Module Spec；
4. production source、tests 与 executed Results 对 current behavior 的共同证据；
5. Accepted Plan 与 Plan Item status；
6. canonical Current Architecture；
7. Capability summary、Proposal、implementation record、Historical/Legacy narration。

Source/tests 证明 current fact，但 executed evidence 不因排在本列表前面而静默替代长期 ADR decision。已确认需求若要求改变 Accepted decision，也必须显式 supersede；发现 Accepted authorities 真实冲突时停止当前 batch，列出证据与选项，并请求项目所有者决策。

### 4.2 唯一 Current Architecture

```text
Root README ───────────────┐
Documentation Index ──────┼──> current/overview.md
Capability Inventory ─────┘          |
                                      +--> runtime.md
                                      +--> core_runner.md
                                      +--> core_model_resolution.md
                                      +--> core_media.md
                                      +--> adapter_channel.md
                                      +--> platform_config.md
                                      +--> adapter_llm.md
                                      +--> core_tools.md
                                      +--> core_tools_builtin.md
                                      +--> core_session.md
                                      +--> core_prompt.md
                                      +--> core_memory.md
                                      +--> core_workspace.md
                                      +--> platform_logger.md

Accepted ADRs  <── durable decisions
Accepted Specs <── contracts and validated delivery boundaries
Active Plans   <── unfinished work
Results/tests  <── execution evidence
Historical     <── reviewed unique evidence only; never Current
Deferred Input <── non-authorizing future input with Owner/successor
```

“唯一”约束入口与 fact ownership，不要求物理单文件：[Current Architecture Overview](current/overview.md) 拥有模块地图、authority 声明、核心 flow 和 topic 导航；每个 topic file 只拥有其主题的 verified current facts。跨主题内容通过链接引用，不复制第二份说明。

### 4.3 Current fact ownership matrix

下表冻结完整 topic ownership。一个 flow 可以链接多个 topic，但同一个 detailed fact 只能由 Primary Owner 陈述；其他 topic 只链接，不复述。

| Current fact domain | Primary Owner | Boundary note |
|---|---|---|
| module map、authority map、end-to-end Turn overview | `current/overview.md` | overview 不复制 topic detail |
| Runtime composition、generation、queue、route、Fanout、Abort、Shutdown | `current/runtime.md` | Runner algorithm 只链接 DOC-C03 |
| Subagent orchestration、Parent/Child delegation、generation inheritance、Child lifecycle | `current/runtime.md` 的 Subagent subsection | Runner 只描述 generic Tool/Abort contract，不建立第二个 Subagent section |
| Runner loop、context budgeting、Compaction、Tool/Hook invocation、events | `current/core_runner.md` | Runtime scheduling 只链接 DOC-C02 |
| Channel contract、transport、interaction、WebSocket/CLI protocol | `current/adapter_channel.md` | Runtime route state 只链接 DOC-C02 |
| attachment ingress、Channel delivery、client wire summary | `current/adapter_channel.md` 的 Attachments subsection | media validation/normalization 只链接 `core_media.md` |
| media validation、limits、MIME sniffing、optimization、drop reasons、canonical block normalization | `current/core_media.md` | Channel wire、Prompt composition 与 Provider conversion 不在此重复 |
| prompt composition、Context Hook、normalized media placement | `current/core_prompt.md` | media pipeline 与 Channel protocol facts只链接其 Owner |
| Config source、precedence、schema、Wizard | `current/platform_config.md` | Model Facts ownership服从 ADR-004 |
| Provider protocol、normalized event/error mapping、Anthropic Adapter | `current/adapter_llm.md` | Model resolution/composition分别链接 Runtime/ADR-004 |
| Model Reference、Provider projection、canonical identity、Facts/limits、capability validation、resolution failures | `current/core_model_resolution.md` | Provider publishing 链接 Adapter；Turn capture/composition 链接 Runtime |
| canonical Tool contract、policy/approval execution boundary | `current/core_tools.md` | builtin implementation detail只链接 DOC-C08 |
| builtin inventory、filesystem/search/web、Exec/Process behavior | `current/core_tools_builtin.md`，Exec/Process 为具名 subsection | generic Tool contract只链接 DOC-C07 |
| Session、Transcript、JSONL、persistence | `current/core_session.md` | Runtime queue不在此重复 |
| Memory Port/Store、indexing、optional degradation | `current/core_memory.md` | lifecycle ownership链接 Runtime |
| Workspace initialization、context file loading | `current/core_workspace.md` | prompt consumption链接 DOC-C10 |
| Logger、startup buffering、diagnostics、close | `current/platform_logger.md` | aggregated Shutdown ownership链接 Runtime |

### 4.4 Document roles

| Role | 可以承担 | 不得承担 |
|---|---|---|
| Current Architecture | 已由 source/tests 验证的当前边界与 flow | future design、未接受 decision、过程 narration |
| Target Architecture | 目标 ownership、依赖方向、迁移约束 | 声称当前已实现 |
| ADR | durable decision 与 trade-off | 易变全仓 inventory |
| Module Spec | accepted contract、scope、validation | 未经接受的 current fact 替代品 |
| Plan | unfinished work、Gate、顺序 | 当前 implementation authority |
| Results/test mapping | executed evidence | future commitment |
| Active Navigation | 简短入口与链接 | 重复模块地图或 detailed contract |
| Historical Authority | 经 Review 的独有历史证据 | Current、Target 或 active work |
| Deferred Input | 具名 Owner/successor 的未来输入 | implementation authorization |

## 5. Frozen Baseline

### 5.1 Count and scope

| Category | IDs | Count | Initial state |
|---|---|---:|---|
| Current Fact Candidates | DOC-C01–DOC-C13 | 13 | `Pending` |
| Root design/proposal/implementation candidates | DOC-A01–DOC-A27 | 27 | `Pending` |
| v1.0 candidates | DOC-V01–DOC-V12 | 12 | `Pending` |
| **Document total** |  | **52** |  |
| Public Compatibility Candidate | API-M04 | 1 | separate gated review |

All 52 paths existed in the 2026-09-09 read-only audit. Their baseline identity is inherited from [Legacy Migration Inventory](legacy-migration-inventory.md); this Spec freezes Slice 6 disposition and validation without replacing the Inventory as the cross-Slice ledger.

The 52-entry count is a migration ledger, not the Current Architecture schema. [Current Model Resolution](current/core_model_resolution.md) and [Current Media](current/core_media.md) were added from live module boundaries during the approved v0.4 amendment; neither receives a fabricated DOC-C ID or changes the frozen candidate total.

### 5.2 Known governance baseline

The current hard-coded FT-09 test manifest contains and locks:

- 14 active governed documents;
- DOC-V10 as one Legacy document;
- one DOC-V10 `missing-successor-link` diagnostic;
- five production source references from Config Wizard files to DOC-V10.

The six diagnostics are migration inputs, not accepted residuals. The current narrow FT-09 manifest cannot alone prove 52-entry closeout.

### 5.3 Verified stale authority classes

The planning audit verified these blockers:

- Root README still presents the pre-Foundation source tree and links old design documents as primary architecture reading;
- Documentation Index explicitly says no single verified Current Architecture exists and recommends old design-first reading;
- Capability Inventory is dated 2026-08-27, treats `current/` as an old snapshot, and mixes current, candidate and Legacy links;
- Current Runtime and Config retain pre-Slice-5 vocabulary despite later header updates;
- Current overview/topic structure is suitable for canonical authority but does not yet declare that role;
- DOC-V10 lacks successor metadata and remains referenced by five production comments;
- API-M04 still has production, script, test and barrel references; its existing Inventory wording is therefore broader than repository evidence supports.

## 6. Owner Decisions

The project owner confirmed the following planning decisions on 2026-09-09. They become implementation constraints only after the complete Spec is accepted and Delivery is separately authorized.

### DC-OD-01 Canonical Current Architecture

Use [Current Architecture Overview](current/overview.md) plus topic files divided by current reader needs and live module boundaries. The topic count is not frozen to the 13 legacy-derived DOC-C candidates. Do not create another `current-architecture.md`; do not collapse all details into one giant file. New Current pages do not receive fabricated candidate IDs merely to preserve the old disposition shape.

### DC-OD-02 Topic ownership

Each current fact has one topic owner. Overview, Capability Inventory and indexes summarize or link; Accepted ADR/Spec retain decision/contract authority.

### DC-OD-03 Capability Inventory

Retain [Capability Inventory](../agent-capabilities.md) as a dated capability summary. Refresh status and links, but do not promote it to Current Architecture authority.

### DC-OD-04 Root and index navigation

Retain Root README as a concise product entry and Documentation Index as categorized navigation. Neither duplicates the module map; both route current-fact readers to the canonical overview.

### DC-OD-05 Historical and deferred content

Retain `*-changes.md` only when Git history, Results and test mapping cannot replace unique evidence. DOC-A04/A05 and any other valuable future proposal remain explicit non-authorizing Deferred Input with Owner/successor; unowned or rejected future narration is deleted after Review.

### DC-OD-06 Selective `docs/legacy/`

Use `docs/legacy/` only when a frozen stable locator has continuing value. A move never preserves Current authority and does not waive migration or deletion Gates.

### DC-OD-07 Fitness model

Keep FT-09 responsible for generic metadata, authority-link and production Legacy-reference rules. Add a complete Slice 6 manifest/fitness rule for all 52 candidates; do not silently replace the old baseline before successor migration.

### DC-OD-08 DOC-V10

Create and verify the Current Configuration/Config Wizard successor before replacing the five production references. Delete or move DOC-V10 only after successor, zero-reference and unique-value Gates pass.

### DC-OD-09 API-M04 authorization

Plan API-M04 in Slice 6 but execute it as an independent public-contract batch. Document Delivery authorization never implies facade removal authorization.

## 7. Disposition Contract

### 7.1 State machine

Candidates follow ADR-006:

`Pending -> Migrating -> Migrated -> Reviewed -> Deleted`

A reviewed file that remains uses one explicit terminal disposition:

- `Retain Current Authority`;
- `Retain Active Navigation`;
- `Retain Historical Authority`;
- `Retain Deferred Input`.

“Delete After Migration” is a proposed outcome, not permission to skip `Migrated -> Reviewed`.

Generic `Retain Authority` is invalid because it does not identify the retained role. Accepted governance/ADR/Spec/Plan/Results outside the 52-candidate set keep their document-specific authority and are not assigned a candidate disposition.

### 7.2 Required manifest fields

The Delivery manifest must contain exactly one row for every DOC-C/A/V ID and include:

- ID, path and category;
- initial state and current transition state;
- current-fact successor;
- durable-decision authority;
- unfinished-work successor or explicit rejection;
- evidence successor;
- active inbound docs/source/tests/scripts/clients;
- unique-value conclusion;
- proposed and final disposition;
- validation evidence and reviewer result.

The manifest is the review ledger, not a new architecture authority.

## 8. Frozen 52-entry Proposed Disposition

### 8.1 Current Fact Candidates

| ID | Artifact | Canonical ownership / required evidence | Proposed terminal disposition |
|---|---|---|---|
| DOC-C01 | [Current Overview](current/overview.md) | module map and major flows; source/runtime composition and characterization evidence | Retain Current Authority; rewrite in place |
| DOC-C02 | [Current Runtime](current/runtime.md) | queue, routing, Fanout, Abort, lifecycle and generation; CH-01/02/05–10/12 plus Runtime tests | Retain Current Authority; rewrite in place |
| DOC-C03 | [Current Runner](current/core_runner.md) | execution loop, Tool Use, context and events; CH-02–04/11/13 plus Runner tests | Retain Current Authority; rewrite in place |
| DOC-C04 | [Current Channel](current/adapter_channel.md) | transport, routing and interaction; Channel Module Spec plus Channel/Runtime tests | Retain Current Authority; rewrite in place |
| DOC-C05 | [Current Config](current/platform_config.md) | config source/merge/schema and Wizard facts; loader/schema/wizard tests plus ADR-004 | Retain Current Authority; rewrite in place |
| DOC-C06 | [Current Provider Adapter](current/adapter_llm.md) | Provider protocol/error mapping; adapter tests, FT-03/08 and ADR-002/004 | Retain Current Authority; rewrite in place |
| DOC-C07 | [Current Tools](current/core_tools.md) | Tool contract/execution; Tool tests, CH-03/04/14 and FT-07/08 | Retain Current Authority; rewrite in place |
| DOC-C08 | [Current Builtin Tools](current/core_tools_builtin.md) | verified builtin capability inventory; production registrations and builtin tests | Retain Current Authority; rewrite in place |
| DOC-C09 | [Current Session](current/core_session.md) | Session/Transcript/JSONL persistence; Session, Compaction and CH-03/11 tests | Retain Current Authority; rewrite in place |
| DOC-C10 | [Current Prompt](current/core_prompt.md) | prompt/context Hook behavior; Prompt tests and CH-14 | Retain Current Authority; rewrite in place |
| DOC-C11 | [Current Memory](current/core_memory.md) | Memory Port/Store and degradation; Memory/resource tests | Retain Current Authority; rewrite in place |
| DOC-C12 | [Current Workspace](current/core_workspace.md) | initialization/context loading; Workspace and Prompt tests | Retain Current Authority; rewrite in place |
| DOC-C13 | [Current Observability](current/platform_logger.md) | Logger/startup buffering/shutdown; Logger tests and FT-01 | Retain Current Authority; rewrite in place |

### 8.2 Root architecture, proposal and implementation candidates

| ID | Artifact | Successor / unique-value disposition | Proposed terminal disposition |
|---|---|---|---|
| DOC-A01 | [Platform Config Restructure Implementation](platform-config-restructure-impl.md) | facts → DOC-C05; decision → ADR-004/Specs; unfinished work → Plan; narration → Git | Delete After Migration |
| DOC-A02 | [Channel Design](adapters-channel-design.md) | verified facts → DOC-C04; contract → Channel Module Spec | Delete After Migration |
| DOC-A03 | [WebSocket Channel Design](adapters-websocket-channel-design.md) | verified protocol facts → DOC-C04; unaccepted ideas → Plan or reject | Delete After Migration |
| DOC-A04 | [Subagent Evolution Proposal](core-subagent-evolution-proposal.md) | retain only as non-authorizing future direction; Foundation freeze remains | Retain Deferred Input |
| DOC-A05 | [Subagent v2 Spec](core-subagent-v2-spec.md) | future concurrency input; future Accepted Spec must supersede it | Retain Deferred Input |
| DOC-A06 | [Runner Emit Context Refactor](core-runner-emit-context-refactor.md) | approved work → Plan; otherwise explicit rejection and Git history | Delete After Migration |
| DOC-A07 | [Exec Flow Design](core-tools-builtin-exec-flow-design.md) | verified Exec/Process facts → DOC-C08 Exec/Process subsection; generic Tool contract → DOC-C07; future work → Plan | Delete After Migration |
| DOC-A08 | [Root README](../../README.md) | same file becomes concise product/navigation entry | Retain Active Navigation; rewrite in place |
| DOC-A09 | [Capability Inventory](../agent-capabilities.md) | same file becomes dated summary linked to Current Architecture | Retain Active Navigation; rewrite in place |
| DOC-A10 | [Runtime Design](runtime-design.md) | verified facts → DOC-C02; decisions/contracts → accepted Runtime Specs | Delete After Migration |
| DOC-A11 | [Core Runner Design](core-runner-design.md) | facts → DOC-C03; closure/Compaction decisions → ADR-001/002 | Delete After Migration |
| DOC-A12 | [Core Runner Context Design](core-runner-context-design.md) | current budgeting/Compaction → DOC-C03; decisions → ADR-002 | Delete After Migration |
| DOC-A13 | [Core Runner Hooks Design](core-runner-hooks-design.md) | current Hook facts → DOC-C03; contract → Tool/Hook Module Spec | Delete After Migration |
| DOC-A14 | [Platform Config Design](platform-config-design.md) | config facts → DOC-C05; Model ownership → ADR-004/Model Resolution Spec | Delete After Migration |
| DOC-A15 | [Platform Logger Design](platform-logger-design.md) | verified facts → DOC-C13; future decisions → future Spec or reject | Delete After Migration |
| DOC-A16 | [Logging Design](logging-design.md) | merge verified facts into DOC-C13; conflicting suggestions → Plan/Spec or reject | Delete After Migration |
| DOC-A17 | [LLM Adapter Design](adapters-llm-design.md) | facts → DOC-C06; identity/Facts/Port decisions → ADR-004 and accepted Specs | Delete After Migration |
| DOC-A18 | [Core Prompt Design](core-prompt-design.md) | facts → DOC-C10; future decisions → future Prompt Spec | Delete After Migration |
| DOC-A19 | [Core Session Design](core-session-design.md) | facts → DOC-C09; future transaction decisions → future Session Spec | Delete After Migration |
| DOC-A20 | [Core Memory Design](core-memory-design.md) | facts → DOC-C11; future work → Plan/Spec | Delete After Migration |
| DOC-A21 | [Core Tools Design](core-tools-design.md) | facts → DOC-C07; Registry/Hook contract → Slice 3 Spec | Delete After Migration |
| DOC-A22 | [Builtin Tools Design](core-tools-builtin-design.md) | inventory → DOC-C08; future Memory Tool work → Plan or reject | Delete After Migration |
| DOC-A23 | [Workspace Design](core-workspace-design.md) | facts → DOC-C12; future decisions → future Workspace Spec | Delete After Migration |
| DOC-A24 | [Exec Runtime Design](core-tools-builtin-exec-runtime-design.md) | platform and process facts → DOC-C08 Exec/Process subsection; unfinished work → Plan or reject | Delete After Migration |
| DOC-A25 | [Attachments Server Implementation](attachments-server-implementation.md) | contract → Attachments Support Spec; wire ingress/delivery → DOC-C04; media validation/normalization → `current/core_media.md`; prompt placement → DOC-C10 | Delete After Migration |
| DOC-A26 | [Attachments Client Implementation](attachments-client-implementation.md) | contract → Attachments Support Spec; wire/client delivery → DOC-C04; media limits/normalization → `current/core_media.md`; capability presence → dated Capability Inventory | Delete After Migration |
| DOC-A27 | [Core Subagent Implementation](core-subagent-impl.md) | contract → Core Subagent Spec; orchestration/delegation facts → DOC-C02 Subagent subsection; generic Runner interaction → DOC-C03; evidence → Slice 2 record | Delete After Migration |

### 8.3 v1.0 candidates

| ID | Artifact | Successor / unique-value disposition | Proposed terminal disposition |
|---|---|---|---|
| DOC-V01 | [Channel Changes](v1.0/adapters-channel-changes.md) | facts → DOC-C04; retain only migration delta not reconstructible from Git/Results/tests | Retain Historical Authority, conditional on unique-value Gate |
| DOC-V02 | [Channel Design](v1.0/adapters-channel-design.md) | facts → DOC-C04; contract → Channel Module Spec | Delete After Migration |
| DOC-V03 | [Runner Changes](v1.0/core-runner-changes.md) | facts → DOC-C03; retain only non-reconstructible acceptance/delta evidence | Retain Historical Authority, conditional on unique-value Gate |
| DOC-V04 | [Runner Design](v1.0/core-runner-design.md) | facts → DOC-C03; decisions → ADR-001/002 | Delete After Migration |
| DOC-V05 | [Runner Message Flow](v1.0/core-runner-message-flow.md) | verified flow → DOC-C02/C03; evidence → steering/intake tests | Delete After Migration |
| DOC-V06 | [FS Changes](v1.0/core-tools-fs-changes.md) | facts → DOC-C07/C08; retain only non-reconstructible migration evidence | Retain Historical Authority, conditional on unique-value Gate |
| DOC-V07 | [FS Design](v1.0/core-tools-fs-design.md) | verified workspace-path contract → DOC-C07 and accepted Tool contract | Delete After Migration |
| DOC-V08 | [Config Changes](v1.0/platform-config-changes.md) | facts → DOC-C05; retain only non-reconstructible migration evidence | Retain Historical Authority, conditional on unique-value Gate |
| DOC-V09 | [Config Design](v1.0/platform-config-design.md) | source/precedence facts → DOC-C05; Model Facts → ADR-004 | Delete After Migration |
| DOC-V10 | [Config Wizard Design](v1.0/platform-config-wizard-design.md) | verified Wizard section → DOC-C05; replace five production references; FT-09 zero | Delete After Migration |
| DOC-V11 | [Runtime Changes](v1.0/runtime-changes.md) | facts → DOC-C02; retain only non-reconstructible queue/routing delta evidence | Retain Historical Authority, conditional on unique-value Gate |
| DOC-V12 | [Runtime Design](v1.0/runtime-design.md) | facts → DOC-C02; contract → accepted Runtime Specs | Delete After Migration |

The five conditional Historical dispositions are not blanket retention. During Review each must prove specific evidence unavailable from Git history, Results or test mapping; failure to prove it changes the terminal disposition to `Delete After Migration` without changing this policy.

## 9. Inbound-link and Unique-value Gate

### 9.1 Inbound inventory

For every candidate, Delivery must classify inbound references from:

- active governance, Current, ADR, Spec, Plan, Results and indexes;
- other document candidates;
- `src/**` production source;
- `scripts/**`, `clients/**` and tests;
- generated or manual integration instructions tracked in the repository.

An inbound link is not equivalent to authority. Candidate-to-candidate links still need replacement before deletion. Repository-relative links, anchors and source comments are all part of the Gate.

### 9.2 Unique-value questions

Reviewers must answer all six questions per candidate:

1. Does it contain verified current fact absent from the canonical topic?
2. Does it contain a durable decision absent from Accepted ADR/Spec?
3. Does it contain unfinished approved work absent from an active Plan?
4. Does it contain executed evidence absent from Results/tests/Git history?
5. Does a stable historical locator still serve an active repository reference?
6. Would deletion remove rationale needed to interpret a retained authority?

“No” to all six permits deletion after link migration. “Yes” requires explicit successor extraction or a retained terminal role; it never permits a second Current authority.

### 9.3 Per-file deletion Gate

A file can reach `Deleted` only when all applicable conditions pass:

- verified current facts migrated;
- durable decisions migrated;
- unfinished work planned or explicitly rejected;
- execution evidence preserved or explicitly judged reconstructible from Git history;
- active inbound links and production references are zero;
- successor/status metadata is valid;
- unique-value Review is recorded;
- file is not Accepted governance/ADR/Spec, active Plan or durable Results;
- documentation diagnostics, link audit and relevant Fitness pass;
- disposition manifest records `Reviewed -> Delete`.

Moving a file to `docs/legacy/` requires the same migration Review and must add frozen status plus successor. A move is not a substitute for deletion readiness.

## 10. DOC-V10 Successor Gate

DOC-V10 is the only currently registered FT-09 Legacy document and has six known diagnostics: one missing successor plus five source references.

Required order:

1. verify Config Wizard behavior from source/tests;
2. add an owned Config Wizard section to [Current Config](current/platform_config.md);
3. link the section from Current overview/config navigation as needed;
4. replace or remove the five Legacy source comments so each comment is self-contained or points to the Current section;
5. add DOC-V10 successor/status metadata while it remains;
6. run focused Config Wizard tests and FT-09;
7. complete unique-value Review;
8. delete or selectively retain only after FT-09 diagnostics reach zero.

A generic link to Current Config without verified Wizard facts does not satisfy the successor Gate.

## 11. API-M04 Separate Gate

### 11.1 Verified baseline

API-M04 is the deprecated `LLMClient` / `ChatParams` / `StreamEvent` adapter facade. Stable invocation contracts live under `core/model-invocation`, but the 2026-09-09 audit found:

- two Runtime production imports of stable Core symbols through the compatibility facade path;
- one Anthropic Adapter implementation import that still uses deprecated alias names from its local facade;
- eight integration scripts importing the facade path: six use deprecated aliases and two use stable Core symbols through that path;
- tests that either use deprecated aliases or import stable Core symbols through the facade path;
- one adapter barrel re-export containing deprecated aliases and stable Core symbols;
- unresolved external consumer/deprecation decision.

The entire `adapters/llm/types.ts` module is documented as a temporary compatibility facade, while `ChatParams`, `LLMClient` and `StreamEvent` are deprecated alias names defined by Stable Core. Therefore two independent residual classes must be measured: **facade-path imports** and **deprecated-alias usages**. API-M04 is not deletion-ready, and the Inventory statement “production callers migrated” must be narrowed to the authoritative invocation contract rather than interpreted as zero facade-path usage.

### 11.2 Removal conditions

S6-D7 may run only after separate public-contract authorization and must prove:

1. external-consumer policy: deprecation window or explicit breaking release decision;
2. zero production usage of deprecated aliases;
3. zero repository imports through the temporary facade path, unless the owner explicitly narrows API-M04 to alias removal and separately governs the remaining path Compatibility;
4. explicit script/test migration or a reviewed test-only allowance that does not preserve a public recommendation;
5. deprecated adapter barrel exports removed and stable symbols exported only from their authoritative Core boundary;
6. Stable Core invocation Contract tests pass;
7. Anthropic Adapter contract tests pass;
8. FT-03 and FT-08 pass;
9. deterministic symbol-level and path-level reference audits plus build pass;
10. no reverse dependency from Stable Core to the facade;
11. Legacy Migration Inventory and release-facing documentation are synchronized.

If S6-D7 is not authorized, API-M04 remains a named Compatibility Candidate with Owner, caller list, review date and exit conditions. Pure document closeout may complete, but repository claims must not say all Compatibility has been deleted.

## 12. Delivery Batches

### S6-D1 Baseline and manifest

- create the 52-entry disposition/inbound-link manifest;
- verify ID/path uniqueness and classify inbound references;
- lock known stale facts, FT-09 diagnostics and API-M04 callers;
- update no candidate content and delete nothing in the first change;
- run focused manifest/Fitness test immediately after the first substantive edit.

**Exit:** 52/52 entries represented exactly once; no path anomaly; baseline review complete.

S6-D1 is the first separately authorized Document Delivery batch, not a pre-acceptance planning artifact. It is deliberately non-deleting. S6-D2–D8 cannot start until the S6-D1 exit evidence includes the detailed inbound-link, unique-value, transition-state and named evidence fields required by §7.2.

**Delivery status（2026-09-09）：** `Completed`。52-entry manifest、immutable surface 与 FT-11 已建立；52/52 ID/path/category/disposition、逐项 baseline state、active/candidate/source/test/script/client inbound references、governance ledger、DOC-V10 五个 production references + FT-09 reference、separate API-M04 facade-path/alias baseline 均被锁定。未修改或删除任何候选文档。Focused FT-11 3/3、FT-01–FT-11 29/29、lint、build、`git diff --check`、JSON 与 Spec link/anchor validation 全部通过；independent review 为 `Ready`，无 unresolved Critical/High/Medium blocker。项目所有者已于 2026-09-09 确认 S6-D1 完成并单独授权 S6-D2；该授权不包含 S6-D3、API-M04、commit 或 push。

### S6-D2 Current Architecture

- rewrite DOC-C01–C13 in place from source/tests and controlling ADR/Spec;
- declare overview/topic authority and remove stale Runtime/Config/model/composition vocabulary;
- add per-topic verified date and evidence mapping;
- keep overview concise and avoid cross-topic duplication.

**Exit:** Current fact audit passes; every current fact has one topic Owner; all 13 entries are `Migrated` and retained as Current Authority.

**Delivery status（2026-09-09）：** `Completed — Owner Accepted`。Current Architecture 现为一个 overview + 14 个按 live module boundary 划分的 topics；新增 `core_model_resolution.md` 与 `core_media.md`，并从 Channel/Prompt/Provider/Config/Runtime 收窄重复或错置 ownership。FT-12 不再冻结 Legacy-derived DOC-C count/sequence，而是锁定唯一 overview、完整受管页面集合、唯一 ownership keys、动态 source-module coverage、evidence/links/anchors 与关键 current claims。原 52-entry manifest 仍只管理候选迁移：DOC-C01–C13 为 `Migrated` / `Retain Current Authority`，两个新增 Current topics 不伪造 candidate IDs；39 个 non-DOC-C candidates 与 API-M04 baseline paths 均未修改。Focused FT-11/FT-12 7/7、FT-01–FT-12 33/33、editor diagnostics、lint、build、15-page surface、52-candidate count、JSON parse、16-file Current/Spec link-anchor audit 和 `git diff --check` 全部通过；21 个 changed/untracked paths 全部属于已授权 S6-D2 scope。多轮 independent review 发现的结构/事实偏差已全部按 live source/tests 修正，最终 acceptance check 无 unresolved Critical/High/Medium blocker。项目所有者于 2026-09-09 接受 S6-D2 v0.4，随后单独授权 S6-D2 commit/push checkpoint 与 S6-D3 Active Navigation；API-M04 Delivery 仍未授权。

### S6-D3 Active navigation

- rewrite Root README project structure and Documentation links;
- reorganize Documentation Index around Governance, Current, ADRs, Specs, Plans, Results, Historical/Deferred and Analysis;
- refresh Capability Inventory date/status/links;
- replace active design-first navigation with the canonical overview.

**Exit:** DOC-A08/A09 are active navigation only; no active index recommends candidate design as Current.

**Delivery status（2026-09-09）：** `Completed — Owner Accepted`。Root README、Documentation Index 与 dated non-authoritative Capability Summary 已围绕 canonical Current Architecture 和 authority roles 重写；旧 design-first active navigation 已移除。Manifest 仅推进 DOC-A08/A09 为 `Migrated` / `Retain Active Navigation`，保留 DOC-C01–C13 的既有状态；其余 37 个 candidates 仍为 `Pending`，API-M04 仍为 separate unauthorized gate。FT-11 现接受 S6-D3 phase、锁定该 state boundary，并通过 canonical multi-syntax reference audit 阻止三个 active-navigation pages 链接 pending candidates。Focused FT-11/FT-12 8/8、FT-01–FT-12 34/34、editor diagnostics、lint、build、JSON、link、scope 和 `git diff --check` validation 全部通过；independent review 的一项 Medium parser-coverage finding 已修正，最终 re-review 为 `Ready`，无 unresolved Critical/High/Medium blocker。项目所有者于 2026-09-09 接受 S6-D3；该验收不授权 checkpoint commit/push、S6-D4 或 API-M04 Delivery。

### S6-D4 Root candidate extraction

- process DOC-A01–A03 and A07, A10–A27;
- extract verified facts, decisions, work and evidence to their proper authorities;
- replace candidate-to-candidate and active inbound links;
- delete only reviewed files passing §9.3.

**Exit:** every processed DOC-A entry has final disposition and no candidate remains an accidental Current authority.

### S6-D5 Deferred Subagent decisions

- mark DOC-A04/A05 explicitly Deferred and non-authorizing;
- link Owner, Foundation freeze and future Plan/Spec successor;
- process DOC-A06 here: decide whether its unfinished work enters an active Plan or is explicitly rejected, then apply its final deletion Gate;
- do not import v2 concurrency claims into Current Architecture.

**Exit:** retained Deferred Inputs have active Owner/successor; rejected/unowned work is removed rather than frozen indefinitely.

### S6-D6 v1.0 and DOC-V10 closeout

- review DOC-V01–V12 individually;
- apply the unique-value Gate to five `*-changes.md` records;
- execute DOC-V10 successor sequence;
- move only artifacts requiring a stable frozen locator;
- update FT-09 from known diagnostics to the final governed set without hiding intermediate failures.

**Exit:** all 12 DOC-V entries reach reviewed terminal disposition; the DOC-V10 missing-successor diagnostic and all five Legacy-source-reference diagnostics are zero.

### S6-D7 API-M04 removal — optional, separately authorized

- execute §11 only after explicit authorization;
- do not combine facade changes with unrelated document deletion;
- validate public contract, callers, exports, Fitness and build.

**Exit:** API-M04 is either deleted with complete evidence or remains explicitly governed Compatibility.

### S6-D8 Final validation and acceptance

- run 52-entry terminal-state audit;
- validate links, anchors, metadata and no Legacy production references;
- synchronize Inventory, Current, Capability, index and Plan;
- run full applicable static/build/test validation;
- obtain independent implementation/document review;
- present evidence to project owner for Slice completion acceptance.

## 13. Validation Matrix

| Area | Minimum evidence |
|---|---|
| Baseline completeness | 52/52 unique IDs and paths; API-M04 separate |
| Authority structure | one overview; topic owners follow current module boundaries; complete module coverage; no duplicate current fact authority |
| Current correctness | source + relevant Unit/Contract/Integration/Characterization evidence per topic |
| Navigation | Root README, Documentation Index and Capability Inventory link canonical overview |
| Link integrity | all active relative targets/anchors resolve; no active link to deleted authority |
| Disposition | every candidate has fact/decision/work/evidence/inbound/unique-value result |
| Historical retention | retained `*-changes.md` names evidence unavailable from Git/Results/tests |
| Deferred input | explicit non-authorizing status, Owner, freeze and future successor |
| DOC-V10 | verified Current Wizard successor; five production references removed; six diagnostics zero |
| Governance | FT-09 generic rules plus 52-entry manifest/Fitness |
| Static hygiene | document diagnostics and `git diff --check` |
| TypeScript comments/Fitness | focused tests plus `npm run lint` when TypeScript changes |
| API-M04, if authorized | zero callers/exports, Core + Adapter Contract, FT-03/08, lint/build/tests |
| Final Slice | relevant integration scenarios, architecture Fitness, `npm run lint`, `npm run build`, `npm test` |
| Review | independent review has no unresolved Critical/High/Medium blocker |

Validation is incremental. The first substantive change in each batch receives the cheapest falsifiable focused check before scope expands. A broad green suite never replaces per-entry authority and unique-value Review.

## 14. Acceptance Criteria

- **AC-DC-01 Canonical entry:** Root README, Documentation Index and Capability Inventory route current-fact readers to one overview.
- **AC-DC-02 Topic ownership:** every current fact belongs to exactly one current-boundary topic or the overview-level map/flow; topic count and IDs do not mirror Legacy candidates.
- **AC-DC-03 Authority separation:** Current, Target, ADR, Spec, Plan, Results, Historical and Deferred roles are explicit and non-competing.
- **AC-DC-04 Complete inventory:** all 52 document candidates have one manifest row and reviewed terminal disposition.
- **AC-DC-05 Evidence:** every Current topic records controlling authority, source/test evidence and verified date.
- **AC-DC-06 Runtime truth:** deleted APIs and pre-Slice-5 composition paths no longer appear as current behavior.
- **AC-DC-07 Navigation truth:** README structure, docs index and capability status reflect Slice 1–5 outcomes.
- **AC-DC-08 Link closure:** active docs and production source do not point to deleted/Legacy current authority.
- **AC-DC-09 Unique-value discipline:** no file is deleted by age; every deletion has fact/decision/work/evidence and inbound-link Review.
- **AC-DC-10 Historical discipline:** retained historical artifacts name their unique evidence and never serve as Current.
- **AC-DC-11 Deferred discipline:** retained proposals are non-authorizing and have Owner/future successor.
- **AC-DC-12 DOC-V10:** verified Wizard successor exists and all six known FT-09 diagnostics are eliminated.
- **AC-DC-13 Fitness:** automated governance locks the final 52-entry disposition and rejects Legacy production references.
- **AC-DC-14 API isolation:** Document Delivery does not alter API-M04 without separate authorization.
- **AC-DC-15 No behavior drift:** document closeout does not change runtime behavior or dependency direction.
- **AC-DC-16 Net reduction:** candidates end as unique retained roles or deletion; no second Legacy/current documentation system is created.

## 15. Rollback and Failure Policy

- before a file is deleted, its migration and link replacements are a reviewable checkpoint;
- deleted documents recover only through version-control rollback, not copied backup files;
- failed link/Fitness/current-fact validation stops that batch before additional deletion;
- an incorrectly classified historical/deferred item returns to `Migrating`, not silently to Current authority;
- accepted document changes can be reverted as a coherent batch without changing production behavior;
- API-M04 rollback is release/version rollback after removal; no hidden runtime Feature Flag or dual facade is added;
- inability to prove unique-value disposition blocks that file, not unrelated reviewed entries, but the Slice cannot reach 52/52 completion while it remains unresolved.

## 16. Definition of Ready

- [x] Plan Item and user-observable outcome are defined;
- [x] 52 document candidates and API-M04 are identified;
- [x] authority direction and deletion policy follow Accepted ADR-006;
- [x] DC-OD-01..09 planning directions are confirmed;
- [x] known FT-09 diagnostics, DOC-V10 references and API-M04 caller classes are recorded;
- [x] all 52 candidate identities, proposed outcomes and initial validation sources are recorded;
- [x] independent Spec review has no unresolved Critical/High/Medium blocker;
- [x] project owner accepts the complete Spec v0.3（2026-09-09）;
- [x] project owner separately authorizes non-deleting S6-D1 Document Delivery（2026-09-09）;
- [x] project owner separately authorizes S6-D2 Current Architecture Delivery（2026-09-09）;
- [x] project owner separately authorizes S6-D3 Active Navigation Delivery（2026-09-09）;
- [ ] project owner separately authorizes S6-D4 or later candidate-document Delivery;
- [ ] API-M04 public-contract Delivery receives separate authorization if included.

## 17. Definition of Done

- [ ] AC-DC-01..16 have evidence;
- [ ] 52/52 candidates reach reviewed terminal disposition;
- [ ] Current Architecture, active navigation and Capability Inventory are synchronized;
- [ ] DOC-V10 known diagnostics reach zero;
- [ ] API-M04 is either removed under separate authorization or remains a fully governed Compatibility entry;
- [ ] no active link treats a Legacy artifact as Current authority, no production source depends on a Legacy document for implementation behavior, and retained Historical/Deferred links are explicitly contextual with status/successor metadata;
- [ ] document diagnostics, link/anchor audit, Fitness and `git diff --check` pass;
- [ ] applicable lint, build, full tests and integration validation pass;
- [ ] independent final review has no unresolved Critical/High/Medium blocker;
- [ ] Legacy Migration Inventory and Architecture Foundation Plan record final dispositions;
- [ ] project owner accepts validation and confirms Slice 6 complete.

## 18. Planning Review History

- **2026-09-09 — Owner direction:** confirmed use of existing Current overview/topic files, dated Capability summary, concise Root README, selective historical retention, selective `docs/legacy/`, FT-09 plus 52-entry audit, DOC-V10 successor-first ordering and separate API-M04 authorization.
- **2026-09-09 — Read-only audit:** verified all 52 paths; found no path anomaly; confirmed stale Root/index/Capability authority, six FT-09 diagnostics, and remaining API-M04 production/script/test/barrel references. No files were moved or deleted and no production code was changed.
- **2026-09-09 — Independent Spec review:** no Critical finding; accepted and resolved two High findings by separating API-M04 path/alias residuals and adding explicit Subagent/Exec/Attachments ownership; accepted and resolved five Medium findings covering DOC-A06 batch order, terminal role precision, S6-D1 manifest readiness, retained Legacy links and all-six DOC-V10 diagnostics; clarified two Low observations about authority priority and the FT-09 hard-coded manifest.
- **2026-09-09 — Corrected Draft re-review:** prior High findings and four Medium findings were resolved. The remaining Medium process ambiguity was resolved by defining S6-D1 as the non-deleting first Delivery batch and making its complete manifest a hard prerequisite for S6-D2–D8 rather than a pre-acceptance DoR artifact. DOC-C08 terminology normalization remains a non-blocking S6-D1 watch item.
- **2026-09-09 — Final readiness review:** `Ready`; no unresolved Critical/High/Medium blocker or authorization ambiguity. Prior findings remain resolved.
- **2026-09-09 — Owner acceptance:** project owner accepted the complete Spec v0.3. This acceptance does not authorize Document Delivery, API-M04 Delivery, commit or push.
- **2026-09-09 — S6-D1 authorization and delivery:** project owner separately authorized only the non-deleting S6-D1. Delivery created the 52-entry disposition/inbound-link manifest, immutable FT-11 surface and Fitness checks; no candidate document or API-M04 path changed. Focused and full architecture Fitness, lint, build, diff, JSON and link validation passed; independent review found no unresolved Critical/High/Medium blocker.
- **2026-09-09 — S6-D1 completion / S6-D2 authorization:** project owner requested the S6-D1 checkpoint be committed and pushed, confirmed continuation, and separately authorized S6-D2 Current Architecture Delivery. Commit `5189a9e` was pushed to `origin/feature/refactoring`. S6-D3, API-M04 Delivery, the S6-D2 checkpoint and push remain unauthorized.
- **2026-09-09 — S6-D2 delivery and review:** rewrote the 13 Current Authority pages, advanced only DOC-C01–C13, and added FT-12 plus successor-anchor protection. Focused and full Architecture Fitness, diagnostics, lint, build, JSON, link/anchor, scope and diff validation passed. The initial independent review's High and Medium findings were corrected; re-review found no unresolved Critical/High/Medium blocker. S6-D2 remains `In Review — Awaiting Owner Acceptance`.
- **2026-09-09 — S6-D2 structure amendment:** project owner required the refactored documentation structure to follow the new architecture rather than accommodate old documents, then approved one overview plus 14 current-boundary topics. The amendment adds Model Resolution and Media owners, generalizes FT-12 from fixed DOC-C count/sequence to semantic ownership and module coverage, and removes migration-process narration from Current Authority.
- **2026-09-09 — S6-D2 v0.4 validation and review:** completed the 15-page Current surface and dynamic module-coverage Fitness. Corrected review findings in Model Resolution, Media, Tool conversion, Runtime approval, Runner events/Abort ordering, Prompt evidence, and Channel correlation/async delivery. Focused/full Architecture Fitness, diagnostics, lint, build, JSON, links/anchors, candidate/API isolation and diff checks passed; final independent acceptance check found no unresolved Critical/High/Medium blocker.
- **2026-09-09 — S6-D2 v0.4 owner acceptance:** project owner accepted the current-boundary documentation structure and S6-D2 validation evidence. S6-D2 is complete. This acceptance does not authorize commit, push, S6-D3 or API-M04 Delivery.
- **2026-09-09 — S6-D2 checkpoint / S6-D3 authorization:** project owner separately authorized committing and pushing the accepted S6-D2 checkpoint, then starting S6-D3 Active Navigation. API-M04 Delivery remains unauthorized.
- **2026-09-09 — S6-D3 delivery and review:** rewrote Root README, Documentation Index and Capability Summary around canonical Current Architecture and authority roles; advanced only DOC-A08/A09; added S6-D3 state-boundary and active-navigation Fitness. Focused/full Architecture Fitness, diagnostics, lint, build, JSON, links, scope and diff checks passed. The independent review's Medium link-parser finding was corrected by reusing the canonical FT-11 reference audit; final re-review found no unresolved Critical/High/Medium blocker. S6-D3 remains `In Review — Awaiting Owner Acceptance`.
- **2026-09-09 — S6-D3 owner acceptance:** project owner accepted the active-navigation structure and S6-D3 validation evidence. S6-D3 is complete. This acceptance does not authorize commit, push, S6-D4 or API-M04 Delivery.
- **2026-09-09 — Remaining delivery authorization:** project owner separately authorized the S6-D3 checkpoint commit/push, sequential S6-D4–D8 Delivery, and API-M04 Delivery. Each batch still requires its own validation, independent review and owner acceptance before its checkpoint; authorization does not permit combining unrelated document and API changes in one checkpoint.
- **Next:** create and push the S6-D3 checkpoint, then begin S6-D4 Root Candidate Extraction. Process S6-D5–D8 and API-M04 only in their planned sequence and isolated scopes.
