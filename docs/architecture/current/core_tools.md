# Core Tools 与 Hook Registry

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: canonical Tool contract, portable validation, and policy/approval execution boundary
> Ownership key: canonical-tool-contract

---

## 1. 概述

`src/core/tools/` 拥有 Provider-neutral Tool Contract 和 portable Schema validation；`src/core/registry/` 拥有 Contribution、immutable projection 与 Snapshot Contract。Builtin、Memory 和 Task Tool 都通过 `RuntimeContributionUnit` 注册，启动期由 `runtime/registry-builder.ts` 原子 staging。

Core 不使用 Anthropic `input_schema` 或 OpenAI-compatible `function.parameters`。Provider Adapter 从 canonical definition 显式转换 wire shape。

## 2. 目录结构

```text
src/core/tools/
├── types.ts             # canonical definition/call/result/execution contracts
├── portable-schema.ts   # Draft-07 portable subset + Ajv compile/validation
├── index.ts             # public exports
└── builtin/             # builtin implementations

src/core/registry/
├── types.ts             # Contribution / ToolProjection / HookProjection / Snapshot
└── index.ts

src/runtime/
└── registry-builder.ts  # atomic staging of one immutable generation Snapshot
```

## 3. Canonical Tool Contract

```text
Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: PortableToolSchema
  execute(input, context): Promise<ToolExecutionOutput>
}

ToolExecutionContext {
  readonly sessionKey: string
  readonly turnId: string
  readonly callId: string
  readonly signal: AbortSignal
}

ToolExecutionOutput {
  readonly outcome: 'success' | 'failed'
  readonly content: string
}
```

Tool implementation 只能报告真实 execution success/failure。Policy deny、approval unavailable、Abort、not-executed 和 recovery outcome 由 Runner 选择 canonical `ToolResultOutcome`。现有 `AgentEvent.tool_result.result` 仍使用 presentation-compatible `{ content, isError? }`，但该 shape 不再是 Tool implementation boundary。

Canonical Tool Call 保留 Provider opaque `callId`，并明确区分 decoded object、malformed JSON 和 non-object input。Canonical Tool Result 保存 `callId + outcome + content`；Provider wire 只要求 correlation/content 可移植。

## 4. Portable Schema 与 validation

`compilePortableToolSchema()` 在 staging 时执行：

- root 必须是 object Schema；
- 仅允许 accepted v1 Draft-07 subset；
- unknown/provider-specific keyword、非法 `required`、非有限数值等立即拒绝 unit；
- Ajv 禁用 coercion、defaults 和 property removal；
- Snapshot 保存 deep-frozen Schema 与 compiled validator；
- Runner 只校验 `before_tool_call` 完成后的 effective input。

## 5. Contribution 与 Snapshot

```text
RuntimeContributionUnit.register(api)
  ├─ api.registerTool(tool)
  └─ api.registerHook(contribution)

buildRegistrySnapshot({ providers, units })
  ├─ 每个 unit 独立 staging
  ├─ Builtin invalid → startup failure
  ├─ External invalid → 整个 unit 隔离并记录 diagnostic
  └─ 发布 frozen RegistrySnapshot
       ├─ providers
       ├─ tools: ToolProjection
       └─ hooks: HookProjection
```

`ToolProjection.resolve()` 返回 canonical implementation 与 validator；`visibleDefinitions(policy)` 是 pure deny-filtered view，不修改 Snapshot。Hook projection 按 priority、unit ID、contribution ID 稳定排序。

每个 generation 只发布一个完整 Snapshot。Workspace、Memory 和可选 Task units 都在该 generation publication 前完成 staging；RuntimeApp 不追加 Task、不替换 executor，也不重建 partial Snapshot。Reload 可以发布下一完整 generation，但已开始的 root/child request tree 继续使用其捕获的 Snapshot identity。

## 6. Provider conversion

Anthropic Adapter 显式映射 canonical definitions/calls/results。`tool-contract-codecs.ts` 提供 Anthropic 与 OpenAI-compatible pure reference codecs，覆盖 definition round-trip、complete/streamed/multiple calls、interleaved fragments、malformed/non-object input、duplicate identity 和 correlated results。OpenAI codec 是 portability proof，不代表 production OpenAI client。

## 7. Policy and approval execution boundary

Tool visibility and Tool execution are separate controls:

1. Snapshot construction compiles and freezes the canonical Tool plus validator.
2. Application deny policy filters the Model-visible definition projection.
3. Runner resolves the returned call against the same immutable projection.
4. `before_tool_call` interceptors may replace input or deny execution.
5. Runner validates effective input, applies deny/allow policy, and invokes the optional current-call approval capability for an unmatched Tool.
6. Only then does Runner call `Tool.execute()`.

Every accepted Tool Use receives exactly one terminal canonical result, including malformed input, unknown Tool, denial, unavailable approval, Abort, execution failure and recovery paths. Approval is an explicit application capability, not a mutable Hook or Tool implementation property. Runtime routing and interaction settlement are owned by [Runtime](./runtime.md) and [Channel](./adapter_channel.md). Builtin behavior is owned by [Builtin Tools](./core_tools_builtin.md).

## 8. Evidence

| Kind | Evidence |
|---|---|
| Source | [Tool contracts](../../../src/core/tools/types.ts), [portable-schema.ts](../../../src/core/tools/portable-schema.ts), [Registry contracts](../../../src/core/registry/types.ts), [registry-builder.ts](../../../src/runtime/registry-builder.ts), [AgentRunner.ts](../../../src/core/runner/AgentRunner.ts) |
| Tests | [portable-schema.test.ts](../../../src/core/tools/portable-schema.test.ts), [AgentRunner.tool-pipeline.test.ts](../../../src/core/runner/AgentRunner.tool-pipeline.test.ts), [registry-builder.test.ts](../../../src/runtime/registry-builder.test.ts), [ft-07-registry-snapshot.test.ts](../../../src/architecture-fitness/ft-07-registry-snapshot.test.ts), [ft-08-contract-inventory.test.ts](../../../src/architecture-fitness/ft-08-contract-inventory.test.ts) |
| Controlling authority | [Tool/Hook Module Spec](../tool-hook-module-spec.md), [ADR-001](../adr-001-tool-result-closure-and-recovery.md), [ADR-005](../adr-005-extension-registry-runtime-composition.md) |
