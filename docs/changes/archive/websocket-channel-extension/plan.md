# WebSocket Channel Extension Plan

> Status: Accepted and Archived
> Date: 2026-09-24
> Owner: Project owner
> Type: Architecture Slice
> Decision: [ADR-015: Host-local and Extension-delivered Channels](../../../decisions/adr-015-host-local-and-extension-delivered-channels.md)
> Specification: [WebSocket Channel Extension Specification](websocket-channel-extension-specification.md)
> Authorization: ADR, Plan, Specification, WCE-0 through WCE-4, and final archive accepted by project owner on 2026-09-24.
> WCE-0 evidence: [Contract and Packaging Proof](wce-0-proof.md)
> WCE-1 evidence: [WebSocket Extension Extraction](wce-1-implementation.md)
> WCE-2 evidence: [Standalone Host Convergence](wce-2-implementation.md)
> WCE-3 evidence: [Distribution and Installed-package Verification](wce-3-implementation.md)
> WCE-4 evidence: [Authority and Closeout Validation](wce-4-validation.md)

## 1. Outcome

Move the reusable WebSocket transport out of Standalone Built-in Channels and
deliver it as an explicitly enabled first-party Extension. Keep CLI as the
only Standalone-local Channel, selected with `--cli`. Omitted Channel arguments
start no Host-local Channel.

The WebSocket Extension owns and serves the existing HTML chat client from its
HTTP listener. Browser launch is opt-in through Extension-scoped
`openBrowser: true`; it defaults to `false`.

## 2. Problem

Before this Change, Standalone imported and constructed every Built-in
Channel, validated their names in `--builtin-channels`, fixed WebSocket
settings, and gave WebSocket special process-lifetime priority. Every new
reusable transport would therefore have required another Standalone code path.

WebSocket is not inherently a terminal or Standalone capability. It is a
reusable network transport with its own protocol and HTML client. Treating it
as Host-local creates the wrong dependency direction and leaves the client in
the unrelated top-level `clients/` directory.

## 3. Scope

- Create a first-party `extensions/websocket-channel/` workspace package.
- Move WebSocket transport, Runtime Unit entry, tests, and
  `clients/html/chat.html` into that package.
- Give the package an `extension.json` Descriptor and strict scoped schema.
- Keep global Extension defaults unchanged: acquisition defaults enabled but
  `extensions.entries` defaults empty, so `{}` starts no WebSocket listener.
- Make Descriptor schema defaults the effective WebSocket configuration
  defaults after an entry is explicitly present; remove Host and transport
  fallback copies.
- Serve the chat client from the same HTTP server that accepts WebSocket
  upgrades.
- Preserve default network values `127.0.0.1:8787` and WebSocket path `/ws`
  when the Extension is explicitly enabled.
- Add `openBrowser`, default `false`, and open the served client only when
  explicitly configured.
- Expand `my-agent/extension-api` only with the stable Channel-extension
  contracts and helpers required by this package.
- Remove WebSocket imports, fixed configuration, name parsing, Unit creation,
  and controlling-lifetime policy from Standalone.
- Replace `--builtin-channels` and `-bc` with one `--cli` boolean switch.
- Make omitted `--cli` mean no Host-local Channel; reject all removed
  Built-in selection forms directly.
- Keep Extension enablement under `extensions.entries.websocket-channel`.
- Update npm assembly, Host build closure, smoke verification, stable
  authority, README, and architecture Fitness.

## 4. Non-goals

- Implementing HTTP/SSE in this Change.
- Creating a general Built-in Channel Catalog.
- Letting Standalone select or configure Extension Channels.
- Adding a global `channels` configuration namespace.
- Automatically enabling the WebSocket Extension for compatibility.
- Preserving `--builtin-channels`, `-bc`, or omitted WebSocket startup through
  an alias, dual-read path, warning period, or Feature Flag.
- Adding authentication, TLS, Origin/Host policy, a general remote-exposure
  policy, or a general Web UI asset framework. Deployment security belongs to
  the operational proxy/gateway boundary.
- Making Extension Channel completion control Standalone process lifetime.
- Redesigning Runtime Channel routing, Approval, Session, Media, or Fanout.

## 5. Target ownership

```text
Standalone Host
  -> optional CLI Runtime Unit selected by --cli
  -> generic startup facts

Runtime Bootstrap
  -> generic Extension Acquisition

WebSocket Extension
  -> WebSocket transport and protocol
  -> Extension-scoped configuration/defaults/validation
  -> HTML chat client and HTTP serving
  -> optional browser launch
  -> Channel Runtime Unit

Runtime
  -> Unit/Channel lifecycle, publication, routing, Fanout, and Shutdown
```

