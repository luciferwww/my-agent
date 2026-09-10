# Source Layout Convergence Migration Spec

## 1. 状态

- **状态：** Accepted
- **版本：** 0.2
- **日期：** 2026-09-09
- **所有者：** 项目所有者
- **Architecture Slice：** Independent post-Foundation Source Layout Convergence
- **设计输入：** [Source Layout Convergence Proposal](source-layout-convergence-proposal.md)
- **长期决策：** [ADR-003 Progressive Architecture Migration](adr-003-progressive-architecture-migration.md)、[ADR-005 Extension Registry Runtime Composition](adr-005-extension-registry-runtime-composition.md)、[ADR-006 Legacy and Compatibility Exit](adr-006-legacy-and-compatibility-exit.md)
- **相关 Contract：** [Runtime Composition Module Spec](runtime-composition-module-spec.md)、[Model Resolution Module Spec](model-resolution-module-spec.md)、[Channel Module Spec](channel-module-spec.md)
- **架构原则：** [Architecture Principles](architecture-principles.md) AP-01、AP-04–AP-06、AP-09–AP-13
- **工作流：** [Development Workflow](../development-workflow.md)

本 Spec 是 Source Layout Convergence 的候选 implementation authority，冻结物理拓扑、规范入口、Anthropic Bundled Runtime Module seam、post-Snapshot default Provider 来源、失败语义、迁移批次和验证 Gate。

项目所有者于 2026-09-09 接受本 Spec v0.1，并授权 C1 production Delivery。C1 实施取证发现旧 Anthropic path 删除会在 C3 前使 FT-12 evidence 失效，并与 C2 完整测试 Gate 冲突；项目所有者接受 v0.2 批次修正，把纯路径/evidence 与 FT-12 同步前移到 C1，C3 保留 C2 后的 Runtime 语义同步。项目所有者随后依次验收 C1 并授权 C2、验收 C2 并授权 C3；2026-09-10 验收 C3、确认整个 Source Layout Convergence Slice 完成，并授权一个 checkpoint commit。push 仍未授权。

## 2. 目标与用户可观察结果

本 Slice 让源码目录基本反映当前模块所有权，同时删除旧路径和旁路：

1. Anthropic Provider Integration 的唯一生产位置为 `src/adapters/provider/anthropic/`；
2. CLI/WebSocket 保持为 Channel Transport Adapters，Turn Interaction manager 归入 Runtime Application；
3. Core Channel contracts 不再经 Adapter barrel 转发；
4. Anthropic 作为一个 required Bundled Runtime Module，经与 External Units 相同的 create → registration → staging → publication 路径接入；
5. Runtime Builder 不再构造具体 Provider 或读取 staging 前的 Provider entries；
6. `defaultProviderId` 只从成功发布的 immutable Registry Snapshot 取得并冻结；
7. production Anthropic codec 与 test-only portability reference codecs 拥有独立实现，并由同一 canonical fixtures/expectations 防漂移；
8. Current Architecture 在代码验收后与最终源码同步。

成功路径的 Provider、Model Resolution、Turn、Tool 和 Channel 公共语义保持不变。允许的有意行为变化仅限 Anthropic 构造进入 required Unit `create` 阶段后产生的 startup phase、错误归属和 cleanup 顺序变化；这些变化由本 Spec 冻结。

## 3. Current Baseline

### 3.1 Anthropic 与 codec

- `src/adapters/llm/AnthropicClient.ts` 拥有 Anthropic SDK/protocol mapping；
- `src/adapters/llm/AnthropicProvider.ts` 拥有 Anthropic connection、facts 和 invocation binding；
- `src/adapters/llm/tool-contract-codecs.ts` 混合 production Anthropic conversion 与 test-only Anthropic/OpenAI-compatible reference codecs；
- production 只使用其中的 `encodeAnthropicToolDefinition()`；
- Runtime Builder 直接构造 `AnthropicProvider`。

### 3.2 Channel 与 Turn Interaction

