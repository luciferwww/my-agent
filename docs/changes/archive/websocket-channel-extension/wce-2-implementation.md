# WCE-2 Standalone Host Convergence

> Status: Completed
> Date: 2026-09-24
> Scope: WCE-2 Host convergence
> Related Plan: [WebSocket Channel Extension Plan](plan.md)
> Specification: [WebSocket Channel Extension Specification](websocket-channel-extension-specification.md)
> Preceding record: [WCE-1 WebSocket Extension Extraction](wce-1-implementation.md)
> Authorization boundary: WCE-3 and later remain unauthorized.

## 1. Outcome

WCE-2 removed WebSocket knowledge and policy from Standalone. The Host now
supplies no Host-local Channel by default and supplies only CLI when `--cli`
is explicitly present.

WebSocket is available only through generic Extension Acquisition after an
explicit `extensions.entries.websocket-channel` entry. Standalone does not
import, identify, configure, or observe that concrete Extension.

## 2. Standalone arguments

The supported Channel-related argument surface is:

```text
my-agent         -> no Host-local Channel
my-agent --cli   -> CLI only
```

`--cli` is a valueless boolean flag. A duplicate flag, an equals form such as
`--cli=true`, and unknown short forms are rejected with
`HOST_ARGUMENT_INVALID`.

The following grammar was removed without a compatibility alias:

```text
-bc <list>
--builtin-channels <list>
--builtin-channels=<list>
```

All removed forms are rejected before path resolution, configuration
bootstrap, or Runtime creation.

## 3. Host composition

Standalone creates a frozen empty Unit list when `--cli` is omitted. With
`--cli`, it creates one Host-local CLI Unit using the existing fixed prompt
and approval behavior.

CLI plus enabled Console Logger remains an output conflict and fails before
Runtime creation. With no CLI, Console Logger remains valid.

Only the Agent Home argument is forwarded to path resolution. Channel
selection is no longer mixed into Host path options.

## 4. Process lifetime

Without `--cli`, Standalone waits for the shared Runtime Host completion,
normally driven by a process signal or explicit Host shutdown. Completion of
an arbitrary Extension Channel does not control Standalone process lifetime.

With `--cli`, CLI completion controls Host lifetime:

- normal CLI completion initiates shared Runtime shutdown;
- failed CLI completion sets process exit status 1 and initiates shutdown;
- a rejected completion observer still enters the shared shutdown path.

The WebSocket-first lifetime policy and secondary-CLI distinction no longer
exist.

## 5. Legacy removal

WCE-2 deleted:

- `src/builtins/channels/websocket/`;
- the Built-in WebSocket Runtime Unit;
- the Built-in WebSocket Unit and protocol tests;
- the top-level `clients/html/chat.html`;
- the old Host WebSocket construction constants and imports.

The only production WebSocket transport and HTML client now live under
`extensions/websocket-channel/`.

Architecture Fitness now rejects restoration of the old Built-in source and
top-level client paths. The `ws` SDK allowlist permits only the WebSocket
Extension package.

## 6. Extension design compatibility

WCE-2 preserves ADR-014:

- Runtime Bootstrap and generic Acquisition remain the only Extension loading
  path;
- Host source contains no `websocket-channel` identity or factory reference;
- WebSocket Extension and Copilot Relay are acquired as independent
  candidates;
- acquired Units enter the same Runtime staging, publication, and lifecycle
  path as Host-local Units;
- Standalone does not observe Extension Channel completion for process policy.

The source-tree smoke explicitly configures both official Extensions and
proves that the Host loads them through generic Acquisition.

## 7. Documentation and verification surfaces

Current Channel architecture and the Standalone Host specification now
describe optional CLI and Extension-delivered WebSocket behavior. README
examples use `--cli`, the served HTTP client URL, and explicit WebSocket
Extension configuration.

The WebSocket Host smoke no longer relies on port 8787 being free. It reserves
a dynamic loopback port and supplies that value through Extension-scoped
configuration.

At the WCE-2 checkpoint, installed npm package inclusion remained WCE-3 work;
WCE-2 did not add the package or client asset to the root npm `files`
allowlist. [WCE-3](wce-3-implementation.md) subsequently completed that
distribution work.

## 8. Validation evidence

Validated on 2026-09-24:

| Gate | Result |
|---|---|
| Standalone focused tests | 48 passed |
| Full Unit, one worker | 105 files, 1,129 tests passed |
| Full Integration, one worker | 6 files, 18 tests passed |
| Architecture Fitness | 13 files, 43 tests passed |
| Workspace lint and type-check | Passed |
| Build | Passed |
| Host build audit | Passed, 334 files checked |
| Explicit WebSocket Extension Host smoke | Passed |
| `git diff --check` | Passed |

The default Vitest worker pool caused unrelated Windows process-termination
tests to exceed their five-second timeout under concurrent full-suite load.
Those focused tests passed independently, and the complete Unit and
Integration suites passed with one worker. No unrelated process-tool source
was changed.

## 9. WCE-2 boundary

WCE-2 does not:

- add the WebSocket Extension to the published npm package file allowlist;
- verify an installed tarball can load the WebSocket Extension;
- define Marketplace, remote installation, or update behavior;
- archive this Change.

Those were deferred at the WCE-2 checkpoint. WCE-3 distribution is now
complete; WCE-4 closeout remains pending.
