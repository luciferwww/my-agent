# Standalone Host Arguments and Channels Plan

> Status: Completed
> Date: 2026-09-17
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-013](../../../decisions/adr-013-standalone-host-arguments-and-channels.md)
> Contract: [Standalone Host Arguments and Channels Specification](standalone-host-arguments-and-channels-specification.md)
> Validation record: [Validation](validation.md)

## 1. Goal

Remove Standalone-specific Channel selection and settings from the global Agent configuration document. Standalone selects any supported Builtin Channel set through one process argument while Runtime remains the sole owner of Unit and Channel lifecycle.

The observable forms are:

```text
my-agent
my-agent -bc websocket,cli
my-agent --builtin-channels=cli
my-agent --builtin-channels none
```

Omission selects `websocket`. The supported names are `websocket`, `cli`, and the exclusive sentinel `none`. CLI examples require `logger.console.enabled=false` in the global Agent configuration; Standalone never silently disables Console Logger.

## 2. Scope

1. Add `-bc <list>`, `--builtin-channels <list>`, and `--builtin-channels=<list>` to the Standalone argument grammar.
2. Support `websocket`, `cli`, `websocket,cli`, and `none`; reject empty, unknown, duplicate, mixed-`none`, and duplicate-option inputs.
3. Remove the top-level `host` namespace, `StandaloneHostMode`, `StandaloneHostConfigProjection`, Host validation/default resolution, and the `host` projection from `AgentConfigSnapshot`.
4. Keep Standalone orchestration of Agent configuration bootstrap and one strict global Application/Extension configuration read. “Host does not touch config” means the document contains no Host-private selection or settings; it does not remove the Host’s Platform Configuration orchestration.
5. Use fixed Standalone defaults: WebSocket `127.0.0.1:8787`, path `/ws`, Approval enabled; CLI Session `main`, prompt `> `, Approval enabled.
6. Assemble selected Builtin Channel Units in canonical `websocket` then `cli` order, independent of argument order.
7. Preserve External Extension Channel acquisition and Runtime-owned lifecycle.
8. Apply the accepted liveness and failure matrix from the Specification.
9. Directly reject the retired `host` namespace; add no alias, dual read, environment override, or Feature Flag.
10. Migrate package verification from a generated `host` namespace to default fixed WebSocket startup, explicit Builtin Channel argument forwarding, and legacy-`host` rejection.
11. Transfer stable/current/README authority after implementation evidence passes, including Configuration, Channels, Extensions, Standalone Host, README, Fitness baselines, source tests, and package scripts. Historical archives remain unchanged.

## 3. Delivery sequence

| Item | State | Scope | Exit condition |
|---|---|---|---|
| SBCS-0 | Completed | Review and accept ADR-013, this Plan, and the change-local Specification | Owner accepted argument grammar, config removal, defaults, liveness, failure isolation, compatibility, and validation obligations on 2026-09-17 |
| SBCS-1 | Completed | Implement argument parsing, global config cleanup, Channel assembly, liveness, and focused tests | Focused parser/config/Host/lifecycle tests and TypeScript passed |
| SBCS-2 | Completed | Update package scenarios and authority, run final Gate, independent review, and archive | Integration, Fitness, 1,084-test regression, lint, clean build, package/WebSocket verification, links, diagnostics, residuals, whitespace, and independent review passed |

## 4. Acceptance criteria

- Omitted Builtin Channel option selects only WebSocket.
- Short and long split forms and long equals form are accepted in either order with `--agent-home`.
- The option occurs at most once, including across aliases.
- Channel names are case-sensitive, comma-separated, unique, and order-independent.
- `none` is accepted only as the complete list.
- Builtin Unit assembly order is deterministic: WebSocket before CLI.
- `config.json` accepts only `agents`, `logger`, and `extensions`; `host` is rejected without compatibility behavior.
- Standalone still bootstraps and strictly reads the global Agent configuration once, then passes immutable Application and Extension projections to their existing consumers.
- WebSocket and CLI use the fixed defaults recorded in Scope.
- CLI selection with Console Logger enabled fails before acquisition and Runtime creation.
- WebSocket-only completion controls Host shutdown; CLI-only completion controls Host shutdown; with both selected, WebSocket controls Host shutdown and CLI completion is isolated; with none selected, the Host waits for a process signal or an explicit `RuntimeHost.shutdown()` invocation.
- A controlling Channel startup/runtime failure sets exit status 1. A CLI startup/runtime failure while WebSocket remains active is consumed as a bounded warning and does not set failure exit status or stop Runtime.
- Runtime, Registry, Channel implementations, External Extension acquisition, Agent Home bootstrap, and configuration precedence remain otherwise unchanged.

## 5. Non-goals

- generic Channel configuration or discovery;
- selecting Extension-contributed Channels by this option;
- adding Host-private namespaces to `config.json`;
- changing Runtime Fanout or origin-bound Approval routing;
- adding configuration reload/watch behavior;
- coordinating multiple processes sharing one Agent Home;
- changing WebSocket bind settings, CLI presentation settings, or their fixed defaults;
- retaining `host.mode`, Headless terminology, or a compatibility projection.

## 6. Validation strategy

- Parser Unit tests for every accepted form, option ordering, missing values, aliases, duplicates, list grammar, and unknown arguments.
- Configuration tests for removal of Host projection/defaults and direct rejection of `host`.
- Host tests for each selected set, canonical Unit order, Console Logger conflict, startup short-circuit, liveness, failure isolation, and shutdown reason.
- Existing Runtime multi-Channel lifecycle and Fanout tests remain regression evidence; production Runtime changes are not expected.
- Package verification covers `{}` with omitted selection and fixed default WebSocket, one explicit Channel-selection argument reaching the installed command, and direct legacy-`host` rejection.
- Final Gate runs affected Integration/Fitness, full regression, lint, clean build, package and WebSocket Host verification, residual scans, links, diagnostics, `git diff --check`, and independent review.

## 7. Stop conditions

Stop for owner review if implementation evidence requires:

- storing any Host-private selection or settings in `config.json`;
- changing Runtime Channel lifecycle, Registry publication, Fanout, or Approval routing;
- adding a second configuration read or Host-specific configuration file;
- retaining `host` through an alias, dual read, or migration branch;
- changing fixed WebSocket/CLI defaults;
- treating Extension Channels as controlled by `--builtin-channels`;
- adding same-Agent-Home multi-process coordination.

Follow [Development Workflow](../../../governance/development-workflow.md).
