# ADR-013: Standalone Host Arguments and Channel Selection

> Status: Accepted
> Decision date: 2026-09-17
> Owner: Project owner
> Related Plan/Specification: [Standalone Host Arguments and Channels](../changes/archive/standalone-host-arguments-and-channels/plan.md) and [Specification](../changes/archive/standalone-host-arguments-and-channels/standalone-host-arguments-and-channels-specification.md)
> Supersedes: exclusive Builtin Channel mode and Host-configuration clauses of the [Standalone Service Host Specification](../specifications/standalone-service-host.md)
> Refines: Host input preservation in [ADR-009](adr-009-host-boundaries-and-standalone-npm-distribution.md) and Host projection wording in [ADR-011](adr-011-standalone-agent-home-configuration-bootstrap.md); their remaining decisions stay accepted
> Refined by: [ADR-014](adr-014-extension-packages-and-runtime-composition.md) for Runtime-owned Channel failure logging; Host selection and process-liveness decisions remain accepted

## Context

The global `<agentHome>/config.json` currently contains `host.mode` plus CLI and WebSocket settings, and Platform Configuration exposes a Standalone-specific Host projection. Standalone then selects exactly one Builtin Channel: WebSocket, CLI, or no Builtin Channel under the `headless` label.

The Agent configuration document is a Host-shared global authority. A future sibling Host such as a VS Code Extension should consume the same Application and Extension configuration without Platform Configuration depending on every concrete Host schema. Standalone-specific Channel selection inside that document therefore creates the wrong dependency direction.

Runtime already accepts and owns multiple Channel Units. The current exclusivity is a Standalone selection and liveness policy, not a Runtime limitation. A durable decision is required because correcting it removes a stable configuration namespace, replaces an accepted exclusive mode contract, adds a process input, and defines multi-Channel completion behavior.

## Decision drivers

- Keep the global Agent configuration Host-neutral.
- Preserve one strict global configuration read and immutable consumer projections.
- Keep Builtin Channel selection at the Standalone process boundary.
- Express WebSocket-only, CLI-only, combined, and no-Builtin-Channel starts without ambiguous mode terminology.
- Preserve Runtime as the sole lifecycle owner.
- Keep omitted-argument behavior compatible with the current WebSocket default.
- Avoid a general Channel plugin-selection framework, Host-private config namespace, or Compatibility path.

## Options considered

1. **Keep `host.mode`.** Smallest mechanically, but preserves exclusive selection and Standalone coupling in Platform Configuration.
2. **Add `cli.enabled` to `host`.** Enables the immediate combination but further embeds Standalone policy in the global document and cannot cleanly express all sets.
3. **Add `hosts.<hostId>` namespaces.** Decouples schemas but introduces a general Host configuration contract before another Host has concrete requirements.
4. **Select Builtin Channels with a Standalone argument and remove Host config.** Keeps global configuration Host-neutral, naturally expresses all current sets, and avoids changing Runtime.
5. **Let Runtime read Channel configuration.** Violates Host-neutral composition and gives Runtime concrete CLI/WebSocket knowledge.

## Decision

Choose option 4.

Standalone accepts one `-bc <list>`, `--builtin-channels <list>`, or `--builtin-channels=<list>` option. Omission selects `websocket`. The list contains unique comma-separated exact names `websocket` and/or `cli`, or the exclusive sentinel `none`. Selection is canonicalized to WebSocket then CLI order. Invalid, empty, duplicate, unknown, mixed-`none`, and duplicate-option inputs fail with `HOST_ARGUMENT_INVALID` before path/configuration side effects.

The top-level `host` namespace and all Standalone Host projections are removed from Agent configuration. Platform Configuration owns only Application and Extension projections. Standalone still orchestrates Agent configuration bootstrap and one strict read because those projections are needed for composition; it does not read or interpret Host-private fields.

Selected Channel Units use fixed current defaults. This decision adds no replacement Host settings source.

Runtime continues to own Channel creation, start, publication, completion, stop, and bounded failure logging. Standalone observes only the controlling completion required for process lifetime. WebSocket controls lifetime whenever selected; CLI controls lifetime only when selected without WebSocket; no Builtin Channel means waiting for a process signal or explicit `RuntimeHost.shutdown()`. Secondary CLI closure or failure is isolated without Host observation. A controlling failure sets exit status 1 and initiates Runtime shutdown.

`none` means no Builtin Channel and does not suppress External Extension Channels.

## Consequences

### Positive

- Global Agent configuration no longer depends on a concrete Host or Channel implementation.
- Standalone can select any currently supported Builtin Channel set.
- Omission preserves WebSocket service behavior.
- Runtime composition and Channel lifecycle remain unchanged.
- The ambiguous `headless` mode disappears.
- A future Host can consume the same Application/Extension snapshot without inheriting Standalone settings.

### Negative

- Existing documents containing `host` must be edited manually.
- WebSocket bind and CLI presentation values become fixed until a separate configuration authority is justified.
- CLI selection becomes a process invocation concern rather than persistent Agent policy.
- Standalone must explicitly observe the controlling completion path; Runtime observes published Channel failures independently of Host process policy.

## Validation

Delivery must prove:

1. complete argument grammar and first-failure behavior;
2. omitted selection is exactly WebSocket-only;
3. deterministic Unit selection and fixed construction options;
4. direct `host` rejection and absence of Host projections;
5. one configuration bootstrap/read and unchanged Application/Extension handoff;
6. all selection-set liveness rows and failure policies;
7. unchanged Runtime multi-Channel lifecycle, Fanout, interaction, and shutdown behavior;
8. package argument forwarding and default WebSocket operation;
9. no Host-specific configuration remnants outside historical/negative evidence;
10. focused tests, affected Integration/Fitness, full regression, lint, clean build, package/WebSocket verification, links, diagnostics, whitespace, and independent review.

## Migration and rollback

Migration is direct: remove `host` from `config.json`; omit the option for WebSocket, select CLI or combinations explicitly, or use `none`. There is no alias, dual read, automatic rewrite, environment override, or Feature Flag.

Rollback restores the previous complete executable and its `host.mode` document shape. Production code contains no rollback branch.

## Follow-up

Design Host-shared or Host-private settings only when another concrete Host produces requirements that justify a general contract. Do not pre-create `hosts.<hostId>` or a raw Host configuration escape hatch in this Change.

Process authority: [Development Workflow](../governance/development-workflow.md).
