# WebSocket Channel Extension Specification

> Status: Accepted and Archived
> Date: 2026-09-24
> Owner: Project owner
> Related Plan: [WebSocket Channel Extension Plan](plan.md)
> Decision: [ADR-015: Host-local and Extension-delivered Channels](../../../decisions/adr-015-host-local-and-extension-delivered-channels.md)
> Authorization: WCE-0 through WCE-4 are authorized.
> WCE-0 evidence: [Contract and Packaging Proof](wce-0-proof.md)
> WCE-1 evidence: [WebSocket Extension Extraction](wce-1-implementation.md)
> WCE-2 evidence: [Standalone Host Convergence](wce-2-implementation.md)
> WCE-3 evidence: [Distribution and Installed-package Verification](wce-3-implementation.md)

## 1. Purpose

Define the package, configuration, transport, client-resource, Host, lifecycle,
and distribution contracts for delivering WebSocket as a first-party
Extension instead of a Standalone Built-in Channel.

## 2. Package and dependency boundary

The implementation lives under:

```text
extensions/websocket-channel/
├── extension.json
├── package.json
├── entry.ts
├── websocket-channel-unit.ts
├── WebSocketChannel.ts
├── client/
│   └── chat.html
└── focused tests
```

The Extension imports Host contracts only through
`my-agent/extension-api`. It must not deep-import `src/core`, `src/runtime`,
`src/platform`, `src/extension/acquisition`, or another Extension.

The package owns its runtime dependency declaration, including `ws`. The root
package remains the official product assembler: its production dependency
table mirrors dependencies declared by every bundled first-party Extension,
and the existing npm audit checks exact compatible ranges against each
Extension manifest and the lockfile. This gives an installed Extension normal
ancestor resolution through the root package's `node_modules`; repository-only
workspace hoisting is not sufficient evidence. Loading must not install
packages or mutate the installation.

## 3. Extension configuration

The Descriptor ID is `websocket-channel`. It is disabled unless a matching
Extension entry exists, under the existing Acquisition contract:

```json
{
  "extensions": {
    "entries": {
      "websocket-channel": {
        "enabled": true,
        "config": {
          "host": "127.0.0.1",
          "port": 8787,
          "webSocketPath": "/ws",
          "clientPath": "/",
          "approval": true,
          "openBrowser": false
        }
      }
    }
  }
}
```

Global Configuration keeps its existing defaults:

```text
extensions.enabled = true
extensions.entries = {}
```

Consequently, an empty Agent document `{}` does not load WebSocket. A present
entry with omitted `enabled` is enabled under the existing Extension contract.
Its omitted `config` is treated as `{}`, and Acquisition's AJV
`useDefaults: true` processing injects the Descriptor schema defaults into the
cloned scoped configuration before freezing it and invoking the factory.

Extension-scoped defaults are:

```text
host          = 127.0.0.1
port          = 8787
webSocketPath = /ws
clientPath    = /
approval      = true
openBrowser   = false
maxClients    = absent
```

The Descriptor schema is the effective default authority. The factory and
Channel receive the complete validated projection and do not copy fallback
literals. The Descriptor schema rejects unknown fields and validates:

- non-empty `host`;
- integer `port` from 0 through 65535;
- absolute `webSocketPath` and `clientPath`;
- distinct WebSocket and client paths;
- positive safe-integer `maxClients` when present;
- boolean `approval` and `openBrowser`.

The factory performs bounded semantic revalidation before returning the Unit.

## 4. HTTP and WebSocket transport

The Extension owns one HTTP server. It:

- serves the bundled `chat.html` only at `clientPath`;
- performs WebSocket Upgrade only at `webSocketPath`;
- returns bounded not-found responses for other paths;
- never maps arbitrary request paths to the filesystem;
- owns the WebSocket payload ceiling while preserving its current value and
  protocol behavior;
- flushes no configuration, credentials, or local paths to clients.

The client derives its WebSocket URL from the served page origin and configured
WebSocket path. The bundled single-page HTML is a minimal reference/debugging
client, not a required or security-hardened production frontend. An external
website may connect directly. Authentication, TLS, Origin/Host policy, and
public-network hardening belong to the operational proxy/gateway boundary.
Opening the packaged page through `file://` is no longer a supported workflow.

Only the logical client bound to a pending approval may resolve it; foreign and
unknown submissions neither settle the interaction nor consume its pending
route. Approval request and closure payloads carry the owning `sessionId` and
`turnId`; the Channel retains those values with the pending `clientId` route.

The transport relationship is many-to-many. A logical client may join and
work in multiple Session audiences concurrently, while each Session may be
observed by multiple clients. The bundled reference client projects the
selected Session over separate page-local state for each Session, including
draft, attachment, Turn, Approval, permission, and waiting state. Switching
the selected Session does not abort or clear work in another Session. The
page does not promise event replay or state restoration after refresh,
disconnect, or browser failure.

All Session-correlated events are applied to their owning Session rather than
whichever Session is currently visible. This includes a queued `request_end`:
although the canonical event has no Session ID, the Channel already resolves
its audience through `originMessageId` and adds the resolved `sessionId` to the
WebSocket payload.

The Extension preserves current Session, Model Catalog, Turn, Approval,
Permission Mode, Abort, attachment, event-routing, and client replacement
semantics unless this Specification explicitly changes them.

## 5. Browser launch

`openBrowser` defaults to `false`. When true:

1. the HTTP/WebSocket listener reaches readiness;
2. the Extension constructs the local served-client URL;
3. it requests the platform browser launcher once per successful start.

