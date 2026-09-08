# Legacy Migration Inventory

## 状态

- **状态：** Accepted
- **版本：** 0.1
- **日期：** 2026-09-04
- **所有者：** 项目所有者
- **关联计划 / ADR：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) Foundation Gate、[ADR-003](adr-003-progressive-architecture-migration.md)、[ADR-006](adr-006-legacy-and-compatibility-exit.md)
- **权威输入：** [Development Workflow](../development-workflow.md)、[Target Architecture](target-architecture.md)、[Domain Glossary](domain-glossary.md)

本 Inventory 遵循 [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)。项目所有者于 2026-09-04 接受本 Inventory 的范围、分类、Owner、目标 Slice、退出条件和验证责任；该次 Inventory 接受本身不授权 production 修改、批量移动或删除文档、Compatibility 实施或 Architecture Slice Delivery。项目所有者随后另行批准 Slice 1 进入 Delivery。

## 1. 目的与接受边界

本 Inventory 是 Foundation Gate 的独立工件，用于回答：哪些 artifact/path 仍是 active authority，哪些已经成为 migration candidate，分别迁移到哪里、由谁负责、何时 Review、满足什么条件后才能退出。

`Legacy` 由 authority/status 判断，不按文件年龄或目录自动判定。`Accepted` ADR、仍生效的 Spec、具有长期价值的 Results 和 active Plan 不因较旧而进入删除队列。

本 Inventory 被项目所有者接受只表示清单范围、分类、Owner、目标 Slice/Review date、删除条件和验证责任足以约束后续工作；不表示其中任何迁移或删除已经发生。

## 2. 盘点范围与方法

### 2.1 范围

基线盘点覆盖：

- `docs/architecture/**`、根 [README](../../README.md)、[Capability Inventory](../agent-capabilities.md) 和 [Documentation Index](../README.md)；
- `src/**` 中将被 Target Architecture 替代的 production path、public/internal API、Config 和 composition path；
- `scripts/**`、`clients/**` 与 production source 内可检索的 repository caller；
- architecture migration Feature Flag。

不覆盖 repository 外部消费者、未检出的私有下游 fork 或尚未引入的未来路径。对已导出的 API，删除前必须另行完成 external consumer/deprecation decision；“repository 内未发现 caller”不等于不存在外部 caller。

### 2.2 分类

| 状态 | 含义 |
|---|---|
| `Retained Authority` | 当前仍有效或具有长期历史权威；不进入删除流程 |
| `Active Candidate` | 当前仍在使用，但已由 Accepted Target/ADR 指定后继；等待对应 Slice 迁移 |
| `Document Candidate` | 含 Current Fact、decision、work 或 evidence，需要先分责迁移再 Review |
| `Compatibility Candidate` | 迁移时可能短期保留的 public/config boundary；必须单向、具名且到期 |
| `No Entry at Baseline` | 已审计的类别当前不存在；每个 Slice 开始时重新确认 |

文档退出状态采用 ADR-006 定义的 `Pending -> Migrating -> Migrated -> Reviewed -> Deleted`。本 Inventory 中所有 migration candidate 初始均为 `Pending`。

### 2.3 共同 Owner 与退出规则

除表中另有说明：

- **当前 Owner：** 项目所有者；进入 Slice 后转交对应 Slice Owner；
- **文档目标 Review：** Slice 6；
- **文档删除条件：** Current Fact 进入唯一 Current Architecture、长期 decision 进入 ADR、unfinished work 进入 Plan、execution evidence 进入 Results/test mapping；active inbound links 已替换；unique-value disposition 已 Review；
- **文档验证：** 源码/测试事实审计、FT-09、local link audit、文档 diagnostics、`git diff --check`；
- **production 删除条件：** 真实 caller 已迁移，新 Contract/行为验证通过，新代码不依赖 Compatibility/Legacy，旧路径已删除或降级为具有 Owner、caller、期限、测试和删除条件的 Compatibility；
- **production 验证：** 对应 Module Spec 的 Unit/Contract/Integration/Regression、Architecture Fitness、lint 和 build。
- **Compatibility rollback：** API-M01–M04 与 CODE-M09 默认只通过完整版本/发布回滚；基线不存在 architecture migration Feature Flag。若后续需要 Flag，使用前必须补齐 FLAG-001 的 Owner、默认值、观测信号、trigger、完整旧/新 path、目标删除 Slice 和 tests。

## 3. 明确保留的 Authority

下列工件不属于 Legacy migration candidate：

