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

Agent Home defaults to `<user-home>/.my-agent` and can be selected with `--agent-home <path>` or
`--agent-home=<path>`. A relative value resolves against startup CWD; after that resolution, only
`installDir` and `agentHome` remain architecture paths. On first standalone startup, the Host creates
a missing `<agent-home>/config.json` with exact UTF-8 bytes `{}\n` before one strict read; existing
configuration is never overwritten. The generated empty document is valid default content, but it
does not select a Provider/Model, provision credentials or Extensions, or guarantee a successful
Turn. Replace it with deliberate deployment configuration such as the example below. Configuration,
Agent Context, Memory, Sessions, Subagents, logs, and other mutable state remain under Agent Home;
no `.agent` directory is used.

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

Agent Home is also the prompt path context, the relative-path anchor for Environment filesystem
Tools, the default Search root, and the default Exec `cwd`. To select another Agent Home:

```bash
my-agent --agent-home <agent-home>
```

For repository development, `npm run agent` runs the same standalone composition from the package
root. There are no custom path-selection environment variables. Its architecture paths are:

- `installDir`: the installed `my-agent` package, including pre-provisioned `extensions/`;
- `agentHome`: the explicit CLI value, or `<user-home>/.my-agent` by default.

Structured Environment Tool targets outside Agent Home require current-call Approval and fail closed
when Approval is unavailable. Agent Home anchoring is not a sandbox: Exec allow grants arbitrary
Shell authority, while unmatched Exec calls require current-call Approval. Exec `cwd` is execution
context rather than confinement.

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
