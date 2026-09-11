# Provider Model Catalog and Copilot Relay Plan

## 1. 文档状态

- **状态：** Accepted
- **版本：** 0.9
- **日期：** 2026-09-10
- **所有者：** 项目所有者
- **类型：** Independent post-Foundation Architecture Slice
- **关联 Spec：** [Provider Model Catalog and Copilot Relay Module Spec](../architecture/provider-model-catalog-and-copilot-relay-spec.md)
- **关联 Spike：** [Copilot Relay Responses Protocol Spike Spec](../architecture/copilot-relay-responses-spike-spec.md)
- **长期决策：** [ADR-004 Provider/Model Identity and Facts Ownership](../architecture/adr-004-provider-model-identity-and-facts-ownership.md)、[ADR-005 Extension/Registry Composition](../architecture/adr-005-extension-registry-runtime-composition.md)
- **工作流：** [Development Workflow](../development-workflow.md)

项目所有者于 2026-09-10 接受本 Plan。接受 Plan 不等于接受 Module Spec、批准 Spike 执行、授权 production Delivery、commit 或 push；这些控制点分别确认。

项目所有者于 2026-09-10 另行接受 [Module Spec v0.8](../architecture/provider-model-catalog-and-copilot-relay-spec.md)。Production Delivery DoR 已完成，但 C1/C2/C3/C4 production 修改仍需单独授权并分别通过 Gate。

在本 Plan 与关联 Spec 被接受并完成对应 Delivery Gate 前，当前源码和既有 Accepted Architecture 仍是实现事实与架构权威；Draft/Proposed 文档中的 target contract 不得被表述为 current behavior。

## 2. 已确认的产品与架构方向

1. 用户只能选择当前 Runtime generation 的 Provider Model Catalog 中存在的模型；该闭集规则适用于所有 Provider。
2. 调用方只知道结构化 `{ providerId, modelId }`；Provider 内部拥有 Endpoint、API、Streaming、SDK、Tool/Image 编码和错误映射。
3. Copilot Relay 第一版只纳入 `/v1/models` 中声明支持 HTTP `/responses` 的模型，只实现一个 OpenAI Responses Adapter。
4. Runtime 返回按 Provider 分组、传输安全、不可变的模型目录快照；不向普通调用方暴露 Endpoint、Protocol、Streaming 或原始 Provider Metadata。
5. Channel 通过统一、窄小、强类型的 Runtime Capability binding 查询目录；不取得整个 `RuntimeApplication`，不使用 Service Locator。
6. CLI 提供本地 `/models` 和 `/model` 命令；WebSocket 使用请求/响应消息；第一版不增加 REST API。
7. `/model default` 只清除当前 CLI override；Runtime default model 可以为空，不静默选择目录第一项。
8. Provider Metadata 第一版只保留执行所需的基本身份、Token limits、Tool Use 和 Vision 信息；忽略图片数量/大小、reasoning、structured output 等扩展约束。
9. configured default 是可恢复的用户偏好，不是 optional Provider Extension 的启动依赖；其 Provider/Model 暂时不在 Catalog 时 Runtime degraded startup，并公开 unavailable default 状态供用户改选。
10. Copilot Relay 第一版由 in-repo Composition Root 直接取得并作为 bundled optional Extension Unit 交给 `loadedUnits`；`bundled` 只描述 in-repo acquisition，该 Unit 在 Runtime 中仍使用 `source: 'external'`、`required: false` 和通用 external Unit lifecycle，不形成新的 Unit category。该 acquisition 方式不是未来 package contract。后续独立 package/discovery loader 必须产出相同的 `LoadedRuntimeUnit`，并复用现有 Unit Catalog、registration staging、Registry Snapshot、generation 与 lifecycle 路径。

## 3. 目标与成功标准

