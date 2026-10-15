# ADR-022: Explicit Standalone Agent Home Initialization

> Status: Proposed
> Decision date: 2026-10-14
> Owner: Project owner
> Related Plan/Specification: [Plan](../changes/active/agent-home-initialization/plan.md) and [Specification](../changes/active/agent-home-initialization/specification.md)
> Supersedes on acceptance: ADR-011 ordinary Standalone missing-config bootstrap
> Preserves: ADR-011 Platform Configuration ownership and strict loading; ADR-012 path roles

## Context

Ordinary Standalone startup currently creates a missing `config.json` as `{}`.
That behavior materializes a file but selects no Provider or default Model and
does not make a fresh Agent Home usable. ADR-011 identifies it as a temporary
bootstrap pending a separately accepted setup workflow.

## Decision drivers

- Initialization success must have a useful user-visible meaning.
- Ordinary startup should not create incomplete user configuration.
- Initialization must remain independent from Runtime lifecycle.
- The first version should use a terminal wizard and existing module APIs.
- Scope must remain inside the Standalone Host.
- Initialization must not assume every usable LLM environment fits the
  Built-in Provider.

## Options considered

1. Keep ordinary startup bootstrap.
2. Add a file-only initializer that still selects no usable Model.
3. Add an explicit terminal initializer that produces a validated Agent Home.
4. Add a browser setup server.

## Decision

Choose option 3.

Standalone exposes:

```text
my-agent --initialize [--agent-home <path>]
```

The entry routes this mode to a small Standalone-owned initializer and exits.
It never constructs `RuntimeApp`. The implementation uses existing public
module APIs and does not modify non-Standalone production modules.

Ordinary Standalone startup stops creating a missing empty configuration and
instead gives bounded initialization guidance.

The first version uses `@clack/prompts` and offers both the Built-in Provider
and installed Extensions statically discovered through the separately accepted
Extension Initialization Metadata contract. It imports only the Provider
Extension explicitly selected by the user and verifies actual Provider
registration before readiness and publication.

The Built-in route supports its current OpenAI Responses, OpenAI Chat
Completions, and Anthropic Messages protocols. An Extension route derives a
bounded scalar prompt flow from its Draft-07 Schema, using optional `title` and
`description`, Schema defaults, and explicit `writeOnly: true` sensitive
strings. It does not infer sensitivity from property names.

Initialization installs fixed Root/named Agent content, writes one valid
configuration using `agents.list[]` plus the global
`agents.steeringEnabled`, `agents.maxLlmCallsPerTurn`, and
`agents.maxSubagentDepth` fields, and adds no Web, non-interactive, repair,
migration, Manifest version, secret-store, or generic setup framework. It writes no
top-level `runner` namespace or Role-level Model-call limit.

Sensitive input is an explicit choice between a masked literal, an existing
environment-variable reference, and omission when its Schema permits it.
Literal is the default highlighted path and carries a plaintext-storage
warning. The initializer does not create `.env`, Keychain, or Secret Store
state.

Success requires one real minimal tool-free inference using the exact
candidate endpoint, protocol, credential, and Model. This probe carries no
Agent Context, Session history, Tools, attachments, or user data and is not
persisted.

## Consequences

### Positive

- Initialization and ordinary Runtime startup are separate.
- A fresh startup cannot silently create an unusable config.
- Implementation remains localized and independently testable.
- No setup server or cross-module framework is introduced.
- Installed custom Provider environments can initialize without being forced
  through the Built-in protocol configuration.

### Negative

- Fresh Agent Homes require an explicit command.
- Provider Extension prompting supports only a bounded scalar Schema subset.
- Existing public APIs constrain readiness verification.
- Existing Agent Homes are not upgraded.

## Validation

Standalone routing, prompt, filesystem, candidate validation, publication,
ordinary-start cutover, package, and manual terminal tests must pass. The Agent
Home Initialization production diff must not modify non-Standalone modules
except dependency manifests, lockfile, documentation, tests, and packaged
assets. Its separately accepted Extension Initialization Metadata prerequisite
owns the Extension contract changes.

## Migration and rollback

There is no migration. Rollback restores ordinary Standalone bootstrap and
removes the explicit initializer as one unit.

## Follow-up

Richer Schema forms, Extension installation, configuration editing,
non-interactive setup, and Web setup each require separate evidence and scope
confirmation.

Process authority: [Development Workflow](../governance/development-workflow.md).
