# my-agent

A single-process TypeScript AI Agent runtime for learning and architecture experimentation. It composes Provider, Tool, Prompt, Session, Memory, Channel, and lifecycle modules into generation-bound Agent Turns.

## Requirements

- Node.js 22.x
- npm
- An installed Provider Extension; the example below uses a local Copilot Relay exposing `/v1/models` and `/v1/responses`

## Setup and validation

```bash
npm install
npm run lint
npm run build
npm run test:all
```

## Run the supported local entry point

The supported Host discovers explicitly enabled Extensions from Agent Home. Build the repository,
stop the Host, and copy the complete Relay artifact directory from
`dist/extension-artifacts/copilot-relay-provider` to a direct child such as
`<agent-home>/extensions/relay`. Do not copy individual files or run `npm install` inside the
artifact. Partial overwrite, symlink-based installation, and replacement while the Host is running
are unsupported; stop the Host and replace the complete directory.

Create `<agent-home>/config.json`:

```json
{
	"extensions": {
		"enabled": true,
		"entries": {
			"copilot-relay-provider": {
				"enabled": true,
				"config": {
					"baseURL": { "$env": "COPILOT_RELAY_BASE_URL" },
					"apiKey": {
						"$secret": {
							"source": "env",
							"name": "COPILOT_RELAY_API_KEY"
						}
					}
				}
			}
		}
	}
}
```

Set `MY_AGENT_HOME` to that directory, set the two example Relay variables referenced by the
scoped config, and provide a complete default Model Reference through workspace config or the
atomic environment pair `MY_AGENT_PROVIDER=copilot-relay` plus `MY_AGENT_MODEL=<model-id>`.
Then start the static WebSocket Channel on `ws://127.0.0.1:8787/ws`:

```bash
npm run agent:websocket
```

Generic Host environment:

- `MY_AGENT_HOME` selects Agent Home; `--agent-home <path>` has higher precedence.
- `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` must be supplied together when overriding the default Model Reference.
- `MY_AGENT_WS_HOST` and `MY_AGENT_WS_PORT` change the Channel listener.

`COPILOT_RELAY_BASE_URL` and `COPILOT_RELAY_API_KEY` above are Extension-owned reference names in
the example config, not Relay-specific Host settings. The Host does not import Relay code, infer a
Provider ID, or fall back to a static Relay Unit when acquisition fails. Actionable acquisition and
optional Unit startup failures are printed as bounded, redacted operator warnings and are not sent
to WebSocket clients.

The browser client is [clients/html/chat.html](clients/html/chat.html).

[scripts/server.ts](scripts/server.ts) is the only currently supported executable under `scripts/`.
The remaining scripts support the Host, build, artifact audits, or explicit verification; historical
research-era `test-*` programs have been retired. A stable package-root library import is not
currently documented as a public consumer contract.

## Documentation

- [Current Architecture](docs/architecture/overview.md) — sole entry for verified current boundaries and flows
- [Capability Summary](docs/evidence/capability-summary-2026-09-09.md) — dated, non-authoritative product capability overview
- [Documentation Index](docs/README.md) — governance, decisions, Specs, Plans, Results, and analysis by authority role
- [Development Workflow](docs/governance/development-workflow.md) — authoritative contribution and delivery process
- [Contributing](CONTRIBUTING.md) — concise contributor entry point

Current implementation facts belong to Current Architecture and source/tests. Older design, implementation, historical, and deferred documents are not alternative current authority.