| 范围 | 当前 authority / disposition |
|---|---|
| [Development Workflow](../development-workflow.md)、[Architecture Principles](architecture-principles.md)、[Domain Glossary](domain-glossary.md)、[Target Architecture](target-architecture.md)、[Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) | `Accepted` governance、target 和 active plan；长期保留，只有正式 supersession 才改变 authority |
| [ADR-001](adr-001-tool-result-closure-and-recovery.md)、[ADR-002](adr-002-context-budgeting-and-compaction-recovery.md)、[ADR-003](adr-003-progressive-architecture-migration.md)、[ADR-004](adr-004-provider-model-identity-and-facts-ownership.md)、[ADR-005](adr-005-extension-registry-runtime-composition.md)、[ADR-006](adr-006-legacy-and-compatibility-exit.md) | `Accepted` decisions；长期保留，按 ADR status 管理 |
| [AF-05 Spec](af-05-provider-model-resolution-spike-spec.md)、[AF-05 Results](af-05-provider-model-resolution-spike-results.md)、[AF-06 Spec](af-06-extension-framework-spike-spec.md)、[AF-06 Results](af-06-extension-framework-spike-results.md)、[AF-07 Spec](af-07-architecture-decision-spec.md) | 已完成 Foundation evidence/acceptance record；保留历史权威，不因 disposable fixture 删除而删除 Results |
| [Documentation Index](../README.md) | active index；持续同步，不作为删除对象 |
| [Coding Standards](coding-standards.md) | active implementation convention；只由独立 governance change 修改 |

现有行为 Specs 在其行为被新的 Accepted Spec/实现替代前继续生效，包括 [Core Abort Spec](core-abort-spec.md)、[Multi-client User Message Spec](channel-multi-client-user-message-spec.md)、[Approval Lifecycle Spec](approval-lifecycle-spec.md)、[Attachments Support Spec](attachments-support-spec.md)、[Core Runner Turn Flow Spec](core-runner-turn-flow-spec.md) 和 [Platform Config Restructure Spec](platform-config-restructure-spec.md)。它们当前为 `Retained Authority`；[Core Subagent Spec](core-subagent-spec.md) 仅对未被 Slice 2 Spec 替代的 behavior/history 保留 authority。Slice 6 继续完成 supersession/link review，不因文件年龄删除。

## 4. Current Fact Candidate 文档

以下 13 份文件均是 Target Architecture 已识别的 `Current Fact Candidate`。每份文件因事实范围和 inbound links 不同而单独记录；它们在唯一 Current Architecture 建立前继续提供候选事实，但不得覆盖 Accepted Target/ADR。

| ID | Artifact / unique-value disposition | Inbound / successor | Owner / target / deletion and validation |
|---|---|---|---|
| DOC-C01 | [Current Overview](current/overview.md)：模块地图和 Turn flow 候选；只迁移经源码/测试确认的事实 | [Capability Inventory](../agent-capabilities.md)；后继为唯一 Current Architecture overview | 项目所有者 → Slice 6 Owner / Slice 6；模块与 flow audit、links 替换后 Review |
| DOC-C02 | [Current Runtime](current/runtime.md)：queue、routing、Fanout、Abort、lifecycle 候选 | Capability Inventory、Core Subagent Spec；后继为 Current Runtime section | 项目所有者 → Slice 6 Owner / Slice 6；CH-01/02/05–10/12 与 runtime source/tests 核验 |
| DOC-C03 | [Current Runner](current/core_runner.md)：execution loop、Tool Use、context、Event 候选 | Capability Inventory、Core Subagent Spec；后继为 Current Runner section | 项目所有者 → Slice 6 Owner / Slice 6；CH-02–04/11/13 与 Runner tests 核验 |
| DOC-C04 | [Current Channel](current/adapter_channel.md)：transport、routing、Interaction 候选 | Capability Inventory；后继为 Current Channel section | 项目所有者 → Slice 6 Owner / Slice 6；Channel/Runtime characterization 和 source/tests 核验 |
| DOC-C05 | [Current Config](current/platform_config.md)：配置来源与合并候选；混合 Model Facts 不作为 target authority | Capability Inventory、Config Spec；后继为 Current Configuration section | 项目所有者 → Slice 6 Owner / Slice 6；loader/schema/tests 核验 |
| DOC-C06 | [Current LLM Adapter](current/adapter_llm.md)：protocol mapping 候选；raw overflow 描述以代码/AF-04 为 current fact | Capability Inventory；后继为 Current Provider Adapter section | 项目所有者 → Slice 6 Owner / Slice 6；adapter source/tests 与 ADR-002 authority audit |
| DOC-C07 | [Current Tools](current/core_tools.md)：Tool Contract 与 execution 候选 | Capability Inventory、Core Subagent Spec；后继为 Current Tool section | 项目所有者 → Slice 6 Owner / Slice 6；CH-03/04/14 与 Tool tests 核验 |
| DOC-C08 | [Current Builtin Tools](current/core_tools_builtin.md)：builtin inventory 候选，不决定 target Module structure | Capability Inventory；后继为 Current Capability Inventory | 项目所有者 → Slice 6 Owner / Slice 6；production registration 与 tests 核验 |
| DOC-C09 | [Current Session](current/core_session.md)：JSONL、Session/Transcript、persistence 候选 | Capability Inventory、Core Subagent Spec；后继为 Current Session section | 项目所有者 → Slice 6 Owner / Slice 6；CH-03/11 与 Session tests 核验 |
| DOC-C10 | [Current Prompt](current/core_prompt.md)：prompt/context hook 候选 | Capability Inventory、Core Subagent Spec；后继为 Current Prompt section | 项目所有者 → Slice 6 Owner / Slice 6；CH-14 与 prompt tests 核验 |
| DOC-C11 | [Current Memory](current/core_memory.md)：Memory Port/Store 和 optional degradation 候选 | Capability Inventory、Core Subagent Spec；后继为 Current Memory section | 项目所有者 → Slice 6 Owner / Slice 6；Memory tests 与 resource behavior 核验 |
| DOC-C12 | [Current Workspace](current/core_workspace.md)：workspace initialization/loading 候选 | Capability Inventory；后继为 Current Workspace section | 项目所有者 → Slice 6 Owner / Slice 6；workspace source/tests 核验 |
| DOC-C13 | [Current Logger](current/platform_logger.md)：Logger、startup buffering、shutdown 候选 | Capability Inventory；后继为 Current Observability section | 项目所有者 → Slice 6 Owner / Slice 6；Logger tests、resource ownership 与 FT-01 核验 |

