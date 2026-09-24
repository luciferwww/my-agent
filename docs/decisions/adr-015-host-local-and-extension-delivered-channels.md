# ADR-015: Host-local and Extension-delivered Channels

> Status: Accepted
> Decision date: 2026-09-24
> Owner: Project owner
> Related Change: [WebSocket Channel Extension](../changes/archive/websocket-channel-extension/plan.md)
> Supersedes: WebSocket Built-in/default/liveness clauses of [ADR-013](adr-013-standalone-host-arguments-and-channels.md)
> Refines: [ADR-014](adr-014-extension-packages-and-runtime-composition.md) by making reusable first-party Channel transports Extension-delivered

## Context

Before this decision, Standalone owned a concrete list of WebSocket and CLI
Built-in Channels. It parsed their IDs, constructed their Units, fixed their
settings, and selected WebSocket as the default and controlling completion.
Adding another reusable transport would have required editing Standalone
again.

CLI is Host-local: it owns Standalone stdin/stdout, terminal presentation,
Ctrl+C behavior, and a Console Logger conflict. WebSocket is a reusable network
transport with its own protocol and HTML client. Future HTTP/SSE has the same
reusable character.

## Decision drivers

- Keep concrete reusable transports out of Host code.
- Preserve generic Extension Acquisition and Runtime Unit composition.
- Keep every Channel implementation/configuration/resource with its owner.
- Make all network transports explicitly enabled.
- Keep Host-local terminal behavior simple.
- Avoid a Built-in Channel Catalog and automatic filesystem registration.
- Ship first-party WebSocket capability without requiring repository source.

## Options considered

1. **Keep WebSocket Built-in and add a central catalog.** Reduces repeated Host
   branching but retains a second registration/selection system beside
   Extensions.
2. **Put all Channel enablement in global configuration while Host constructs
   them.** Reintroduces concrete Channel knowledge into Platform/Host and makes
   cross-Host documents ambiguous.
3. **Deliver reusable network Channels as first-party Extensions; keep only
   Host-local Channels in each Host.** Reuses the existing generic loading and
   lifecycle path and removes Standalone knowledge of future transports.
4. **Dynamically scan source directories as Built-ins.** Makes packaging,
   auditing, identity, and activation implicit.

## Decision

Choose option 3.

Standalone owns one optional CLI Channel selected by `--cli`. Omission selects
no Host-local Channel. The old `--builtin-channels`/`-bc` grammar is removed
without compatibility behavior.

WebSocket becomes an explicitly configured first-party Extension. It owns its
transport, protocol, strict scoped settings, Runtime Unit, HTML chat client,
and optional browser launch. It is not enabled merely because it is installed.
The client is served by the Extension; direct `file://` use is retired.
`openBrowser` defaults false and may be explicitly enabled.

Global Extension defaults do not change: acquisition is enabled and the entry
map is empty. The WebSocket Extension's Descriptor schema owns and injects its
defaults only after the user adds its entry. The root npm artifact mirrors
dependencies declared by bundled first-party Extension packages so installed
resolution does not rely on the development workspace.

Future reusable transports such as HTTP/SSE should normally use the same
Extension path. A Channel remains Host-local only when it is integral to that
Host, such as CLI for Standalone or a VS Code Channel required by a VS Code
Host.

Runtime continues to own Unit/Channel creation, publication, routing,
completion observation, and Shutdown. Standalone does not give Extension
Channels special process-lifetime semantics. Without CLI it remains alive
until a signal or explicit shutdown.

## Consequences

### Positive

- Adding a reusable Channel package does not modify Standalone.
- WebSocket code, UI, configuration, tests, and dependencies share one owner.
- Network listeners are opt-in rather than surprising defaults.
- Host-local and reusable Channel responsibilities are explicit.
- HTTP/SSE can be added later without another Host selection grammar.

### Negative

- Existing no-argument WebSocket deployments must enable the Extension.
- `--builtin-channels` users must migrate to `--cli` or Extension config.
- The stable Extension API must grow enough to support Channel authors.
- First-party package assembly must include static assets and runtime
  dependencies.
- Extension Channel failure no longer automatically terminates Standalone.

## Compatibility

Migration is direct. There is no alias, dual read, automatic configuration
rewrite, default enablement, or Feature Flag.

## Validation

Acceptance requires an installed-package proof for Extension discovery,
dependency resolution, served HTML, a real WebSocket Turn, no default browser
launch, optional launch behavior, zero-Channel Standalone startup, CLI-only
lifecycle, old-path removal, full regression, and independent review.

These conditions were satisfied on 2026-09-24. See the
[WCE-4 validation record](../changes/archive/websocket-channel-extension/wce-4-validation.md).

Process authority: [Development Workflow](../governance/development-workflow.md).