- `src/adapters/channel/types.ts` 转发 Core Channel contracts；
- `src/adapters/channel/index.ts` 导出 concrete adapters、Core types、`TurnInteractionManager` 和 `ApprovalManager` compatibility alias；
- `RuntimeApp` 创建并持有 `TurnInteractionManager`，但 manager 源码位于 Adapter 目录。

### 3.3 Provider Composition seam

当前 `RuntimeDependencies.createProviderProjection()` 返回裸 `ProviderProjectionEntry[]`。`assembleLoadedRuntimeUnits()`：

1. 在 staging 前取得 Provider entries；
2. 从第一项取得 `defaultProviderId`；
3. 构造通用 `builtin-provider-bindings` Unit；
4. 在 Builder 内执行 `registerProvider()` 循环。

该路径绕过 Anthropic-owned Bundled Runtime Module 构造边界，并使默认 Provider 依赖 pre-staging projection。

### 3.4 已验证的 Composition 能力

`RuntimeCompositionManager.start()` 已返回成功发布的 `RegistrySnapshot`。现有 Runtime Composition path 已负责 required Unit create、registration staging、start、candidate resolution、atomic publication、handoff 和 candidate cleanup，因此本 Slice不得建立第二套 Provider composition path。

## 4. Scope

### 4.1 C1 — 路径与所有权

- 移动 Anthropic Adapter 源码和测试；
- 移动 Turn Interaction manager 源码和测试；
- 建立 Anthropic Adapter 与 Turn Interaction 的规范入口；
- 删除 Channel Core-type facade 和 `ApprovalManager` alias；
- 拆分 production Anthropic codec 与 test-only portability reference codecs；
- 建立共享 canonical test fixtures/expectations；
- 更新所有 production、test、script imports；
- 更新路径、barrel 与 SDK allowlist Fitness。
- 同步因物理删除而失效的 Current Architecture source/test path、FT-12 manifest 和直接源码读取路径；不提前写入 C2 尚未实现的 Runtime 语义。

C1 不改变 Provider 构造时机或 Runtime Provider seam。

### 4.2 C2 — Anthropic Bundled Runtime Module

- 新增具名 Anthropic Provider Runtime Module；
- 把 Anthropic 构造和 Provider registration 从 Builder 移入 Module；
- 以 singular Bundled Provider Unit seam 替换裸 projection seam；
- production 和 Fake Provider 经过相同 Unit staging path；
- 从成功 `start()` 返回的 Snapshot 取得默认 Provider；
- 锁定 required Unit create failure、cleanup、no-partial-publication 和 no-kernel 语义；
- 更新相关 Runtime、integration、architecture fitness tests。

### 4.3 C3 — Current Architecture authority

代码验收后更新 C2 引入的语义变化：

- `docs/architecture/current/adapter_llm.md` 的 Runtime Module ownership/startup 语义；
- `docs/architecture/current/runtime.md` 的 Unit seam、Snapshot-derived default Provider 和 startup failure flow；
- 必要时更新 `docs/architecture/current/core_model_resolution.md` 的 Composition 语义；
- FT-12 对 C2 语义的断言；
- `legacy-migration-inventory.md` 中确实受本 Slice 改变的 caller/deletion evidence。

C3 不机械重写 Accepted Specs 的历史 baseline，也不借机重命名 Current Architecture topic 文件。

## 5. Non-goals

- 不修改 Core Provider、Model Resolution、Tool、Channel 或 Registry contracts 的业务语义；
- 不新增 OpenAI-compatible production Provider；
- 不新增通用 Provider framework、DI Container、Service Locator 或 mutable Registry access；
- 不扩展为多个 bundled Provider Units；
- 不拆分 `builtin-channels.ts` 或 `builtin-tools.ts`；
- 不重排其他 Core、Platform 或 Runtime 目录；
- 不保留旧路径 facade、alias、symlink、hidden flag 或双入口；
- 不重新定义 runtime enable/disable、generation retirement 或 hot reload；
- 不把 test-only reference codec 当作 production compatibility promise；
- 不改变 Slice 6 的范围或 acceptance；
- 不授权 dependency 安装、commit 或 push。

