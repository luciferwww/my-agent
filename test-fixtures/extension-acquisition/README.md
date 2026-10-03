# Extension acquisition fixtures

`never-execute.js` has an observable top-level side effect. A1 discovery and
Host-config tests copy it into temporary Agent Homes and assert that static
processing never imports it. A2 may reuse it for disabled/rejected loader tests.

The A2 fixtures cover a valid External Unit, a factory throw containing scoped
config, an invalid module export, and a metadata mismatch. They contain no
Host, Runtime, Relay, package-manager, or repository-relative runtime imports.

`runtime-provider.js` is the A5 integration fixture. Its acquired Unit publishes
a minimal Provider through the ordinary registration API so the test can prove
the complete acquisition → Runtime staging → immutable typed projection path.
