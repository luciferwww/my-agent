# Contributing

This repository uses a spec-driven workflow. The authoritative process is [Development Workflow](docs/governance/development-workflow.md); this file is only the contributor entry point.

## Setup

The project requires Node.js 22.

```bash
npm install
npm run build
npm test
```

## Before Changing Files

1. Classify the work as a Small Change, Defect, Documentation, Architecture Slice, or Architecture Spike.
2. Confirm the intended scope before editing.
3. Use an ADR, Module Spec, or Spike when required by the development workflow.
4. Follow the [Coding Standards](docs/governance/coding-standards.md) for TypeScript changes.
5. Do not silently change an accepted architecture decision during implementation.

## Validation

Run the focused checks for the changed behavior first, then expand only when the changed boundary or a failure requires it. `npm test` runs the default Unit tier; it is not an alias for every repository check.

```bash
npm test
npm run test:integration
npm run test:fitness
npm run test:all
npm run lint
npm run build
```

Integration and Fitness checks are impact-driven. `test:all`, lint, and build are final or cross-cutting Gates, not a per-edit checklist. Host, Relay artifact, and WebSocket verification remain explicit commands for changes to those boundaries. Document any required check that could not be run and the remaining risk.

## Submitting Changes

- Keep each change focused and exclude unrelated formatting or generated files.
- Keep implementation, tests, and authoritative documentation synchronized.
- Use English for commit subjects and bodies.
- Do not commit credentials, tokens, local secrets, or provider responses containing sensitive data.
- Treat review comments as claims to verify; apply only findings supported by code, tests, or authoritative documentation.

See the [Documentation Index](docs/README.md) for current architecture and roadmap documents.
