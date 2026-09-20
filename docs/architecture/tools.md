# Tool Contract and Policy

> Status: Current Authority
> Authority: Current implemented Tool behavior
> Verified: 2026-09-18
> Ownership: Canonical Tool contract, portable validation, Registry projection, policy, approval, and execution boundary
> Ownership key: canonical-tool-contract

## 1. Boundary

`src/core/tools/` owns the Provider-neutral Tool contract and portable input-schema validation. `src/core/registry/` owns Contribution and immutable projection contracts. Runtime composition stages Units and publishes complete Registry generations.

Concrete filesystem, search, web, Exec, and Process behavior belongs to [Builtin Tools](builtin-tools.md). Runtime routing and interaction settlement belong to [Runtime](runtime.md) and [Channels](channels.md).

Core contracts do not expose Anthropic `input_schema` or OpenAI-compatible `function.parameters`. Provider adapters map canonical definitions and calls to their own wire protocols.

## 2. Canonical contracts

`types.ts` defines immutable Tool identity/schema, execution context, implementation output, and canonical call/result shapes. Implementations report execution success/failure; Runner owns all pre-execution, cancellation, closure, and recovery outcomes. [Tools and Hooks](../specifications/tools-and-hooks.md) owns the stable contract.

## 3. Portable input schemas

`compilePortableToolSchema()` validates the bounded portable profile, clones and freezes the canonical Schema, and returns normalized immutable validation errors. Registry staging compiles before publication; Runner validates only effective input after interceptor transformation.

Runner validates only the effective input after `before_tool_call` transformation. Hook replacement inputs must themselves be plain JSON objects.

## 4. Contributions and immutable projections

`registry-builder.ts` stages each Unit's Tool/Hook contributions, validates conflicts atomically, orders accepted contributions, and builds immutable definitions, resolution, visibility, and Hook projections. Runtime publishes those projections only as part of a complete generation; root/Child request trees keep the captured Snapshot.

## 5. Provider portability and production conversion

Provider adapters independently map canonical definitions, calls, and results to wire formats. The unified Built-in Provider's Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions Clients own their respective definition, call, result, and stream conversion behind one model-aware routing Port.

## 6. Policy, approval, and execution order

`AgentRunner` separates Model-visible definitions from executable resolution, then applies decode, interceptor, validation, policy, current-call Approval, execution, result persistence, and observer settlement against one Snapshot. [Tools and Hooks](../specifications/tools-and-hooks.md) owns ordering and closure semantics; [Approval Lifecycle](../specifications/approval-lifecycle.md) owns interaction terminalization.

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [Tool contracts](../../src/core/tools/types.ts), [portable schema](../../src/core/tools/portable-schema.ts), [AgentRunner](../../src/core/runner/AgentRunner.ts) |
| Tests | [portable schema tests](../../src/core/tools/portable-schema.test.ts), [Tool pipeline tests](../../src/core/runner/AgentRunner.tool-pipeline.test.ts) |
| Controlling authority | [Tools and Hooks](../specifications/tools-and-hooks.md), [Approval Lifecycle](../specifications/approval-lifecycle.md) |
