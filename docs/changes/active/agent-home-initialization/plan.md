# Agent Home Initialization Plan

> Status: Proposed
> Date: 2026-10-14
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Agent Home Initialization Specification](specification.md)
> Decision: [ADR-022: Explicit Standalone Agent Home Initialization](../../../decisions/adr-022-explicit-standalone-agent-home-initialization.md)
> Depends on: [Shared Configured Agents](../../archive/shared-configured-agents/plan.md) and [Extension Initialization Metadata](../../archive/extension-initialization-metadata/plan.md)
> Authorization: Not authorized for Delivery. Plan, Specification, and ADR require project-owner acceptance.

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
- Offer the Built-in Provider and installed Extensions whose Descriptor
  statically declares `provider`.
- Configure the Built-in Provider through one selected protocol, or configure
  one selected Provider Extension from its bounded Draft-07 scalar Schema.
- Accept masked literals, existing environment-variable references, or
  omission for Schema-declared sensitive strings.
- Load only the selected Provider Extension and verify its actual registration.
- Select one exact Provider and Model from the candidate's effective Catalog.
- Verify the candidate with one real minimal tool-free inference.
- Validate the candidate with existing public APIs.
- Write one authoritative `config.json`.
- Stop ordinary standalone startup from creating a missing empty config;
  report bounded initialization guidance instead.
- Exit without constructing `RuntimeApp`.

## 4. Configuration output

The initializer writes one minimal `config.json` with two or three top-level
sections:

| Section | Generated content |
|---|---|
| `llm` | the exact selected Provider/Model as `defaultModel`, plus Built-in configuration only for the Built-in route |
| `agents` | fixed global execution policy and the `reviewer`, `explorer`, and `researcher` entries |
| `extensions` | only for an Extension route: one entry containing only authored non-default configuration |

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
    "list": [
      { "id": "reviewer", "...": "fixed read-only tools" },
      { "id": "explorer", "...": "fixed read-only tools" },
      { "id": "researcher", "...": "fixed research tools" }
    ]
  }
}
```

For a Provider Extension, `llm.builtin` is omitted, `defaultModel.providerId`
uses the actual registered Provider ID, and one
`extensions.entries.<extensionId>.config` object contains only values authored
by the user. `extensions.enabled` and entry `enabled` are omitted because their
effective value is already true.

Placeholders are explanatory and are not written literally. Sensitive fields
are omitted when permitted and declined; `maxLlmCallsPerTurn` is omitted when
its prompt is blank. `agents.defaults`, `logger`, top-level `runner`, and all
other default or unused sections are omitted.

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
- Configure, repair, upgrade, merge, or reset commands.
- A Provider onboarding SDK or generic adapter framework.
- Extension installation, update, or configuration outside the selected
  Provider route.
- A template system or Role marketplace.
- A secret store.
- Automation implementation.
- Existing Agent Home migration or versioning.

## 6. Delivery items

| Item | Status | Exit condition |
|---|---|---|
| AHI-1 Standalone mode | Not Started | argument and routing tests prove initialization does not start Runtime |
| AHI-2 Terminal wizard | Not Started | supported Provider, credential, and Model choices are collected and cancel safely |
| AHI-3 File publication | Not Started | Context, fixed Agent profiles, and valid config are created without overwrite |
| AHI-4 Startup cutover | Not Started | missing config fails with initialization guidance instead of creating `{}` |
| AHI-5 Validation | Not Started | focused, package, manual terminal, regression, lint, build, and review gates pass |

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
`stageRegistryUnit()`, `loadAgentConfig()`, `BuiltinLlmProvider`,
`ModelResolver`, and `ModelInvocationPort.chat()` provide that path. If
implementation evidence disproves it, this Change stops for a separate
decision. It does not expand into other modules.

## 8. Validation

- Standalone argument and mode-routing tests.
- Fake-prompt wizard tests.
- Built-in and discovered Provider Extension route tests.
- Supported/unsupported Schema prompt projection, sensitive input, static
  claim, actual registration, and selected-candidate cleanup tests.
- Missing, empty, cancelled, conflicting, failed, and successful filesystem
  cases.
- Initialization followed by ordinary standalone startup.
- Package-content verification for terminal and profile assets.
- Manual Windows terminal validation.
- Affected Unit, integration, lint, build, link, and diff checks.

## 9. Exit gate

The Change exits when successful initialization produces a usable Agent Home,
ordinary startup no longer bootstraps an empty config, no non-Standalone
production module changed, authority is synchronized, and the project owner
accepts closeout.
