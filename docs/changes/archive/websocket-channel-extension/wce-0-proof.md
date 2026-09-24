# WCE-0 Contract and Packaging Proof

> Status: Completed
> Date: 2026-09-24
> Scope: Design and executable proof only; no production WebSocket migration
> Related Plan: [WebSocket Channel Extension Plan](plan.md)
> Contract: [WebSocket Channel Extension Specification](websocket-channel-extension-specification.md)

## 1. Conclusion

The proposed Extension boundary is viable without a second acquisition path,
private deep imports, runtime installation mutation, or Host knowledge of the
WebSocket Extension.

WCE-1 may proceed only after separate owner authorization.

## 2. Minimum public API proof

The current WebSocket implementation consumes these Host contracts:

| Need | Current owner | WCE-1 public disposition |
|---|---|---|
| Channel instance, completion, interactions, run requests, Runtime capabilities | `core/channel` | Type re-exports through `my-agent/extension-api` |
| Agent events delivered to `Channel.send()` | `core/runner` | Type re-export only |
| Session capability and attachment rejection | `core/session`, `core/media` | Normalize at the Runtime boundary into a Channel-owned `ChannelOperationError`; do not export concrete Session or Media errors |
| WebSocket payload ceiling | WebSocket transport | Keep it private to the WebSocket Extension; it is not a Host contract |
| Unit and registration construction | `runtime/runtime-unit` and `core/registry` | Existing public exports remain |
| Logging | Platform Logger | Add a narrow scoped `ExtensionLogger` to `ExtensionLoadContext`; do not export global Logger mutation |

`my-agent/extension-api` currently exposes the Unit helper and registration
API, but not the Channel, event, Session, Media, or scoped logging contracts.
The gap is bounded and does not require Bootstrap, Acquisition, concrete Host,
Registry Builder, or mutable Runtime internals.

Existing factories remain compatible with the additive readonly
`ExtensionLoadContext.logger` member because they may ignore it. Acquisition
can derive the logger scope from the already validated Descriptor ID.

## 3. HTTP/WebSocket and browser proof

An executable proof used Node HTTP plus the existing `ws` dependency to:

1. bind one ephemeral loopback HTTP server;
2. serve an HTML response at `/`;
3. return 404 at an unrelated path;
4. accept WebSocket Upgrade only at `/ws`;
5. exchange one WebSocket message;
6. skip the injected browser launcher when disabled;
7. invoke it exactly once after listener readiness when enabled;
8. convert an injected launch failure to a bounded warning while leaving the
   transport operational;
9. close the WebSocket server and HTTP listener cleanly.

Observed result:

```json
{
  "pageStatus": 200,
  "missingStatus": 404,
  "echoed": "echo:ready",
  "launches": 1,
  "warning": "browser_launch_failed",
  "closed": true
}
```

The proof script is retained as a session artifact rather than production
source because WCE-1 is not authorized.

## 4. Configuration-default proof

Extension Acquisition constructs AJV with `useDefaults: true`, clones scoped
input before validation, and freezes the resulting projection. Loader behavior
is:

```text
missing entries.websocket-channel -> disabled
entry enabled: false               -> disabled
entry present, enabled omitted     -> enabled
config omitted                     -> {}
Descriptor defaults               -> injected before factory call
```

Therefore global defaults remain:

```text
extensions.enabled = true
extensions.entries = {}
```

An empty Agent document starts no WebSocket listener. Host and Channel fallback
literals can be deleted once the Descriptor schema becomes the effective
default authority.

## 5. Package-closure proof

The existing root npm audit already accepts all bundled Extension manifests as
inputs and rejects any Extension production dependency whose exact range is
absent from either the root manifest or root lockfile. This is the intended
official-product assembly boundary:

```text
Extension package.json declares ws
        ↓
root package.json and lockfile mirror the same range
        ↓
installed Extension resolves root node_modules/ws through normal ancestry
```

`npm pack --dry-run --json` completed successfully on the current package and
reported the explicit Host/Extension allowlist. The final WebSocket package,
HTML asset, and installed dependency resolution remain WCE-3 acceptance
evidence after WCE-1 creates the package.

## 6. Executed checks

| Check | Result |
|---|---|
| HTTP/WebSocket/browser executable proof | Passed with the observed result above |
| Package audit, Extension configuration, and Extension loader focused tests | 43/43 passed |
| `npm run verify:host-build` | Passed; 340 files audited |
| `npm pack --dry-run --json` | Passed; current artifact reported 351 entries |
| Documentation governance FT-09 | 2/2 passed before WCE-0 proof closeout |
| `git diff --check` | Passed before WCE-0 proof closeout |

## 7. WCE-1 gate

WCE-1 must not begin without owner authorization. Its first implementation
step must add and test the bounded public Extension API above before moving
WebSocket code. If that surface proves insufficient or requires mutable
Runtime/Host internals, Delivery stops for owner review.
