# Extension Initialization Metadata Plan

> Status: Completed, validated, owner-accepted, and archived
> Date: 2026-10-15
> Owner: Project owner
> Type: Bounded Contract Change
> Specification: [Extension Initialization Metadata Specification](specification.md)
> Authorization: The project owner accepted the Plan and Specification and authorized Delivery on 2026-10-15.
> Closeout: The project owner accepted completed Delivery and validation and authorized archive on 2026-10-15.

## 1. Outcome

Allow a setup consumer to discover which installed Extensions claim Provider
capability and safely interpret sensitive scalar configuration without loading
every Extension.

## 2. Scope

- Add optional Extension-level `name` presentation metadata with `id` fallback.
- Add optional `contributes[]` static metadata whose only accepted value in
  this Change is `provider`.
- Preserve the existing `manifestVersion: 1`; adding these fields does not
  introduce a new Manifest version, migration, or compatibility reader.
- Treat a direct root `type: "string"` property with `writeOnly: true` as
  sensitive Extension configuration.
- Replace field-name-based `apiKey` environment materialization with
  Schema-driven materialization for those sensitive root strings.
- Update the official Copilot Relay Manifest.
- Update Extension discovery, configuration preparation, tests, and stable
  authority.

## 3. Non-goals

- Extension installation, download, marketplace, update, or signing.
- A general setup framework or terminal UI.
- Capability-specific display names or declared contribution IDs.
- Full JSON Schema form generation.
- Runtime sandboxing or permissions.
- Loading an Extension solely because it makes a static contribution claim.
- A new Manifest version or compatibility path.

## 4. Production scope

Production changes remain in:

```text
src/extension/acquisition/
extensions/copilot-relay-provider/extension.json
```

Tests and Extension authority change with that contract. Runtime composition,
Registry behavior, Provider implementations, and Standalone behavior do not
change in this prerequisite.

## 5. Delivery items

| Item | Status | Exit condition |
|---|---|---|
| EIM-1 Descriptor metadata | Complete | discovery validates optional `name` and `provider` contribution metadata without importing Extension code |
| EIM-2 Sensitive configuration | Complete | direct root write-only strings support literal and exact environment references without field-name inference |
| EIM-3 Official Manifest | Complete | Relay declares its display name and Provider contribution |
| EIM-4 Authority and validation | Complete | focused acquisition, integration, lint, build, documentation, and review gates pass |

Only one item may be `In Progress`.

## 6. Entry and exit gates

Delivery requires owner acceptance of this Plan and its Specification. The
Change exits when static Provider discovery and Schema-driven sensitive
configuration are implemented and validated, stable Extension authority is
synchronized, and the owner accepts closeout.

## 7. Validation record

Validated on 2026-10-15:

- focused Extension Acquisition Unit and Runtime integration coverage passed:
  72 tests;
- full Unit suite passed: 115 files, 1447 tests;
- full Integration suite passed: 7 files, 23 tests;
- TypeScript and workspace lint passed;
- build, WebSocket Client verification, Host build audit, and Relay tests
  passed; Relay coverage passed 109 tests;
- independent implementation review found two bounded gaps: composed or
  referenced property Schemas could receive sensitive materialization, and
  diagnostic truncation could split a JSON Pointer escape; both were fixed and
  covered before final validation;
- `git diff --check` passed;
- the build retained the existing Node 20.16/Vite 20.19+ warning and completed
  successfully.
