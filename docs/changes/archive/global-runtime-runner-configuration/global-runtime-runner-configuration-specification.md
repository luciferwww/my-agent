# Global Runtime and Runner Configuration Specification

> Status: Accepted — Delivery Authorized
> Date: 2026-09-21
> Owner: Project owner
> Related Plan: [Global Runtime and Runner Configuration Plan](plan.md)
> Predecessor: [Runtime Steering and Runner Configuration](../runtime-steering-and-runner-configuration/runtime-steering-and-runner-configuration-specification.md)
> Authorization: Delivery authorized by project owner on 2026-09-21.

## 1. Purpose

Define Runtime and Runner policy as global Application configuration while
retaining the existing per-Agent configuration model for Agent-scoped modules.

## 2. Public document shape

```ts
interface AgentConfigDocument {
  llm?: LLMConfigInput;
  runtime?: Partial<RuntimeConfig>;
  runner?: Partial<RunnerConfig>;
  agents?: {
    defaults?: DeepPartial<AgentDefaults>;
    list?: AgentEntry[];
  };
  logger?: LoggerModuleConfig;
  extensions?: ExtensionsConfig;
}

interface RuntimeConfig {
  readonly steeringEnabled: boolean;
}

interface RunnerConfig {
  readonly maxLlmCalls?: number;
}

interface AgentDefaults {
  readonly memory: MemoryModuleConfig;
  readonly prompt: PromptConfig;
  readonly tools: ToolsConfig;
  readonly context: AgentContextConfig;
  readonly compaction: CompactionConfig;
  readonly subagents?: SubagentsConfig;
}
```

`RuntimeConfig` and `RunnerConfig` are not members of `AgentDefaults`.

## 3. Application projection

```ts
interface ApplicationConfigProjection {
  readonly llm: LLMConfig;
  readonly runtime: RuntimeConfig;
  readonly runner: RunnerConfig;
  readonly agents: AgentsConfig;
  readonly logger: LoggerModuleConfig;
}
```

The empty document projects:

```ts
{
  llm: {},
  runtime: { steeringEnabled: false },
  runner: {},
  agents: {
    defaults: DEFAULT_AGENT_CONFIG,
    list: [],
  },
  logger: DEFAULT_LOGGER_CONFIG,
}
```

`runner: {}` means no Model-call count limit.

## 4. Ownership

### Runtime

Runtime owns:

- `RuntimeConfig`;
- `DEFAULT_RUNTIME_CONFIG`;
- `steeringEnabled` validation semantics;
- consumption of the resolved global Runtime projection.

### Runner

Runner owns:

- `RunnerConfig`;
- `DEFAULT_RUNNER_CONFIG`;
- `maxLlmCalls` validation semantics;
- Model-loop enforcement of an effective optional limit.

### Platform Configuration

Platform owns:

- reading the sole `config.json`;
- recognizing top-level namespaces;
- dispatching leaf validation;
- merging module defaults with top-level document values;
- constructing and freezing `ApplicationConfigProjection`;
- resolving only Agent-scoped precedence through `resolveAgentConfig()`.

Platform does not redefine Runtime/Runner fields or defaults.

## 5. Validation

- `runtime`, when present, must be an object.
- `runtime.steeringEnabled`, when present, must be boolean.
- `runtime` rejects unknown fields.
- `runner`, when present, must be an object.
- `runner.maxLlmCalls`, when present, must be a positive integer.
- `runner` rejects unknown fields, including `inTurnMessageMode`.
- `agents.defaults.runtime` and `agents.defaults.runner` are invalid.
- `agents.list[].runtime` and `agents.list[].runner` are invalid.
- No misplaced nested value is promoted or merged into the top-level value.
- Errors use the existing bounded, secret-free configuration error shape and
  exact field path.

The valid top-level namespace set becomes:

```text
llm
runtime
runner
agents
logger
extensions
```

## 6. Defaults and precedence

Global Runtime/Runner precedence is:

```text
module default -> top-level file value
```

`agents.defaults`, `agents.list[]`, Agent environment overrides, and Agent
caller/CLI overrides do not participate.

Agent-scoped precedence remains:

```text
Agent module defaults
  -> file agents.defaults
  -> matching agents.list[] entry
  -> Agent environment overrides
  -> Agent caller/CLI overrides
```

The final Application projection is deeply frozen. `resolveAgentConfig()`
returns only `AgentDefaults`.

## 7. Runtime and Runner consumption

Runtime Bootstrap receives the immutable Application projection and exposes:

```ts
interface RuntimeResourceSet {
  readonly appConfig: AppConfig;
  readonly runtimeConfig: RuntimeConfig;
  readonly runnerConfig: RunnerConfig;
  readonly resolvedConfig: AgentDefaults;
}
```

- Steering admission reads `runtimeConfig.steeringEnabled`.
- Root Runner invocation uses:

  ```ts
  params.maxLlmCalls ?? runnerConfig.maxLlmCalls
  ```

- `resolvedConfig` continues to supply Memory, Prompt, Tools, Context,
  Compaction, and Subagent policy only.
- Runtime and Runner do not read the physical configuration document.

## 8. Override behavior

- A direct or Channel-provided `RunTurnParams.maxLlmCalls` overrides the global
  Runner value for that Root Turn.
- A Child profile's explicit limit overrides the Parent effective limit.
- An omitted Child profile limit inherits the Parent effective limit.
- If global, per-Turn, and Child profile limits are all absent, the Child is
  unlimited.
- There is no per-Turn override for `steeringEnabled`.

## 9. Behavioral preservation

This Change does not alter:

- safe steering injection points;
- distinct FIFO steering messages;
- one continuation call per ready batch;
- normal terminal promotion;
- Abort/failure/Shutdown discard;
- `max_llm_calls` Result semantics;
- Client limit notices;
- Session or Subagent identity.

Only configuration placement, precedence, and wiring change.

## 10. Acceptance scenarios

- Empty configuration produces global Runtime/Runner defaults.
- Top-level explicit values are accepted and frozen.
- Nested Runtime/Runner values fail at their exact paths.
- Per-Agent entries cannot override Runtime/Runner.
- Two different Agent selections observe the same global Runtime/Runner values
  while retaining distinct Agent-scoped values.
- Steering enabled at top level affects active-Session routing.
- Explicit global limit reaches `max_llm_calls`.
- Omitted global limit permits more than 12 Model calls.
- Per-Turn and Child overrides retain their established behavior.
- Test-workspace uses the documented top-level shape.
- Current Architecture, stable Configuration, and Fitness checks agree.

## 11. Compatibility

No compatibility reader or migration alias is provided for the nested form.
Repository-owned fixtures move atomically during Delivery. User configuration
must move:

```text
agents.defaults.runtime -> runtime
agents.defaults.runner  -> runner
```

Follow [Development Workflow](../../../governance/development-workflow.md).