## 6. Frozen target topology

```text
src/
├── adapters/
│   ├── channel/
│   │   ├── CliChannel.ts
│   │   ├── CliChannel.test.ts
│   │   ├── WebSocketChannel.ts
│   │   ├── WebSocketChannel.test.ts
│   │   └── index.ts
│   └── provider/
│       └── anthropic/
│           ├── AnthropicClient.ts
│           ├── AnthropicClient.test.ts
│           ├── AnthropicProvider.ts
│           ├── AnthropicProvider.test.ts
│           ├── tool-codec.ts
│           ├── tool-codec.test.ts
│           └── index.ts
├── core/
│   └── tools/
│       ├── provider-portability-fixtures.ts
│       └── provider-portability.test.ts
├── runtime/
│   ├── turn-interaction/
│   │   ├── TurnInteractionManager.ts
│   │   ├── TurnInteractionManager.test.ts
│   │   └── index.ts
│   └── ...
└── runtime-modules/
    ├── anthropic-provider.ts
    ├── anthropic-provider.test.ts
    ├── builtin-channels.ts
    ├── builtin-tools.ts
    └── index.ts
```

`provider-portability-fixtures.ts` 是 test-support source：只允许被测试代码导入，不从 production barrel 导出。若实施时现有 `core/tools/test-utils.ts` 能在不混入不相关 fixture 的前提下承担同一职责，可以使用该文件；必须保持相同的 test-only import rule，不能同时保留两份 fixture authority。

## 7. Canonical entry and import rules

| 模块 | 模块外生产入口 | 允许导出 |
|---|---|---|
| Anthropic Adapter | `src/adapters/provider/anthropic/index.ts` | Anthropic concrete adapter values 和配置类型 |
| Channel Adapter | `src/adapters/channel/index.ts` | `CliChannel`、`CliChannelConfig`、`WebSocketChannel`、`WebSocketChannelConfig` |
| Turn Interaction | `src/runtime/turn-interaction/index.ts` | `TurnInteractionManager` |
| Bundled Runtime Modules | `src/runtime-modules/index.ts` | Module factories |
| Core Channel contracts | `src/core/channel/index.ts` | Core-owned Channel/interaction contracts |

规则：

1. 模块外 production value import、type import 和 re-export 只使用上表入口；
2. 模块内部源码和同目录测试可使用相对文件导入；
3. 不建立 `src/adapters/provider/index.ts`；
4. Channel Adapter 不导出 Core contract、Turn Interaction manager 或 `ApprovalManager`；
5. Runtime Module barrel 不导出 Adapter internals；
6. scripts 直接从 Core canonical entry 取得 Core types；
7. C1 完成时旧 `src/adapters/llm/**` 与 `src/adapters/channel/types.ts` 必须物理删除。

## 8. Codec ownership and anti-drift contract

### 8.1 Production ownership

`src/adapters/provider/anthropic/tool-codec.ts` 只保留 Anthropic production path 实际需要的 conversion。`AnthropicClient` 只能从本 Anthropic Adapter 模块内部使用该实现。

### 8.2 Portability proof

`src/core/tools/provider-portability.test.ts` 可包含或导入 test-local Anthropic/OpenAI-compatible reference implementations，用于证明 canonical Tool Contract 可表达不同 Provider wire shape。reference implementation：

- 不是 production Provider；
- 不从 Core production barrel 导出；
- 不被 production、scripts 或生成工具导入；
- 不导入 Anthropic Adapter。

### 8.3 Shared fixtures

production codec test 与 portability test 必须共享同一 canonical fixture/expectation authority，至少覆盖：

- Tool definition 与 nested input schema；
- Tool call order；
- fragmented JSON input；
- malformed fragment/input；
- duplicate call identity；
- canonical Tool result success/error；
- Anthropic wire expectations；
- OpenAI-compatible wire expectations。