- 新 Provider 可以通过现有 Unit/Registry path 发布一个闭集模型目录和 Invocation Port，不修改 Runner 的 Provider-specific 分支。
- 任意目录外模型在 Provider 网络调用前被拒绝，包括 direct API、CLI、WebSocket 和配置默认值路径。
- Copilot Relay 使用原生 HTTP `/responses` 路径完成文本、Tool、Image、Usage、Abort 和错误归一化。
- CLI 和 Web Client 只展示 Catalog 中的模型，并使用结构化 Model Reference 发起 Turn。
- 一个 Turn 只消费其捕获 generation 的 Provider、Catalog 和 Invocation binding，不观察混合 generation。
- 被替代的 `bindAbortHooks()` 和自由文本 Web 模型输入删除，不保留双路径 Compatibility。
- Relay 的源码目录和 direct factory import 只属于第一版 acquisition；未来切换到独立 package acquisition 时不改变 Core、RuntimeApp、Runner、Registry、Channel、Provider contract 或 Turn execution path。

## 4. 非目标

- Extension Marketplace、文件系统发现、远程安装、独立 npm Extension SDK、manifest/package compatibility contract 或通用 Extension Config framework；这些能力后续作为独立 acquisition/delivery Slice 设计，不在本 Slice 预建；
- `/chat/completions`、Anthropic Messages、`ws:/responses`、Realtime 或 Embeddings Adapter；
- 后台 Catalog 刷新、定时轮询、跨 generation 原地变更；
- REST API、HTTP 管理 Server、CORS 或额外认证面；
- 暴露 Provider 原始 Metadata、Endpoint、Protocol 或 SDK 类型给 Channel/UI；
- 第一版执行 `max_prompt_images`、`max_prompt_image_size`、reasoning effort、parallel tool calls 或 structured outputs；
- 重写 Session 格式、历史跨 Provider 可移植性或旧 Tool Call ID 迁移；
- 未经单独授权修改、提交或推送当前工作树中的其他变更。

## 5. Delivery slices 与 Gate

### R0 — Copilot Relay Responses Spike

**Plan Item 状态：** Completed — 项目所有者已确认 [Provisional Pass Results](../architecture/copilot-relay-responses-spike-results.md)（2026-09-10）

- 运行已接受的 Spike Spec；
- 取证 `/v1/models` 和 `/v1/responses` 的 Text、SSE Streaming、Tool round-trip、Image、Usage、Abort 和错误行为；
- 确定官方 OpenAI SDK 或原生 `fetch` 的最小 Adapter 选择；
- 产出 Results，清理 disposable code。

**Gate R0：** Passed — Results 已由项目所有者确认；该 Gate 不接受 Module Spec，也不授权 production Delivery。

### C1 — Closed Provider Model Catalog Contract

**Plan Item 状态：** Completed — Technical Gate 与 Delivery 已由项目所有者接受（2026-09-10）

- Provider projection 发布不可变模型目录；
- Registry staging 校验 Provider/Model identity 和重复项；
- Model Resolver 在 Invocation 前拒绝目录外引用；
- Builtin Anthropic Provider 从静态 Catalog 与精确 `deploymentFacts` 发布目录；
- Runtime 提供传输安全的 `getModelCatalog()` 快照；
- 将 `AgentDefaults.model?: ModelReference` 作为唯一结构化 default；删除 `llm.model` 和依赖第一 Provider 的 string default；
- default model 为空和无效 default 的语义由 Spec 冻结并覆盖。

**Gate C1：** Passed — Core/Registry/Resolver/Runtime contract tests、相关 regression、lint、build 已通过，项目所有者已接受。

Technical Gate evidence（2026-09-10）：C1 focused tests 通过；除本机 `better-sqlite3` Node ABI 不匹配项外的完整 regression 为 96 files / 850 tests 全部通过；`npm run lint` 与 `npm run build` 通过；独立只读审计结论为 Accept。原始全量测试仅被既有 native module ABI（module 127，当前进程要求 115）阻塞，不归因于 C1。项目所有者于同日接受 C1 Delivery Gate；该接受不授权 C2。

项目所有者确认 `scripts/` 下现有脚本为非权威、当前不保证可运行的 legacy utilities；C1 不删除或迁移这些脚本，也不把它们作为 Gate evidence。其后续 disposition 另行逐项评审，且不得要求 production 保留 legacy model/config path。

### C2 — Copilot Relay Provider Extension

**Plan Item 状态：** Completed — Owner Accepted（2026-09-11）

