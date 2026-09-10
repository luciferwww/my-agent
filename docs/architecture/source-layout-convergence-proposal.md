# Source Layout Convergence Proposal

> Status: Direction Accepted
> Date: 2026-09-09
> Authority: Accepted design input for the successor Migration Spec; not implementation authority
> Candidate classification: Independent post-Foundation Architecture Slice
> Scope: Anthropic Provider、Channel Adapter 与 Turn Interaction 的物理目录和规范入口，以及 Anthropic Bundled Runtime Module 的 composition seam 与 startup ownership 收敛

## 1. 目的

当前实现已经基本完成 Core Contract、Provider Adapter 和 Channel Adapter 的逻辑边界迁移，但 Anthropic Runtime Module、物理目录和唯一权威导入路径仍未完全收敛。本提案只讨论会妨碍架构识别的目录/文件，不进行全仓库美化式重排。

这是一次 **source-path breaking** 的候选架构迁移。它不改变成功路径的 Provider、Model Resolution、Turn、Tool 或 Channel 语义；Anthropic 构造时机及其启动失败路径会发生有意变化，必须由后续正式 Spec 冻结。

基本原则：

1. 顶层目录应基本反映主要所有权边界，但不要求每个概念机械地一一对应目录；
2. Core 拥有稳定 Contract、Port 和 Contribution 类型；
3. Adapter 只拥有外部 SDK、协议、Transport 及其数据转换；
4. Bundled Runtime Module 拥有自身构造边界、registration identity 和 Contribution 注册；
5. Runtime Application 拥有 Turn、队列、路由和交互生命周期；
6. Composition 只选择配置、装配 Module 并加入 Runtime Unit catalog；
7. 每个生产模块只有一个规范外部入口，测试可在模块内部使用同目录相对导入。

项目所有者于 2026-09-09 接受本 Proposal 的方向，并授权起草 successor Migration Spec。该接受不单独授权 production 修改、commit 或 push；Delivery 以 Accepted Migration Spec 和后续明确实施授权为准。

## 2. 与 Architecture Foundation Slice 6 的关系

本提案不属于 Slice 6，也不修改 Slice 6 的范围、完成条件或 S6-D8 evidence。

- Slice 6 只按其已接受的文档与 Legacy Closeout Spec 独立进入 Owner acceptance；
- 本提案的继续评审、接受、延期或拒绝均不阻塞 Slice 6；
- Slice 6 完成不会自动授权本提案；
- 本提案已作为独立 post-Foundation Architecture Slice 的设计输入；successor Migration Spec 必须建立 Definition of Ready、Delivery batches 和验证 Gate。现有 ADR-003、ADR-005 与 ADR-006 已覆盖迁移、Runtime Composition 和 Compatibility 退出原则；除非 Spec Review 发现新的长期决策冲突，否则不重复新增 ADR。

## 3. 当前需要修正的问题

### 3.1 `adapters/llm` 名称过时

`llm` 同时可能指 Model Invocation Contract、Provider Integration 或具体 SDK Client，无法表达当前 Provider / Model Resolution 架构。这里实际承载的是 Anthropic Provider Integration，候选目标应为 `adapters/provider/anthropic`。

### 3.2 Channel Adapter 混入 Runtime Application component

`CliChannel` 和 `WebSocketChannel` 是外部 Transport Adapter，当前位置合理；`TurnInteractionManager` 管理 Turn 内 pending interaction、Abort 和 settlement 生命周期，直接由 `RuntimeApp` 创建和持有，不属于外部 Transport Adapter。

`TurnInteractionManager` 不是正式 Runtime Module：它不是 `LoadedRuntimeUnit`，不经 Registry 注册，也不形成 Contribution。准确术语是 Turn Interaction application component / manager。

### 3.3 Channel compatibility barrel 仍存在

`adapters/channel/types.ts` 只转发 `core/channel` 类型，导致 Core Contract 仍可经 Adapter 路径访问。`adapters/channel/index.ts` 还导出 `ApprovalManager` 旧别名。两者都会模糊唯一权威路径，应删除而不是继续兼容。

### 3.4 Anthropic 缺少真正的 Bundled Runtime Module

