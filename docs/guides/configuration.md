# Configuration Guide

This guide explains how to configure a standalone `my-agent` installation.
It is intended for users operating the agent. For implementation ownership,
merge rules, and validation internals, see
[Configuration Architecture](../architecture/configuration.md).

## 1. Configuration file location

The standalone Host reads exactly one configuration file:

```text
<agentHome>/config.json
```

Select Agent Home when starting the process:

```bash
npm run agent -- --agent-home ./agent-home
```

If `--agent-home` is omitted, the default is:

```text
<user-home>/.my-agent
```

Start normally with a new or empty Agent Home. The Host creates a missing Home
and exclusively creates `config.json` containing `{}`; existing files are never
overwritten. Existing malformed or zero-byte files still fail validation.
The old `--initialize` wizard and its fixed named-Agent profile installer are removed.

Startup discovers all installed Extensions and attempts to load each unless its
entry explicitly sets `enabled: false`. Schema defaults apply without a saved
entry. A failed Extension is reported and skipped without suppressing healthy
neighbors. The bundled WebSocket client defaults to `http://127.0.0.1:8787/`;
automatic browser opening is off. Open Settings there to configure the first
Provider, models and default selection. Startup itself requires no Model call.

Manual file edits are read at startup; restart the Runtime after editing the file
directly. Browser Settings can apply Built-in/default changes to new execution
trees without restarting, as described below. No external file watcher is added.

The accepted top-level sections are:

```text
llm
agents
logger
extensions
```

Configuration is JSON, not JSONC: comments and trailing commas are invalid.
Field names and values are case-sensitive. Unknown namespaces and invalid
known fields normally fail startup or disable the affected Extension rather
than being silently corrected.

### Browser Settings

Open **Settings** in the bundled WebSocket client's navigation. This requires a
running, connected Channel; the automatically created empty configuration is valid.

- The left navigation has **LLM**, **Agents** and **Extensions**; narrow screens use a top
  category selector. Navigation summarizes unsaved changes, restart requirements
  and unconfirmed state. Lists and detail pages preserve the same independent drafts.
- **Agents -> Global settings -> Memory** has one **Enable Memory** checkbox.
  **Save Memory** changes only that flag and requires a service restart. It does
  not download models, index files or change running Tools. Saving the startup
  value again clears the restart marker. Advanced Memory options remain file-only.
- **LLM** starts with a default-model selector and Provider list, not all Provider
  forms expanded together. Built-in is always an entry, even before configuration;
  its model count describes the draft. Other entries and model counts come from
  the loaded Runtime catalog, not saved Extension candidates.
- **Details** opens a Provider detail page under LLM. Built-in details contain
  connection and editable models; other Provider details contain their loaded
  model list, Test and Set default. **Configure Extension** is a separate link to
  the owning Extension's configuration. Ownership is supplied by Runtime, not
  inferred from Provider IDs. Multiple Providers can link to the same Extension
  and share its one configuration draft. Missing configuration links do not
  prevent viewing a Provider's models.
  **Extensions** lists all discovered editable Extensions, including disabled ones.
- Default selection and Built-in details share **Save LLM**. **Set default** in
  Provider details changes the LLM draft; use the fixed footer's Save LLM to
  apply it. An Extension detail contains only enablement/configuration and saves
  only that Extension, never model actions or the LLM default.
- Built-in details always show the configuration form, without an enable/configure
  checkbox. Deleting all models preserves the saved URL and key. Leaving a never
  configured Built-in form empty does not create it when saving other LLM settings.
- Save each section independently. Closing the editor preserves noncredential
  drafts, not an automatic save. **Reload saved settings** explicitly discards
  drafts. Replacement credential inputs are cleared on submission, close and
  disconnect; submitting one section does not clear another section's inputs.
- One fixed footer reports the latest operation's pending, successful or failed
  outcome. Loading, saving and model Test use the same area; starting another
  operation replaces the old message. Late responses cannot overwrite a newer
  message such as a disconnect warning.
  Feedback aligns with the content column; Save stays right-aligned. Success is
  green, errors red, pending operations use the theme accent and informational
  messages use muted text. The footer remains visible while scrolling.
