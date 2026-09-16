# Current Architecture Overview

> Status: Current Authority
> Authority: Current Architecture entry and module ownership map
> Verified: 2026-09-16
> Ownership: current module map, authority map, and end-to-end Turn overview
> Ownership key: architecture-map-and-turn-overview

---

## 1. Authority contract

This page owns only the current module map, Current Architecture authority map, dependency direction, and end-to-end Turn overview. Detailed behavior has exactly one topic owner in §4. Accepted ADRs own durable decisions; stable Specifications own contracts; source and tests prove implemented behavior. Changes, Evidence, Deferred inputs, and Research do not override Current Architecture.

## 2. Module map

```text
src/
├── hosts/
│   └── standalone/       Node process entry, composition adaptation and lifecycle policy
├── runtime/               composition, generation publication, orchestration and lifecycle
├── builtins/              concrete application-delivered capabilities
│   ├── providers/         concrete builtin Provider integrations
│   ├── channels/          concrete builtin Channel transports
│   └── tools/             concrete builtin Tool implementations
├── extension-acquisition/ install-owned discovery, scoped config and controlled Unit loading
├── extensions/            concrete optional External Extension implementations
├── core/
│   ├── model-invocation/  provider-neutral invocation contract
│   ├── model-resolution/  identity, Provider facts, limits and capability validation
│   ├── registry/          immutable Provider, Tool, Hook and Channel projections
│   ├── channel/           transport-neutral Channel and interaction contracts
│   ├── approval/          approval request/result contract
│   ├── runner/            one Turn execution loop and context recovery
│   ├── session/           JSONL transcript persistence
│   ├── prompt/            system/user prompt assembly
│   ├── media/             inbound media validation and canonical normalization
│   ├── tools/             canonical Tool contract and portable validation
│   ├── memory/            optional indexed memory
│   ├── agent-context/     Agent Home Context initialization and loading
│   └── subagent/          Child request preparation and isolated execution
└── platform/
        ├── config/            Agent configuration, precedence and merge
    └── logger/            process-wide logging and output adapters
```

Runtime Builder is the composition authority. `RuntimeApp.create()` delegates construction; it does not itself assemble Provider, Tool, Hook, Task, or Model Resolution components. Each root Turn captures one complete immutable generation; Child Turns inherit their Parent generation.

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
- Environment Hosts depend on Runtime's public composition boundary; Runtime and Core do not depend on Hosts.
- Extension acquisition returns only not-yet-created Units; Runtime owns lifecycle and publication.
- Runtime maps global configuration into narrow module inputs.
- Provider adapters translate only at the Infrastructure boundary.
- Published generations and their Registry projections are immutable.
- Runtime owns aggregate queue, routing, Abort, reload, retirement, and Shutdown state.

## 4. Current topic owners

| Detailed fact domain | Sole topic owner |
|---|---|
| Runtime composition, generation, queue, routing, Fanout, Abort, Shutdown, and Parent/Child lifecycle | [Runtime](runtime.md) |
| Turn loop, Tool/Hook invocation, context budgeting, Compaction, and Runner events | [Runner](runner.md) |
| Model references, Catalog projections, canonical identity, Model Facts/limits, capability validation, and resolution failures | [Model Resolution](model-resolution.md) |
| Provider-neutral invocation plus concrete Anthropic and Relay protocol behavior | [Providers](providers.md) |
| Channel contract, CLI/WebSocket behavior, interactions, attachment ingress, and wire summary | [Channels](channels.md) |
| Media validation, limits, MIME verification, optimization, drop reasons, and canonical normalization | [Media](media.md) |
| Agent configuration, precedence, defaults, and policy fields | [Configuration](configuration.md) |
| Install-owned Extensions, Host Extension config, discovery, controlled loading, and Runtime handoff | [Extensions](extensions.md) |
| Canonical Tool contract, validation, policy, approval, and execution boundary | [Tools](tools.md) |
| Builtin inventory and Environment filesystem, search, web, Exec, and Process behavior | [Builtin Tools](builtin-tools.md) |
| Session, Transcript, JSONL, and persistence | [Session](session.md) |
| Prompt composition, Context Hooks, and normalized media placement | [Prompt](prompt.md) |
| Memory Store, indexing, search, and optional degradation | [Memory](memory.md) |
| Agent Context initialization and allowlisted Context-file loading | [Agent Context](agent-context.md) |
| Logger, startup buffering, diagnostics, and adapter close | [Observability](observability.md) |

## 5. End-to-end Turn overview

1. A Channel or library caller submits input to Runtime.
2. Runtime sends inbound blocks through Media normalization, emits the user-message event, and queues a root Turn or routes steering to the active Turn.
3. At Turn start, Runtime captures one published generation, resolves one Turn-bound Model, resolves Session and prompts, and calls Runner with immutable Model, Tool, and Hook projections plus policy, approval, steering, and Abort capabilities.
4. Runner loads persisted history, applies context budgeting, streams provider-neutral model events, executes canonical Tools, persists paired results, and retries through Compaction when required.
5. Runtime fans out Turn events, completes route and queue state, and releases the generation lease. A Child Turn receives its Parent generation rather than sampling the latest publication.
6. Reload builds and validates a complete replacement before atomic publication. Shutdown rejects new work, aborts or bounds active work, retires generations, closes channels and resources, and reports failures without reopening the application.

Topic pages own every detail behind these steps; this overview intentionally does not duplicate their algorithms or protocol tables.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [standalone entry](../../src/hosts/standalone/entry.ts), [standalone Host](../../src/hosts/standalone/standalone-host.ts), [Runtime Builder](../../src/runtime/runtime-builder.ts), [RuntimeApp](../../src/runtime/RuntimeApp.ts), [composition manager](../../src/runtime/runtime-composition-manager.ts), [Extension acquisition](../../src/extension-acquisition/index.ts), [Anthropic Runtime Unit](../../src/builtins/providers/anthropic/runtime-unit.ts), [ModelResolver](../../src/core/model-resolution/ModelResolver.ts), [attachment pipeline](../../src/core/media/attachment-pipeline.ts), [AgentRunner](../../src/core/runner/AgentRunner.ts) |
| Tests | [standalone Host tests](../../src/hosts/standalone/standalone-host.test.ts), [acquisition integration](../../src/extension-acquisition/acquisition-runtime.integration.test.ts), [Runtime Builder tests](../../src/runtime/runtime-builder.test.ts), [Anthropic Unit tests](../../src/builtins/providers/anthropic/runtime-unit.test.ts), [Runtime intake tests](../../src/runtime/RuntimeApp.intake.test.ts), [ModelResolver tests](../../src/core/model-resolution/ModelResolver.test.ts), [attachment tests](../../src/core/media/attachment-pipeline.test.ts) |
| Controlling authority | [ADR-003](../decisions/adr-003-progressive-architecture-migration.md), [ADR-005](../decisions/adr-005-extension-registry-runtime-composition.md), [ADR-006](../decisions/adr-006-legacy-and-compatibility-exit.md), [ADR-007](../decisions/adr-007-builtin-capability-source-ownership.md), [ADR-009](../decisions/adr-009-host-boundaries-and-standalone-npm-distribution.md), [ADR-010](../decisions/adr-010-install-and-agent-home-ownership.md), [ADR-012](../decisions/adr-012-agent-home-path-unification.md), [Runtime Composition Specification](../specifications/runtime-composition.md), [Standalone Service Host Specification](../specifications/standalone-service-host.md) |