共享 fixture 不共享 codec function。Anthropic Adapter test 验证 production codec；Core portability test 验证独立 reference codecs。任一测试不得导入另一套 codec 实现。

## 9. Anthropic Bundled Runtime Module contract

### 9.1 Factory

目标 factory：

```text
createAnthropicProviderModule(options: AnthropicProviderModuleOptions): LoadedRuntimeUnit
```

约束：

- Unit ID 固定为 `builtin-anthropic-provider`；
- source 为 `builtin`；
- required 为 `true`；
- initially enabled；
- factory 只捕获不可变 options 并返回 `LoadedRuntimeUnit`；
- `AnthropicProvider` 只在 `LoadedRuntimeUnit.create(signal)` 中构造；
- Provider entry 封闭在返回 instance 的 registration closure；
- registration 只通过 `ExtensionRegistrationApi.registerProvider()` 进入 staging；
- RuntimeApp、Runner、Core 和 Builder 不识别 Anthropic concrete type；
- Module 自己拥有其内部 SDK/client/resource cleanup；Framework 只编排 Unit instance lifecycle。

### 9.2 Runtime dependency seam

`RuntimeDependencies` 的目标 seam 为：

```text
createBundledProviderUnit(options: RuntimeProviderOptions): LoadedRuntimeUnit
```

必须删除 `createProviderProjection`。新 seam 不得返回：

- `ProviderProjectionEntry` 或其数组；
- `RuntimeContributionUnit`；
- 可以在 staging 前读取 Provider entry 的等价 wrapper；
- 多个 bundled Provider Units。

默认 implementation 返回 `createAnthropicProviderModule(options)`。External Providers 继续经 `RuntimeAppOptions.loadedUnits` 进入普通 Unit catalog。

### 9.3 Fake contract

Runtime tests 和 integration scripts 使用具名 Fake `LoadedRuntimeUnit`。Fake 必须经过 production 相同的 create → registration → staging → start → publication path。

一个 Fake Unit 可以在 registration closure 内注册多个 Provider entries，以覆盖 Parent/Child 使用不同 Provider 的场景；不得因此把 bundled seam 改为复数，也不得恢复裸 projection test shortcut。

共享 Fake helper 应放在现有 Runtime test-support 边界内；不得从 production barrel 导出。

## 10. Builder and startup flow

目标顺序固定为：

```text
bootstrapRuntime
  -> map resolved config to RuntimeProviderOptions
  -> createBundledProviderUnit
  -> assemble RuntimeUnitCatalog
  -> RuntimeCompositionManager.start
  -> published immutable RegistrySnapshot
  -> select snapshot.providers[0].id
  -> freeze RuntimeResourceSet.defaultProviderId
  -> construct RuntimeApp kernel
  -> emit app_ready
```

Builder：

- 可以映射已验证 Config 为 Module options；
- 可以把 `LoadedRuntimeUnit` 加入 catalog；
- 可以读取 `start()` 成功返回的 immutable Snapshot projection；
- 不得构造 `AnthropicProvider`；
- 不得调用 `registerProvider()`；
- 不得在 staging 前读取 Provider entry；
- 不得建立 Provider-specific conditional branch。

`assembleLoadedRuntimeUnits()` 不再返回 `defaultProviderId`。Runtime kernel 只在 Composition start、default selection 和全部 startup prerequisites 成功后构造。

## 11. Default Provider selection

### 11.1 Authoritative source

唯一来源是 `RuntimeCompositionManager.start()` 成功返回的 published immutable `RegistrySnapshot.providers`。

选择规则：

```text
defaultProviderId = registrySnapshot.providers[0].id
```

Provider 顺序服从现有 Registry deterministic ordering：Builtin 优先于 External；Unit ordering 和单 Unit registration ordering 继续由现有 Registry/Composition contracts 管理。本 Slice 不建立第二份 Provider priority metadata。