The launcher is injected in tests. Browser launch never runs during module
import, Extension acquisition, Unit creation, or disabled startup.

A browser-launch failure is a bounded warning and does not stop an otherwise
healthy transport. It must not expose raw command lines, environment values,
credentials, or installation paths. Runtime shutdown does not attempt to close
the launched browser.

For wildcard bind addresses, the browser URL uses a loopback address rather
than the wildcard address. The served URL contains no credential.

## 6. Public Extension API

`my-agent/extension-api` exports the minimum stable contracts and runtime
helpers necessary to implement a Channel Extension:

- canonical Channel instance, completion, interaction, inbound-message, and
  Runtime-capability types;
- `AgentEvent` and the Approval/Session value types required by those Channel
  contracts;
- a Channel-owned `ChannelOperationError` preserving bounded Session
  capability and attachment-ingress failure codes without exposing concrete
  Session or Media errors;
- the existing Runtime Unit construction helper and registration API;
- a scoped `ExtensionLogger` capability on `ExtensionLoadContext`.

Acquisition creates the logger using the validated Descriptor identity and
passes it with the frozen scoped configuration. An Extension may retain that
capability in its not-yet-created Unit, but receives no global Logger mutation
surface. Existing Extension factories remain source-compatible because they
may ignore the added readonly context member.

The public API does not expose mutable Runtime internals, Bootstrap, Registry
builders, concrete Host APIs, Platform Logger static state, or Acquisition
implementation.

## 7. Standalone Host

Standalone accepts:

```text
--agent-home <path>
--agent-home=<path>
-ah <path>
--cli
```

`--cli` occurs at most once and takes no value. The following are invalid:

```text
--cli=true
--builtin-channels ...
--builtin-channels=...
-bc ...
```

Omitting `--cli` supplies no Host-local Channel Unit. Supplying `--cli`
supplies exactly the CLI Unit with its existing fixed prompt and Approval
behavior. CLI plus enabled Console Logger remains `HOST_OUTPUT_CONFLICT`.

Standalone does not import, construct, configure, select, wait for, or name the
WebSocket Extension. With CLI selected, CLI completion controls Host shutdown.
Without CLI, Standalone waits for a signal or explicit Host shutdown;
Extension Channel completion remains governed by generic Runtime logging and
does not terminate the process.

## 8. Extension enablement and failure

- Missing `extensions.entries.websocket-channel` means disabled.
- Explicit `enabled: false` means disabled.
- `{}` therefore starts no WebSocket listener and changes no global
  configuration default.
- Valid enabled configuration produces one initially enabled, non-required
  Runtime Unit and one Channel contribution with ID `websocket`.
- Descriptor/config/import/factory failures use existing isolated Extension
  diagnostics.
- Listener startup failure fails Unit activation according to existing Runtime
  composition behavior.
- Runtime listener failure settles Channel completion as failed and uses
  existing bounded Runtime Channel failure logging.
- One failed/disabled Extension does not prevent valid neighboring Extensions
  from acquisition.

## 9. Distribution

The root npm artifact includes:

- the generic Host and `my-agent/extension-api`;
- the first-party WebSocket Extension descriptor, executable entry/code, HTML
  client, package metadata, and production runtime dependency closure;
- no duplicate top-level `clients/html/chat.html`;
- no Standalone-owned WebSocket implementation or asset copy.

The WebSocket Extension manifest declares `ws`; the root product manifest and
lockfile mirror the same supported range because the root artifact assembles
the bundled first-party package. Package audit reads all bundled Extension
manifests and fails when any production dependency is absent or range-mismatched
in the root closure.

The installed command does not enable the Extension automatically. Package
verification creates explicit Agent configuration enabling it, starts the
installed command, fetches the served client, completes a real WebSocket Turn,
and proves installation/startup-CWD immutability.

## 10. Compatibility

This Change intentionally removes:

- omitted-argument WebSocket startup;
- `--builtin-channels`;
- `-bc`;
- Standalone fixed WebSocket construction;
- WebSocket-first controlling completion;
- opening `clients/html/chat.html` directly.

No alias, automatic migration, compatibility warning period, Feature Flag, or
dual implementation remains.

## 11. Acceptance scenarios

1. `my-agent` starts with no Host-local Channel and waits for shutdown.
2. `my-agent --cli` starts CLI only.
3. removed Built-in selection arguments fail before path/configuration side
   effects.
4. missing or disabled WebSocket Extension creates no WebSocket listener.
5. `{}` creates no WebSocket listener; a present empty Extension entry applies
   the Descriptor defaults, serves chat at `/`, and upgrades at `/ws`.
6. custom valid paths and port take effect.
7. unknown/invalid fields are rejected with bounded Extension diagnostics.
8. `openBrowser` omission/false never invokes the launcher.
9. `openBrowser: true` invokes it once after readiness; launch failure warns
   without stopping the listener.
10. one client can keep multiple Sessions active and switch the reference UI
    without clearing another Session's page-local state.
11. Approval request/closure and queued terminal messages carry enough Session
    and Turn correlation for the client to update background Sessions.
12. a foreign connected client cannot resolve or consume another client's
    pending approval.
13. protocol, Approval, Session permission, Abort, Model Catalog, attachment,
    and Fanout behavior otherwise remains compatible.
14. installed-package verification uses only packaged Extension code/assets
    and production dependencies.
15. private import, source-tree asset, old Built-in WebSocket, and old CLI
    argument residual checks are clean.
