# Current Architecture Overview

> Status: Current Authority
> Verified: 2026-09-09
> Authority: sole entry point for verified Current Architecture
> Ownership: current module map, authority map, and end-to-end Turn overview
> Ownership key: architecture-map-and-turn-overview

## 1. Authority contract

This page owns only the current module map, the Current Architecture authority map, and the end-to-end Turn overview. Detailed behavior has exactly one topic owner in §4. Accepted ADRs own durable decisions; accepted Specs own contracts; source and tests prove current implementation behavior. Plans, proposals, Results, Historical documents, and Deferred Input do not override Current Architecture.

## 2. Module map

```text
src/
├── runtime/          composition, generation publication, orchestration and lifecycle
├── runtime-modules/  composition units for builtin and optional capabilities
├── core/
│   ├── model-invocation/  provider-neutral invocation contract
│   ├── model-resolution/  identity, Provider facts, limits and capability validation
│   ├── registry/          immutable Provider/Tool/Hook projections
│   ├── channel/           transport-neutral Channel and interaction contracts
│   ├── approval/          approval request/result contract
│   ├── runner/            one Turn execution loop and context recovery
│   ├── session/           JSONL transcript persistence
│   ├── prompt/            system/user prompt assembly
│   ├── media/             inbound media validation and canonical normalization
│   ├── tools/             canonical Tool contract and builtin implementations
│   ├── memory/            optional indexed memory
│   ├── workspace/         workspace bootstrap and context loading
│   └── subagent/          Child request preparation and isolated execution
├── adapters/
│   ├── channel/       CLI/WebSocket transports and interaction adapters
│   └── provider/
│       └── anthropic/ Anthropic protocol adapter and production codec
└── platform/
    ├── config/        configuration schema, defaults, merge and Wizard
    └── logger/        process-wide logging and output adapters
```

Runtime Builder is the composition authority. `RuntimeApp.create()` delegates construction; it does not assemble Provider, Tool, Hook, Task, or Model Resolution components itself. A complete immutable generation is published atomically and captured by each root Turn. Child Turns inherit their Parent generation.

## 3. Dependency and authority direction

```text
Channel / library caller
        |
        v
Runtime orchestration ----> immutable generation Snapshot
        |                         |
        v                         +--> resolved Model / Tool / Hook projections
Agent Runner
        +--> Session
        +--> Prompt assembly
        +--> provider-neutral Model invocation
        +--> canonical Tool execution
```

- Core contracts do not import Provider SDK wire types.
- Runtime maps global configuration into narrow module inputs.
- Provider adapters translate only at the Infrastructure boundary.
- Published generations and their Registry projections are immutable.
- Runtime owns aggregate queue, routing, Abort, reload, retirement, and Shutdown state.

## 4. Current topic owners

| Detailed fact domain | Sole topic owner |
|---|---|
| Runtime composition, generation, queue, routing, Fanout, Abort, Shutdown, Subagent Parent/Child lifecycle | [Runtime](./runtime.md) |
| Runner loop, Tool/Hook invocation, context budgeting, Compaction, Runner events | [Runner](./core_runner.md) |
| Model references, Provider projections, canonical identity, Model Facts/limits, capability validation, resolution failures | [Model Resolution](./core_model_resolution.md) |
| Channel contract, CLI/WebSocket protocol, interactions, attachment ingress and wire summary | [Channel](./adapter_channel.md) |
| Media validation, limits, MIME verification, optimization, drop reasons, canonical block normalization | [Media](./core_media.md) |
| Configuration sources, precedence, schema, defaults, Wizard | [Configuration](./platform_config.md) |
| Provider protocol, Anthropic conversion, normalized invocation events/errors | [Provider Adapter](./adapter_llm.md) |
| Canonical Tool contract, validation, policy/approval execution boundary | [Tools](./core_tools.md) |
| Builtin inventory, filesystem/search/web and Exec/Process behavior | [Builtin Tools](./core_tools_builtin.md) |
| Session, Transcript, JSONL and persistence | [Session](./core_session.md) |
| Prompt composition, Context Hooks and normalized media placement | [Prompt](./core_prompt.md) |
| Memory Store, indexing, search and optional degradation | [Memory](./core_memory.md) |
| Workspace initialization and context-file loading | [Workspace](./core_workspace.md) |
| Logger, startup buffering, diagnostics and adapter close | [Observability](./platform_logger.md) |

## 5. End-to-end Turn overview

1. A Channel or library caller submits input to Runtime.
2. Runtime sends inbound blocks through Media normalization, emits the user-message event, and either queues a root Turn or routes steering to the active Turn.
3. At Turn start, Runtime captures one published generation, resolves one Turn-bound Model from its Provider projection, resolves the session and prompts, and calls Runner with immutable Model/Tool/Hook projections plus explicit policy and Abort capabilities.
4. Runner loads persisted history, applies context budgeting, streams provider-neutral model events, executes canonical Tools, persists paired results, and retries through Compaction when required.
5. Runtime fans out Turn events, completes route/queue state, and releases the generation lease. A Child Turn receives its Parent generation rather than sampling the latest publication.
6. Reload builds and validates a complete replacement before atomic publication. Shutdown rejects new work, aborts or bounds active work, retires generations, closes channels/resources, and reports failures without reopening the application.

The topic pages own every detail behind these steps; this overview intentionally does not duplicate their algorithms or protocol tables.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [runtime-builder.ts](../../../src/runtime/runtime-builder.ts), [Anthropic Provider Runtime Module](../../../src/runtime-modules/anthropic-provider.ts), [RuntimeApp.ts](../../../src/runtime/RuntimeApp.ts), [runtime-composition-manager.ts](../../../src/runtime/runtime-composition-manager.ts), [ModelResolver.ts](../../../src/core/model-resolution/ModelResolver.ts), [attachment-pipeline.ts](../../../src/core/media/attachment-pipeline.ts), [AgentRunner.ts](../../../src/core/runner/AgentRunner.ts) |
| Tests | [runtime-builder.test.ts](../../../src/runtime/runtime-builder.test.ts), [anthropic-provider.test.ts](../../../src/runtime-modules/anthropic-provider.test.ts), [RuntimeApp.intake.test.ts](../../../src/runtime/RuntimeApp.intake.test.ts), [ModelResolver.test.ts](../../../src/core/model-resolution/ModelResolver.test.ts), [attachment-pipeline.test.ts](../../../src/core/media/attachment-pipeline.test.ts), [ft-01-boundaries.test.ts](../../../src/architecture-fitness/ft-01-boundaries.test.ts), [ft-10-runtime-composition-deletion.test.ts](../../../src/architecture-fitness/ft-10-runtime-composition-deletion.test.ts) |
| Controlling authority | [ADR-003](../adr-003-progressive-architecture-migration.md), [ADR-005](../adr-005-extension-registry-runtime-composition.md), [ADR-006](../adr-006-legacy-and-compatibility-exit.md), [Runtime Composition Module Spec](../runtime-composition-module-spec.md) |
