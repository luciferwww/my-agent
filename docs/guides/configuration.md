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

On first startup, a missing `config.json` is created as:

```json
{}
```

The file is read at startup. Restart the Runtime after changing it.

The accepted top-level sections are:

```text
llm
runtime
runner
agents
logger
extensions
```

Configuration is JSON, not JSONC: comments and trailing commas are invalid.
Field names and values are case-sensitive. Unknown namespaces and invalid
known fields normally fail startup or disable the affected Extension rather
than being silently corrected.

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
  "runtime": {
    "steeringEnabled": true
  },
  "runner": {
    "maxLlmCalls": 12
  },
  "agents": {
    "defaults": {
      "memory": {
        "enabled": false
      },
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

`llm.builtin` configures one endpoint:

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
| `displayName` | No | Name shown to clients |
| `maximumContextTokens` | No | Published total Context limit |
| `maximumPromptTokens` | No | Published Prompt limit; cannot exceed Context |
| `maximumOutputTokens` | No | Published output limit; cannot exceed Context |
| `outputTokenLimit` | No | Per-invocation output cap |
| `reasoning` | No | Verified Thinking and Effort capabilities |
| `anthropicThinking` | Anthropic only | Anthropic adaptive or budget adapter |

Token limits must be positive safe integers. Effective Context budgeting uses
`maximumPromptTokens` first, then `maximumContextTokens`, and finally the
conservative `32768` fallback. `outputTokenLimit` is invocation policy, not a
published model fact, and is clamped to a known `maximumOutputTokens`.

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
| `anthropic-messages` | `on` uses the configured adaptive or budget adapter and displays returned Thinking blocks |

There is no separate `readableSummary` configuration field.

### 3.4 Anthropic Thinking

Anthropic models that publish Thinking or Effort capabilities must also select
an adapter.

`reasoning` and `anthropicThinking` have different responsibilities:

- `reasoning` is the public capability declaration. It determines which
  Thinking and Effort values clients may offer to users.
- `anthropicThinking` is private Built-in Provider wiring. It tells the
  Anthropic Client how to translate those generic values into an Anthropic
  request.

This extra mapping is required because Anthropic deployments can expose two
different control mechanisms:

| Adapter | Generic selection | Anthropic request |
|---|---|---|
| `adaptive` | Thinking On, Default Effort | `thinking: { "type": "adaptive" }` |
| `adaptive` | Thinking On, High Effort | adaptive Thinking plus `output_config.effort: "high"` |
| `budget` | Thinking On, Default Effort | enabled Thinking with `defaultBudgetTokens` |
| `budget` | Thinking On, High Effort | enabled Thinking with the configured `budgets.high` value |
| either | Thinking Off or Effort None | `thinking: { "type": "disabled" }` |

The Client cannot safely infer the adapter:

- not every Anthropic model supports adaptive Thinking;
- budget token counts are deployment-specific;
- an Effort label such as `high` does not define a numeric budget.

`anthropicThinking` is not projected to the Model Catalog or shown as another
UI control. Readable Thinking still comes from the Thinking blocks returned by
Anthropic. Models that do not publish `reasoning` capabilities do not need
this field.

Adaptive example:

```json
{
  "modelId": "claude-adaptive",
  "protocol": "anthropic-messages",
  "reasoning": {
    "thinking": ["on", "off"],
    "efforts": ["none", "low", "medium", "high"]
  },
  "anthropicThinking": {
    "mode": "adaptive"
  }
}
```

Budget example:

```json
{
  "modelId": "claude-budget",
  "protocol": "anthropic-messages",
  "maximumOutputTokens": 16384,
  "reasoning": {
    "thinking": ["on", "off"],
    "efforts": ["none", "low", "high"]
  },
  "anthropicThinking": {
    "mode": "budget",
    "defaultBudgetTokens": 2048,
    "budgets": {
      "low": 1024,
      "high": 8192
    }
  }
}
```

Budget values must be safe integers of at least `1024`, lower than the
effective output limit, and present for every declared non-`none` Effort.
Publishing `thinking: ["on"]` in budget mode requires
`defaultBudgetTokens`.

## 4. Runtime and Runner

These sections are global. They cannot be placed under `agents.defaults` or
an individual Agent entry.

```json
{
  "runtime": {
    "steeringEnabled": true
  },
  "runner": {
    "maxLlmCalls": 12
  }
}
```

| Field | Default | Meaning |
|---|---:|---|
| `runtime.steeringEnabled` | `false` | Allow compatible user messages to steer a running Turn |
| `runner.maxLlmCalls` | omitted | Maximum Model calls in one Turn; omission means no count limit |

`maxLlmCalls`, when present, must be a positive integer.

## 5. Agent defaults and per-Agent overrides

`agents.defaults` applies to every Agent. An entry in `agents.list` can
override the same Agent-scoped sections:

```json
{
  "agents": {
    "defaults": {
      "memory": {
        "enabled": false
      },
      "tools": {
        "allow": ["read_file", "file_search"],
        "deny": ["exec"]
      }
    },
    "list": [
      {
        "id": "research",
        "tools": {
          "allow": ["read_file", "file_search", "grep_search"]
        }
      }
    ]
  }
}
```

Arrays replace lower-precedence arrays; they are not appended. Runtime,
Runner, Model, LLM, and workspace settings are not valid inside Agent entries.

### 5.1 Memory

```json
{
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
```

Defaults are shown above. `embedding.provider` accepts `local` or `openai`;
the current built-in embedding factory implements `local`, while a non-local
selection falls back to keyword-only search. Chunk sizes and `maxResults` are
positive integers; overlap must be smaller than chunk size. Search scores and
weights must be between `0` and `1`.

### 5.2 Prompt

```json
{
  "prompt": {
    "safetyLevel": "normal"
  }
}
```

Allowed levels are `strict`, `normal`, and `relaxed`. The default is `normal`.

### 5.3 Tool policy

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

### 5.4 Agent Context budgets

```json
{
  "context": {
    "maxFileChars": 20000,
    "maxTotalChars": 150000
  }
}
```

Both values are positive safe integers. The values shown are the defaults.

### 5.5 Compaction

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

### 5.6 Subagents

```json
{
  "subagents": {
    "enabled": true,
    "maxDepth": 1,
    "list": [
      {
        "id": "reviewer",
        "description": "Reviews a bounded implementation change.",
        "model": "inherit",
        "maxLlmCalls": 6,
        "tools": {
          "allow": ["read_file", "file_search", "grep_search"],
          "deny": ["write_file", "exec"]
        }
      }
    ]
  }
}
```

`model` is either `"inherit"` or:

```json
{
  "providerId": "builtin",
  "modelId": "my-model"
}
```

Subagent IDs must be non-empty and unique. `maxDepth` is a non-negative safe
integer. `maxLlmCalls`, when present, is positive.

## 6. Logger

```json
{
  "logger": {
    "minLevel": "info",
    "console": {
      "enabled": true
    },
    "file": {
      "enabled": false,
      "minLevel": "warn"
    }
  }
}
```

Allowed levels are `debug`, `info`, `warn`, and `error`. Defaults:

- global level: `info`
- Console Logger: enabled
- File Logger: disabled

The CLI owns terminal output, so disable Console Logger when using `--cli`:

```json
{
  "logger": {
    "console": {
      "enabled": false
    }
  }
}
```

## 7. Extensions

Extensions are globally enabled by default, but an installed Extension is
loaded only when it has a matching entry:

```json
{
  "extensions": {
    "enabled": true,
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

### 7.2 Copilot Relay Provider

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "copilot-relay",
      "modelId": "gpt-model-id"
    }
  },
  "extensions": {
    "entries": {
      "copilot-relay-provider": {
        "config": {
          "baseURL": "http://127.0.0.1:5000",
          "discoveryTimeoutMs": 5000
        }
      }
    }
  }
}
```

The Extension discovers models and their supported Responses or Chat
Completions endpoint from `<baseURL>/v1/models`.

| Field | Default |
|---|---|
| `baseURL` | `http://127.0.0.1:5000` |
| `apiKey` | omitted |
| `discoveryTimeoutMs` | `5000` |

### 7.3 Extension environment references

Extension configuration supports exact environment-backed values:

```json
{
  "config": {
    "baseURL": {
      "$env": "COPILOT_RELAY_URL"
    },
    "apiKey": {
      "$secret": {
        "source": "env",
        "name": "COPILOT_RELAY_API_KEY"
      }
    }
  }
}
```

An `apiKey` string may alternatively use the exact
`"${COPILOT_RELAY_API_KEY}"` form.

References must occupy the entire value. Missing or blank environment values
disable the affected Extension with a bounded diagnostic; secret values are
not included in diagnostics.

## 8. Precedence

Agent-scoped settings resolve from lowest to highest precedence:

1. module defaults;
2. `agents.defaults`;
3. matching `agents.list[]` entry;
4. environment overrides;
5. caller or CLI overrides.

Arrays and scalar values replace the lower-precedence value. Plain objects are
merged recursively.

Global `runtime` and `runner` settings use only module defaults followed by
their top-level file values.

## 9. Common failures

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

Disable `logger.console.enabled` when running with `--cli`.

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