### 11.2 Invariants

- Snapshot 没有 Provider 时 startup fatal；
- 该失败发生在 RuntimeApp kernel construction 和 `app_ready` 之前；
- `defaultProviderId` 写入 Runtime resources 后保持冻结；
- Turn 显式 Model Reference 可以选择其他 accepted Provider；
- 缺省 Turn 使用冻结 ID，但不在每个 Turn 重新选择默认 Provider；
- 当前 required bundled Anthropic Unit 按 Builtin-first 排序先于 External Providers，因此 External Provider 不改变缺省值；
- 未来第二个 bundled Provider Unit 需要新的 Accepted default-selection decision。

## 12. Lifecycle and failure semantics

### 12.1 Required Unit create failure

Anthropic construction、endpoint 或 deployment facts validation 在 Unit `create` 中失败时：

- 整体 startup 失败；
- 诊断 Unit identity 为 `builtin-anthropic-provider`；
- phase 为 `create`；
- 不发布 candidate/partial Snapshot；
- 不构造 RuntimeApp kernel；
- 不发出 `app_ready`；
- 已创建且尚未 handoff 的 candidate units 按现有 Composition cleanup contract 清理。

### 12.2 Before-instance cleanup

若 `LoadedRuntimeUnit.create()` 在返回 instance 前抛错，Framework 没有可调用的 `stop()`。Anthropic Module 必须：

- 避免在可能失败的 validation 前取得需关闭资源；或
- 在抛错前自行关闭已取得资源；
- 保持原错误为 primary failure，并按现有规范聚合 cleanup diagnostics。

不得在 Builder 增加 Anthropic-specific cleanup 旁路。

### 12.3 After-instance cleanup and publication

instance 返回后发生 registration、staging、start、Channel preparation 或 publication failure 时，沿用 Runtime Composition 的 creator-before-handoff、ledger-after-handoff ownership。candidate cleanup failure 保持 fail-closed；不得为保留原 startup 错误而静默吞掉 cleanup failure。

### 12.4 Snapshot without Provider

即使所有 Units 完成 Composition，只要 published Snapshot 不含 Provider，Builder 必须在 kernel construction 前失败。该检查不修改已发布 Snapshot；startup failure path 必须关闭 Composition 和 bootstrap resources，且不得发出 ready event。

## 13. Turn Interaction ownership

- `TurnInteractionManager` 是 Runtime-owned application component，不是 Runtime Module、Contribution 或 Channel Adapter；
- `RuntimeApp` 继续唯一创建并持有 manager；
- pending interaction、settlement、Abort、close 和 fail-closed coordination 语义不变；
- CLI/WebSocket Adapter 只拥有 request presentation、response receipt 和 transport failure；
- Core Channel 继续拥有 transport-facing contracts；
- 本 Slice 只迁移物理位置和入口，不修改 public interaction protocol。

## 14. Compatibility, deletion and rollback

### 14.1 One-shot cutover

本 Slice 不提供运行时 migration flag。每个 Delivery batch 在自身 Gate 内完成 source/test/script caller cutover 和旧路径删除，不允许：

- old/new barrel 并存；
- re-export facade；
- deprecated alias；
- hidden fallback import；
- 复制 Provider registration path。

### 14.2 Deletion conditions

C1 删除前必须证明：

- 所有 `src/adapters/llm/**` consumers 已迁移；
- 所有 Adapter Channel Core-type consumers 已改为 Core entry；
- `ApprovalManager` 无 caller；
- manager caller 已改为 Runtime entry；
- relevant tests、scripts 和 Fitness 已更新。

C2 删除 `createProviderProjection` 前必须证明：

- production default Unit 已建立；
- Runtime tests 和 scripts 的 Fake Unit helper 已建立；
- 多 Provider Fake 场景由单 Unit registration 覆盖；
- Builder 可从成功 Snapshot 取得 default ID；
- failure/cleanup tests 已先建立或在同一受审 batch 中建立。