## 5. 其他文档 migration candidates

### 5.1 根 architecture 文档

| ID | Artifact / current status | Successor and unique-value disposition | Inbound / Owner / target / validation |
|---|---|---|---|
| DOC-A01 | [Platform Config Restructure Implementation](platform-config-restructure-impl.md)：无 Accepted/Validated 状态的 implementation record | verified facts → Current Architecture；durable decisions → ADR；unfinished work → Plan；其余 narration 经 Review 舍弃 | Capability Inventory；项目所有者 → Slice 6 Owner / Slice 6；config source/tests + links |
| DOC-A02 | [Channel Design](adapters-channel-design.md)：`设计中，待确认` | verified transport/current facts → Current Channel；target decision 以 Target/未来 Channel Spec 为准 | WebSocket design、current Runtime/Runner；Slice 6；Channel source/tests + links |
| DOC-A03 | [WebSocket Channel Design](adapters-websocket-channel-design.md)：`设计中，待确认` | verified protocol/current facts → Current Channel；未接受建议进入 Plan 或舍弃 | Channel design；Slice 6；WebSocket source/tests + links |
| DOC-A04 | [Subagent Evolution Proposal](core-subagent-evolution-proposal.md)：未批准 Proposal | 仍获批准的 future work → Plan；其余冻结/删除，不得解除 Foundation freeze | Capability/Subagent docs；Slice 6；Owner disposition + links |
| DOC-A05 | [Subagent v2 Spec](core-subagent-v2-spec.md)：future concurrency design，与当前 freeze 并存 | 保留为 deferred historical input，或由后续 Accepted Spec supersede；不按年龄直接删除 | Capability/Subagent docs；项目所有者 / Slice 6 Review；authority/link audit |
| DOC-A06 | [Runner Emit Context Refactor](core-runner-emit-context-refactor.md)：明确未实施 proposal | unfinished work → Plan 或明确舍弃；不得作为 Current Fact | source test comment；Slice 6；source/test + inbound-link audit |
| DOC-A07 | [Exec Flow Design](core-tools-builtin-exec-flow-design.md)：混合 current behavior 与 design suggestion，且含 stale validation links | verified facts → Current Exec section；future work → Plan；其余 Review | active Tool docs/index；Slice 6；exec/process source/tests + links |
| DOC-A08 | [Root README](../../README.md) Project Structure section：active product doc 中的 outdated section，文件本身不是 Legacy | section 更新为唯一 Current Architecture link；README 保留 | product entry；Slice 6；tree/source audit + links |
| DOC-A09 | [Capability Inventory](../agent-capabilities.md)：active snapshot，文件本身不是 Legacy | 更新验证日期并把 stale `current/` links 指向唯一 Current Architecture；文件保留 | docs index；Slice 6；capability/source/test audit + links |

以下 design baseline 和 implementation record 在当前 docs index 中仍可作为导航/历史输入，但不是唯一 Current Architecture。每个 entry 当前为 `Document Candidate`、Owner 为项目所有者（进入 Slice 6 后转交 Slice 6 Owner）、target Review 为 Slice 6；删除均须满足 §2.3 的事实/决策/工作/evidence 分责、inbound-link replacement 和逐文件 Review。