项目所有者于 2026-09-10 选择将 `scripts/server.ts` 单独迁移为 C2 受支持 Host Composition Root。该文件负责读取 Relay Host 环境、显式构造 Relay external Unit，并与 WebSocket Channel 一同传入 `RuntimeAppOptions.loadedUnits`；`scripts/` 其余文件仍保持非权威、当前不保证可运行的 legacy 状态。

- 新增 in-repo external Provider Unit；
- Unit `create()` 有界获取、校验并冻结 `/v1/models` 快照；
- 只发布支持 HTTP `/responses` 且具备必要执行 facts 的模型；
- Responses Adapter 实现 Core `ModelInvocationPort`；
- Provider 内部拥有 API/Streaming/Tool/Image/error mapping；
- Relay 作为 optional external Unit；discovery 失败不污染 current generation，configured default 指向缺失 Relay 时以 unavailable 状态保留而不阻断 startup；
- Host 通过 `loadedUnits` 组合 Extension，不给 Runtime/Runner 增加 Relay branch；
- direct in-repo factory import 仅存在于 Composition Root；Relay 注册后与未来 package-loaded external Unit 使用相同 staging、conflict isolation、Snapshot 和 lifecycle path。

**Gate C2：** Passed — Provider contract、protocol fixtures、真实 Relay smoke、failure cleanup、lint、build 已通过，项目所有者已接受。

Technical Gate evidence（2026-09-10）：Relay focused suite 为 40 tests 全部通过；完整 regression 为 99 files / 894 tests 全部通过；`npm run lint` 与 `npm run build` 通过。真实 loopback Relay smoke 通过 `/v1/models` discovery、external Unit registration、`gpt-5.6-sol` Catalog membership 与原生 `/v1/responses` 调用，得到单一 `end_turn`、有效 Usage 和 text content。迁移后的 `scripts/server.ts` 在 Relay Provider + WebSocket Channel 组合下成功启动，并通过现有 Host signal path 有界关闭。两轮独立只读审计提出的 pending-body Abort、未知 terminal、Tool ordering、URL logging 与 failure cleanup 问题均已修复；最终复审结论为 Gate-ready，且无 unresolved Critical/High/Medium finding。该技术通过不构成项目所有者接受，也不授权 C2 commit、push 或进入 C3。

项目所有者于 2026-09-11 接受 C2 Delivery Gate。该接受关闭 C2，但不授权 C2 commit、push 或进入 C3/C4。

### C3 — Channel Runtime Capabilities and Model Selection

**Plan Item 状态：** Completed（项目所有者于 2026-09-11 接受）

本 Gate 修改 production CLI/WebSocket Channel Adapter 与 Web Client，但不提升其他 `scripts/` 文件的可信状态；`scripts/server.ts` 仍是 `scripts/` 下唯一受支持 Host Composition Root。

- 以 `bindRuntimeCapabilities()` 替换 `bindAbortHooks()`；
- 能力对象按 `modelCatalog`、`abort` 等窄 Port 分组；
- CLI 增加 `/models`、`/model`、`/model default`；
- WebSocket 增加 `get_model_catalog` / `model_catalog`；
- 新 WebSocket 消息使用 snake_case，既有 mixed-case wire 在本 Slice 保持不变且不升级协议版本；
- Web Client 使用 Provider/Model selector，删除自由文本模型输入；
- 所有提交路径仍由 Model Resolver 执行闭集校验。

**Gate C3：** Channel contract、CLI interaction、WebSocket protocol、Web UI smoke、existing Abort regression、lint、build 通过。

项目所有者于 2026-09-11 接受 C3 Delivery Gate。最终验证为 99 test files / 919 tests 全部通过，`npm run lint`、`npm run build` 与 `git diff --check` 通过；supported Host 的 Relay default/explicit model、Catalog、empty opaque Model ID、stale selection 和 Abort 路径完成验证。该接受关闭 C3，但不授权 commit、push 或进入 C4。后续通用 Extension discovery/scoped configuration 作为独立 Architecture Slice 设计，不回写或重开 C2/C3。

### C4 — Authority and Closeout

- 更新 Current Architecture、Module Spec 状态、文档索引和必要 Fitness evidence；
- 删除被替代路径与临时诊断/Compatibility；
- 运行全量可执行回归并记录环境阻塞；
- 项目所有者验收 Slice。

## 6. 风险与控制