Channel 和 Tool 已有 `runtime-modules/builtin-channels.ts` 与 `runtime-modules/builtin-tools.ts`，Anthropic 的构造和 Provider registration 仍由 Runtime Builder 的默认依赖与内联注册块共同完成。只把已构造的 `ProviderProjectionEntry[]` 包成通用 Unit，不是目标架构定义的 Anthropic Bundled Runtime Module。

候选目标是：Anthropic Module 拥有稳定 Unit identity、Anthropic 构造边界和 Provider Contribution 注册；Runtime Builder 只映射配置、选择 Module 并加入 Runtime Unit catalog。

### 3.5 跨 Provider codec 文件没有单一生产所有者

现有 `tool-contract-codecs.ts` 同时包含 Anthropic 与 OpenAI-compatible reference codecs。生产代码只使用 Anthropic definition encoder；OpenAI-compatible 部分及其他 reference conversions 只用于 Contract expressiveness tests。

生产所需 Anthropic conversion 应归入 Anthropic Adapter。只用于证明 portable Tool Contract 的 Anthropic/OpenAI-compatible reference implementation 应进入对应测试文件，不建立虚假的 OpenAI-compatible production Provider 模块。

拆分后必须防止 production Anthropic codec 与 portability reference codec 静默漂移：两类测试共享 canonical Tool fixtures 和期望值，但不共享 codec 实现。Core portability test 不导入 Anthropic Adapter；Anthropic Adapter test 使用同一组 canonical fixtures 验证 production `tool-codec.ts`。

## 4. 建议目标目录

```text
src/
├── core/
│   ├── channel/                    # Channel/interaction contracts
│   ├── model-invocation/           # provider-neutral invocation Port
│   ├── model-resolution/           # Provider facts and resolution
│   ├── registry/                   # Contribution/Registry contracts
│   └── tools/
│       └── provider-portability.test.ts
│
├── adapters/
│   ├── channel/
│   │   ├── CliChannel.ts
│   │   ├── CliChannel.test.ts
│   │   ├── WebSocketChannel.ts
│   │   ├── WebSocketChannel.test.ts
│   │   └── index.ts                # concrete adapters only
│   └── provider/
│       └── anthropic/
│           ├── AnthropicClient.ts
│           ├── AnthropicClient.test.ts
│           ├── AnthropicProvider.ts
│           ├── AnthropicProvider.test.ts
│           ├── tool-codec.ts
│           ├── tool-codec.test.ts
│           └── index.ts
│
├── runtime/
│   ├── turn-interaction/
│   │   ├── TurnInteractionManager.ts
│   │   ├── TurnInteractionManager.test.ts
│   │   └── index.ts
│   ├── RuntimeApp.ts
│   └── ...
│
└── runtime-modules/
    ├── anthropic-provider.ts
    ├── anthropic-provider.test.ts
    ├── builtin-channels.ts
    ├── builtin-tools.ts
    └── index.ts
```

说明：

- 保留 `adapters/channel`，当前只有两个 Transport 实现，不增加 `cli/`、`websocket/` 子目录；
- 将 `llm` 收敛为具名 `provider/anthropic`，不建立泛化生产 Provider 聚合目录；
- 不增加 `core/provider`。现有 Core 目录已分别拥有 invocation、resolution 和 registry contracts；
- `runtime/turn-interaction` 表达 Runtime-owned application component，不把它称为 Runtime Module；
- `builtin-channels.ts` 与 `builtin-tools.ts` 本次不拆分，不能据此宣称整个 `runtime-modules` 已按模块对齐。

## 5. 规范生产入口

| 模块 | 唯一模块外生产入口 | 约束 |
|---|---|---|
| Anthropic Adapter | `src/adapters/provider/anthropic/index.ts` | 不建立父级 Provider 转发 barrel |
| Channel Adapter | `src/adapters/channel/index.ts` | 只导出 CLI/WebSocket concrete adapters 及配置类型 |
| Turn Interaction component | `src/runtime/turn-interaction/index.ts` | 只导出 `TurnInteractionManager`，不经 Channel Adapter 转发 |
| Bundled Runtime Modules | `src/runtime-modules/index.ts` | Composition 从该入口取得 Module factories |

