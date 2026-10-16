# ADR-022: Explicit Standalone Agent Home Initialization

> Status: Accepted
> Decision date: 2026-10-15
> Owner: Project owner
> Related Plan/Specification: [Plan](../changes/archive/agent-home-initialization/plan.md) and [Specification](../changes/archive/agent-home-initialization/specification.md)
> Supersedes on acceptance: ADR-011 ordinary Standalone missing-config bootstrap
> Preserves: ADR-011 Platform Configuration ownership and strict loading; ADR-012 path roles

## Context

Ordinary Standalone startup currently creates a missing `config.json` as `{}`.
That behavior materializes a file but selects no Provider or default Model and
does not make a fresh Agent Home usable. ADR-011 identifies it as a temporary
bootstrap pending a separately accepted setup workflow.

## Decision drivers

- Initialization and configuration-edit success must have useful
  user-visible meaning.
- Ordinary startup should not create incomplete user configuration.
- Initialization must remain independent from Runtime lifecycle.
- The first version should use a terminal wizard and existing module APIs.
- Scope must remain inside the Standalone Host.
- Initialization must not assume every usable LLM environment fits the
  Built-in Provider.

## Options considered

1. Keep ordinary startup bootstrap.
2. Add a file-only initializer that still selects no usable Model.
3. Add an explicit terminal initializer/editor that produces a validated
   Agent Home.
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
and installed Extensions statically discovered through the separately
accepted Extension Initialization Metadata contract. Every discovered
Extension with a supported Schema can be configured without importing its
entry. It imports only Provider Extensions explicitly selected for Provider
verification and requires each to register one logical Provider before
readiness and publication. Absence of a capability declaration does not make
an Extension Schema unavailable; it means no live verification policy is
declared for that Extension in this version.

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

The Wizard uses a repeatable section menu and one in-memory Draft. A missing
configuration enters Initialize mode. An existing configuration requires
explicit confirmation and enters Edit mode; untouched supported content is
preserved, while accepted modified functional sections or Extension IDs are
replaced. Destructive reset is not included.

UI sections are navigation views, not duplicate owners. Each Extension ID has
one configuration Draft shared by every capability it contributes. Built-in
and Extension capabilities use source-independent candidate and verification
semantics. New, enabled, or changed capabilities that require verification
must produce evidence bound to the normalized candidate configuration before
Save. Unchanged existing configuration is not re-verified merely because an
unrelated section changed.

The Wizard may retain multiple Provider configurations and Models. Every
retained Provider/Model pair requires its own real minimal tool-free inference
using the exact candidate endpoint, protocol, credential, and Model. Failed
Models and Provider configurations with no successful Model are not authored.
One Default Model is selected only from the verified pairs; a manually entered
alternative must first pass the same verification. These probes carry no
Agent Context, Session history, Tools, attachments, or user data and are not
persisted.

Verification evidence is invalidated when its Provider configuration changes.
Before publication, all retained contributions are resolved as one Registry
candidate so independently successful Extensions cannot publish conflicting
Provider or other contribution identities.

Configuration changes remain candidates until all required affected
capabilities verify. A failed candidate does not replace the accepted Draft.
Save is disabled while candidates are pending, evidence is stale, the Default
Model is invalid, cleanup is incomplete, or the composed configuration is
invalid.

Initialization first completes the Wizard, final confirmation, in-memory
candidate validation, readiness, and candidate cleanup without changing Agent
Home files. Only then does Publication create missing Root Context and fixed
Profile assets in Initialize mode and publish `config.json` last.
Initialization uses exclusive creation; Edit mode uses optimistic concurrency
against the original config bytes and an exclusive same-directory temporary
file for atomic replacement. Cancellation or any pre-Publication failure
leaves Agent Home unchanged. A Publication filesystem failure may leave
compatible create-if-missing Context/Profile files in Initialize mode, but
does not publish the candidate configuration.

## Consequences

### Positive

- Initialization and ordinary Runtime startup are separate.
- A fresh startup cannot silently create an unusable config.
- Implementation remains localized and independently testable.
- No setup server or cross-module framework is introduced.
- Installed custom Provider environments can initialize without being forced
  through the Built-in protocol configuration.
- Existing Agent Homes can add or change capabilities without overwriting
  untouched logger, Agent, or Extension configuration.

### Negative

- Fresh Agent Homes require an explicit command.
- Provider Extension prompting supports only a bounded scalar Schema subset.
- Existing public APIs constrain readiness verification.
- Multi-capability Extension verification policies beyond Provider remain
  future work.

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

Richer Schema forms, Extension installation, destructive reset,
non-interactive setup, and Web setup each require separate evidence and scope
confirmation.

Process authority: [Development Workflow](../governance/development-workflow.md).
