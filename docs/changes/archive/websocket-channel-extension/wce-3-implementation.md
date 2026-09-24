# WCE-3 Distribution and Installed-package Verification

> Status: Completed
> Date: 2026-09-24
> Scope: WCE-3 distribution and verification
> Related Plan: [WebSocket Channel Extension Plan](plan.md)
> Specification: [WebSocket Channel Extension Specification](websocket-channel-extension-specification.md)
> Preceding record: [WCE-2 Standalone Host Convergence](wce-2-implementation.md)
> Authorization boundary: WCE-4 remains unauthorized.

## 1. Outcome

The official npm package now includes the first-party WebSocket Extension,
its Descriptor, production TypeScript source, package metadata, and HTML
client asset. An installed tarball can discover and load the Extension through
the same Jiti Acquisition path used in the source workspace.

Installed-package verification explicitly enables the Extension, completes a
WebSocket handshake, serves the packaged HTML client, and proves installation
and startup-CWD trees remain immutable.

## 2. Package surface

At the WCE-3 checkpoint, the root npm `files` allowlist included the following
WebSocket Extension production content:

```text
extensions/websocket-channel/
├── WebSocketChannel.ts
├── websocket-constants.ts
├── websocket-channel-unit.ts
├── config.ts
├── entry.ts
├── index.ts
├── extension.json
├── package.json
└── client/chat.html
```

Tests and `tsconfig.json` are not published. The package audit requires the
Descriptor, entry, package metadata, transport implementation, and HTML client
and rejects files outside the accepted Host and official Extension roots.

## 3. Dependency ownership and closure

`extensions/websocket-channel/package.json` remains the owner and source of
truth for the `ws` runtime dependency. The root manifest and lockfile mirror
the exact range only to assemble the official installation dependency closure.

The npm package audit reads both official Extension manifests and rejects any
Extension dependency that is absent or range-divergent in the root package
closure. Runtime never invokes a package manager or mutates the installation.

## 4. Installed acquisition

Verification installs the generated tarball into an isolated project and
loads both:

- `copilot-relay-provider`;
- `websocket-channel`.

Acquisition uses the installed `dist/host/extension/acquisition` entry and the
installed `extensions` directory. It returns two ordered
`LoadedRuntimeUnit` values with no diagnostics. No source-checkout Extension
path participates.

## 5. Installed WebSocket and client smoke

The verification creates an isolated Agent Home configuration containing an
explicit `extensions.entries.websocket-channel` entry. It supplies a dynamic
loopback port through Extension-scoped configuration so the smoke does not
depend on port 8787 being free.

The installed command then proves:

- the WebSocket listener reaches readiness;
- `hello` receives the expected `hello_ack`;
- `GET /` returns status 200 and an HTML content type;
- the client contains the configured `/ws` path;
- the build-time path token is absent;
- Runtime operation does not change the installed package or startup CWD.

Omitted Channel arguments still exercise zero-Host-local-Channel startup.
The retired top-level `host` configuration namespace remains rejected.

## 6. Extension API scope review

WCE-3 repeated the Extension API review before accepting the published
surface.

The public API contains Channel contracts that a Channel Extension must
implement and a scoped logger capability. It does not expose:

- `WS_MAX_PAYLOAD_BYTES` or other transport policy;
- concrete `SessionError` or `AttachmentValidationError` classes;
- global Logger mutation;
- Acquisition internals;
- Runtime, Bootstrap, Registry Builder, or Host state.

Runtime converts internal Session and Media failures at the Channel boundary
to the Channel-owned `ChannelOperationError`. The WebSocket Extension depends
only on that bounded Channel contract. Architecture Fitness prevents the
concrete Session/Media errors from being restored to
`my-agent/extension-api`.

## 7. Validation evidence

Validated on 2026-09-24:

| Gate | Result |
|---|---|
| Package audit and verification helper tests | 9 passed |
| Channel boundary focused tests | 73 passed |
| Full Unit, one worker | 105 files, 1,130 tests passed |
| Full Integration, one worker | 6 files, 18 tests passed |
| Architecture Fitness | 13 files, 43 tests passed |
| Workspace lint and type-check | Passed |
| Installed npm package verification | Passed, 354 files |
| Installed WebSocket handshake | Passed |
| Installed HTTP client smoke | Passed |
| Installation/startup-CWD immutability | Passed |
| `git diff --check` | Passed |

The verification machine runs Node 20.16.0 while the package correctly
declares Node 22.x. The first installation attempt was rejected by local
engine-strict enforcement. The successful verification disabled
engine-strict only for that validation process; the package engine declaration
was not changed.

## 8. WCE-3 boundary

WCE-3 does not archive the Change or perform final owner acceptance.
WCE-4 owns:

- final stable-authority consistency review;
- complete residual and link scans;
- final independent code review;
- full closeout gates;
- owner acceptance and archival.