### 14.3 Rollback

rollback 依赖版本/变更集回滚，不保留永久双路径。若 C1 已验收而 C2 失败，可保留新物理路径并回滚 C2 seam；不得恢复旧 `adapters/llm` facade。若实现证据否定本 Spec 的生命周期或 Snapshot 假设，停止 Delivery并回到 Spec Review。

## 15. Delivery batches and gates

### 15.1 C1 Gate — Path and ownership

交付：

1. 移动 Anthropic Adapter 和 tests；
2. 拆分 codecs 与建立 shared fixtures；
3. 移动 Turn Interaction manager 和 tests；
4. 收窄 Channel barrel、删除 Channel type facade/alias；
5. 更新 production/test/script imports；
6. 更新 FT-02、FT-04、FT-08 和新增/扩展 source-layout Fitness。
7. 更新 Current Architecture 中因 C1 物理删除而失效的 source/test paths，以及 FT-12 manifest/direct source path；不描述 C2 future state。

通过条件：

- 旧物理路径和 facade 已删除；
- focused Anthropic/Channel/Turn Interaction/codec tests 通过；
- SDK allowlist、barrel 和 path Fitness 通过；
- Current Architecture 的 C1 path/evidence 与实际源码一致，FT-12 通过；
- lint 与 clean build 通过；
- C1 不改变 Runtime Provider seam 或构造时机。

### 15.2 C2 Gate — Runtime Module and Snapshot seam

交付：

1. 新增 Anthropic Runtime Module 和 focused tests；
2. 更新 Runtime Module barrel；
3. 替换 `RuntimeDependencies` seam；
4. 更新 Builder assembly/start/default selection；
5. 更新 Runtime tests 与 integration scripts Fake；
6. 更新 FT-10 并增加 default/failure/source-layout assertions。

通过条件：

- Builder 不含 concrete Anthropic construction 或 Provider registration loop；
- production/Fake 均走 Unit staging；
- default ID 只来自 successful published Snapshot；
- empty Provider Snapshot、required create failure、candidate cleanup、no-partial-Snapshot、no-kernel/no-ready tests 通过；
- RuntimeApp、Parent/Child Model Resolution、Shutdown 和 integration regressions 通过；
- lint、clean build 和完整 production tests 通过。

### 15.3 C3 Gate — Architecture authority

交付：

1. 更新 C2 影响的 Current Architecture Runtime/Provider facts/links；
2. 更新 FT-12 的 C2 semantic assertions；
3. 按实际变化更新 Legacy inventory；
4. 运行 documentation governance 和 final repository audit。

通过条件：

- Current Architecture 与 final source tree、seam 和 ownership 一致；
- active docs 不把旧路径描述为 Current；
- Accepted historical baseline 未被机械篡改；
- FT-09、FT-11、FT-12 通过；
- full FT-01–FT-12 与新增 source-layout Fitness 通过；
- `git diff --check` 通过。

C1、C2、C3 独立 Review。不得用后续 batch 修复前一 batch 已知 Gate failure 后仍宣称前一 batch通过。

## 16. Test and Fitness matrix

| Requirement | Primary evidence |
|---|---|
| Anthropic path and canonical barrel | source-layout Fitness + TypeScript import graph |
| SDK only in Anthropic Adapter | FT-02 SDK allowlist |
| Core 不依赖 concrete Provider | FT-01/FT-03/FT-04 + import audit |
| Channel barrel only exports concrete adapters | source-layout barrel assertion |
| Channel Core facade/Approval alias removed | path/export Fitness + caller audit |
| Turn Interaction Runtime ownership | focused manager/RuntimeApp tests + path Fitness |
| production/reference codec anti-drift | shared-fixture production and portability suites |
| singular `LoadedRuntimeUnit` seam | FT-10 + Runtime type/build evidence |
| no naked Provider projection dependency | FT-10 forbidden-symbol assertion |
| production/Fake common staging | Runtime Builder/Composition tests |
| post-Snapshot default Provider | Builder sequencing and Snapshot ordering tests |
| empty Provider Snapshot startup failure | Runtime Builder failure test |
| Anthropic create attribution | Runtime Module/Composition failure test |
| no partial Snapshot/kernel/ready | startup failure integration test |
| candidate cleanup ownership | Runtime Composition cleanup tests |
| Current Architecture synchronization | FT-09/FT-11/FT-12 |
| no old callers/paths | repository grep/path audit |

