# Agent Home Initialization Plan

> Status: Accepted
> Date: 2026-10-14
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Agent Home Initialization Specification](specification.md)
> Decision: [ADR-022: Explicit Standalone Agent Home Initialization](../../../decisions/adr-022-explicit-standalone-agent-home-initialization.md)
> Depends on: [Shared Configured Agents](../../archive/shared-configured-agents/plan.md) and [Extension Initialization Metadata](../../archive/extension-initialization-metadata/plan.md)
> Authorization: Authorized for Delivery by the project owner on 2026-10-15.

## 1. Outcome

Add one explicit terminal flow that initializes a new Agent Home and exits. A
successful result contains valid Root Context, first-party named Agent
profiles, one configured default Model, and a configuration that ordinary
standalone startup can load.

## 2. Production scope

Production code changes are limited to:

```text
src/hosts/standalone/
package.json
package-lock.json
Standalone-owned packaged initialization assets
```

The initializer may call existing public APIs from other modules. It does not
change Runtime, Session, Channel, Runner, Memory, Model Resolution, Extension
Acquisition, Provider, Platform Configuration, Agent Context, or Core
Subagent production code.

## 3. Scope

- Add `--initialize` to standalone argument parsing.
- Route initialization separately from ordinary Host startup.
- Use `@clack/prompts` for a bounded interactive terminal wizard.
- Create Root Context through the existing public Agent Context API.
- Install fixed `reviewer`, `explorer`, and `researcher` profiles using the
  accepted Shared Configured Agents layout.
- Generate only the accepted global Agent execution fields:
  `agents.steeringEnabled`, `agents.maxLlmCallsPerTurn`, and
  `agents.maxSubagentDepth`; do not generate a `runner` section or Role-level
  execution limits.
- Show all statically discovered installed Extensions. Allow bounded
  Schema-driven configuration for each; apply Provider live verification only
  when its Descriptor statically declares `provider`.
- Configure one Built-in connection with one or more explicit
  protocol/Model-ID pairs and configure multiple selected Provider Extensions
  from their bounded Draft-07 scalar Schemas.
- Accept masked literals, existing environment-variable references, or
  omission for Schema-declared sensitive strings.
- Load only explicitly selected Provider Extensions and require each to
  register exactly one logical Provider.
- Verify every retained Provider/Model pair with one real minimal tool-free
  inference.
- Select one Default Model only from the successfully verified pairs.
- Invalidate prior Model successes when their Provider configuration changes,
  and reject combined Registry contribution conflicts before publication.
- Validate the candidate with existing public APIs.
- Complete prompting, confirmation, validation, readiness, and candidate
  cleanup before changing Agent Home files.
- Enter Edit mode only after explicit confirmation when `config.json` exists.
- Preserve untouched supported configuration and replace only accepted
  modified functional sections or exact Extension entries.
- Use one Extension configuration Draft across all contributed capabilities.
- Require source-independent verification evidence for every new or modified
  capability whose policy requires it.
- Atomically create or concurrency-protected replace one authoritative
  `config.json`.
- Stop ordinary standalone startup from creating a missing empty config;
  report bounded initialization guidance instead.
- Exit without constructing `RuntimeApp`.

## 4. Configuration output

The initializer writes one minimal `config.json` with two or three top-level
sections:

| Section | Generated content |
|---|---|
| `llm` | one verified pair as `defaultModel`, plus only successfully verified Built-in Model registrations when present |
| `agents` | fixed global execution policy and the `reviewer`, `explorer`, and `researcher` entries |
| `extensions` | Schema-configured Extension entries, with Provider Extension entries retained only after at least one verified Model |

