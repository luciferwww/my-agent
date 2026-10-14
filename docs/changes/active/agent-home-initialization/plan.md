# Agent Home Initialization Plan

> Status: Proposed
> Date: 2026-10-14
> Owner: Project owner
> Type: Architecture Slice
> Specification: [Agent Home Initialization Specification](specification.md)
> Decision: [ADR-022: Explicit Standalone Agent Home Initialization](../../../decisions/adr-022-explicit-standalone-agent-home-initialization.md)
> Depends on: [Shared Configured Agents](../../archive/shared-configured-agents/plan.md)
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
- Configure the Built-in Provider with one explicitly selected
  `openai-responses`, `openai-chat-completions`, or `anthropic-messages`
  Model.
- Accept a masked literal API key, an existing environment-variable reference,
  or no credential.
- Verify the candidate with one real minimal tool-free inference.
- Validate the candidate with existing public APIs.
- Write one authoritative `config.json`.
- Stop ordinary standalone startup from creating a missing empty config;
  report bounded initialization guidance instead.
- Exit without constructing `RuntimeApp`.

## 4. Non-goals

- Changes to any non-Standalone production module.
- Web setup, setup server, or browser lifecycle.
- Non-interactive initialization.
- Configure, repair, upgrade, merge, or reset commands.
- A Provider onboarding SDK or generic adapter framework.
- A template system or Role marketplace.
- A secret store.
- Automation implementation.
- Existing Agent Home migration or versioning.

## 5. Delivery items

| Item | Status | Exit condition |
|---|---|---|
| AHI-1 Standalone mode | Not Started | argument and routing tests prove initialization does not start Runtime |
| AHI-2 Terminal wizard | Not Started | supported Provider, credential, and Model choices are collected and cancel safely |
| AHI-3 File publication | Not Started | Context, fixed Agent profiles, and valid config are created without overwrite |
| AHI-4 Startup cutover | Not Started | missing config fails with initialization guidance instead of creating `{}` |
| AHI-5 Validation | Not Started | focused, package, manual terminal, regression, lint, build, and review gates pass |

Only one item may be `In Progress`.

## 6. Entry gate

Delivery requires:

- this Plan, its Specification, and ADR-022 to be Accepted;
- Shared Configured Agents to remain implemented and validated;
- implementation tests that preserve the verified existing public-API path
  for in-memory candidate validation, exact Model resolution, and the real
  tool-free readiness invocation.

The design review verified that `loadAgentConfig()`, `BuiltinLlmProvider`,
`ModelResolver`, and `ModelInvocationPort.chat()` provide that path. If
implementation evidence disproves it, this Change stops for a separate
decision. It does not expand into other modules.

## 7. Validation

- Standalone argument and mode-routing tests.
- Fake-prompt wizard tests.
- Missing, empty, cancelled, conflicting, failed, and successful filesystem
  cases.
- Initialization followed by ordinary standalone startup.
- Package-content verification for terminal and profile assets.
- Manual Windows terminal validation.
- Affected Unit, integration, lint, build, link, and diff checks.

## 8. Exit gate

The Change exits when successful initialization produces a usable Agent Home,
ordinary startup no longer bootstraps an empty config, no non-Standalone
production module changed, authority is synchronized, and the project owner
accepts closeout.