| ID | Artifact / current authority | Successor / unique-value disposition | Inbound links / specific validation |
|---|---|---|---|
| DOC-A10 | [Runtime Design](runtime-design.md)：无 Accepted status 的 unversioned design baseline | verified queue/routing/lifecycle facts → Current Runtime；durable target decisions → Accepted Runtime/Composition Specs；其余建议 Review | Root README、docs index、v1.0 Runtime/Channel docs；Runtime source、CH-01/02/05–10/12 和 links |
| DOC-A11 | [Core Runner Design](core-runner-design.md)：无 Accepted status 的 unversioned design baseline | verified execution-loop facts → Current Runner；Tool closure/Compaction decision 分别服从 ADR-001/002 | Root README、docs index、Runtime/Context/Subagent/v1.0 Runner docs；Runner tests、CH-02–04/11/13 和 links |
| DOC-A12 | [Core Runner Context Design](core-runner-context-design.md)：current Compaction design baseline，仍受 ADR-002 约束 | verified current budgeting/Compaction facts → Current Runner；target decisions → ADR-002/Accepted Runner Spec | ADR-002、docs index、Runner/v1.0 docs；Compaction/context tests、CH-04/11 和 links |
| DOC-A13 | [Core Runner Hooks Design](core-runner-hooks-design.md)：声明部分 hooks 已实现的 mixed baseline | verified current Hook facts → Current Runner；target Tool/Hook contract → Slice 3 Spec；detached observer assumption 服从 ADR-002 | Capability Inventory、v1.0 Runner/Channel/Runtime docs；Hook/Runner tests、CH-04/06 和 links |
| DOC-A14 | [Platform Config Design](platform-config-design.md)：无 Accepted status 的 unversioned design | verified load/source facts → Current Configuration；Model fields ownership → ADR-004/Model Resolution Spec | Runtime Design、v1.0 Config/Runner docs、Root docs index；loader/defaults/wizard tests 和 links |
| DOC-A15 | [Platform Logger Design](platform-logger-design.md)：`设计中，待确认` | verified logger facts → Current Observability；未接受 target suggestions → future Spec 或舍弃 | v1.0 Config Wizard/Runtime docs；logger source/tests、FT-01 和 links |
| DOC-A16 | [Logging Design](logging-design.md)：`草案 · 待审阅` | 与 DOC-A15 合并 verified facts 到 Current Observability；冲突建议不保留双 authority | self-reference and repository link audit；logger source/tests、Owner conflict disposition |
| DOC-A17 | [LLM Adapter Design](adapters-llm-design.md)：无 Accepted status 的 LLM Client baseline | verified protocol/event facts → Current Provider Adapter；target Port/Facts → Model Resolution Spec/ADR-004 | Root README、docs index、v1.0 Runner；Anthropic adapter tests、FT-03/08 和 links |
| DOC-A18 | [Core Prompt Design](core-prompt-design.md)：无 Accepted status 的 design baseline | verified prompt behavior → Current Prompt；future Module decision → Accepted Prompt Spec | Root README、docs index、Workspace design；prompt tests、CH-14 和 links |
| DOC-A19 | [Core Session Design](core-session-design.md)：无 Accepted status 的 design baseline | verified JSONL/persistence facts → Current Session；target transaction decisions → Accepted Session Spec | Root README、docs index、Compaction design；Session tests、CH-03/11 和 links |
| DOC-A20 | [Core Memory Design](core-memory-design.md)：无 Accepted status 的 design baseline | verified optional/degraded behavior → Current Memory；future work → Plan/Accepted Memory Spec | Runtime Design、docs index；Memory tests/resource audit 和 links |
| DOC-A21 | [Core Tools Design](core-tools-design.md)：声明当前 Tool implementation 的 mixed baseline | verified Tool contract/execution facts → Current Tools；target Registry/Hook decisions → Slice 3 Spec | Root README、docs index、Builtin/Subagent v2 docs；Tool tests、CH-03/04/14 和 links |
| DOC-A22 | [Builtin Tools Design](core-tools-builtin-design.md)：声明 builtin 已实现的 mixed baseline | verified builtin inventory → Current Capability Inventory；future memory Tool work → Plan | docs index、Tools/FS docs；production registration、builtin tests 和 links |
| DOC-A23 | [Workspace Design](core-workspace-design.md)：无 Accepted status 的 design baseline | verified initialization/loading facts → Current Workspace；future decisions → Accepted Workspace Spec | Root README、docs index、Prompt design；Workspace tests 和 links |
| DOC-A24 | [Exec Runtime Design](core-tools-builtin-exec-runtime-design.md)：声明 v2.1 implemented baseline | verified platform runtime facts → Current Exec section；仍未完成建议 → Plan 或舍弃 | docs index、Builtin Tools design；exec/process unit/integration/platform tests 和 links |
| DOC-A25 | [Attachments Server Implementation](attachments-server-implementation.md)：implementation record，无独立 Accepted status | durable contract 由 Attachments Support Spec 保留；verified server facts → Current Media/Channel；过程 narration Review | Capability Inventory、Client Implementation；attachment pipeline/Runtime/WebSocket tests 和 links |
| DOC-A26 | [Attachments Client Implementation](attachments-client-implementation.md)：implementation record，无独立 Accepted status | durable contract 由 Attachments Support Spec 保留；verified client facts → Current Client/Channel；过程 narration Review | Capability Inventory、Server Implementation；chat client/manual protocol evidence 和 links |
| DOC-A27 | [Core Subagent Implementation](core-subagent-impl.md)：implementation record，状态同步但非 Accepted Spec | durable contract → Core Subagent Spec；verified facts → Current Subagent；migration work → Slice 2 | Capability Inventory、Subagent Proposal/v2 docs；Subagent unit/e2e、Abort/Usage/Event tests 和 links |

### 5.2 `v1.0` 文档

`docs/architecture/v1.0/` 是历史版本目录，但目录名不自动决定删除。以下文件分别进入 `Pending` Review：