规范入口同时约束模块外生产代码的 value import、type import 和 re-export。模块内部实现和测试可以使用同目录相对导入。

候选迁移采用一次性 cutover：完成后，生产代码不得再引用 `src/adapters/llm/**`、`src/adapters/channel/TurnInteractionManager.ts`、`src/adapters/channel/types.ts` 或 Channel barrel 中被删除的兼容导出。

## 6. 文件改造建议

| 当前 | 建议 | 原因 |
|---|---|---|
| `src/adapters/llm/AnthropicClient.ts` 及测试 | 移至 `src/adapters/provider/anthropic/` | Anthropic SDK/protocol Adapter |
| `src/adapters/llm/AnthropicProvider.ts` 及测试 | 移至 `src/adapters/provider/anthropic/` | Anthropic connection、model facts 与 invocation binding |
| `tool-contract-codecs.ts` 中生产使用的 Anthropic conversion | 收敛为 Anthropic Adapter 内的 `tool-codec.ts` | 由 Anthropic Adapter 单独拥有 |
| 仅供证明的 Anthropic/OpenAI-compatible codecs | 直接放入 `src/core/tools/provider-portability.test.ts` | 保留 portability proof，不伪装成生产实现 |
| production/reference codec 共用输入与期望值 | 收敛为 test-only canonical fixtures | 防止语义漂移，但不共享 codec 实现或形成 production 依赖 |
| `src/adapters/llm/index.ts` | 替换为 Anthropic module `index.ts` | 消除旧命名并建立唯一入口 |
| `CliChannel.ts`、`WebSocketChannel.ts` 及测试 | 保持在 `src/adapters/channel/` | 纯 Transport Adapter |
| `TurnInteractionManager.ts` 及测试 | 移至 `src/runtime/turn-interaction/` | RuntimeApp-owned application component |
| `src/adapters/channel/types.ts` | 删除 | Core Channel Contract 已是唯一权威 |
| `src/adapters/channel/index.ts` | 仅导出两个 concrete adapters/config | 不再转发 Core 类型、manager 或旧别名 |
| Runtime Builder 的 Anthropic 默认构造与内联 Provider registration | 迁入具名 `anthropic-provider.ts` | 形成拥有构造、身份和 Contribution 的 Runtime Module |
| `RuntimeDependencies.createProviderProjection` | 候选替换为 bundled Provider `LoadedRuntimeUnit` seam | Fake 和 production 不绕过 Module staging |

测试 reference code 与 canonical fixtures 位于 test-only source，会参与当前 `tsconfig.json` 的 TypeScript Program。本提案不声称它们位于 production TypeScript build 之外；约束是非测试生产源码、scripts 和生成工具不得导入，且不得从 production barrel 导出。共享的是 canonical fixtures 和期望值，不是 production/reference codec 实现。

## 7. Anthropic Runtime Module 候选边界

**Current Fact：** 当前源码仍通过 `RuntimeDependencies.createProviderProjection()` 返回裸 `ProviderProjectionEntry[]`，并由 Runtime Builder 构造通用 `builtin-provider-bindings`。以下内容只是候选目标，不表示当前已实现。

```text
createAnthropicProviderModule(options: AnthropicProviderModuleOptions): LoadedRuntimeUnit

RuntimeDependencies {
    createBundledProviderUnit(options: RuntimeProviderOptions): LoadedRuntimeUnit
}

default createBundledProviderUnit(options) = createAnthropicProviderModule(options)
```

候选约束：

1. 删除裸 `createProviderProjection` seam，不能改名后继续返回 `ProviderProjectionEntry`、`RuntimeContributionUnit` 或等价包装；
2. `createAnthropicProviderModule(options)` 只捕获不可变 options 并返回 required、initially-enabled `LoadedRuntimeUnit`；
3. 稳定 Unit ID 候选为 `builtin-anthropic-provider`；
4. Runtime Builder 在 staging 前只把 Unit 放入 `RuntimeUnitCatalog`，不能读取 Module-private Provider entry；
5. `RuntimeCompositionManager` 调用 `LoadedRuntimeUnit.create(signal)` 时才构造 `AnthropicProvider`；
6. Provider entry 封闭在 `RuntimeUnitInstance.registration` closure 内，只经 `registration.register(api)` 进入 staging；
7. Runtime Composition 负责 identity validation、staging、start、candidate resolution、publication 和 cleanup 编排；
8. Fake Provider 提供具名 `LoadedRuntimeUnit`，经过相同 create → registration → staging 路径；
9. RuntimeApp、Runner 和 Core 不识别 Anthropic concrete type；
10. 当前 distribution 只装配一个 required bundled Anthropic Provider Unit；External Provider 继续通过 ordinary `loadedUnits` 接入，不扩展该 seam 为复数；
11. 一个 Fake Unit 可以注册多个 Provider entries，以覆盖多 Provider Model Resolution 场景，而不要求 factory 返回多个 Units。