- Credential password inputs show a fixed `******` mask when already configured.
  Leave the mask unchanged to retain the saved value, replace it with a literal
  or exact `${ENV}`, or delete it to remove the credential on section save.
  The mask is reserved as the keep marker for already-configured credentials.
  The eye icon only reveals newly entered text, never the saved credential.
  Credential controls do not display saved values or environment-reference names.
  References resolve from the environment captured at startup when applying or
  testing; save-time validation does not require the variable to be available.
- Built-in models have add/edit/delete controls, protocol, relative endpoint and
  optional display name. Advanced JSON retains limits and reasoning capabilities.
  Models start as compact rows; Edit expands one inline form, preserving drafts
  when collapsed. New models open for editing immediately. Test, Set default and
  Delete align right. Built-in and Extension model lists show Default for the
  current LLM draft selection; the existing unsaved indicator means Save LLM is
  still required.
  Omitted existing limit/reasoning fields on retained model IDs are preserved.
- **Set default** changes only the default selection in the LLM
  draft. **Save LLM** applies Built-in/default changes to new execution trees;
  already-running trees keep their version. An existing Provider-free
  configuration uses this same editor for its first Provider.
- **Test** makes a real model request and may incur charges. Built-in tests use
  the draft; other Providers use currently loaded instances, not saved Extension
  parameters. Test does not save or change the default and has a fixed 30-second
  total deadline including preparation. It never creates a conversation.
- Extension sections expose supported scalar fields and explicit credential
  intents. Unsupported/read-only values remain server-owned and are not exposed
  or silently overwritten. Extension changes require a manual restart. Saving
  the startup values again clears that Extension's restart flag, without clearing
  outstanding differences in other Extensions. Closing the editor does not erase
  restart requirements.
- A known pre-publication LLM failure restores the file and the confirmed editor
  values with a fresh revision, without reloading other sections. Failed rollback
  reports unknown file state and retains the draft/latest revision for another
  explicit save; it does not claim successful recovery. Saved-but-unconfirmed
  Runtime application is shown separately from file-save success.
- A disconnected or missing response may hide a completed save. The client never
  retries it automatically: reconnect, then explicitly reload before saving again.
  Its 60-second response-wait bound is not cancellation of server work and does
  not replace the server's 30-second model Test deadline.

## 2. Practical starting configuration

The following example configures:

- one OpenAI Responses-compatible Built-in model;
- explicit Thinking and Effort controls;
- the browser chat client;
- disabled semantic Memory;
- a conservative Tool allow-list.

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "my-reasoning-model"
    },
    "builtin": {
      "baseURL": "https://llm.example.com/v1",
      "apiKey": "${MY_AGENT_LLM_API_KEY}",
      "models": [
        {
          "modelId": "my-reasoning-model",
          "protocol": "openai-responses",
          "displayName": "My reasoning model",
          "maximumContextTokens": 131072,
          "maximumPromptTokens": 100000,
          "maximumOutputTokens": 32768,
          "outputTokenLimit": 16384,
          "reasoning": {
            "thinking": ["on", "off"],
            "efforts": ["none", "low", "medium", "high"]
          }
        }
      ]
    }
  },
  "agents": {
    "steeringEnabled": true,
    "maxLlmCallsPerTurn": 12,
    "maxSubagentDepth": 1,
    "memory": {
      "enabled": false
    },
    "defaults": {
      "tools": {
        "allow": [
          "list_dir",
          "read_file",
          "file_search",
          "grep_search",
          "write_file",
          "edit_file",
          "apply_patch"
        ],
        "deny": []
      }
    }
  },
  "extensions": {
    "entries": {
      "websocket-channel": {
        "config": {
          "host": "127.0.0.1",
          "port": 8787,
          "webSocketPath": "/ws",
          "clientPath": "/",
          "approval": true,
          "openBrowser": false
        }
      }
    }
  }
}
```

Set the credential outside the JSON file:

```bash
# macOS / Linux
export MY_AGENT_LLM_API_KEY="your-api-key"
```

```powershell
# Windows PowerShell
$env:MY_AGENT_LLM_API_KEY = "your-api-key"
```

## 3. LLM configuration

### 3.1 Default model

`llm.defaultModel` is the preferred model for a Root Turn when the client does
not explicitly select one:

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "my-model"
    }
  }
}
```