| ID | Artifact / disposition target | Unique value / inbound and validation |
|---|---|---|
| DOC-V01 | [Channel Changes](v1.0/adapters-channel-changes.md) → Current Channel / historical Results | 保留已实现 delta evidence；Channel source/tests 与 links 核验 |
| DOC-V02 | [Channel Design](v1.0/adapters-channel-design.md) → Current Channel / Accepted Channel Spec | 迁移 verified contract；与 root Channel design 分别 Review |
| DOC-V03 | [Runner Changes](v1.0/core-runner-changes.md) → Current Runner / historical Results | 保留已实现 delta evidence；Runner tests 核验 |
| DOC-V04 | [Runner Design](v1.0/core-runner-design.md) → Current Runner / Accepted Runner Specs | 迁移 verified execution facts；ADR-001/002 优先 |
| DOC-V05 | [Runner Message Flow](v1.0/core-runner-message-flow.md) → Current Runtime/Runner | 迁移 verified in-turn flow；Runtime intake/steering tests 核验 |
| DOC-V06 | [FS Changes](v1.0/core-tools-fs-changes.md) → Current Tools / historical Results | 保留已实现 delta evidence；filesystem Tool tests 核验 |
| DOC-V07 | [FS Design](v1.0/core-tools-fs-design.md) → Current Tools / Accepted Tool Spec | 迁移 verified workspace-path contract；source/tests 核验 |
| DOC-V08 | [Config Changes](v1.0/platform-config-changes.md) → Current Configuration / historical Results | 保留已实现 delta evidence；loader/defaults tests 核验 |
| DOC-V09 | [Config Design](v1.0/platform-config-design.md) → Current Configuration / Accepted Config Spec | 迁移 verified source/precedence facts；Model Facts 服从 ADR-004 |
| DOC-V10 | [Config Wizard Design](v1.0/platform-config-wizard-design.md) → verified Current Config Wizard section | 已确认 Legacy entry；production comments 是 inbound links，successor 建立并替换 links 后才能删除 |
| DOC-V11 | [Runtime Changes](v1.0/runtime-changes.md) → Current Runtime / historical Results | 保留已实现 queue/routing delta evidence；Runtime tests 核验 |
| DOC-V12 | [Runtime Design](v1.0/runtime-design.md) → Current Runtime / Accepted Runtime Specs | 迁移 verified runtime facts；Target/ADR 优先 |

DOC-V01–V12 的 Owner 为项目所有者至 Slice 6 Owner 接手，target Review 为 Slice 6；验证和删除适用 §2.3。`*-changes.md` 若仍承担无法由 Git history/Results 替代的 execution evidence，可在 Review 后保留为 Historical Authority，而不是强制删除。

## 6. Production、API、Config 与 Compatibility inventory