The Host does not import the WebSocket Extension, inspect its configuration,
or observe its completion.

## 6. Delivery slices

| Slice | Status | Outcome | Exit condition |
|---|---|---|---|
| WCE-0 Contract and packaging proof | Complete | Confirm the minimum public Channel Extension API, root-mirrored first-party package dependency closure, static asset inclusion, HTTP/WebSocket co-hosting, and browser-launch failure behavior | Proof and focused tests establish a viable public-API and official-package closure strategy without private imports or mutable installation writes |
| WCE-1 Extension extraction | Complete | WebSocket implementation, Unit entry, strict config, tests, and HTML client moved into the Extension package | [Implementation and validation record](wce-1-implementation.md) |
| WCE-2 Host convergence | Complete | Standalone knows only optional CLI and removes the old list grammar and WebSocket lifetime special case | [Implementation and validation record](wce-2-implementation.md) |
| WCE-3 Distribution and verification | Complete | Installed npm package contains a runnable first-party WebSocket Extension, assets, and dependency closure | [Implementation and validation record](wce-3-implementation.md) |
| WCE-4 Authority and closeout | Complete | ADR, stable docs, README, full gates, and independent review describe the final boundary | [Validation record](wce-4-validation.md); owner acceptance and archive remain |

Only one Slice may be `In Progress`.

## 7. Compatibility and migration

This is a direct breaking migration:

```text
Before:
  my-agent                                  -> WebSocket
  my-agent --builtin-channels cli           -> CLI

After:
  my-agent                                  -> no Host-local Channel
  my-agent --cli                            -> CLI
  config enables websocket-channel          -> WebSocket Extension
```

There is no compatibility alias. Existing deployments must explicitly enable
the Extension and remove old Channel-selection arguments.

## 8. Validation strategy

- Extension schema/default/unknown-field tests.
- Empty global configuration and absent-entry tests proving no WebSocket
  listener; present empty Extension config tests proving schema defaults are
  applied exactly once.
- Acquisition tests for absent, disabled, enabled, invalid, and neighbor
  isolation cases.
- Protocol regression for Session, Model Catalog, Turn streaming, Approval,
  Permission Mode, Abort, attachment ingress, and event routing.
- HTTP tests for the served client, content type, path behavior, and absence
  of arbitrary file access.
- Browser-launch tests using an injected launcher; default startup must never
  launch, and explicit launch failure must be observable without leaking
  configuration or command details.
- Standalone parser and lifecycle tests for omitted `--cli`, explicit
  `--cli`, duplicates, removed arguments, Console Logger conflict, zero
  Channels, and signal shutdown.
- Extension API Fitness preventing private `src/` imports from the package.
- Host build and package audits proving WebSocket implementation/client are no
  longer in the Host-local closure except through the public Extension API.
- Installed-package smoke enabling the WebSocket Extension and loading the
  served client URL.
- Full Unit, Integration, Fitness, lint, build, package, WebSocket smoke,
  documentation-link, residual, and `git diff --check` gates.

### WCE-1 evidence

Validated on 2026-09-24:

- the Extension imports Host contracts only through `my-agent/extension-api`;
- absent Extension configuration starts no WebSocket listener, while an
  explicit empty entry receives Descriptor defaults;
- focused configuration, protocol, HTTP-client, browser-launch, occupied-port,
  and script-safe path tests pass;
- independent review findings for unhandled listener startup errors and unsafe
  URL-path embedding are fixed with regression coverage;
- Unit: 107 files / 1,168 tests;
- Integration: 7 files / 19 tests;
- Architecture Fitness: 13 files / 43 tests;
- workspace lint, build, Host build audit, and `git diff --check` pass.

This was the WCE-1 checkpoint. WCE-2 subsequently removed the old Built-in
path and converged Standalone; see the
[WCE-2 implementation record](wce-2-implementation.md).

## 9. Risks and stop conditions

Stop for owner review if Delivery requires:

- an Extension import from Host, Runtime, Core private paths, or Acquisition;
- a second Extension-loading path;
- runtime installation or package-manager mutation;
- automatic WebSocket enablement or default browser launch;
- Host knowledge of Extension IDs/configuration/completion;
- serving files outside the immutable Extension package;
- changing generic Runtime Channel semantics;
- silently ignoring browser launch, transport, asset, or configuration errors;
- a package layout that works only from the repository source tree.

Delivery requires explicit owner acceptance of the ADR and Specification.
