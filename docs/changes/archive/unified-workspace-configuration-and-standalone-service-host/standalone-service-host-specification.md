# Standalone Service Host Specification

> Status: Archived Change Contract
> Date: 2026-09-15
> Accepted: 2026-09-15 (SSH-0 design Gate, before SSH-1 implementation)
> Validated: 2026-09-16
> Archived: 2026-09-16
> Owner: Project owner (full-auto execution)
> Authority: Completed Change contract; stable authority transferred to [Standalone Service Host](../../../specifications/standalone-service-host.md)
> Related Plan: [Unified Workspace Layout and Standalone Service Host](plan.md)
> Configuration decision: [ADR-008](../../../decisions/adr-008-workspace-configuration-authority.md)

## 1. Scope

Define one canonical standalone process Host and executable, while preserving `RuntimeApp.create()` as the one Runtime composition path. The Host owns path selection, Workspace snapshot loading, Extension acquisition, optional built-in Channel selection, process signals, service liveness, operator diagnostics, and exit status.

The Host is service-first. CLI is one explicit optional mode and does not define the architecture.

## 2. Entry and process inputs

The canonical command is `my-agent`; repository development uses `npm run agent`. The emitted Host entry is included in `dist/host` and `package.json.bin` maps `my-agent` to it.

Accepted arguments:

```text
my-agent [--workspace <path>] [--agent-home <path>]
```

Workspace precedence is:

1. `--workspace <path>` or `--workspace=<path>`;
2. `MY_AGENT_WORKSPACE`;
3. `process.cwd()`.

Agent Home precedence remains explicit argument, `MY_AGENT_HOME`, then `<user-home>/.my-agent`.

Both options may occur at most once and reject missing/blank values. Relative Workspace input resolves against `process.cwd()`; Agent Home keeps its existing normalization contract. A missing Workspace is valid: missing configuration yields defaults and Runtime initialization creates the root Context files. An existing Workspace path of an incompatible kind fails startup.

## 3. Host configuration

The unified Workspace document adds:

```text
host.mode: "websocket" | "cli" | "headless"   # default "websocket"
host.websocket.host                              # default "127.0.0.1"
host.websocket.port                              # default 8787, integer 1..65535
host.websocket.path                              # default "/ws"
host.websocket.approval                          # default true
host.cli.sessionKey                              # default "main"
host.cli.prompt                                  # default "> "
host.cli.approval                                # default true
```

Exactly one built-in mode is selected:

- `websocket`: append the builtin WebSocket Channel Unit;
- `cli`: append the builtin CLI Channel Unit;
- `headless`: append no builtin Channel Unit; External Units may still contribute Channels.

Simultaneous builtin CLI and WebSocket selection is intentionally unsupported. Adding arbitrary combinations requires a later liveness/output-arbitration contract.

## 4. Output compatibility

`host.mode="cli"` owns terminal presentation through `CliChannel`. It is incompatible with an enabled Console Logger after defaults and file overrides are resolved. The Host rejects this combination before Runtime creation with `HOST_OUTPUT_CONFLICT`; it never silently disables or redirects configured logging.

File Logger remains compatible with every mode. WebSocket and headless modes permit all existing Logger combinations. Startup/fatal operator diagnostics use bounded `stderr` output before or outside Runtime Logger availability; the CLI Host emits no routine banner to stdout.

## 5. Composition and liveness

Startup order is:

1. resolve Workspace;
2. read one immutable Workspace configuration snapshot;
3. validate Host/output composition;
4. resolve Agent Home and acquire External Units using the snapshot's Extension projection;
5. append the selected optional builtin Channel Unit;
6. call `RuntimeApp.create()` with explicit Workspace, application projection, and all acquired/Host Units;
7. install the common Runtime Host signal/deadline wrapper.

For `websocket` or `cli`, normal or failed completion of the selected builtin Channel initiates Runtime shutdown; failed completion sets failure exit status and is reported after shutdown. A process signal may initiate the same shared shutdown first.

For `headless`, the Host remains alive until a process signal or an externally initiated Host shutdown. External Channel completion does not implicitly determine process lifetime because arbitrary External Channel identities and policies are not Host configuration authority.

The Runtime Host wrapper exposes one completion Promise for the shared shutdown result. First signal starts cooperative shutdown, second signal forces the conventional signal exit, and the existing overall Host deadline forces exit code 1. Runtime library code never calls `process.exit()`.

## 6. Failure and diagnostics

- argument, Workspace configuration, Host configuration, Agent Home, and fatal discovery-root failures reject startup and set exit code 1;
- candidate-local acquisition failures remain bounded warnings and do not suppress valid neighbors;
- optional Unit startup behavior remains Runtime-owned;
- selected builtin Channel completion failure initiates shutdown and sets exit code 1;
- diagnostics never include secret values or raw configuration documents.

## 7. Compatibility and removal

The canonical entry replaces the old WebSocket-only `scripts/server.ts` and stale `scripts/cli.ts`/`scripts/websocket.ts` prototypes. `npm run agent:websocket` is replaced by `npm run agent`; WebSocket remains the default mode through configuration. No forwarding executable or second composition root remains.

## 8. Acceptance scenarios

Tests must prove:

1. Workspace and Agent Home precedence plus duplicate/missing argument rejection;
2. default configuration selects WebSocket mode;
3. CLI and headless modes append only their specified builtin Unit set;
4. CLI plus Console Logger fails before Runtime creation;
5. CLI plus File-only Logger is valid;
6. one Workspace snapshot supplies application, Extension, and Host projections;
7. builtin Channel normal/failure completion and process signal share one shutdown;
8. headless mode remains alive until Host shutdown;
9. source/build/package expose one canonical standalone executable;
10. no old executable creates a second Runtime path.