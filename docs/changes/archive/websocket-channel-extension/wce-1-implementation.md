# WCE-1 WebSocket Extension Extraction

> Status: Completed
> Date: 2026-09-24
> Scope: WCE-1 Extension extraction
> Related Plan: [WebSocket Channel Extension Plan](plan.md)
> Specification: [WebSocket Channel Extension Specification](websocket-channel-extension-specification.md)
> Preceding proof: [WCE-0 Contract and Packaging Proof](wce-0-proof.md)
> Authorization boundary: WCE-2 and later remain unauthorized.

## 1. Outcome

WCE-1 created a first-party `websocket-channel` Extension package and expanded
`my-agent/extension-api` with the minimum public contracts required to
implement a Channel outside the Host source tree.

The extracted Extension owns:

- WebSocket transport and protocol handling;
- Extension-scoped configuration and defaults;
- Channel Runtime Unit registration;
- HTTP delivery of the HTML chat client;
- optional browser launch;
- focused Unit and Integration tests.

The old Built-in WebSocket implementation and current Standalone behavior
remain in place. Removing that path is WCE-2 work.

## 2. Public Extension API

WCE-1 added the public Channel-extension surface needed by the extracted
package:

- Channel contracts and Runtime capabilities;
- `AgentEvent`;
- Channel-owned `ChannelOperationError` and its bounded code;
- `ExtensionLogger`.

`ExtensionLoadContext` now contains a required scoped logger. Extension
Acquisition creates that logger with the identity
`Extension:<extension-id>` and exposes only `debug`, `info`, `warn`, and
`error`.

The WebSocket Extension imports Host contracts only through
`my-agent/extension-api`. It has no private import from `src/core`,
`src/runtime`, `src/platform`, or `src/extension/acquisition`.

`WS_MAX_PAYLOAD_BYTES` is transport policy, not a Host contract. It is owned
privately by the WebSocket Extension and is not exported through
`my-agent/extension-api`. The staged old Built-in keeps a local copy only
until WCE-2 removes that implementation.

Concrete `SessionError` and `AttachmentValidationError` classes are also not
public Extension contracts. Runtime converts those owner-internal failures to
`ChannelOperationError` at Channel ingress and Session-capability boundaries.

## 3. Extension package

WCE-1 added this workspace package:

```text
extensions/websocket-channel/
├── package.json
├── tsconfig.json
├── extension.json
├── entry.ts
├── index.ts
├── config.ts
├── websocket-channel-unit.ts
├── WebSocketChannel.ts
├── client/
│   └── chat.html
└── focused Unit and Integration tests
```

The Descriptor identity is `websocket-channel`. The package contributes one
optional Runtime Unit, also named `websocket-channel`, which registers the
`websocket` Channel.

The package declares `ws` as its Runtime dependency. The root manifest and
lockfile mirror that dependency only for official package assembly. The
Extension package remains the dependency owner and source of truth; Host code
does not import `ws` on behalf of the Extension or install it at startup.

## 4. ADR-014 compatibility

WCE-1 extends the existing Extension model established by ADR-014; it does not
create a Channel-specific loading or composition model.

| ADR-014 principle | WCE-1 conformance |
|---|---|
| Extension is an independently owned npm workspace package | `extensions/websocket-channel` owns its manifest, Descriptor, source, tests, client asset, and `ws` declaration |
| One Descriptor and one unified Jiti loading path | `extension.json` points to `entry.ts`; Runtime Bootstrap and generic Acquisition remain the only loading path |
| Extension imports only stable Host API | Host contracts are imported only from `my-agent/extension-api`; there are no private Host source imports |
| Public API expands only for demonstrated needs | WCE-1 adds Channel contracts and scoped logging required by the implementation; transport policy such as `WS_MAX_PAYLOAD_BYTES` remains private |
| Descriptor owns static identity and scoped schema | WebSocket identity, entry, strict schema, and acquisition defaults remain in `extension.json` |
| Package owns runtime dependencies | `ws` is declared by the Extension; the root dependency is an audited distribution mirror, not a second owner |
| Factory returns an uncreated Runtime Unit | `createExtension(context)` performs bounded projection and returns `LoadedRuntimeUnit` without opening listeners or reading the client asset |
| Runtime owns composition and lifecycle coordination | Acquisition hands the Unit to the existing Runtime staging/publication path; the Extension owns only resources created by its Unit instance |
| Candidate failures remain isolated | schema, import, factory, and Unit failures use existing Acquisition diagnostics and do not block valid neighbors |
| No Host knowledge of concrete Extensions | WCE-1 adds no WebSocket branch, import, configuration read, or loading path to Standalone or Runtime Bootstrap |

Copilot Relay remains the first reference implementation, but its internal
factory fallback constants are not an Extension framework requirement.
WebSocket defaults are injected by its Descriptor schema and then
semantically validated as a complete scoped projection. Both approaches use
the same Acquisition contract; WCE-1 does not move defaults into Host or
global Agent configuration.