### 7.1 Default Provider 的 post-Snapshot 来源

删除裸 projection seam 后，`defaultProviderId` 不能再从 staging 前的 `ProviderProjectionEntry[]` 取得。候选 startup flow 固定为：

```text
RuntimeUnitCatalog
    -> RuntimeCompositionManager.start()
    -> published immutable RegistrySnapshot
    -> registrySnapshot.providers[0].id
    -> frozen RuntimeResourceSet.defaultProviderId
    -> RuntimeApp kernel construction
```

约束：

1. `compositionManager.start()` 成功后，Runtime Builder 可以读取已发布 Snapshot 的 readonly Provider projection；
2. 默认 Provider 是 Snapshot 中确定性排序后的第一个 accepted Provider；不得从 Module concrete type、私有 entry、重复 metadata 或 staging 旁路取得；
3. Snapshot 没有 Provider 时 startup fatal，不创建 RuntimeApp kernel、不发出 `app_ready`；
4. `defaultProviderId` 在 RuntimeApp kernel 构造时冻结；每个 Turn 可显式选择其他 Provider，但缺省值不在 Turn 内重选；
5. 当前 required bundled Anthropic Unit 按 Builtin-first 规则先于 External Provider，因此 External Provider 不改变默认 Provider；
6. 若未来引入第二个 bundled Provider Unit，必须由新的 Accepted decision 明确 default selection policy，不能静默依赖新增 Unit 的文件名或偶然注册顺序。

## 8. 构造时机与失败语义

不能把整个候选迁移笼统称为 runtime behavior-preserving。成功路径语义应保持不变，但 Anthropic 构造从 Builder assembly 移到 required Runtime Unit create 阶段后，至少可能改变错误阶段、Unit attribution、cleanup 和诊断顺序。

后续正式 Spec 应至少冻结：

1. 无效 endpoint、deployment facts 或其他构造错误使整个 startup 失败；
2. 错误归属 `builtin-anthropic-provider`，phase 为 `create`；
3. 错误进入 startup failure path，不伪装成 Turn-level Model Resolution failure；
4. 已创建且尚未 handoff 的 candidate units 按 Runtime Composition cleanup contract 清理；
5. `loaded.create()` 尚未返回 instance 时，Framework 无 `stop()` 可调用；Module 必须在抛错前自行释放已取得的可关闭资源，或避免提前取得此类资源；
6. 不发布部分 Registry Snapshot，不创建 RuntimeApp kernel，不发出 `app_ready`；
7. cleanup failure 保持 `candidate-cleanup` fail-closed 语义；
8. 错误分类和诊断顺序由聚焦测试锁定，不依赖不稳定字符串猜测。

如实现取证发现现有 Runtime Composition Contract 无法满足上述候选要求，应暂停 Delivery 并回到正式 Spec Review，不能在代码中增加旁路。

## 9. Turn Interaction 所有权

| 边界 | 拥有 | 不拥有 |
|---|---|---|
| Core Channel | Transport-facing request/response、delivery 和 unavailable contracts | pending Promise、settlement state、Runtime shutdown coordination |
| Turn Interaction application component | pending、settlement、Abort、close 与 fail-closed coordination | Registry Contribution、CLI/WebSocket wire behavior |
| Channel Adapter | 请求呈现、响应接收与传输失败报告 | Turn queue、approval Policy、跨 Channel Runtime 状态 |
| RuntimeApp | 创建并持有 manager，连接 Turn route 与 Channel binding | 具体 CLI/WebSocket 类型判断 |

