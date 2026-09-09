# Documentation

Documentation is organized by authority role. For implemented architecture, always begin with [Current Architecture](architecture/current/overview.md); topic pages linked from that overview own the detailed current facts.

## Governance

- [Development Workflow](development-workflow.md) — authoritative work classification, approval, validation, review, and completion process
- [Contributing](../CONTRIBUTING.md) — setup and contributor entry point
- [Architecture Principles](architecture/architecture-principles.md)
- [Domain Glossary](architecture/domain-glossary.md)
- [Coding Standards](architecture/coding-standards.md)
- [Target Architecture](architecture/target-architecture.md) — accepted target direction, not current implementation status
- [Legacy Migration Inventory](architecture/legacy-migration-inventory.md) — cross-Slice migration ledger
- [Slice 6 Documentation and Legacy Closeout Spec](architecture/slice-6-documentation-legacy-closeout-spec.md)

## Current Architecture

[Current Architecture Overview](architecture/current/overview.md) is the sole current entry point. Its topic set follows live module boundaries rather than older document structure:

- [Runtime](architecture/current/runtime.md)
- [Runner](architecture/current/core_runner.md)
- [Model Resolution](architecture/current/core_model_resolution.md)
- [Channel](architecture/current/adapter_channel.md)
- [Media](architecture/current/core_media.md)
- [Configuration](architecture/current/platform_config.md)
- [Model Invocation and Provider Adapter](architecture/current/adapter_llm.md)
- [Tools](architecture/current/core_tools.md)
- [Builtin Tools](architecture/current/core_tools_builtin.md)
- [Session](architecture/current/core_session.md)
- [Prompt](architecture/current/core_prompt.md)
- [Memory](architecture/current/core_memory.md)
- [Workspace](architecture/current/core_workspace.md)
- [Observability](architecture/current/platform_logger.md)

The [Capability Summary](agent-capabilities.md) is a dated reader-facing summary, not architecture authority.

## Architecture Decisions

- [ADR-001 Tool Result Closure and Recovery](architecture/adr-001-tool-result-closure-and-recovery.md)
- [ADR-002 Context Budgeting and Compaction Recovery](architecture/adr-002-context-budgeting-and-compaction-recovery.md)
- [ADR-003 Progressive Architecture Migration](architecture/adr-003-progressive-architecture-migration.md)
- [ADR-004 Provider/Model Identity and Facts Ownership](architecture/adr-004-provider-model-identity-and-facts-ownership.md)
- [ADR-005 Extension Registry and Runtime Composition](architecture/adr-005-extension-registry-runtime-composition.md)
- [ADR-006 Legacy and Compatibility Exit](architecture/adr-006-legacy-and-compatibility-exit.md)

## Contracts and Specs

Each document's own status controls whether it is accepted, validated, implemented, or still an input.

- [Model Resolution Module Spec](architecture/model-resolution-module-spec.md)
- [Subagent Model Resolution Module Spec](architecture/subagent-model-resolution-module-spec.md)
- [Runtime Composition Module Spec](architecture/runtime-composition-module-spec.md)
- [Tool/Hook Module Spec](architecture/tool-hook-module-spec.md)
- [Core Subagent Spec](architecture/core-subagent-spec.md)
- [Core Runner Turn Flow Spec](architecture/core-runner-turn-flow-spec.md)
- [Core Abort Spec](architecture/core-abort-spec.md)
- [Channel Module Spec](architecture/channel-module-spec.md)
- [Approval Lifecycle Spec](architecture/approval-lifecycle-spec.md)
- [Multi-client User Message Spec](architecture/channel-multi-client-user-message-spec.md)
- [Attachments Support Spec](architecture/attachments-support-spec.md)
- [Platform Config Restructure Spec](architecture/platform-config-restructure-spec.md)

## Plans and Roadmap

- [Architecture Foundation Plan](roadmap/architecture-foundation-plan.md)
- [AF-03 Target Architecture Plan](roadmap/af-03-target-architecture-plan.md)
- [AF-04 Characterization and Fitness Plan](roadmap/af-04-characterization-fitness-plan.md)

Plans own unfinished work and sequencing. They do not override verified Current Architecture.

## Results and Execution Evidence

- [AF-05 Provider/Model Resolution Spike Results](architecture/af-05-provider-model-resolution-spike-results.md)
- [AF-06 Extension Framework Spike Results](architecture/af-06-extension-framework-spike-results.md)
- [AF-05 Spike Spec](architecture/af-05-provider-model-resolution-spike-spec.md)
- [AF-06 Spike Spec](architecture/af-06-extension-framework-spike-spec.md)
- [AF-07 Architecture Decision Spec](architecture/af-07-architecture-decision-spec.md)

Executed Results and tests are evidence; they are not a second Current Architecture.

## Historical and Deferred Material

Historical and deferred artifacts remain non-current. Their retained locators and final dispositions are governed by the [Legacy Migration Inventory](architecture/legacy-migration-inventory.md) and [Slice 6 Spec](architecture/slice-6-documentation-legacy-closeout-spec.md). Candidate design or implementation records must not be used as current implementation guidance.

## Analysis

External comparisons and research inputs are non-authoritative for this repository:

- [Claude Code Subagent Analysis](analysis/claude-code-subagent-analysis.md)
- [Subagent Systems Overview](analysis/subagent-systems-overview.md)

## Templates

- [ADR Template](templates/adr-template.md)
- [Module Spec Template](templates/module-spec-template.md)
- [Spike Spec Template](templates/spike-spec-template.md)
- [Spike Results Template](templates/spike-results-template.md)

## Manual scripts

Stable workflows are exposed through package scripts. Other smoke and integration scripts under `scripts/` run directly as `npx tsx scripts/<name>.ts`; consult the script header for its current contract.
