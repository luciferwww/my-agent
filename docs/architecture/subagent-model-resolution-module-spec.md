# Subagent Model Resolution Module Spec

## 状态

- **状态：** Validated
- **版本：** 0.2
- **日期：** 2026-09-04
- **所有者：** 项目所有者
- **Plan Item：** [Architecture Foundation Plan](../roadmap/architecture-foundation-plan.md) Slice 2
- **关联 ADR / Spec：** [ADR-003](adr-003-progressive-architecture-migration.md)、[ADR-004](adr-004-provider-model-identity-and-facts-ownership.md)、[ADR-006](adr-006-legacy-and-compatibility-exit.md)、[Model Resolution Module Spec](model-resolution-module-spec.md)
- **证据输入：** [Target Architecture §5.7](target-architecture.md#57-subagent-独立-model-resolution-调用流)、[Target Architecture §8.6](target-architecture.md#86-subagent-delegation独立-resolution-与结果归一化)、[AF-05 Results](af-05-provider-model-resolution-spike-results.md)、[Legacy Migration Inventory](legacy-migration-inventory.md)

本 Spec 遵循 [Development Workflow](../development-workflow.md) 和 [Architecture Foundation Plan §7.4](../roadmap/architecture-foundation-plan.md#74-当前架构重构文档的语言与术语约定)。项目所有者确认：Subagent 必须有真实 Parent Turn；删除无 Parent 的 public `RuntimeApp.runSubagentTurn()`；Profile 使用 native Model Reference 且必须显式选择 `inherit` 或具体 Reference；旧 Subagent public/host/request Contract 不保留 Compatibility；Child capability requirements 从实际请求派生。Independent review 的 Critical/High/Medium findings 已解决，项目所有者于 2026-09-04 接受本 Spec，并随后单独批准 Slice 2 进入 production Delivery；不授权提交、推送或 Slice 3–6。

项目所有者于 2026-09-04 接受 Delivery 验证结果并确认 Slice 2 完成。该确认不授权提交、推送或 Slice 3–6。

## 1. 目的与用户可观察结果

Slice 2 让每个真实 Parent Turn 委派的 Child Turn 独立解析 Model：

- Profile 选择具体 Model Reference 时，Child 可以使用与 Parent 不同的 Provider/Model；
- Profile 选择 `inherit` 时，只继承 Parent 的规范化有效 Model Reference，然后为 Child 重新解析，不共享 Parent `ResolvedModel`、Invocation Port 或可变 request state；
- Child resolution 失败时不发生 Provider invocation，并向 Parent `task` 调用归一化一个可分类的 terminal error result；
- Usage、Abort、Session 隔离、blocking Tool 语义和既有 Parent/Child Event correlation 保持不变。

## 2. 范围

- native Subagent Profile Model Selection；
- read-only、per-Turn effective Model Reference context；
- 真实 Parent → Child delegation 的独立 Model Resolution；
- Child actual request → capability requirements 的单一派生路径；
- Child setup、resolution、execution 的一次 terminal result 与 cleanup；
- 删除 Slice 1 `legacy-child` Compatibility、静态 LLM defaults 复制和无 Parent library path；
- 更新 CODE-M09 disposition、相关 public exports、tests 和 Fitness rules。

## 3. 非目标

- Child Tools 接入、Profile `tools.allow/deny` 执行或 Tool/Hook Registry；这些属于 Slice 3；
- Child 多模态输入或 attachment forwarding；
- 并发、Batch、Background、Detached、Handoff、Agent Team 或第二个 scheduler；
- Extension Registry、dynamic reload、Snapshot replacement 或 Runtime Builder 全面收敛；
- Provider Catalog/Facts redesign、remote discovery、paid probe 或新的 Provider；
- Session persistence、Prompt、Channel、Approval 或 Event schema 的通用重构；
- 为删除的 Subagent API、raw Profile model string 或旧 host/request export 建立 Compatibility facade；
- 创建无 Parent 的“Subagent”。未来若需要 direct library execution，必须另行设计 Root Agent API，不属于 Slice 2。

## 4. 当前 baseline 与问题

当前真实 Tool path 为：

`Parent AgentRunner` → `task` Tool → `SubagentRunner.run()` → `resolveLegacyChildModel({ model: profile.model })` → `ModelResolver.resolve()` → shared `AgentRunner.run({ resolvedModel })`。

当前路径已经为 Child 生成独立 `ResolvedModel`，但仍有以下 Legacy：

- Profile `model?: string` 允许省略、`inherit` 和裸 model ID，不能原生表达 Provider identity；
- `inherit` 实际回退 startup global default model，而不是 Parent Turn effective Model Reference；
- Child Adapter 复制 `defaultProviderId`、`defaultModel` 和 `defaultMaxTokens`；
- Child requirements 在 Compatibility 中硬编码为无 Tools/media，而不是从实际 request 派生；
- `SubagentRunner` 同时分配 identity、登记 route、准备 session/prompt、执行 resolution 和启动 Runner；
- public `RuntimeApp.runSubagentTurn()` 在没有 Parent Turn 时伪造 Parent identity，违反 Subagent 定义和 Target Architecture。

## 5. Ownership 与依赖方向

| 概念 | 权威所有者 | 禁止责任 |
|---|---|---|
| Profile Model Selection schema | Platform Configuration；语义属于 Subagent Orchestration | Provider Facts、Resolved Model、全局 default fallback |
| Parent effective Model Reference | Model Resolution 产生；Runtime Turn context 持有 | Runner 转发、从 raw Config 重建 |
| Child reference selection | Subagent Orchestration | 共享 Parent Resolved Model、按 model string 猜 Provider |
| Child identity、parent correlation、route、tree signal、terminal record | RuntimeApp Turn orchestration | SubagentRunner 私自创建未登记 Child、synthetic Parent |
| Child request assembly | Subagent Orchestration/Runtime execution boundary | caller 手填 capability declaration |
| Child resolution | ModelResolver | Tool loop、session mutation、Provider invocation |
| Child execution | AgentRunner | Model selection、Facts inference、Compatibility mapping |

依赖方向为 Runtime/Orchestration → Model Resolution → Provider projection。Runner 只接收 Child `ResolvedModel`。新路径不得依赖 `src/compat/model-resolution/legacy-child.ts`。

Task Tool 不再持有或调用 concrete `SubagentRunner`。Stable Core 定义窄的 internal delegation Port，Runtime 实现并注入该 Port；Runtime 内部的 Child execution component 只负责准备 prompt/session input 并调用 AgentRunner，不再拥有 Parent validation、Model selection、resolution 或 terminal record。

## 6. Public 与内部 Contract

### 6.1 Profile Model Selection

逻辑 Contract：

```ts
type SubagentModelSelection =
  | 'inherit'
  | { readonly providerId?: string; readonly modelId: string };
```

每个 user-defined Profile 必须显式提供 `model`。省略不是 `inherit`；空白、unknown field 或旧裸 model string 在 Config validation 时失败。builtin `general-purpose` Profile 由系统显式设为 `inherit`。

该 Contract 是有意的 breaking replacement：不保留 raw string Compatibility，也不通过字符串分隔符编码 Provider。

### 6.2 Turn Model Resolution Context

每个已解析 Parent Turn 提供一个只读逻辑 context：

```ts
interface TurnModelResolutionContext {
  readonly turnId: string;
  readonly effectiveReference: ModelReference;
}
```

`effectiveReference` 来自 Parent authoritative resolution 的 canonical Provider/Model identity，不从 Config、raw input 或 Runner 参数重建。Context 只暴露给 Runtime/Subagent Orchestration，不进入 AgentRunner，不是通用 Service Locator，也不包含 credential、SDK object 或 Parent `ResolvedModel`。

### 6.3 Child delegation

Slice 2 只接受来自活动 Parent Turn 的 internal delegation。Runtime 必须验证 Parent identity 仍登记且 Child 使用 Parent tree signal。外部不再获得无 Parent 的 `RuntimeApp.runSubagentTurn()`。

逻辑 Port 不冻结最终 TypeScript 文件布局：

```ts
interface SubagentDelegationPort {
  delegate(request: {
    readonly profile: SubagentProfile;
    readonly description: string;
    readonly prompt: string;
    readonly parent: {
      readonly sessionKey: string;
      readonly turnId: string;
      readonly toolUseId: string;
    };
    readonly signal: AbortSignal;
  }): Promise<SubagentTerminalResult>;
}
```

Task Tool 从当前 `ToolContext` 提供 Parent identity/signal；Runtime 将其与自己的 active Parent record 原子核对。该 record 至少持有 Parent session/turn identity、tree signal 和 `TurnModelResolutionContext`。Parent 只有在 resolution 成功并登记为 active 后才可 delegate；Parent terminal transition 后不再接受新 Child。

Profile selection：

- `inherit` → Parent `effectiveReference`；
- concrete Reference → 该 Reference；未写 `providerId` 时使用 Model Resolution 的明确 default Provider policy；
- 两种情况都调用同一 `ModelResolver` 生成新的 Child `ResolvedModel`。

### 6.4 Request requirements

外部 caller 和 Profile 不提供 `tools: boolean` 或 `mediaKinds` capability declaration。Runtime 从即将交给 Child Runner 的同一份 actual request 派生：

- `tools = finalToolDefinitions.length > 0`；
- `mediaKinds = actual message content blocks` 中出现的 media kinds。

Slice 2 不给 Child 接入 Tools，Child prompt 仍是 string，因此当前派生结果为 `tools: false`、`mediaKinds: []`。这些值只需由一个小型纯函数从 assembled Child execution input 派生，不要求建立通用 request builder，也不得继续由 Compatibility adapter 独立硬编码。

Model 不支持 actual request requirements 时必须在 invocation 前明确失败；不得静默删除 Tool definitions、media content 或切换 Model。

## 7. 行为流程

1. Parent Runner 调用 `task` Tool，并携带真实 Parent session/turn identity 与 tree signal；
2. Subagent Orchestration 解析 Profile；unknown Profile 保持现有 Tool fallback 到 builtin `general-purpose`；
3. Task Tool 调用 injected delegation Port；Runtime 原子验证 active Parent record，分配 Child identity 并发出一次 correlated `subagent_start`；
4. Runtime 尝试登记 Child route/tree；
5. Orchestration 根据 Profile concrete Reference 或 Parent effective Reference 选择 Child Reference；
6. 准备 Child temporary session、prompt 和 actual request；
7. 从 actual request 派生 requirements；
8. Runtime 调用 authoritative Resolver；失败时不调用 Provider；
9. 成功时将新的 Child `ResolvedModel` 与同一 actual request 交给 shared AgentRunner；
10. Runtime 记录并 fanout 一次 correlated Child terminal outcome；
11. 只释放已登记 route，只清理已实际取得的 temporary resource，并把结果归一化为 Parent Tool Result。

不得存在 CLI、script、Tool 或 Runner 自行选择 Provider/Model 的第二条路径。

## 8. Lifecycle、Abort 与 cleanup

- Subagent 必须属于一个真实活动 Parent Turn；Parent 不存在或已结束时拒绝创建 Child；
- Child 使用 Parent tree signal，不创建独立 Root Abort controller；
- registration、setup、resolution、Runner execution 和 cleanup 都观察同一 signal；
- accepted Child delegation 的 Abort/Shutdown 与 normal/error completion 进入同一个顺序化 terminal selection；只产生一个 `subagent_end`；
- setup/resolution 失败只释放已经成功登记或取得的资源；
- awaited setup operation 不要求新增可取消 primitive；若 signal 在 operation 中触发，则 operation 返回后立即检查 signal、禁止进入下一阶段并清理已取得资源；
- 本 Slice 只实现 Target Architecture §8.6 中当前 blocking Child 的 Parent validation、route/tree signal、resolution、terminal result 与 cleanup 子集；不宣称完成未来 Registry Snapshot pin、通用 scheduler、dynamic lifecycle 或 Slice 5 Runtime Builder transaction。

### 8.1 Lifecycle matrix

| 阶段 | start/end | Provider invocation | 结果与 cleanup |
|---|---|---:|---|
| active Parent validation 失败 | 0 / 0 | 0 | 未接受 Child；直接返回 Parent error ToolResult，无资源 |
| identity 已分配，route registration 失败 | 1 / 1 | 0 | `setup` error；未成功登记则不 release route |
| session/context/prompt setup 失败或 Abort | 1 / 1 | 0 | `setup` error 或 `aborted`；release 已登记 route，删除已取得 temporary session |
| Model Resolution 失败 | 1 / 1 | 0 | `resolution` error + category；执行相同 acquired-resource cleanup |
| AgentRunner 完成、失败或 Abort | 1 / 1 | 0..n | `ok` / `error` / `aborted` / `max_llm_calls`；保留已报告 Usage 后 cleanup |
| terminal result 后 cleanup 失败 | 不增加 Event | 不增加 | 不改变已选择 outcome；记录 sanitized diagnostic，并继续其他 eligible cleanup |

## 9. Error 与结果语义

- Profile schema 无效：startup/config validation 失败；
- Parent 不活动：delegation 在 Child invocation 前失败；
- Child resolution failure：保留 `ResolutionFailureCategory`，Provider invocation count 为零；
- setup/resolution/execution failure：统一产生 `SubagentRunResult.outcome = 'error'` 和一次 correlated `subagent_end`；
- Parent `task` 将 Child error 归一化为 error `ToolResult`，不让 raw Provider/SDK error 穿透；
- Abort 产生 `outcome = 'aborted'`；不得重分类为普通 error；
- 已发生的 Usage 不得重复累计或重置以掩盖成本；resolution 前失败的 Usage 为零。

internal terminal result 至少包含 correlation IDs、`outcome`、top-level Usage，以及 error 时的 discriminated stable information：

```ts
type SubagentTerminalFailure =
  | { readonly phase: 'setup'; readonly message: string }
  | {
      readonly phase: 'resolution';
      readonly category: ResolutionFailureCategory;
      readonly message: string;
    }
  | { readonly phase: 'execution'; readonly message: string };

interface SubagentTerminalResult {
  readonly runId: string;
  readonly sessionKey: string;
  readonly turnId: string;
  readonly outcome: 'ok' | 'error' | 'aborted' | 'max_llm_calls';
  readonly usage: TokenUsage;
  readonly failure?: SubagentTerminalFailure;
}
```

只有 `phase: 'resolution'` 能携带 Resolution category。AgentRunner normal result 是 execution Usage 的权威来源；若 AgentRunner 在已有成功调用后失败，Runner execution boundary 必须抛出以下最小 core-owned typed failure，Child executor 捕获后把 `usage` 复制到 `SubagentTerminalResult.usage`，并把 sanitized `message` 映射为 `phase: 'execution'`。Subagent 层不得解析 Event 或 raw error 重建 Usage。

```ts
interface AgentExecutionFailure {
  readonly kind: 'agent_execution_failure';
  readonly message: string;
  readonly usage: TokenUsage;
}
```

该 failure 在 AgentRunner 已建立 per-run accumulator 后包裹逃逸的 non-Abort execution error；尚无成功调用时 Usage 为零。Abort 继续走现有 aborted result，不转换为 execution failure。该最小 Runner error enrichment 属于 Slice 2，不改变 Provider error taxonomy、重试或正常 `RunResult`。

本 Slice不新增通用 retry；Model Resolution failure 不重试或 fallback Provider。

## 10. Compatibility、migration 与删除

### 10.1 Breaking decisions

项目所有者已确认以下 Subagent 边界不保留 Compatibility：

- 删除无 Parent 的 public `RuntimeApp.runSubagentTurn()`；
- 删除 `RunTrigger` 的 `library` variant 和 synthetic Parent/session semantics；
- Profile `model` 从 optional/raw string 改为 required native Model Selection；
- 删除 legacy Child resolver、host method 和旧 public host/request construction exports。

repository 外 consumer 不作为保留错误语义的理由；这是明确 breaking migration。Release note/API versioning 由发布流程记录，不在 production 中保留双路径。

### 10.2 CODE-M09 migration

Slice 2 的 Legacy 起始口径为一个聚合 entry `CODE-M09`，包含：legacy Child model inputs、`resolveLegacyChildModel`、static LLM defaults 复制、parentless library path 和旧 Subagent host/request boundary。完成时全部删除，因此目标为：

$$
Legacy_{start}=1,\qquad Legacy_{end}=0
$$

API-M03 的 Runner Contract 已在 Slice 1 完成迁移，不再列为 Slice 2 Child Compatibility。API-M01 Parent input 与 API-M04 deprecated LLM facade 不属于本 Slice，不顺带删除：API-M01 因 Parent public input successor 尚未进入范围而延期到 Slice 5 Runtime Composition Review；API-M04 因 external consumer decision 与最终 legacy barrel closeout 未完成而延期到 Slice 6 Review。两者禁止新增 production caller。

### 10.3 Rollback

不使用 migration Feature Flag。rollback 只通过完整版本/发布回滚；一个进程内不保留 old/new Child resolution 双路径。

## 11. 删除条件

- `src/compat/model-resolution/legacy-child.ts` 及其 tests 删除；
- `SubagentHostBindings.resolveLegacyChildModel` 和 copied static LLM defaults 删除；
- no-Parent `RuntimeApp.runSubagentTurn()`、`library` trigger 和 synthetic Parent logic 删除；
- `TaskToolDeps.subagentRunner` 改为 internal delegation Port；concrete Runner 不再成为 Tool dependency；
- Profile model omission/raw string 不再进入 production；
- Child concrete/inherited Reference 都生成新的 `ResolvedModel`；
- Child resolution requirements 来自 actual request；
- SubagentRunner/Runner 不读取 Parent Resolved Model、raw Profile model 或 Config defaults；
- repository callers 和 exports 已迁移，没有新 Core → Compatibility dependency；
- `RunTrigger`、`SubagentRunInput`、`SubagentHostBindings`、`SubagentRunnerDeps` 和旧 `SubagentRunRequest` public exports 删除或由本 Spec 的窄 internal Contract replacement；`AgentEvent` 不再反向 import legacy `RunTrigger`；
- parentless scenarios 从 `test-subagent-e2e.ts`、`test-subagent-live.ts` 和 Runtime unit tests 删除，不改写为另一种 synthetic Child；
- AgentRunner escaping execution failure 携带已累计 Usage，并在 Child executor boundary 转换为 discriminated terminal failure；
- Inventory 中 CODE-M09 进入 `Migrated`，且没有 hidden Flag 或第二权威路径。

## 12. 验收场景

- **AC-SMR-01 Explicit inherit：** `inherit` 读取 Parent canonical effective Reference，并为 Child 生成不同实例的 `ResolvedModel`；identity 可相同但 binding/result 不共享可变 state。
- **AC-SMR-02 Different Provider/Model：** concrete Profile Reference 可选择与 Parent 不同的 Provider/Model，并原子切换 Child Port、Protocol、Endpoint 和 Facts。
- **AC-SMR-03 No Parent：** 不存在 public parentless Subagent path；无活动 Parent 的 internal delegation 在创建/invocation 前失败。
- **AC-SMR-04 Fail closed：** 每个 Child Resolution Failure 在 Provider invocation 前成为一次 typed terminal Child error 与 Parent error ToolResult。
- **AC-SMR-05 Actual requirements：** Resolver requirements 与交给 Child Runner 的 actual Tools/media 一致；Slice 2 baseline 为 false/empty。
- **AC-SMR-06 Turn pin：** Parent/Child 各自固定自己的 `ResolvedModel`；Tool loop/Compaction retry 不重新解析。
- **AC-SMR-07 Behavior preservation：** blocking execution、prompt/context isolation、Usage、Abort、Session cleanup、depth limit 和 Event correlation 保持。
- **AC-SMR-08 Cleanup：** registration、setup、resolution 或 execution 任一阶段失败/Abort 都只有一次 end，且只释放已取得资源。
- **AC-SMR-09 Direction：** Child production path 不依赖 Compatibility，Runner 不读取 Model Reference/Config。
- **AC-SMR-10 Legacy exit：** CODE-M09 完整删除，API-M03 inventory wording 修正，`Legacy_end = 0 < Legacy_start = 1`。

## 13. 分层验证

### Unit / Contract

- Profile native selection schema：required、`inherit`、concrete Provider/Model、invalid raw string；
- inherited/concrete Child reference selection；
- actual request requirements derivation；
- Parent effective Reference context read-only/no Runner exposure；
- resolution categories、no invocation 和 normalized Tool error；
- setup-stage acquired-resource cleanup 与 exactly-once end。

### Integration / Regression

- real Parent `task` → inherited Child → shared Resolver → Child Runner；
- Parent/Child different Provider/Model；
- Parent Abort before/during Child resolution/execution；
- existing prompt/context merge、Session isolation、Usage、depth、Tool result 和 Event correlation；
- no public/synthetic library path 或 remaining repository caller。

### Static / Build

- FT-01、FT-03；FT-04 root 扩展到新的 Subagent Core/delegation path；FT-08 登记保留的 delegation Port、terminal result 与 Event Contract；
- 对 CODE-M09、`legacy-child`、`runSubagentTurn`、`library-synthetic`、`TaskToolDeps.subagentRunner`、旧 host/request exports 做 deterministic zero-reference audit；
- document diagnostics、FT-09、local link audit、`npm run lint`、相关 Vitest、`npm run build` 和 `git diff --check`。

不重复增加已有 prompt merge、Usage、Abort、Session 或 Tool result baseline tests；新测试只证明 native reference、真实 Parent、独立 resolution、failure/cleanup 或删除边界。

## 14. Definition of Ready

- [x] Plan Item、用户可观察结果和非目标已起草；
- [x] ADR-003/004/006、Target Architecture 与 Validated Slice 1 Spec 提供权威边界；
- [x] AF-05 已证明 Parent/Child independent resolution；本 Slice 只使用现有 blocking control flow、AbortSignal 和 acquired-resource bookkeeping，不引入新的并发/lifecycle primitive，因此无需新 Spike；
- [x] ownership、依赖方向、Compatibility 与删除条件已起草；
- [x] 项目所有者确认 no-Parent public API、Profile native selection、explicit inherit、旧 exports 和 actual-request requirements 的设计方向；
- [x] 分层 validation 与不重复测试原则已起草；
- [x] independent Spec review 已完成；接受并最小修正 internal Port、terminal result/Usage、caller inventory、lifecycle matrix、Fitness 和 Plan 同步意见；拒绝新增 lifecycle Spike，因为收窄后的 Slice 不包含未验证的新 primitive（2026-09-04）；
- [x] 项目所有者接受本 Spec 并将状态改为 `Accepted`（2026-09-04）；
- [x] 项目所有者另行批准 Slice 2 进入 Delivery（2026-09-04）。

## 15. Open Questions

无 architecture-level blocking unknown。Independent review 可以提出局部 Contract 修正，但不得扩大到 Slice 3 Tools、并发或 Runtime Builder。