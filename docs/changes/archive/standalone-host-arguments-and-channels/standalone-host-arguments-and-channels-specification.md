# Standalone Host Arguments and Channels Specification

> Status: Implemented and Validated
> Date: 2026-09-17
> Owner: Project owner
> Related Plan/Decision: [Plan](plan.md) and [ADR-013](../../../decisions/adr-013-standalone-host-arguments-and-channels.md)

## Purpose and observable outcome

Standalone selects its Builtin Channel set only from process arguments. The global Agent configuration document contains no Host-private Channel selection or settings. Runtime receives the selected Builtin Channel Units and continues to own their complete lifecycle.

Omitting the option is exactly equivalent to selecting `websocket`.

## Scope

- Standalone argument grammar and selected-channel value object.
- Removal of the top-level `host` configuration namespace and Host projection.
- Fixed Standalone CLI and WebSocket construction defaults.
- Builtin Unit assembly, controlling-Channel choice, completion observation, and Host shutdown policy.
- Direct migration of maintained callers, package checks, tests, and authority.

## Non-goals

- Runtime or Registry redesign;
- configuration of Builtin Channel internals;
- Extension Channel selection;
- generic Host configuration namespaces;
- automatic configuration migration;
- Channel reload or dynamic enable/disable after Runtime publication;
- changes to event Fanout, Session routing, interaction routing, or Approval semantics.

## Boundaries and dependency direction

The Standalone Host parses process arguments, chooses Builtin Channel Units, supplies fixed construction options, combines those Units with acquired External Units, and injects the complete list into `RuntimeApp.create()`.

Platform Configuration bootstraps and strictly loads the global Agent document. It returns only immutable Application and Extension projections. It does not type, validate, default, or project Standalone, CLI, WebSocket, or other Host settings.

Runtime and Registry remain Host-neutral. They create, stage, start, publish, observe, retire, and stop all injected Units and Channel instances. Concrete Channel packages do not parse Standalone arguments or read configuration files.

## Public and structural contracts

### Standalone arguments

```ts
type BuiltinChannelName = 'websocket' | 'cli';

interface StandaloneHostArguments {
  readonly agentHomeArgument?: string;
  readonly builtinChannels: readonly BuiltinChannelName[];
}
```

Supported forms:

```text
-bc <list>
--builtin-channels <list>
--builtin-channels=<list>
```

The option may appear before or after `--agent-home` and may occur at most once across all aliases/forms.

`<list>` is either:

- one or more comma-separated exact names from `websocket` and `cli`; or
- the exact sentinel `none`.

Whitespace within the value is not normalized. Empty segments, duplicate names, unknown names, case variants, and any use of `none` in a list are `HOST_ARGUMENT_INVALID`. Output is frozen and canonicalized to `websocket`, then `cli`, independent of input order. Omission produces `['websocket']`.

Short equals form `-bc=<list>` is intentionally unsupported. No combined-short-option grammar exists.

### Global configuration snapshot

```ts
interface AgentConfigSnapshot {
  readonly application: ApplicationConfigProjection;
  readonly extensions: ResolvedHostExtensionsConfig;
}
```

The only valid top-level namespaces are `agents`, `logger`, and `extensions`. `host`, `hosts`, and every other unknown namespace fail through the existing unknown-namespace configuration error. There is no Host projection and no Host-private raw-value escape hatch.

### Fixed Builtin Channel construction

Standalone constructs selected Units with these fixed values:

```text
websocket: host=127.0.0.1, port=8787, path=/ws, approval=true
cli:       sessionKey=main, prompt=> , approval=true
```

The Builtin Unit catalog order is always WebSocket before CLI. External acquired Units retain their existing position before Host-selected Builtin Units in the injected `loadedUnits` list.

## Behavior and invariants

