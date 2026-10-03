# Governance

> Status: Governance Authority
> Authority: Project-wide work classification, approval, implementation, validation, and completion rules

This directory contains durable project-wide rules. It does not own current implementation facts, architectural decisions, stable module contracts, or the scope of individual Changes.

| Document | Status | Owner | Purpose |
|---|---|---|---|
| [Development Workflow](development-workflow.md) | Accepted v1.2 | Project owner | Sole development-process authority |
| [Architecture Principles](architecture-principles.md) | Accepted v1.1 | Project owner | Stable architecture constraints |
| [Domain Glossary](domain-glossary.md) | Accepted v1.5 | Project owner | Canonical domain terms and non-meanings |
| [Coding Standards](coding-standards.md) | Active | Project owner | TypeScript implementation conventions |

The existing [Development Workflow](development-workflow.md) remains the only change workflow. Physical organization under `changes/active/` and `changes/archive/` does not create another state model.

The four approved [Documentation Templates](../templates/README.md) preserve the Development Workflow state model and do not create a second process authority.