**Current Fact：** RuntimeApp 已创建并持有 `TurnInteractionManager`，但其源码和公开导出仍位于 Channel Adapter。候选迁移必须同时处理源码、测试、import 和 public export，不能只改变文档所有权。

## 10. 明确不做

- 不重排 `core/memory`、`core/session`、`core/tools/builtin`、`core/workspace` 或 `platform/logger`；
- 不拆分 `builtin-channels.ts` 或 `builtin-tools.ts`；
- 不修改 Provider/Model/Turn 成功路径公共语义；
- 不新增通用 DI Container、Service Locator 或 Provider factory framework；
- 不为旧 Provider/Channel 路径保留 facade、alias 或 hidden flag；
- 不把 OpenAI-compatible reference proof 升级为 production Provider；
- 不顺带统一所有目录单复数；
- 不提前更新 Current Architecture；
- 不把本提案并入 Slice 6，或以本提案阻塞 Slice 6 验收。

## 11. 接受后的治理与实施顺序

本 Proposal 已接受为 successor Migration Spec 的设计输入，但不直接成为 implementation authority。下一步应：

1. 建立独立 post-Foundation Architecture Slice；
2. 建立并接受 Migration Spec，冻结物理拓扑、唯一入口、Module/application component 区分、seam、default Provider 来源、失败语义、Compatibility 删除和验证；
3. 确认 Spec 不与 ADR-003、ADR-005、ADR-006 或既有 Accepted Module Specs 冲突；发现新的长期决策缺口时暂停并另行提议 ADR，不在 Spec 中静默覆盖；
4. 达到 Architecture Slice Definition of Ready；
5. 项目所有者单独授权 production Delivery。

建议未来 Delivery 分批：

- **C1 — 路径与所有权：** 移动 Adapter/manager、拆分 production/test codec、建立唯一入口、删除 facade；不改变 Anthropic 构造时机；
- **C2 — Anthropic Runtime Module：** 迁移 Unit seam、构造和 registration，并验证 create failure/cleanup/Snapshot 原子性；
- **C3 — Current Architecture：** 代码验收后同步 module map、topic evidence、manifest 和链接，再执行最终验证。

## 12. 候选验收条件

1. 生产代码不存在 `src/adapters/llm/` 和 `src/adapters/channel/types.ts`；
2. Adapter barrel 不导出 Core contracts、`ApprovalManager` 或 `TurnInteractionManager`；
3. Anthropic、Channel、Turn Interaction 和 Runtime Modules 的模块外生产 import 只有 §5 入口；
4. Runtime Builder 不直接构造 `AnthropicProvider`，也不包含 `registerProvider` 循环；
5. production 和 Fake Provider 都通过 `LoadedRuntimeUnit` create/registration/staging 接入；
6. `RuntimeDependencies` 使用 singular bundled Provider Unit seam；默认 Provider 只在 Composition start 成功后从 published Snapshot 取得并冻结；
7. Snapshot 无 Provider 时 startup fatal，且不创建 RuntimeApp kernel、不发布部分 Snapshot、不发出 `app_ready`；
8. portability reference implementation 只存在于测试代码，不被生产源码、scripts、生成工具或 barrel 使用；production/reference codec 使用同一 canonical fixtures 验证且实现保持独立；
9. Anthropic Unit create failure 具有稳定归属、candidate cleanup 和 no-partial-Snapshot 证据；
10. 成功路径 Provider/Model/Turn regressions 保持通过；
11. 路径、SDK allowlist、唯一入口、singular Unit seam 和禁止裸 projection seam 由 Architecture Fitness 自动验证；
12. FT-01–FT-12、相关单元/集成测试、lint、clean build 和完整测试通过；
13. 代码验收后 Current Architecture 与最终源码一致；
14. 完成声明只覆盖 Anthropic Provider、Turn Interaction 和相关路径，不宣称全部 Runtime Modules 已按模块拆分。

## 13. 当前结论

项目所有者已接受本提案的局部模块聚合方向，并授权进入 successor Migration Spec 起草。Proposal 不替代 Accepted Spec、不直接授权 production 修改、不改变 Current Architecture、不影响 Slice 6 的独立验收，也不授权 commit 或 push。
