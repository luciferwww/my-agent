# my-agent

A self-hosted TypeScript AI agent with Web and CLI clients, configurable LLM
providers, tools, memory, persistent sessions, and subagents.

`my-agent` is an experimental project for learning and architecture exploration.
It is useful as a personal agent runtime and as a reference implementation for
building Provider, Tool, Channel, Session, and lifecycle boundaries.

## What it can do

- Connect to OpenAI-compatible Responses and Chat Completions APIs, or Anthropic
  Messages APIs.
- Run through the included browser client, CLI, or an external Channel.
- Use filesystem, search, web, shell execution, and managed-process tools.
- Keep persistent conversations with rename, archive, fork, and resume support.
- Load Agent Context files and optional local semantic Memory.
- Delegate bounded work to configured subagents.
- Accept steering messages while a Turn is running.
- Apply Tool allow/deny policy and per-Session `manual` or `allow_all`
  permission modes.
- Load additional Providers and Channels through Extensions.

## Requirements

- Node.js 22.x
- npm
- An LLM endpoint and, when required, an API key

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create an Agent Home

Agent Home contains configuration, sessions, memory, context, logs, and other
mutable state. Create `agent-home/config.json`:

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "<model-id>"
    },
    "builtin": {
      "baseURL": "https://api.siliconflow.cn/v1",
      "apiKey": "${SILICONFLOW_API_KEY}",
      "models": [
        {
          "modelId": "<model-id>",
          "protocol": "openai-chat-completions",
          "displayName": "My model"
        }
      ]
    }
  },
  "agents": {
    "defaults": {
      "memory": {
        "enabled": false
      }
    }
  }
}
```

Replace `<model-id>` with a model exposed by your endpoint. For SiliconFlow,
the model catalog can be queried with:

```bash
curl -H "Authorization: Bearer $SILICONFLOW_API_KEY" \
  https://api.siliconflow.cn/v1/models
```

Set the credential without writing it into `config.json`:

```bash
# macOS / Linux
export SILICONFLOW_API_KEY="your-api-key"
```

```powershell
# Windows PowerShell
$env:SILICONFLOW_API_KEY = "your-api-key"
```

The Built-in Provider also supports:

- `openai-responses`
- `openai-chat-completions`
- `anthropic-messages`

`baseURL` is the complete API prefix before `/responses`,
`/chat/completions`, or `/messages`.

### 3. Start the agent

From a source checkout:

```bash
npm run agent -- --agent-home ./agent-home
```

The default WebSocket endpoint is:

```text
ws://127.0.0.1:8787/ws
```

Open [clients/html/chat.html](clients/html/chat.html) in a browser and connect
to that endpoint.

If `--agent-home` is omitted, Agent Home defaults to `<user-home>/.my-agent`.
On first startup, a missing `config.json` is created as `{}`, but an empty
configuration does not select a Provider or Model.

## Run with the CLI

The CLI owns terminal output, so Console Logger must be disabled:

```json
{
  "logger": {
    "console": {
      "enabled": false
    }
  }
}
```

Keep the LLM configuration from the Quick Start and run:

```bash
npm run agent -- --agent-home ./agent-home --builtin-channels cli
```

Useful CLI commands include:

```text
/sessions
/session
/models
/model
/permission
/permission manual
/permission allow_all
```

Available Built-in Channel selections:

```bash
npm run agent -- --agent-home ./agent-home                         # WebSocket
npm run agent -- --agent-home ./agent-home -bc websocket,cli       # Both
npm run agent -- --agent-home ./agent-home --builtin-channels cli  # CLI only
npm run agent -- --agent-home ./agent-home --builtin-channels none # External Channels only
```

## Configuration

The only accepted top-level namespaces are:

```text
llm
runtime
runner
agents
logger
extensions
```

Common global settings:

```json
{
  "runtime": {
    "steeringEnabled": true
  },
  "runner": {
    "maxLlmCalls": 12
  },
  "agents": {
    "defaults": {
      "tools": {
        "allow": ["read_file", "file_search"],
        "deny": ["exec"]
      },
      "memory": {
        "enabled": false
      }
    }
  }
}
```

`MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` may be supplied together to override
the default Model Reference for a run. Supplying only one is an error.

See [Configuration](docs/architecture/configuration.md) for the full schema,
defaults, precedence, Agent overrides, Subagent profiles, credential
references, and strict validation behavior.

## Tool permissions and security

`tools.deny` is final. A denied Tool remains denied even when the Session uses
Allow All.

| Session mode | Behavior |
|---|---|
| `manual` | Exec and structured filesystem targets outside Agent Home require current-call Approval even when statically allowed. Other allowed Tools run directly; unmatched Tools request Approval. |
| `allow_all` | Every registered Tool not matched by `tools.deny` runs without current-call Approval. The mode remains active for the live Session after client disconnect. |

Allow All is process-local. It is reset by Runtime restart, Session
archive/delete, fork, or unarchive. It is not written to configuration,
transcript, Memory, Agent Context, or browser storage.

**Agent Home is a path context, not a sandbox.** Allow All can grant arbitrary
Shell and external filesystem effects. The Runtime does not verify executable
or dependency integrity and does not provide filesystem, process, network,
container, VM, or OS isolation.

See [Approval Lifecycle](docs/specifications/approval-lifecycle.md) and
[Built-in Tools](docs/architecture/builtin-tools.md) for the complete contract.

## Agent Home and deployment

The standalone Host uses two path authorities:

- `installDir`: immutable installed program content and executable Extensions;
- `agentHome`: writable configuration and Agent state.

Relative filesystem Tool paths, Search defaults, prompt path rendering, and
the default Exec `cwd` use Agent Home. Select it with `-ah <path>`,
`--agent-home <path>`, or `--agent-home=<path>`.

Stop the Host before replacing installed Extensions. Partial overwrite,
symlink-based installation, mutation while running, and running `npm install`
inside the live installation are unsupported.

The source checkout uses the tracked
`extensions/copilot-relay-provider` workspace package. The npm package ships
the Extension under its installation directory. The standalone Host acquires
Extensions generically and does not hard-code Relay fallback behavior.

## Development

```bash
npm install
npm run lint
npm test
npm run test:integration
npm run test:fitness
npm run build
npm run verify:websocket-host
```

The canonical executable bootstrap is
[src/hosts/standalone/entry.ts](src/hosts/standalone/entry.ts). Scripts support
builds, audits, packaging, and verification; they do not own production Host
behavior.

A stable package-root library import is not currently a public consumer
contract. The supported executable is the `my-agent` bin or `npm run agent`
from a source checkout.

## Documentation

- [Current Architecture](docs/architecture/overview.md) — verified boundaries and flows
- [Configuration](docs/architecture/configuration.md) — schema, defaults, and precedence
- [Channels](docs/architecture/channels.md) — WebSocket, CLI, routing, and interactions
- [Tools](docs/architecture/tools.md) — Tool pipeline and policy
- [Session](docs/architecture/session.md) — persistence and lifecycle
- [Documentation Index](docs/README.md) — current authority and historical sources
- [Development Workflow](docs/governance/development-workflow.md) — contribution and delivery process
- [Contributing](CONTRIBUTING.md) — contributor entry point

Current implementation facts belong to source, tests, and Current Architecture.
Research, Evidence, Deferred, and archived Change documents are historical or
opt-in sources rather than alternative current authority.