It is a reference, not a fallback list. Both values must be non-empty strings.
The referenced model must be published by an available Provider before it can
be used.

The environment variables `MY_AGENT_PROVIDER` and `MY_AGENT_MODEL` can
override this reference for a run. Supply both or neither.

### 3.2 Built-in Provider

`llm.builtin` configures one shared base URL and credential:

```json
{
  "llm": {
    "builtin": {
      "baseURL": "https://llm.example.com/v1",
      "apiKey": "${MY_AGENT_LLM_API_KEY}",
      "models": []
    }
  }
}
```

| Field | Required | Meaning |
|---|---:|---|
| `baseURL` | Yes | HTTP(S) API prefix before `/responses`, `/chat/completions`, or `/messages` |
| `apiKey` | No | Literal credential or one exact `${ENV_VAR}` reference |
| `models` | Yes | Model registrations; duplicate `modelId` values are rejected |

`baseURL` must not contain credentials, a query string, or a fragment.
Trailing slashes are removed.

Each model registration supports:

| Field | Required | Meaning |
|---|---:|---|
| `modelId` | Yes | Exact model ID sent to the endpoint |
| `protocol` | Yes | `openai-responses`, `openai-chat-completions`, or `anthropic-messages` |
| `endpoint` | No | Relative operation path, including version if needed; overrides the protocol-default path |
| `displayName` | No | Name shown to clients |
| `maximumContextTokens` | No | Published total Context limit |
| `maximumPromptTokens` | No | Published Prompt limit; cannot exceed Context |
| `maximumOutputTokens` | No | Published output limit; cannot exceed Context |
| `outputTokenLimit` | No | Per-invocation output cap |
| `reasoning` | No | Verified Thinking and Effort capabilities |

Token limits must be positive safe integers. Effective Context budgeting uses
`maximumPromptTokens` first, then `maximumContextTokens`, and finally a
conservative `131072` fallback. `outputTokenLimit` is invocation policy, not a
published model fact, and is clamped to a known `maximumOutputTokens`.

Without `endpoint`, Clients append `/responses`, `/chat/completions`, or
`/messages` as before. With it, the final URL is the shared `baseURL` plus the
model path, joined with one slash. No protocol suffix is added again.
For example, `baseURL: "https://gateway.example"` with `endpoint: "responses"`
and `endpoint: "v1/responses"` selects two different paths using the same
Responses protocol. Endpoints cannot change the host or credentials.

All three Built-in Clients send `User-Agent: my-agent/0.1.0` and
`x-opencode-session`. Runner supplies the conversation's existing Session ID,
including Compaction calls. Calls without one use a fresh UUID per invocation;
an existing HTTP compatibility retry reuses that ID. These headers are sent
without vendor checks. They support routing/cache affinity, not server-side
conversation history or guaranteed cache hits.

### OpenCode Go example

Go requires an active Go or Go Plus subscription and a process environment
containing `OPENCODE_API_KEY`:

```json
{
  "llm": {
    "defaultModel": { "providerId": "builtin", "modelId": "glm-5.2" },
    "builtin": {
      "baseURL": "https://opencode.ai/inference/go",
      "apiKey": "${OPENCODE_API_KEY}",
      "models": [
        {
          "modelId": "glm-5.2",
          "protocol": "openai-chat-completions",
          "endpoint": "openai/v1/chat/completions"
        },
        {
          "modelId": "gpt-5.6-luna",
          "protocol": "openai-responses",
          "endpoint": "openai/v1/responses"
        },
        {
          "modelId": "claude-haiku-5-5",
          "protocol": "anthropic-messages",
          "endpoint": "anthropic/v1/messages"
        }
      ]
    }
  }
}
```

Model paths and IDs should be checked against the current upstream service.
The transport support is covered by mocked regression tests; this is not a
claim that every model or Thinking/effort setting has been live-tested.
See [OpenCode Go Model Capabilities](opencode-model-capabilities.md).

### 3.3 Thinking and Effort capabilities