- No option means WebSocket-only.
- `websocket`, `cli`, `websocket,cli`, and `cli,websocket` select their corresponding sets.
- `none` selects no Builtin Channel but does not suppress Extension-contributed Channels.
- CLI selection requires Console Logger to be disabled; violation is `HOST_OUTPUT_CONFLICT` before acquisition or Runtime creation.
- File Logger remains compatible with CLI.
- Builtin Channel selection is immutable for the process lifetime.
- Standalone still invokes Agent configuration bootstrap and one strict load because it is the composition root for Application and Extension projections. “Host does not touch config” means no Host-private configuration content or selection, not that Standalone bypasses Platform Configuration.

## Lifecycle and resource ownership

Runtime retains sole Channel lifecycle ownership. Standalone observes completion only to determine process-host lifetime:

| Selected Builtin Channels | Controlling completion | Secondary completion |
|---|---|---|
| `websocket` | WebSocket | none |
| `cli` | CLI | none |
| `websocket,cli` | WebSocket | CLI is observed but does not control Host lifetime |
| `none` | `RuntimeHost.completion`, resolved by process signal or explicit `RuntimeHost.shutdown()` | none |

When a controlling Channel reaches any terminal outcome, Standalone initiates shared Runtime shutdown. With both Channels selected, normal CLI input closure leaves WebSocket and Runtime active.

## Failure, Abort, deadline, and concurrency semantics

- A controlling Channel startup or runtime failure sets `process.exitCode = 1`, emits one bounded diagnostic naming the Channel, and initiates shared shutdown.
- A secondary CLI startup or runtime failure while WebSocket is selected emits one bounded warning and does not set exit status or initiate shutdown.
- Secondary CLI normal completion emits no failure warning.
- All completion observers consume resolved failure outcomes; no detached observer rejection or unhandled rejection is permitted.
- Runtime Host signal, second-signal, deadline, and shutdown behavior remain unchanged.
- Existing Runtime optional-Channel isolation still determines whether Runtime publication succeeds; Standalone applies the same controlling/secondary policy to the resulting stored startup completion. This Change does not add a second lifecycle owner.
- Selection does not alter same-Session admission, multi-client behavior, generation capture, Fanout, origin-bound interaction routing, or shutdown convergence.
- Same-Agent-Home process coordination remains unsupported.

## Security and capabilities

CLI and WebSocket Approval remain enabled in their fixed construction options. Interaction requests continue to route only to the Turn origin Channel/client. Selecting multiple Channels does not transfer Approval capability between origins. Process arguments contain no credentials.

## Compatibility and migration

This is a direct cutover:

- remove `host.mode`, `host.websocket`, and `host.cli`;
- reject the top-level `host` namespace;
- add no alias, dual read, automatic rewrite, environment override, or Feature Flag;
- operators remove `host` from existing documents and pass `-bc` or `--builtin-channels` when the default WebSocket-only selection is not desired.

ADR-013 supersedes the exclusive Host mode and configuration clauses of the Standalone Service Host Specification and refines ADR-009/ADR-011 only where they mention Host configuration projections or preserved mode behavior. Their Host ownership, package, bootstrap, and one-read global configuration decisions remain accepted.

## Acceptance and validation

- Parser tests cover all accepted and rejected forms, mixed option ordering, canonicalization, and exact first-failure behavior.
- Configuration tests prove the snapshot has only Application/Extension projections and rejects `host` directly.
- Host tests prove fixed defaults, selected Unit sets/order, conflict short-circuit, all four liveness rows, controlling failure, and secondary CLI isolation.
- Existing Runtime multi-Channel, Fanout, interaction, and Shutdown tests remain green.
- Package verification proves `{}` with omitted selection starts fixed default WebSocket, at least one explicit selection reaches the installed executable correctly, and a legacy `host` namespace fails before Runtime creation.
- Affected Integration and Fitness, full regression, lint, clean build, package/WebSocket verification, documentation links/diagnostics, residual scan, whitespace, and independent review pass before closeout.

## Open questions

None after owner acceptance.

Follow [Development Workflow](../../../governance/development-workflow.md).