| ID | Artifact / category / current authority | Target、callers 与 unique disposition | Owner / target / deletion conditions / validation |
|---|---|---|---|
| CODE-M01 | `LLMConfig`、`AgentDefaults.llm`：[config types](../../src/platform/config/types.ts)；Active Config API，混合 Connection/Reference/Policy/Facts | 单向映射为 Provider Connection、Model Reference、policy/default request limit 和 provider-interpreted legacy context override；callers：loader、wizard、bootstrap、RuntimeApp、Subagent host | Slice 1 Owner；Parent fields Slice 1，`llmDefaults` Slice 2；删除混合 semantic ownership；schema/loader/migration tests |
| CODE-M02 | `DEFAULT_AGENT_CONFIG.llm` 的 `model`、`maxTokens=4096`、`contextWindowTokens=200000`：[defaults](../../src/platform/config/defaults.ts)；Active defaults，不是 target Model Facts | `model` → default Model Reference；`maxTokens` → policy/default request limit；context value 只能成为带 provenance 的 legacy deployment override 或 Provider-owned fallback | Slice 1；删除 Core/global Model Fact 含义；Facts provenance/precedence 与 equivalence tests |
| CODE-M03 | Config precedence/env mapping：[loader](../../src/platform/config/loader.ts)；Active input behavior | 保留 defaults/file/agent/env/CLI input precedence，但 merged Config 不再等于 Resolved Model；callers：bootstrap、config integration | Slice 1；loader 保留，LLM output 降级为 Compatibility input；loader tests |
| CODE-M04 | `createDefaultRuntimeDependencies().createLLMClient()` 和 direct `new AnthropicClient()`：[bootstrap](../../src/runtime/bootstrap.ts)；Active Composition path | bundled Anthropic Provider Module + startup Provider projection + Resolver；caller：`bootstrapRuntime()` | Slice 1；真实 Parent caller 迁移后删除 direct import/construction；Provider Contract/Integration + FT-02/06 |
| CODE-M05 | startup `llmClient` 和 `RuntimeResourceSet.llmClient`：[runtime types](../../src/runtime/types.ts)；Active singleton slot | Provider binding/projection 和 per-Turn Resolved Model Port binding | Slice 1；删除 authoritative client slot；startup/resource ownership/integration tests |
| CODE-M06 | `RuntimeApp.requireModel()` 与 `runTurnInternal()` static fact assembly：[RuntimeApp](../../src/runtime/RuntimeApp.ts)；Active Parent path | `runTurnInternal()` 调 Resolver并传 immutable Resolved Model；覆盖 direct 与 queued callers | Slice 1；删除 `requireModel()` 和 execution 对 `resolvedConfig.llm` 的 facts 读取；CH-13 replacement + integration |
| API-M01 | `RunTurnParams.model/maxTokens`、queue projection：[runtime types](../../src/runtime/types.ts)、[queue types](../../src/runtime/queue-types.ts)；public/runtime Compatibility Candidate | mapping：`model` → Model Reference，`maxTokens` → allowlisted Request Override，queued input 到 start transition 才 resolve。Repository consumers/export surfaces：`runtime/index.ts`、`RuntimeApp.runTurn()`/`runTurnInternal()`、`queue-types.ts`、`prompt-factory.ts`；direct scripts `test-abort-e2e.ts`、`test-abort-live.ts`、`test-runtime-multichannel-integration.ts`、`test-runtime-shutdown-integration.ts`、`test-runtime-wiring-integration.ts`、`test-subagent-e2e.ts`、`test-subagent-live.ts`；`RuntimeApp.test.ts` | Slice 1 Owner；Slice 2 Review 确认 Parent public input successor 不在 Slice 2 范围，延期到 Slice 5 Runtime Composition Review；禁止新增 production caller。删除需 repository callers 迁移、external consumer notice/decision 和 contract/intake/queue tests |
| API-M02 | WebSocket `run_turn.model/maxTokens`：[WebSocketChannel](../../src/adapters/channel/WebSocketChannel.ts)；public wire Compatibility Candidate | mapping 同 API-M01。Repository protocol producers：[HTML client](../../clients/html/chat.html)、`scripts/test-runtime-attachments-integration.ts`、`scripts/test-runtime-multichannel-integration.ts`（当前均不发送这两个 optional fields）；validation consumers：`WebSocketChannel.test.ts`、Runtime intake/queue tests；repository 外 protocol clients 未知 | Slice 1 Owner；至少保留到 Slice 4 Review，除非另行接受 protocol breaking change；删除需 protocol version/deprecation decision、external client notice 和 WebSocket→Runtime queued integration |
| API-M03 | former `AgentRunnerConfig.llmClient`、`RunParams.model/maxTokens/contextWindowTokens`：[Runner types](../../src/core/runner/types.ts)；`Migrated` in Slice 1 | Runner Contract 只消费 `ResolvedModel`/core-owned Port；Parent 与 temporary Child Compatibility 均已迁移到该 Contract | Slice 1 validation、Runner Contract/build/FT-03/08 已通过；不再作为 Slice 2 Compatibility entry |
| CODE-M07 | Runner-owned `4096`/`200000` fallback：[AgentRunner](../../src/core/runner/AgentRunner.ts)；Legacy Model Fact ownership | facts/request limit 只来自 Resolved Model/Policy | Slice 1；删除 Runner model defaults；Resolver/Runner/budgeting regression |
| API-M04 | deprecated `LLMClient`、`ChatParams`、`StreamEvent` adapter facade：[LLM types](../../src/adapters/llm/types.ts)；Compatibility Candidate，authority 已迁入 Stable Core | Stable Core 拥有 Invocation Port/normalized contract；Anthropic Adapter implements。Repository production callers 已迁移；adapter facade 仅为可能的 external consumers 保留 | Slice 2 Review 确认该 facade 与 Child migration 无关；因 external consumer decision/legacy barrel closeout 未完成，延期到 Slice 6 Review；禁止新增 production caller。删除需 external consumer decision、zero internal caller、adapter Contract、FT-03/08 和 build |
| CODE-M08 | Runner raw Provider error string parsing：[AgentRunner](../../src/core/runner/AgentRunner.ts)、[runner errors](../../src/core/runner/errors.ts)；Active Legacy responsibility | Provider Adapter 归一化 overflow/canonical errors；Runner 只消费 core-owned errors | Slice 1，受 ADR-002 约束；删除 raw-string classification；overflow/compaction/error regressions |
| CODE-M09 | Former Subagent `llmDefaults`、optional/raw-string `model`、legacy Child resolver/host/request、parentless library trigger；`Migrated` in Slice 2 | Required native Profile Model Selection + Parent effective Model Reference + Runtime-owned delegation Port + independent Child resolution are the only production path | Old resolver/Runner/API/trigger/synthetic-session contracts and scenarios deleted；native Profile、real Parent、different Provider/Model、typed failure/Usage/Abort/Event/Session/cleanup、FT-04/08 and deterministic zero-reference validation passed |
| CODE-E01 | Former central Tool bundle/list/executor setter/Task post-assembly；`Migrated` in Slice 3 | One startup `RegistrySnapshot` with canonical Tool projection and Builtin Modules | Central list/bundle/executor factory/setter deleted；Task staged before publication；Tool/Registry/Runtime tests + FT-07 |
| CODE-E02 | Former `AgentRunner.on()` production API and startup approval Hook wiring；`Migrated` in Slice 3 | Immutable Hook Contribution/projection plus explicit Policy/current-call Approval Capability | Production mutable registration/startup authorization history deleted；Hook/approval/Runner contracts + FT-07 |
| API-E01 | `registerChannel/startChannels/stopChannels` 和 concrete script construction：[RuntimeApp](../../src/runtime/RuntimeApp.ts)、[CLI](../../scripts/cli.ts)、[server](../../scripts/server.ts)、[websocket](../../scripts/websocket.ts)；Active public composition API | Builtin Channel Modules 和 Builder-created bindings | Slice 4；scripts 不再 concrete register；Channel lifecycle/CH-07/08 |
| CODE-E03 | `RuntimeApp.create()` post-bootstrap composition 与 mutable resources：[RuntimeApp](../../src/runtime/RuntimeApp.ts)；Active mixed responsibility | Runtime Builder + immutable explicit dependencies | Slice 5；删除 discovery/mutation/duplicate ownership；startup/rollback/shutdown + FT-01/05/07 |