The generated shape is:

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "<model-id>"
    },
    "builtin": {
      "baseURL": "<base-url>",
      "apiKey": "<optional literal or ${ENV_VAR}>",
      "models": [
        {
          "modelId": "<model-id>",
          "protocol": "<selected-protocol>"
        }
      ]
    }
  },
  "agents": {
    "steeringEnabled": false,
    "maxLlmCallsPerTurn": "<optional positive integer>",
    "maxSubagentDepth": 1,
    "defaults": {
      "tools": {
        "allow": ["<recommended Root Agent Tools>"],
        "deny": []
      }
    },
    "list": [
      { "id": "reviewer", "...": "fixed read-only tools" },
      { "id": "explorer", "...": "fixed read-only tools" },
      { "id": "researcher", "...": "fixed research tools" }
    ]
  }
}
```

`llm.builtin` and `extensions` may coexist. `llm.builtin` is omitted when no
Built-in Model succeeded. Each retained
`extensions.entries.<extensionId>.config` contains only values authored by the
user and has at least one successfully verified Model in the in-memory
verification result. `extensions.enabled` and entry `enabled` are omitted
because their effective value is already true.

Placeholders are explanatory and are not written literally. Sensitive fields
are omitted when permitted and declined; `maxLlmCallsPerTurn` is omitted when
its prompt is blank. `agents.defaults` contains only the recommended Root Tool
policy; `logger`, top-level `runner`, other Agent defaults, and all other
default or unused sections are omitted.

The authoritative field values, fixed Tool allow-lists, omission rules,
terminal prompts, credential handling, readiness request, and publication
behavior are defined in the
[Specification](specification.md), especially
[Wizard flow and terminal copy](specification.md#wizard-flow-and-terminal-copy),
[Installed content and generated configuration](specification.md#installed-content-and-generated-configuration),
[Provider and Model prompts](specification.md#provider-and-model-prompts),
[Credentials](specification.md#credentials), and
[Publication](specification.md#publication).

## 5. Non-goals

- Changes to any non-Standalone production module.
- Web setup, setup server, or browser lifecycle.
- Non-interactive initialization.
- Destructive reset, migration, repair, or upgrade commands.
- A Provider onboarding SDK or generic adapter framework.
- Extension installation or update.
- A template system or Role marketplace.
- A secret store.
- Automation implementation.
- Existing Agent Home migration or versioning.

## 6. Delivery items

| Item | Status | Exit condition |
|---|---|---|
| AHI-1 Standalone mode | Completed | argument and routing tests prove initialization does not start Runtime |
| AHI-2 Terminal wizard | Completed | supported Provider, credential, and Model choices are collected and cancel safely |
| AHI-3 File publication | Completed | Initialize creates config last; Edit concurrency-checks and atomically replaces config |
| AHI-4 Startup cutover | Completed | missing config fails with initialization guidance instead of creating `{}` |
| AHI-5 Validation | In Progress | package, Unit, integration, lint, build, link, and diff gates pass on Node 22; manual Windows terminal acceptance and independent review remain |

Only one item may be `In Progress`.

## 7. Entry gate

Delivery requires:

- this Plan, its Specification, and ADR-022 to be Accepted;
- Shared Configured Agents to remain implemented and validated;
- Extension Initialization Metadata to be implemented and validated;
- implementation tests that preserve the verified existing public-API path
  for Descriptor discovery, selected-candidate acquisition and staging,
  in-memory candidate validation, exact Model resolution, and the real
  tool-free readiness invocation.

The design review verified that `discoverExtensionDescriptors()`,
`acquireExtensions()`, selected `LoadedRuntimeUnit.create()`,
`stageRegistryUnit()`, `resolveStagedRegistryCandidate()`, `loadAgentConfig()`,
`BuiltinLlmProvider`, `ModelResolver`, and `ModelInvocationPort.chat()` provide
that path. If implementation evidence disproves it, this Change stops for a
separate decision. It does not expand into other modules.

## 8. Validation

- Standalone argument and mode-routing tests.
- Fake-prompt wizard tests.
- Built-in, multiple Provider Extension, multiple Model, and verified Default
  Model selection tests.
- Supported/unsupported Schema prompt projection, optional unset choices,
  sensitive input, static claim, zero/multiple actual Provider registration,
  per-Model readiness, partial Model success, Provider reconfiguration
  invalidation, combined Registry conflicts, and exact-once candidate
  start/cleanup tests.
- Missing, empty, cancelled, conflicting, failed, and successful filesystem
  cases.
- Zero Agent Home writes before Publication and `config.json`-last partial
  Publication recovery.
- Initialization followed by ordinary standalone startup.
- Package-content verification for terminal and profile assets.
- Manual Windows terminal validation.
- Affected Unit, integration, lint, build, link, and diff checks.

## 9. Exit gate

The Change exits when successful initialization produces a usable Agent Home,
ordinary startup no longer bootstraps an empty config, no non-Standalone
production module changed, authority is synchronized, and the project owner
accepts closeout.