`reasoning` declares values that the endpoint and selected protocol adapter
have been verified to support:

```json
{
  "reasoning": {
    "thinking": ["on", "off"],
    "efforts": ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  }
}
```

Allowed values:

- `thinking`: `on`, `off`
- `efforts`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`

Do not add unsupported values merely to make them appear in the UI. These
arrays are capability declarations:

- `thinking: "on"` means the adapter can enable reasoning and return readable
  Thinking for display.
- `thinking: "off"` means the adapter has a verified disable path.
- Effort values control reasoning strength; they do not select a default.
- `default` is a client choice meaning “do not override the Provider default.”
  It must not appear in the capability arrays.
- Values cannot be duplicated.

Protocol behavior:

| Protocol | Thinking behavior |
|---|---|
| `openai-responses` | `on` requests a detailed readable reasoning summary; `off` maps to effort `none` |
| `openai-chat-completions` | `on` uses the deployment's verified default enable path and displays returned `reasoning_text`; `off` maps to `reasoning_effort: "none"` |
| `anthropic-messages` | `on` maps to adaptive Thinking, explicit Effort maps to `output_config.effort`, and returned Thinking blocks are displayed |

There is no separate `readableSummary` configuration field.

### 3.4 Anthropic Thinking

Anthropic uses the same `reasoning` capability shape as the other protocols:

```json
{
  "modelId": "claude-reasoning",
  "protocol": "anthropic-messages",
  "reasoning": {
    "thinking": ["on", "off"],
    "efforts": ["none", "low", "medium", "high"]
  }
}
```

The Anthropic Client owns the protocol mapping:

- On with Default Effort sends `thinking: { "type": "adaptive" }`.
- A non-`none` Effort also sends its exact value in `output_config.effort`.
- Off or Effort None sends `thinking: { "type": "disabled" }`.

There is no Anthropic-specific model configuration field. Deployments that
cannot support this adaptive mapping must not declare the corresponding
Thinking or Effort capabilities.

## 4. Global Agent execution policy

These fields are global. They cannot be placed under `agents.defaults` or an
individual Agent entry.

```json
{
  "agents": {
    "steeringEnabled": true,
    "maxLlmCallsPerTurn": 12
  }
}
```

| Field | Default | Meaning |
|---|---:|---|
| `agents.steeringEnabled` | `false` | Allow the Runner to claim compatible queued user messages at steering-safe points |
| `agents.maxLlmCallsPerTurn` | omitted | Maximum Model calls in each Root or Child Turn; every Turn counts independently |

`steeringEnabled` must be a boolean. `maxLlmCallsPerTurn`, when present, must
be a positive integer.

## 5. Agent defaults and per-Agent overrides

`agents.defaults` applies to every Agent. An entry in `agents.list` can
override the same Agent-scoped sections:

```json
{
  "agents": {
    "defaults": {
      "tools": {
        "allow": ["read_file", "file_search"],
        "deny": ["exec"]
      }
    },
    "list": [
      {
        "id": "research",
        "description": "Researches a bounded question.",
        "tools": {
          "allow": ["read_file", "file_search", "grep_search"]
        }
      }
    ]
  }
}
```

Arrays replace lower-precedence arrays; they are not appended. Runtime,
Runner, LLM, and workspace settings are not valid inside Agent entries.
`model` is configured-Agent metadata and does not participate in the normal
capability merge. `maxLlmCallsPerTurn` remains global policy and is not valid
inside an Agent entry.

### 5.1 Global Memory

Memory is configured under `agents.memory`, not as an Agent capability. Root and
Child share one store/index; ordinary Tool policy controls access.

```json
{
  "agents": {
    "memory": {
      "enabled": true,
      "embedding": {
        "provider": "local",
        "model": "Xenova/all-MiniLM-L6-v2"
      },
      "chunking": {
        "chunkChars": 1600,
        "overlapChars": 320
      },
      "search": {
        "maxResults": 6,
        "minScore": 0.25,
        "vectorWeight": 0.7,
        "textWeight": 0.3
      }
    }
  }
}
```

Defaults are shown above. `embedding.provider` accepts `local` or `openai`;
the current built-in embedding factory implements `local`, while a non-local
selection falls back to keyword-only search. Chunk sizes and `maxResults` are
positive integers; overlap must be smaller than chunk size. Search scores and
weights must be between `0` and `1`.

Enabling Memory may load/download embedding files and update its index during
startup; unchanged files are not always re-embedded. Local files are downloaded
from Hugging Face when missing from the SDK cache. If that source is unreachable,
set `HF_ENDPOINT` to a trusted Hugging Face-compatible mirror before restarting:

```powershell
$env:HF_ENDPOINT = "https://your-trusted-mirror.example"
npm run agent -- --agent-home .\agent-home
```

Use an HTTP(S) URL without credentials, query or fragment. Arbitrary download
URLs are not supported. Logs report loading start/success and failures with
available network cause/code or actual requested file URL. Check the original
error for authorization, missing-file or local model failures rather than
assuming every failure needs a mirror.

### 5.2 Tool policy

```json
{
  "tools": {
    "allow": ["read_*", "file_search"],
    "deny": ["exec"]
  }
}
```

Patterns support exact names plus `*` and `?` globs. `deny` is final and
removes matching Tools even if they also match `allow`. `group:*` syntax is
not supported.

Session permission mode (`manual` or `allow_all`) is Runtime state and is not
a configuration field.

### 5.3 Agent Context budgets

```json
{
  "context": {
    "maxFileChars": 20000,
    "maxTotalChars": 150000
  }
}
```

Both values are positive safe integers. The values shown are the defaults.

### 5.4 Compaction

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 20000,
    "keepRecentTurns": 3,
    "toolResultContextShare": 0.5,
    "toolResultHeadChars": 10000,
    "toolResultTailChars": 5000,
    "timeoutSeconds": 300,
    "customInstructions": "Preserve decisions and unresolved work."
  }
}
```