| 风险 | 控制 |
|---|---|
| Relay 宣称支持 `/responses` 但 SSE/Tool/Abort 语义不同 | R0 Spike 在生产实现前取证 |
| Catalog 与 Invocation binding 漂移 | 同一 Provider instance 构造一个不可变私有模型 Map，并从它发布 Catalog 与 `resolveModel()` |
| Channel 获得过宽 Runtime 权限 | 只注入具名 typed Capability Ports，不传 `RuntimeApplication` |
| 列表 UI 被绕过 | Model Resolver 在每次 Turn 执行闭集校验 |
| reload 期间目录混合 | Catalog 属于 Registry Snapshot generation；Turn 使用 captured generation |
| unavailable default 导致静默换模型或 Runtime 无法进入改选界面 | degraded startup；Catalog 返回原引用和 unavailable reason；不选第一项、不跨 Provider fallback |
| Relay optional discovery 失败导致错误 fallback | 不发布 Relay；保留其他有效 Provider；configured default 指向 Relay 时保留为 unavailable 用户偏好 |
| WebSocket 历史 mixed-case 被顺带破坏 | 只对新增 Catalog 消息使用 snake_case，不重命名既有字段、不升级协议版本 |
| 与现有未提交 Defect 改动混合 | Delivery 前复核工作树；提交范围单独确认，绝不自动 commit/push |
| 后续独立插件支持迫使新增第二条 Runtime 路径 | package discovery、compatibility 和 provenance 只属于 acquisition；进入 Runtime composition 的可执行产物仍是 deterministic `LoadedRuntimeUnit[]`，loader 不得直接注册、启动或修改 Registry |

## 7. Current → Target 迁移

| Current | Target | 删除/生效 Gate |
|---|---|---|
| `ProviderProjectionEntry.resolveModel()` 可接受未发布的任意 Model ID | Provider 发布 closed `models`，Resolver 先执行 exact membership gate | C1 |
| `llm.model?: string` 与第一 Provider 共同形成默认引用 | `AgentDefaults.model?: ModelReference` 是唯一 default authority | C1 |
| `bindAbortHooks()` | `bindRuntimeCapabilities({ modelCatalog, abort })` | C3 原子替换 |
| Web Client 自由文本模型输入 | Catalog 驱动的 Provider/Model selector | C3 |
| Runtime 无 Catalog query | `RuntimeApplication.getModelCatalog()` 返回 generation-scoped DTO | C1 |
| WebSocket wire 历史 mixed case | 既有消息不变；新增 Catalog 请求/响应使用 snake_case | C3 |

不保留双 Resolver、双 default config、双 Channel binding 或自由文本 fallback。迁移完成后，旧路径及其 Compatibility tests 同 Gate 删除。

## 8. Definition of Ready

### 8.1 R0 Spike Ready

- [x] 本 Plan Accepted；
- [x] Spike Spec Accepted 并获单独执行授权；
- [x] Relay、credential 和最小调用预算已由项目所有者提供或确认；
- [x] 执行前记录工作树状态，确认 disposable artifacts 不覆盖或混入用户及既有 Defect 改动。

### 8.2 Production Delivery Ready

- [x] 本 Plan Accepted；
- [x] Module Spec Accepted；
- [x] Spike Spec Accepted，R0 Results 完成并确认；
- [x] 所有 Open Questions 已关闭；
- [x] 真实 caller、旧路径删除条件和验证命令已在 Module Spec §14 明确；
- [x] 当前工作树边界已记录：本设计里程碑只修改四份关联文档；已有 production、test、script 和其他 untracked 改动不属于本里程碑，后续 Delivery 不得覆盖或混入其 staging。

## 9. Definition of Done

- [ ] R0、C1、C2、C3、C4 Gate 分别通过并由项目所有者确认；
- [ ] 所有 Provider 实施闭集 Catalog；
- [ ] Copilot Relay 原生 Responses Adapter 真实调用通过；
- [ ] CLI/WebSocket/Web UI 至少各一个真实 caller 迁移；
- [ ] 旧 Channel binding 和自由模型输入删除；
- [ ] Current Architecture 与实现同步；
- [ ] 无未解释 diagnostics、旁路或双生产路径；
- [ ] commit/push 仅在单独明确授权后执行。
