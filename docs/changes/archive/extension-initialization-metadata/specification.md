# Extension Initialization Metadata Specification

> Status: Implemented and validated
> Date: 2026-10-15
> Owner: Project owner
> Related Plan: [Extension Initialization Metadata Plan](plan.md)
> Acceptance: The project owner accepted this Specification and authorized Delivery on 2026-10-15.
> Closeout: The project owner accepted completed Delivery and validation and authorized archive on 2026-10-15.

## 1. Descriptor contract

The existing Extension Descriptor adds two fields without changing
`manifestVersion`:

```ts
type ExtensionContributionKind = 'provider';

interface ExtensionDescriptorV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name?: string;
  readonly version: string;
  readonly entry: string;
  readonly contributes?: readonly ExtensionContributionKind[];
  readonly configSchema: Readonly<Record<string, unknown>>;
}
```

When present, `name` is a nonblank Extension-level display name. Presentation
falls back to `id` when it is omitted. The name is not repeated per
contribution. `contributes` is an optional, duplicate-free list. Omission means
the Extension makes no static claim and does not change ordinary loading.

The only accepted contribution string in this Change is:

```text
provider
```

Other Registry contribution kinds are added only when a concrete consumer
requires static discovery for them.

The declaration is discovery metadata, not a permission, sandbox, loading
instruction, or replacement for actual Runtime registration.

## 2. Discovery

`discoverExtensionDescriptors()` validates and returns the added metadata while
retaining current deterministic ordering, containment, duplicate isolation,
and diagnostic behavior. Reading a Descriptor never imports its entry.

A consumer may list installed Provider Extensions by selecting candidates whose
Descriptor includes `provider`. It uses Descriptor `name` for presentation and
falls back to Descriptor `id` when `name` is omitted. The consumer loads only
an explicitly selected candidate and must verify its actual staged
registration contains at least one Provider before relying on the static claim.

An omitted or false claim does not alter ordinary acquisition. This Change
does not require acquisition to create a Unit to compare static and Runtime
contributions.

## 3. Schema annotations

Extension configuration remains strict Draft-07. `title`, `description`, and
`writeOnly` remain optional standard annotations:

- omitted `title` has no Draft-07 default; a UI may fall back to the property
  key;
- omitted `description` provides no help text;
- omitted `writeOnly` has the Draft-07 behavior of `false`.

This contract assigns sensitive-input behavior only to a direct root property
whose Schema is an object with:

```json
{
  "type": "string",
  "writeOnly": true
}
```

Nested, referenced, composed, non-string, or dynamically named properties do
not gain sensitive-input or environment-reference behavior from this rule.

## 4. Sensitive configuration materialization

A sensitive root string may be:

- a literal string;
- one exact `${ENV_VAR}` reference;
- omitted when its Schema permits omission.

Configuration preparation resolves an exact environment reference before Ajv
validation and passes only the resolved value to Extension code. It persists
nothing and never reports the resolved value. Missing or blank referenced
variables retain the existing bounded `secret_unavailable` failure semantics,
including only the property path and environment-variable name.

Field names have no sensitive meaning. The former special case for a root
property named `apiKey` is removed. The official Copilot Relay Schema marks its
root `apiKey` property with `writeOnly: true`, preserving its accepted literal
and environment-reference behavior through Schema metadata.

## 5. Official declaration

The Copilot Relay Descriptor declares:

```json
{
  "name": "Copilot Relay Provider",
  "contributes": ["provider"]
}
```

No capability-specific display name or contribution ID is added.

## 6. Acceptance

- Descriptor discovery returns optional `name` and immutable Provider
  contribution metadata;
- invalid names, unknown kinds, duplicates, and invalid list shapes are
  isolated with existing Descriptor diagnostics;
- an omitted `name` preserves the Descriptor and presents its `id`;
- discovery still imports no Extension code;
- ordinary Extensions with omitted `contributes` retain existing acquisition
  behavior;
- literal and exact environment references work for any sensitive root string;
- an exact `${ENV_VAR}` value in a root `apiKey` lacking `writeOnly: true`
  remains the literal string and is not environment-materialized;
- `writeOnly: true` on unsupported Schema shapes does not silently grant
  credential behavior;
- diagnostics and logs remain secret-free;
- no Manifest version, migration, compatibility reader, setup framework, or
  Runtime composition behavior is added.