### 6.1 Feature Flag 基线

| ID | 当前状态 | 复查与退出规则 |
|---|---|---|
| FLAG-001 | `No Entry at Baseline`：在 `src/**`、`scripts/**`、`clients/**` 未发现用于 architecture old/new path 路由的 migration Feature Flag；`subagents.enabled` 和 Tool helper `enabled` 是产品配置，不是迁移双路径开关 | 每个 Slice 开始时重新审计。若新增，必须先登记 Owner、默认值、观测信号、rollback trigger、目标删除 Slice、caller、tests；不得在一个 Turn 混合新旧事实 |

### 6.2 Slice 1 Delivery disposition（2026-09-04）

| Entry | Delivery disposition | Evidence / remaining exit |
|---|---|---|
| CODE-M01–M03 | Parent semantics `Migrated`；Config input Compatibility active | legacy fields 只经单向 Parent mapping 进入 Resolver；不再拥有 Resolved Model/Facts。`llmDefaults`/Child 部分移交 Slice 2；loader precedence 保留 |
| CODE-M04 | `Migrated` | `createLLMClient()` 和 bootstrap direct `AnthropicClient` construction 已删除；bundled Provider entry + readonly projection 成为 Composition path |
| CODE-M05 | `Migrated` | startup/resource `llmClient` authoritative slot 已删除；resource set 只持 Provider projection、Resolver 和 Parent resolver mapping |
| CODE-M06 | `Migrated` | `RuntimeApp.requireModel()` 与 static fact assembly 已删除；direct/queued Parent caller 在 `runTurnInternal()` 使用同一 Resolver |
| API-M01 | `Compatibility Candidate`，保留 | public/runtime `model`、`maxTokens` 继续单向映射；Owner/到期仍为 Slice 2 Review |
| API-M02 | `Compatibility Candidate`，保留 | WebSocket optional fields 保持 wire compatibility；Owner/到期仍为 Slice 4 Review |
| API-M03 | `Migrated` | Runner legacy client/raw fact input 已删除；`AgentRunnerConfig` 不持 client，`RunParams` 只接收 `ResolvedModel` |
| CODE-M07 | `Migrated` | Runner-owned model/context/output facts defaults 已删除；执行限制来自 `ResolvedModel` |
| API-M04 | Authority `Migrated`；deprecated facade 保留 | authoritative Port/error/event contracts 已迁入 Stable Core；adapter `types.ts` 仅 deprecated re-export，Slice 2 Review 前禁止新增 caller |
| CODE-M08 | `Migrated` | Provider Adapter 归一化 overflow 和其他 Provider errors；Runner 不再解析 raw Provider error string |
| CODE-M09 | `Compatibility Candidate`，active | 具名 one-way Child adapter 只映射 inputs 并调用同一 Resolver，不生成 Facts/binding；Owner 已移交 Slice 2，届时删除 |

Slice 1 起始计数为 13 个受影响 entries（CODE-M01–M09、API-M01–M04）；Delivery 后 6 个 entry 完成迁移，7 个 partial/Compatibility entry 仍具有明确 Owner 与期限，因此 `Legacy_end = 7 < Legacy_start = 13`。未引入 architecture migration Feature Flag。验证证据为相关 Unit/Contract/Integration/Fitness、standalone Compaction 9/9、reload 5/5、`npm run lint`、`npm test`（75 files、708 tests）和 `npm run build` 全部通过；独立 implementation review 结论为 `Ready`，无 Critical/High/Medium blocker。

### 6.3 Slice 2 Delivery disposition（2026-09-04）

| Entry | Delivery disposition | Evidence / remaining exit |
|---|---|---|
| CODE-M09 | `Migrated` | Parentless API、synthetic session semantics、legacy Child resolver、concrete Runner Tool dependency、old host/request exports and raw Profile model path deleted；Runtime-owned real-Parent delegation and native inherited/concrete Child resolution are authoritative |

