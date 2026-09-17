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
runs. A source checkout uses the tracked `extensions/copilot-relay-provider` workspace package
directly; the published npm package ships the same Extension package under `<install-dir>/extensions`.
Do not copy individual files or run `npm install` while the Host is running. Partial overwrite,
symlink-based installation, and replacement while the Host is running are unsupported; stop the
Host and replace the complete Extension package directory.

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
	}
}
```

Set the two example Relay variables referenced by the scoped config. The complete default Model
Reference may instead be supplied through the atomic environment pair
`MY_AGENT_PROVIDER=copilot-relay` plus `MY_AGENT_MODEL=<model-id>`.

Agent Home is also the prompt path context, the relative-path anchor for Environment filesystem
Tools, the default Search root, and the default Exec `cwd`. To select another Agent Home:

```bash
my-agent -ah <agent-home>
```

Standalone opens the WebSocket Channel by default at `ws://127.0.0.1:8787/ws`. Builtin Channels
are selected per process rather than in `config.json`:

```bash
my-agent                                      # WebSocket
my-agent -bc websocket,cli                    # WebSocket plus CLI
my-agent --builtin-channels cli               # CLI only
my-agent --builtin-channels=none              # no Builtin Channel
```

CLI selection requires `logger.console.enabled=false` because CLI owns terminal presentation.
The global configuration accepts only `agents`, `logger`, and `extensions`; retired `host` content
is rejected directly.

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
- [Documentation Index](docs/README.md) — default current-authority reading path and opt-in historical sources
- [Development Workflow](docs/governance/development-workflow.md) — authoritative contribution and delivery process
- [Contributing](CONTRIBUTING.md) — concise contributor entry point

Current implementation facts belong to source/tests and Current Architecture. Historical, Evidence, Research, Deferred, and archived Change documents are opt-in sources, not alternative current authority.
