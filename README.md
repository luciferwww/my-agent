# my-agent

A single-process TypeScript AI Agent runtime for learning and architecture experimentation. It composes Provider, Tool, Prompt, Session, Memory, Channel, and lifecycle modules into generation-bound Agent Turns.

## Requirements

- Node.js 22.x
- npm
- A local Copilot Relay exposing `/v1/models` and `/v1/responses`

## Setup and validation

```bash
npm install
npm run lint
npm run build
npm test
```

## Run the supported local entry point

Start the WebSocket Channel on `ws://127.0.0.1:8787/ws` against the Relay at
`http://127.0.0.1:5000`:

```bash
npm run agent:websocket
```

Optional Host environment:

- `COPILOT_RELAY_BASE_URL` changes the loopback Relay URL.
- `COPILOT_RELAY_API_KEY` adds Bearer authorization when nonblank.
- `MY_AGENT_MODEL` changes the Relay model ID.
- `MY_AGENT_WS_HOST` and `MY_AGENT_WS_PORT` change the Channel listener.

The browser client is [clients/html/chat.html](clients/html/chat.html).

[scripts/server.ts](scripts/server.ts) is the only currently supported executable under `scripts/`.
Other scripts are retained as legacy migration inputs and are not guaranteed to run. A stable
package-root library import is not currently documented as a public consumer contract.

## Documentation

- [Current Architecture](docs/architecture/current/overview.md) — sole entry for verified current boundaries and flows
- [Capability Summary](docs/agent-capabilities.md) — dated, non-authoritative product capability overview
- [Documentation Index](docs/README.md) — governance, decisions, Specs, Plans, Results, and analysis by authority role
- [Development Workflow](docs/development-workflow.md) — authoritative contribution and delivery process
- [Contributing](CONTRIBUTING.md) — concise contributor entry point

Current implementation facts belong to Current Architecture and source/tests. Older design, implementation, historical, and deferred documents are not alternative current authority.