All fields except `customInstructions` have the values above by default.
`toolResultContextShare` must be greater than `0` and at most `1`.
`timeoutSeconds` must be positive. Token, Turn, and character counts must be
non-negative safe integers.

### 5.5 Configured Agents and delegation

```json
{
  "agents": {
    "maxSubagentDepth": 1,
    "list": [
      {
        "id": "reviewer",
        "description": "Reviews a bounded implementation change.",
        "tools": {
          "allow": ["read_file", "file_search", "grep_search"],
          "deny": ["write_file", "exec"]
        }
      }
    ]
  }
}
```

`agents.list[]` is shared by Child delegation and other Agent entry points.
Each entry requires a unique ID and nonblank description. Omitting `model`
inherits the Model selected at the execution entry point. To select a
different Model, use:

```json
{
  "providerId": "builtin",
  "modelId": "my-model"
}
```

`maxSubagentDepth` is a non-negative safe integer. A value of `0` prevents
Root delegation. To disable delegation for one Agent, include `"task"` in
that Agent's effective `tools.deny`; there is no separate enablement flag.
Every Root and Child Turn applies `agents.maxLlmCallsPerTurn` independently;
Roles cannot override it and Child counters do not inherit Parent remaining
capacity. Context files for a configured
Agent belong under `<agentHome>/agents/<agentId>/`.

### 5.6 Skills

Place each Skill under `<agentHome>\skills`, with a `SKILL.md` containing YAML
`name` and `description` followed by instructions. Name must match the containing
directory; use 1–64 lowercase letters, digits and hyphens, without leading,
trailing or consecutive hyphens. Description must be nonblank and at most 1024
characters. For example:

```text
skills\
  builtin\
    code-review\
      SKILL.md
      scripts\
```

Classification folders do not affect names or priority. Discovery stops at each
`SKILL.md`, even an invalid one, rather than treating its internal examples as
Skills. Duplicate names are unavailable until resolved. Directory/instruction
links are not followed. No bundled content is installed automatically.

In **Agents → Global settings → Default Skills**, choose the default selection.
Named Agents can inherit it or use a complete custom selection; a custom empty
selection means no Skills. New discoveries are not enabled automatically.
Settings updates the available list while open without discarding unsaved edits.
Unavailable saved names remain visible and can be removed explicitly.
If the library cannot be read, Settings shows the reason in the Skills area;
other settings remain editable and saved selections are retained. Correcting
the directory allows the next catalog read to recover without restart.