## 5. Enablement and configuration

The Extension is enabled explicitly:

```json
{
  "extensions": {
    "entries": {
      "websocket-channel": {}
    }
  }
}
```

An absent entry loads no WebSocket Unit. An entry with `enabled: false` is
disabled. A present entry with omitted `enabled` is enabled by the existing
Extension Acquisition rules.

Descriptor defaults are:

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "webSocketPath": "/ws",
  "clientPath": "/",
  "approval": true,
  "openBrowser": false
}
```

The Descriptor rejects unknown fields and invalid primitive values. Typed
configuration validation requires a complete Acquisition projection, rejects
equal HTTP and WebSocket paths, and does not contain fallback copies of
Descriptor defaults.

Both paths must be pathname-only values. Query strings, fragments, control
characters, markup, scheme-relative paths, spaces, and malformed percent
encoding are rejected.

## 6. HTTP, WebSocket, and browser behavior

One Node HTTP server owns the configured listener:

- `clientPath` serves the packaged HTML client for `GET` and `HEAD`;
- `webSocketPath` accepts WebSocket upgrades;
- other HTTP paths return `404`;
- client responses use `cache-control: no-store`;
- request paths are not mapped to arbitrary filesystem paths.

The server injects the configured WebSocket path into the HTML client. The
client derives its WebSocket endpoint from the served page origin. The
serialized path is script-safe, including escaping `<` before inserting it
into the inline script.

Browser launch is disabled by default. With `openBrowser: true`, launch is
attempted only after listener readiness. Launch failure records a bounded
warning and leaves the transport running.

## 7. Startup and shutdown behavior

`start()` rejects when:

- no message handler is registered;
- the client asset cannot be loaded;
- the listener closes before readiness;
- the configured address cannot be bound.

The WebSocket server has an explicit error listener, so an occupied port does
not create an unhandled `error` event. Failed startup detaches and closes the
WebSocket server, closes the HTTP listener when necessary, clears retained
server references, and settles Channel completion as a startup failure.

`stop()` remains safe while startup is waiting for listener readiness and
settles completion as an intentional stop.

## 8. Acquisition and architecture integration

WCE-1 added Acquisition coverage proving:

- an absent entry loads no Unit;
- an explicit empty entry receives Descriptor defaults;
- unknown configuration and unsafe paths fail schema validation;
- semantic path overlap fails inside the factory without affecting neighbor
  Extensions.

Integration Vitest configuration now resolves `my-agent/extension-api` and
includes Extension Integration tests.

Architecture Fitness changes:

- FT-02 allows `ws` inside `extensions/websocket-channel`;
- FT-05 records the staged Extension capability alongside the old Built-in;
- FT-12 assigns the new package to Channel authority.

The old Built-in FT-02 and FT-05 allowances remained temporarily at this
checkpoint and were removed during
[WCE-2](wce-2-implementation.md).

## 9. Independent review

Independent WCE-1 review found two issues:

1. listener startup errors could be re-emitted by `WebSocketServer` without an
   error listener and terminate the process;
2. path configuration accepted query, fragment, and markup content that could
   make the HTTP route unreachable or break out of the inline client script.

Both findings were fixed with regression coverage:

- occupied-port startup now rejects and cleans up without an unhandled event;
- Descriptor and typed path validation accept only safe pathname values;
- injected path serialization is script-safe.

## 10. Validation evidence

Validation completed on 2026-09-24:

| Gate | Result |
|---|---|
| Focused WebSocket configuration and transport tests | 44 passed |
| WebSocket Acquisition tests | 2 passed |
| Full Unit | 107 files, 1,168 tests passed |
| Full Integration | 7 files, 19 tests passed |
| Architecture Fitness | 13 files, 43 tests passed |
| Workspace lint and type-check | Passed |
| Build | Passed |
| Host build audit | Passed, 340 files checked |
| Private Extension import search | No matches |
| `git diff --check` | Passed |
| Independent review | Findings resolved |

The local environment uses Node 20.16.0 while the project declares Node 22.x.
The lockfile-only workspace update therefore required npm's explicit
engine-override option. No npm audit remediation was performed because the
reported vulnerabilities predated and were unrelated to WCE-1.

## 11. WCE-1 boundary

WCE-1 does not:

- change Standalone arguments;
- remove `--builtin-channels` or `-bc`;
- add `--cli`;
- stop Standalone from enabling Built-in WebSocket by default;
- remove Built-in WebSocket source or tests;
- remove the top-level HTML client;
- change WebSocket-first Host lifetime behavior;
- add the WebSocket Extension to the published npm package file list.

Those behaviors remained unchanged at the WCE-1 checkpoint. Subsequent
delivery is recorded separately:

- [WCE-2](wce-2-implementation.md): Standalone Host convergence and old
  Built-in removal, now complete;
- WCE-3: npm distribution and installed-package verification;
- WCE-4: stable authority transfer and Change closeout.
