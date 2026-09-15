# Tool Contract and Policy

> Status: Current Authority
> Authority: Current implemented Tool behavior
> Verified: 2026-09-15
> Ownership: Canonical Tool contract, portable validation, Registry projection, policy, approval, and execution boundary
> Ownership key: canonical-tool-contract

## 1. Boundary

`src/core/tools/` owns the Provider-neutral Tool contract and portable input-schema validation. `src/core/registry/` owns Contribution and immutable projection contracts. Runtime composition stages Units and publishes complete Registry generations.

Concrete filesystem, search, web, Exec, and Process behavior belongs to [Builtin Tools](builtin-tools.md). Runtime routing and interaction settlement belong to [Runtime](runtime.md) and [Channels](channels.md).

Core contracts do not expose Anthropic `input_schema` or OpenAI-compatible `function.parameters`. Provider adapters map canonical definitions and calls to their own wire protocols.

## 2. Canonical contracts

```text
Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
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

A Tool implementation reports only actual execution success or failure. Runner owns outcomes that occur outside implementation execution: `unknown_tool`, `denied`, `invalid_input`, `unavailable`, `aborted`, `not_executed`, and recovery handling. The public `AgentEvent.tool_result.result` remains the presentation-compatible `{ content, isError? }` shape; it is not the Tool implementation boundary.

A canonical Tool Call preserves the Provider-opaque `callId`, Tool name, and either a decoded object or the explicit invalid reason `malformed_json` or `not_an_object`. A canonical Tool Result preserves `callId`, outcome, and content.

`ToolExecutionContext.signal` is always present. It tells implementations about Turn cancellation but cannot force a heterogeneous third-party Tool to stop; Runner's invariant is that it stops scheduling additional implementation work.

## 3. Portable input schemas

`compilePortableToolSchema()` accepts a bounded Draft-07 profile:

- the root must be an object Schema;
- every Schema node must declare one portable type;
- only the type-appropriate accepted keywords are allowed;
- `required` names must be unique and present in `properties`;
- values must be plain JSON data with finite numbers;
- provider-specific and unsupported composition keywords are rejected.

Ajv runs with coercion, defaults, and property removal disabled. Compilation defensively clones the Schema, deep-freezes the canonical copy, and returns normalized immutable validation errors. Registry staging compiles contributed Schemas before publication, and finalization binds the frozen Schema and compiled validator to the resolved Tool.

Runner validates only the effective input after `before_tool_call` transformation. Hook replacement inputs must themselves be plain JSON objects.

## 4. Contributions and immutable projections

```text
RuntimeContributionUnit.register(api)
  ├─ registerProvider(...)
  ├─ registerTool(...)
  ├─ registerHook(...)
  └─ registerChannel(...)

complete accepted Unit set
  -> frozen RegistrySnapshot generation
       ├─ Unit provenance
       ├─ Provider projection
       ├─ ToolProjection
       ├─ HookProjection
       ├─ Channel projection
       └─ startup diagnostics
