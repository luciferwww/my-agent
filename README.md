# my-agent

A single-process TypeScript AI Agent runtime for learning and architecture experimentation. It composes Provider, Tool, Prompt, Session, Memory, Channel, and lifecycle modules into generation-bound Agent Turns.

## Requirements

- Node.js 22.x
- npm
- An Anthropic-compatible endpoint for the included local CLI/WebSocket entry points

## Setup and validation

```bash
npm install
npm run lint
npm run build
npm test
```

## Run local entry points

Interactive CLI against `test-workspace/`:

```bash
npx tsx scripts/cli.ts --session=main
```

WebSocket channel on `ws://127.0.0.1:3001/ws` by default:

```bash
npm run agent:websocket
```

The browser client is [clients/html/chat.html](clients/html/chat.html). Generate or update configuration with:

```bash
npx tsx scripts/config.ts --path test-workspace/.agent/config.json
```

The executable scripts are verified repository entry points. A stable package-root library import is not currently documented as a public consumer contract.

## Documentation

- [Current Architecture](docs/architecture/current/overview.md) — sole entry for verified current boundaries and flows
- [Capability Summary](docs/agent-capabilities.md) — dated, non-authoritative product capability overview
- [Documentation Index](docs/README.md) — governance, decisions, Specs, Plans, Results, and analysis by authority role
- [Development Workflow](docs/development-workflow.md) — authoritative contribution and delivery process
- [Contributing](CONTRIBUTING.md) — concise contributor entry point

Current implementation facts belong to Current Architecture and source/tests. Older design, implementation, historical, and deferred documents are not alternative current authority.