Slice 2 frozen scope contained one Legacy entry, CODE-M09. Delivery therefore reached $Legacy_{end}=0<Legacy_{start}=1$. Validation passed for focused Unit/Contract/Runtime integration, FT-01/03/04/08/09, deterministic deleted-contract audit, `npm run lint`, full Vitest (76 files, 675 tests), `npm run build`, and `git diff --check`. One unrelated background-process test timed out once and passed both in isolation and on the final full-suite rerun. Independent implementation review found no remaining Critical/High/Medium implementation blocker after the documented inventory disposition was corrected. No migration Feature Flag or second Child authority was introduced. 项目所有者于 2026-09-04 接受验证结果并确认 Slice 2 完成。

### 6.4 Slice 3 Delivery disposition（2026-09-08）

| Entry | Delivery disposition | Evidence / remaining exit |
|---|---|---|
| CODE-E01 | `Migrated` | One Task-inclusive startup `RegistrySnapshot`、canonical Tool execution/Schema/provider conversion、central list/bundle/executor factory/setter and post-assembly deletion；Registry/Runtime/Provider contracts + FT-07 |
| CODE-E02 | `Migrated` | Immutable Hook Contributions/projections、bounded observers、explicit Policy/current-call Approval Capability；production mutable registration and startup authorization history deleted |

Slice 3 frozen scope contained CODE-E01 and CODE-E02 and reached $Legacy_{end}=0<Legacy_{start}=2$. `npm run lint`、full Vitest (80 files, 705 tests)、`npm run build`、FT-09 document governance and `git diff --check` passed. Independent implementation review found no remaining Critical/High/Medium blocker. No migration Feature Flag、second executor、Task post-assembly or startup approval Hook remains. 项目所有者于 2026-09-08 接受验证结果并确认 Slice 3 完成；已授权 Slice 3 checkpoint commit，未授权 push 或 Slice 4 production Delivery。

## 7. Slice 视图与净减少口径

| Slice | 本 Inventory 的主要 entries | 最小退出结果 |
|---|---|---|
| Slice 1 | CODE-M01–M08、API-M01–M04；CODE-M09 仅建立到期 Compatibility | Parent real caller 使用 Resolved Model；direct Anthropic construction、`requireModel()`、Runner Model Fact defaults 等被替代路径删除；剩余 public/Child boundary 明确到期 |
| Slice 2 | CODE-M09；API-M03 Runner Contract 已在 Slice 1 迁移完成 | Parent/Child 独立 resolution；删除 parentless library path、copied `llmDefaults` 与 legacy Child execution boundary |
| Slice 3 | CODE-E01、CODE-E02 | Tool/Hook caller 迁移，central list/setter/registration special cases 净减少 |
| Slice 4 | API-E01 | Channel caller 迁移，concrete script registration 和 duplicate lifecycle path 删除 |
| Slice 5 | CODE-E03 | Runtime Builder 继续收敛非 Tool/Hook composition 与 lifecycle ownership；Slice 3 Snapshot authority 不回退 |
| Slice 6 | DOC-C01–C13、DOC-A01–A27、DOC-V01–V12 | 唯一 Current Architecture、active links 收口；逐文件完成 `Migrated -> Reviewed -> Deleted` 或明确 `Retained Authority` |

每个 Slice 的 accepted Slice inventory 必须冻结该 Slice 的起始计数口径，并满足：

$$
Legacy_{end} < Legacy_{start}
$$

不能用“增加一个 Adapter/Registry”抵消未迁移 caller 或未删除旧路径。跨 Slice 保留项仍计入后续 Slice inventory。

## 8. 已知不确定性与接受记录

- [x] **INV-01 外部消费者：** repository search 无法证明导出的 Runtime/Runner/LLM/Config API 没有外部 caller。API-M01–M04 已按 entry 设置保留期；未知外部 caller 不阻止本 Inventory 或 Slice 1 Spec 接受，但在完成 per-entry deprecation/breaking decision 前阻止删除。
- [ ] **INV-02 Config Wizard successor：** DOC-V10 删除前必须建立并链接 verified successor，并替换 production comments。
- [x] **INV-03 Slice 1 Compatibility：** API-M01–M04 与 CODE-M09 的 mapping、bounded repository caller、Owner、期限和删除条件已与 Accepted Slice 1 Module Spec 对齐；任何延期必须记录理由和新 Review date。
- [x] 已完成独立 completeness/consistency review，Critical/High/Medium findings 已解决（2026-09-04）。
- [x] 项目所有者确认本 Inventory 的范围、分类、Owner、目标 Slice、退出条件和验证责任，并将状态改为 `Accepted`（2026-09-04）。
- [x] Slice 1 disposition、Legacy 净减少与验证证据已同步；项目所有者确认 Slice 1 完成（2026-09-04）。

## 9. 后续维护

1. 每个 Slice Spec 从本 Inventory 提取并冻结受影响 entries，不复制无关条目；
2. Delivery 开始时记录起始状态和计数；
3. caller migration、Compatibility 延期、Feature Flag 引入或 successor 变化时同步本 Inventory；
4. Slice Review 记录每项 disposition 与验证 evidence；
5. Slice 6 完成最终 Current Architecture、active-link audit 和剩余 Legacy closeout。