新增 source-layout Fitness 优先使用独立 `ft-13-source-layout-convergence.test.ts`，避免把本 Slice 的永久规则混入历史 API-M04 删除断言。若实施选择扩展现有 rule，必须保持同等诊断精度并在 Review 中解释，不得只靠 filename grep 产生高误报。

## 17. Definition of Ready

进入 C1 production Delivery 前必须全部满足：

- [x] 本 Spec 状态为 `Accepted`，版本和 Owner decision 已记录；
- [x] Proposal 与 Spec 不存在 scope/seam/default-selection 冲突；
- [x] ADR-003/005/006 consistency review 无未解决冲突；
- [x] C1–C3 caller、deletion 和 validation boundaries 已确认；
- [x] intentional startup behavior change 已被项目所有者接受；
- [x] 无新增 dependency 或 migration flag；
- [x] C1 production Delivery 获得明确授权。

进入 C2 前还必须满足：

- [x] C1 Gate 已验收；
- [x] singular seam、Fake multi-provider shape 和 default selection tests 已确认；
- [x] C2 production Delivery 获得明确授权。

进入 C3 前必须满足 C2 Gate 已验收。

## 18. Slice acceptance conditions

- [x] C1、C2、C3 Gate 全部通过；
- [x] `src/adapters/llm/**`、`src/adapters/channel/types.ts` 和 Adapter-owned manager path 不存在；
- [x] 规范入口与 barrel surfaces 符合 §7；
- [x] production/reference codec 独立且共享 fixtures 全绿；
- [x] Anthropic 是 required Bundled Runtime Module；
- [x] `createProviderProjection` 不存在；
- [x] Runtime Builder 不读取 pre-staging Provider entry；
- [x] default Provider 只从 successful published Snapshot 取得；
- [x] empty Provider、create failure 和 cleanup semantics 有自动化证据；
- [x] successful Provider/Model/Turn/Channel behavior regressions 通过；
- [x] Current Architecture 和 Fitness manifest 已同步；
- [x] lint、clean build、完整 tests、完整 Fitness、integration scripts 和 `git diff --check` 通过；
- [x] completion claim 只覆盖 Anthropic Provider、Turn Interaction 和相关 source-layout convergence；
- [x] 无 commit/push 越权。

## 19. Stop conditions

出现以下任一情况立即停止对应 Delivery，列出证据和选项，回到 Spec Review：

- 需要改变 Core Contract 或成功路径公共语义；
- 需要多个 bundled Provider Units 或新的 Provider priority metadata；
- 现有 Composition 无法提供 required create attribution、atomic publication 或 cleanup ownership；
- 只能通过 Builder concrete-type branch 或 pre-staging Provider inspection 取得默认值；
- codec anti-drift 只能通过 Core production 导入 Infrastructure 实现完成；
- 必须保留旧 facade/alias 才能完成 caller migration；
- 需要新增 dependency、DI Container、Service Locator 或 runtime migration flag；
- Accepted ADR/Spec 与实现要求发生真实冲突。

## 20. Review decision

项目所有者于 2026-09-09 接受 v0.1 并授权 C1 production Delivery，随后接受 v0.2 的 C1/C3 path-versus-semantics 批次修正。C1、C2、C3 分别完成独立 Delivery、validation 与 Review；项目所有者于 2026-09-10 验收 C3 并确认整个 Source Layout Convergence Slice 完成。项目所有者同时授权一个 checkpoint commit；push 未授权。
