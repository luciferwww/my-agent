# Extension acquisition fixtures

`never-execute.js` has an observable top-level side effect. A1 discovery and
Host-config tests copy it into temporary Agent Homes and assert that static
processing never imports it. A2 may reuse it for disabled/rejected loader tests.
