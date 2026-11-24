# Contributing

This repository uses a spec-driven workflow. The authoritative process is [Development Workflow](docs/governance/development-workflow.md); this file is only the contributor entry point.

## Setup

The project requires Node.js 22.

```bash
npm install
npm run build
npm test
```

### Native image dependency compatibility

`sharp` is pinned to `0.33.5`, the existing attachment-processing version.
The targeted npm override makes `@xenova/transformers` reuse that version:
its own `sharp` 0.32.x loads conflicting libvips DLLs on Windows, even for
text embeddings. Keeping the pin avoids changing attachment encoding and
the embedding runtime at the same time. This intentionally overrides
Transformers 2.x's declared sharp range; it is not an upstream compatibility
guarantee.

When changing either dependency, run the native image compatibility integration
tests in both import orders, the attachment tests, and real local embedding
inference. Check that the dependency tree remains deduplicated. Do not remove
the override until the upstream dependency ranges and native libraries align.

### ONNX protobuf dependency security

The targeted `onnx-proto` override pins `protobufjs` to `6.11.6`, within ONNX's
declared 6.x range, to fix
[GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg).
When changing this override, verify the resolved dependency tree and ONNX
model encode/decode compatibility, including 64-bit integer and byte fields.
This minimal fix does not resolve
[GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm) or
[GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7);
their published fixes require a newer major version and separate compatibility
validation.

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