```

Each Unit is staged independently. Duplicate contribution identities are rejected atomically: invalid or conflicting Builtin Units fail startup, while optional external Unit failures/conflicts are isolated by composition and surfaced as diagnostics. Accepted Units are ordered Builtin-first and then deterministically by acquisition key and Unit identity.

`ToolProjection` exposes:

- `definitions`: the immutable canonical definitions;
- `resolve(name)`: the implementation, definition, validator, and owning Unit;
- `visibleDefinitions(policy)`: a pure deny-filtered Model view that does not remove the implementation from the Snapshot.

Hook projection order is priority descending, then Unit ID and contribution ID ascending. A Registry generation is published as one complete Snapshot. A root/child request tree continues with its captured Snapshot identity even if a later generation is published.

## 5. Provider portability and production conversion

Provider portability is proven by [provider-portability-fixtures.ts](../../src/core/tools/provider-portability-fixtures.ts) and [provider-portability.test.ts](../../src/core/tools/provider-portability.test.ts). The test-local pure reference codecs cover:

- canonical definition semantics on Anthropic and OpenAI-compatible wire shapes;
- complete and streamed calls in Provider order;
- multiple and interleaved call fragments;
- malformed and non-object input;
- incomplete or duplicate call identity failure;
- correlated result content; and
- non-mutation of canonical Schemas and inputs.

These references are portability evidence, not a production OpenAI client. Production Anthropic definition conversion is [tool-codec.ts](../../src/builtins/providers/anthropic/tool-codec.ts), which maps `inputSchema` to `input_schema`; [AnthropicMessagesClient.ts](../../src/builtins/providers/anthropic/AnthropicMessagesClient.ts) owns Anthropic stream call decoding and message conversion.

## 6. Policy, approval, and execution order

Tool visibility and execution are separate controls:

1. Registry staging validates and freezes the canonical Tool, Schema, and validator.
2. Application deny policy filters the Model-visible definition projection.
3. Runner decodes the returned canonical call and fails malformed input before Hook, policy, approval, or implementation work.
4. Runner resolves the Tool against the same immutable projection; an unknown Tool closes without invoking Hooks.
5. `before_tool_call` interceptors run sequentially in Snapshot order and may replace input or deny execution.
6. Runner validates the final effective input.
7. Application policy decides allow, deny, or requires-approval.
8. For requires-approval, Runner invokes the optional current-call Approval Capability and preserves denial, unavailable, failure, and Abort outcomes.
9. Only an allowed, valid call reaches `Tool.execute()`.
10. Runner creates one correlated terminal canonical result and starts `after_tool_call` observers.

Application policy still denies a stale Provider call even when that Tool definition was filtered from the Model request. Approval is an explicit current-call capability, not mutable Hook state or a Tool property.

`before_tool_call` is an awaited Interceptor. `after_tool_call`, `before_compaction`, and `after_compaction` are parallel Observers with isolated rejection and a per-handler five-second logical-settlement deadline. Turn Abort aborts each Observer's local signal. Runner persists the complete Tool Result batch before waiting for `after_tool_call` settlements and waits for those settlements even if persistence fails.

Every accepted Tool Call receives exactly one terminal result, including malformed input, unknown Tool, Hook denial/failure, validation failure, policy denial, unavailable approval, Abort, implementation failure, and not-executed closure.

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [Tool contracts](../../src/core/tools/types.ts), [portable-schema.ts](../../src/core/tools/portable-schema.ts), [Registry contracts](../../src/core/registry/types.ts), [registry-builder.ts](../../src/runtime/registry-builder.ts), [runtime-composition-manager.ts](../../src/runtime/runtime-composition-manager.ts), [AgentRunner.ts](../../src/core/runner/AgentRunner.ts), [Anthropic tool-codec.ts](../../src/builtins/providers/anthropic/tool-codec.ts) |
| Tests | [portable-schema.test.ts](../../src/core/tools/portable-schema.test.ts), [provider-portability.test.ts](../../src/core/tools/provider-portability.test.ts), [tool-codec.test.ts](../../src/builtins/providers/anthropic/tool-codec.test.ts), [AgentRunner.tool-pipeline.test.ts](../../src/core/runner/AgentRunner.tool-pipeline.test.ts), [hooks/runner.test.ts](../../src/core/runner/hooks/runner.test.ts), [registry-builder.test.ts](../../src/runtime/registry-builder.test.ts) |
| Controlling authority | [Tools and Hooks](../specifications/tools-and-hooks.md), [Approval Lifecycle](../specifications/approval-lifecycle.md), [ADR-001: Tool Result Closure and Recovery](../decisions/adr-001-tool-result-closure-and-recovery.md), [ADR-005: Extension Registry Runtime Composition](../decisions/adr-005-extension-registry-runtime-composition.md) |