```json
{
  "agents": {
    "defaults": { "skills": ["code-review"] },
    "list": [{ "id": "reviewer", "skills": [] }]
  }
}
```

Settings saves affect new Root/Child Turns; admitted Turns retain their selections.
Catalogs are discovered on demand, without a background scanner or cache.
Root and Child prompt preparation skip discovery when `skill` is not visible.
The model sees selected names/descriptions and loads complete current instructions
using `skill`. Requests such as `/skill code-review check these changes` are
ordinary model-interpreted text, not a Host slash command.

Skill selection keeps the advertised catalog focused to reduce model confusion;
it is not a security deny-list. Unselected Skill files can still be read through
ordinary Tools when permitted. You may explicitly ask the Agent to read a
specific directory's `SKILL.md` and follow it as a file-based workflow. This
does not enable the Skill or bypass normal Tool permissions and approval rules.

Loading grants no Tool permissions and installs nothing. Skills describe their
own interpreter/dependency/environment requirements; subsequent setup and script
execution use existing Tools and approval rules. Instruction/resource files
remain live and can change or disappear; no whole-package snapshot is promised.

## 6. Logger

```json
{
  "logger": {
    "minLevel": "info",
    "console": {
      "minLevel": "warn"
    },
    "file": {
      "minLevel": "info"
    }
  }
}
```

Allowed levels are `debug`, `info`, `warn`, and `error`. Defaults:

- global level: `info`
- File Logger: always enabled under `<agentHome>/logs`
- Console Logger: selected by the Host, disabled for `--cli`, enabled otherwise
- adapter-local levels: follow the global level unless explicitly set

The global threshold applies before either adapter's threshold. The minimal
configuration is `{ "logger": { "minLevel": "info" } }`; omitting `logger` uses
the same default level. Neither output has an `enabled` configuration field.
Use the same document for CLI and service startup.

Files use UTC names such as `app.2026-11-18.log`. Startup and the next write after
a UTC date advance remove recognized regular log files older than the current
date and six preceding dates. No size cap or background cleanup timer is
provided; idle processes clean expired files on the next write.

An unusable current file prevents startup. Later write/queue-loss failures
produce bounded emergency stderr diagnostics even in CLI mode, but do not stop
the Agent. These errors are not sent back through the failing Logger. Data loss
is also reported when Logger closes. Cleanup failure is reported without
preventing otherwise usable logging.

## 7. Extensions

An installed Extension is loaded only when it has a matching enabled entry:

```json
{
  "extensions": {
    "entries": {
      "extension-id": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

An entry defaults to enabled when present. Setting its `enabled` field to
`false` disables that Extension.

The old global `extensions.enabled` field is no longer accepted, even when it is
`false`. Startup reports the field and leaves the file unchanged. Before removing
an old global `false`, set `"enabled": false` on each existing entry that should
remain disabled. Simply removing the global field would enable entries whose
per-entry `enabled` is omitted. There is no automatic migration.

### 7.1 WebSocket browser client

Minimal configuration:

```json
{
  "extensions": {
    "entries": {
      "websocket-channel": {}
    }
  }
}
```

Full configuration with defaults:

```json
{
  "extensions": {
    "entries": {
      "websocket-channel": {
        "config": {
          "host": "127.0.0.1",
          "port": 8787,
          "webSocketPath": "/ws",
          "clientPath": "/",
          "approval": true,
          "openBrowser": false
        }
      }
    }
  }
}
```

Optional `maxClients` is a positive safe integer. `port` accepts `0` through
`65535`; `0` selects an ephemeral port. WebSocket and HTTP client paths must
be valid, distinct absolute URL paths.

The bundled Channel has no authentication, TLS, or public-network hardening.
Keep it on loopback or place it behind an authenticated operational boundary.

### 7.2 Copilot Provider (source workspace experiment)

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "copilot-login-experiment",
      "modelId": "gpt-model-id"
    }
  },
  "extensions": {
    "entries": {
      "copilot-provider": {
        "enabled": true
      }
    }
  }
}
```

