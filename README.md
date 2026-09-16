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

## Run the supported standalone service

The installed program directory owns executable Extensions and is immutable while the service
runs. Build the repository, stop the Host, and use deployment tooling to copy the complete Relay
artifact directory from `dist/extension-artifacts/copilot-relay-provider` to a direct child such as
`<install-dir>/extensions/relay`. In a source checkout, `<install-dir>` is the repository package
root. Do not copy individual files or run `npm install` inside the artifact. Partial overwrite,
symlink-based installation, and replacement while the Host is running are unsupported; stop the
Host and replace the complete directory.

Agent Home is fixed at `<user-home>/.my-agent`. Create `<user-home>/.my-agent/config.json` with the
Extension projection and Host mode. Configuration, Agent Context, Memory, Sessions, Subagents, logs,
and other mutable state remain under Agent Home; no `.agent` directory is used.

```json
{
	"agents": {
		"defaults": {
			"model": {
				"providerId": "copilot-relay",
				"modelId": "<model-id>"
			}
		}
	},
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
	},
	"host": {
		"mode": "websocket",
		"websocket": { "host": "127.0.0.1", "port": 8787, "path": "/ws" }
	}
}
```

Set the two example Relay variables referenced by the scoped config. The complete default Model
Reference may instead be supplied through the atomic environment pair
`MY_AGENT_PROVIDER=copilot-relay` plus `MY_AGENT_MODEL=<model-id>`.

The installed `my-agent` command captures its current directory as non-owning `workingDir`. Start it
from the directory whose files and command context the Agent should use:

```bash
cd <working-directory>
my-agent
```

For repository development, `npm run agent` runs the same standalone composition from the package
root. The standalone entry accepts no arguments and has no custom path-selection environment
variables. Its paths are derived as follows:

- `installDir`: the installed `my-agent` package, including pre-provisioned `extensions/`;
- `agentHome`: `<user-home>/.my-agent`;
- `workingDir`: startup current directory, used for filesystem/search Tools, prompt `# Workspace`, and command execution only.

Generic Host environment:

- `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` must be supplied together when overriding the default Model Reference.
- `host.mode` selects `websocket`, `cli`, or `headless`; CLI requires Console Logger to be disabled.

`COPILOT_RELAY_BASE_URL` and `COPILOT_RELAY_API_KEY` above are Extension-owned reference names in
the example config, not Relay-specific Host settings. The Host does not import Relay code, infer a
Provider ID, or fall back to a static Relay Unit when acquisition fails. Actionable acquisition and
optional Unit startup failures are printed as bounded, redacted operator warnings and are not sent
to WebSocket clients.

The browser client is [clients/html/chat.html](clients/html/chat.html).

[src/hosts/standalone/entry.ts](src/hosts/standalone/entry.ts) is the only supported executable
bootstrap. The npm `my-agent` bin points directly to its compiled Host artifact. Files under
`scripts/` support builds, artifact/package audits, or explicit verification; they do not own
production Host behavior. A stable package-root library import is not currently documented as a
public consumer contract.

## Documentation

- [Current Architecture](docs/architecture/overview.md) — sole entry for verified current boundaries and flows
- [Capability Summary](docs/evidence/capability-summary-2026-09-09.md) — dated, non-authoritative product capability overview
- [Documentation Index](docs/README.md) — governance, decisions, Specs, Plans, Results, and analysis by authority role
- [Development Workflow](docs/governance/development-workflow.md) — authoritative contribution and delivery process
- [Contributing](CONTRIBUTING.md) — concise contributor entry point

Current implementation facts belong to Current Architecture and source/tests. Older design, implementation, historical, and deferred documents are not alternative current authority.