Replace `gpt-model-id` with an ID from the discovered catalog. This experimental
Extension is available in the source checkout, not the root npm release.
Its configuration has no `active`, `baseURL`, `apiKey`, or discovery-TTL options.

Registration is inert. A catalog query, including an automatic startup query,
can open the Extension's sign-in page when no valid saved sign-in is available.
Discovery and inference use the authenticated Copilot account endpoint directly;
no Relay process is required.

Closing the sign-in page or choosing Cancel returns an empty Copilot catalog
and pauses automatic sign-in for that Provider instance. Restart the Host or
disable and re-enable the Extension to reset the pause. Genuine discovery
failures and invocation failures remain errors rather than empty successes.
See the [Copilot Provider guide](../../extensions/copilot-provider/README.md)
for account management, headless login, and credential storage.

### 7.3 Extension API key

An Extension `apiKey` uses the same rule as Built-in Provider credentials: it
can be a literal string or one exact `"${ENV_VAR}"` reference.

```json
{
  "config": {
    "baseURL": "https://api.example.com",
    "apiKey": "${EXAMPLE_API_KEY}"
  }
}
```

The reference must occupy the entire `apiKey` value. A missing or blank
environment variable disables the affected Extension with a bounded
diagnostic; its value is never included in diagnostics. Other Extension
configuration fields, including `baseURL`, are ordinary values defined by that
Extension's schema.
This generic example applies only to Extensions that declare these fields;
the Copilot Provider above does not.

## 8. Precedence

Agent-scoped settings resolve from lowest to highest precedence:

1. module defaults;
2. `agents.defaults`;
3. matching `agents.list[]` entry;
4. environment overrides;
5. caller or CLI overrides.

Arrays and scalar values replace the lower-precedence value. Plain objects are
merged recursively.

Global Agent execution settings use only module defaults followed by the
`agents` top-level field.

## 9. Common failures

### Agent Home is already in use

One cooperating Runtime may own a local Agent Home at a time. The
`.my-agent.pid` file stays present after exit and records the last owner;
file existence or a live process with that PID alone does not block startup.
An OS lock held by another instance does. Inspect the reported process before
stopping it; never delete or replace a live lock file to force entry.

Normal completed shutdown releases ownership. If cleanup fails or times out,
Runtime reports that the lock is retained until process exit. An embedding
process must exit before retrying that Home; a later cleanup completion does
not automatically release retained ownership.

Stop all instances running the old PID-probe implementation once before
upgrading. Mixed old/new binaries are not coordinated. Windows is validated;
Linux/macOS actual execution remains a release gate. Network Homes are not
supported by this ownership contract.

### Runtime starts but no model is available

Check that:

- the Provider is configured or its Extension entry exists;
- `llm.defaultModel.providerId` matches the Provider identity;
- `modelId` exactly matches a configured or discovered model;
- the endpoint and API key are reachable from the Host process.

### A Thinking or Effort control is missing

The UI only shows values published in the selected model's `reasoning`
capabilities. Verify the deployment first, then declare only its supported
values. Restart the Runtime after editing the file.

### Thinking is enabled but no text is displayed

The endpoint must return readable Thinking, not only opaque or encrypted
continuation state. For Built-in Responses, `thinking: "on"` requests a
detailed reasoning summary. Never expose `encrypted_content` as user-visible
Thinking.

### Configuration changes appear to have no effect

`config.json` is read at startup. Restart the Runtime.

### CLI startup rejects the logger configuration

Logger supports `minLevel` and optional `console.minLevel` / `file.minLevel`.
Remove unrecognized fields at the path reported by validation. Console output
is selected automatically by startup mode; no output switch is needed.

### Startup reports an invalid field path

Use the exact field path from the diagnostic. Check spelling, value type,
allowed enum values, and whether the setting belongs at the global or
Agent-scoped level.

## 10. Related documentation

- [Project README](../../README.md)
- [Configuration Architecture](../architecture/configuration.md)
- [Configuration Specification](../specifications/configuration.md)
- [Extension Architecture](../architecture/extensions.md)
- [Tool Permissions and Approval](../specifications/approval-lifecycle.md)
