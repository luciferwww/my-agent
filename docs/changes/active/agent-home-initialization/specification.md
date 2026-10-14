# Agent Home Initialization Specification

> Status: Draft
> Date: 2026-10-14
> Owner: Project owner
> Related Plan: [Agent Home Initialization Plan](plan.md)
> Related Decision: [ADR-022](../../../decisions/adr-022-explicit-standalone-agent-home-initialization.md)
> Prerequisite: [Shared Configured Agents Specification](../../archive/shared-configured-agents/specification.md)

## 1. Purpose

Initialize a new standalone Agent Home through:

```text
my-agent --initialize [--agent-home <path>]
```

Initialization is a separate Standalone execution path. It does not start
`RuntimeApp` and does not create Runtime-owned state.

## 2. Module boundary

The implementation lives under `src/hosts/standalone/`. The existing entry
parses arguments and routes either to initialization or ordinary Host startup.
A small Standalone-owned initializer performs the prompts and file
orchestration.

The initializer may call existing exported APIs, but this Change makes no
production modification outside the Standalone Host, dependency manifests,
lockfile, and Standalone-owned packaged assets.

No generic initializer framework, Provider setup SDK, or new cross-module
interface is introduced.

## 3. CLI behavior

- `--initialize` may occur once.
- It uses existing `--agent-home` path resolution.
- It is mutually exclusive with `--cli`.
- Unknown, duplicate, positional, and missing-value arguments retain bounded
  `HOST_ARGUMENT_INVALID` behavior.
- A non-interactive terminal fails before writing files.
- Every terminal path exits without starting ordinary Host lifetime.

## 4. Wizard flow and terminal copy

The first version uses this bounded sequence:

| Step | Prompt behavior | Terminal copy |
|---|---|---|
| Introduction | `intro` | `Initialize a new my-agent home` |
| Path | read-only note | `Agent Home: <absolute path>` |
| Protocol | `select` | `Select the model protocol` |
| Endpoint | required `text` | `Enter the provider base URL` |
| Credential source | `select` | `How should the provider credential be supplied?` |
| Literal credential | conditional masked `password` | `Enter the API key` |
| Environment reference | conditional required `text` | `Enter the environment variable name` |
| Model | required `text` | `Enter the model ID` |
| Turn limit | optional positive-integer `text` | `Maximum LLM calls per Turn (leave blank for unlimited)` |
| Summary | non-secret read-only note | show Agent Home, protocol, endpoint, credential source, Model ID, and effective Turn limit |
| Confirmation | `confirm` | `Create this Agent Home?` |
| Validation | `spinner` | `Validating configuration` |
| Readiness | `spinner` | `Verifying model access` |
| Publication | `spinner` | `Creating Agent Home` |
| Success | `outro` | `Agent Home initialized successfully.` followed by the ordinary startup command |

The Protocol choices are exactly:

```text
OpenAI Responses
OpenAI Chat Completions
Anthropic Messages
```

and map to:

```text
openai-responses
openai-chat-completions
anthropic-messages
```

The Credential Source choices are exactly:

```text
Enter API key now
Use an environment variable
No credential
```

`Enter API key now` is the default highlighted choice. Before confirmation,
its summary includes:

```text
The API key will be stored as plaintext in config.json and may be accessible
to processes and Tools running with your user permissions.
```

The summary never contains the literal Secret or resolved environment value.
The environment-reference summary displays only the variable name.

Cancellation at any prompt prints:

```text
Initialization cancelled. No config was written.
```

If create-if-missing Context or profile files were already installed before a
later cancellation, the message additionally states that those files were
preserved. A non-interactive terminal prints:

```text
Initialization requires an interactive terminal.
```

An existing configuration prints:

```text
Agent Home is already configured. Initialization did not change it.
```

Prompt validation remains local and actionable. It does not print raw values,
Secrets, stack traces, or response bodies.

## 5. Accepted target

The first version accepts a missing or empty Agent Home. An existing
`config.json` is rejected without modification. This is not a repair or
configure command.

Created files use exclusive or create-if-missing writes. Existing files are
never overwritten. Cancellation is unsuccessful and may leave only
create-if-missing Context/profile files; rerunning against that partial state
preserves them.

## 6. Installed content

The initializer creates Root Context through the existing Agent Context API and
installs fixed first-party definitions:

```text
<agentHome>/agents/reviewer/
<agentHome>/agents/explorer/
<agentHome>/agents/researcher/
```

Each directory contains the existing allowlisted Context filenames. Their
contents are packaged Standalone initialization assets. There is no template
selection or download.

The initializer writes corresponding entries to `agents.list[]` using the
accepted Shared Configured Agents contract. Role entries contain no
`maxLlmCalls` field.

Global Agent execution policy uses only:

```text
agents.steeringEnabled
agents.maxLlmCallsPerTurn
agents.maxSubagentDepth
```

The generated document contains no top-level `runner` namespace.
`steeringEnabled` is fixed to `false`, `maxSubagentDepth` is fixed to `1`, and
`maxLlmCallsPerTurn` is omitted when the optional prompt is blank.
`agents.defaults` is omitted so module-owned defaults remain authoritative.

The fixed Role Tool allow-lists are:

| Agent | Allowed Tools |
|---|---|
| `reviewer` | `list_dir`, `read_file`, `file_search`, `grep_search` |
| `explorer` | `list_dir`, `read_file`, `file_search`, `grep_search` |
| `researcher` | `list_dir`, `read_file`, `file_search`, `grep_search`, `web_fetch` |

The generated configuration has this semantic shape:

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "builtin",
      "modelId": "<model-id>"
    },
    "builtin": {
      "baseURL": "<base-url>",
      "apiKey": "<literal-or-${ENV_VAR}; omitted for no credential>",
      "models": [
        {
          "modelId": "<model-id>",
          "protocol": "<selected-protocol>"
        }
      ]
    }
  },
  "agents": {
    "steeringEnabled": false,
    "maxLlmCallsPerTurn": "<optional positive integer; omitted when blank>",
    "maxSubagentDepth": 1,
    "list": [
      {
        "id": "reviewer",
        "description": "Reviews code changes for correctness and regressions",
        "tools": {
          "allow": ["list_dir", "read_file", "file_search", "grep_search"]
        }
      },
      {
        "id": "explorer",
        "description": "Explores the codebase and traces existing behavior",
        "tools": {
          "allow": ["list_dir", "read_file", "file_search", "grep_search"]
        }
      },
      {
        "id": "researcher",
        "description": "Researches implementation options and supporting evidence",
        "tools": {
          "allow": ["list_dir", "read_file", "file_search", "grep_search", "web_fetch"]
        }
      }
    ]
  }
}
```

The placeholders above describe omission rules and are never written
literally. `logger`, `extensions`, and all other optional sections are omitted.

## 7. Provider and Model prompts

The first version configures only the Built-in Provider. It supports all three
currently shipped Built-in protocols listed in Section 4. It does not configure
the Copilot Relay Extension or multiple Providers.

The candidate must:

- pass existing configuration validation;
- resolve the exact selected `{ providerId, modelId }` through existing public
  behavior;
- complete one real, minimal, tool-free inference before success.

The readiness request uses the candidate endpoint, protocol, credential, and
Model directly. It carries no Agent Context, Session history, Tools,
attachments, or user data; it asks for a short fixed response and treats a
successful completed invocation as readiness. The request is not persisted to
Session, Transcript, Memory, or configuration.

Readiness failure prints:

```text
Could not verify the selected Model. Check the endpoint, protocol, credential,
and Model ID.
```

The initializer does not add Provider-specific APIs or modify a Provider. If
the required check cannot be implemented with current public APIs, Delivery is
blocked rather than expanded.

The current API boundary is sufficient:

- `loadAgentConfig()` can validate the serialized candidate through its
  injected text-reader dependency without publishing the target
  `config.json`;
- `BuiltinLlmProvider` exposes the candidate Provider projection;
- `ModelResolver` performs exact `{ providerId, modelId }` resolution;
- the resolved `ModelInvocationPort.chat()` performs the tool-free readiness
  request.

The initializer uses those APIs directly and does not construct
`RuntimeApp`, a Session, or a Registry.

## 8. Credentials

Secret input is masked and never logged or included in diagnostics. The
Credential Source choice has these semantics:

- `Enter API key now` keeps the masked value only in memory until readiness
  succeeds, then writes the literal value to `llm.builtin.apiKey`.
- `Use an environment variable` accepts a valid environment-variable name,
  requires its current value to be nonblank for readiness, and writes the exact
  `${ENV_VAR}` reference without copying the resolved value.
- `No credential` omits `llm.builtin.apiKey`.

For an unavailable environment variable, the prompt remains active and shows:

```text
Environment variable <name> is not set or is blank.
```

No `.env` file, credential store, Keychain integration, or claim of isolation
from same-user processes or Tools is introduced.

## 9. Publication

`config.json` is the final publication boundary. Before its exclusive write,
the complete candidate passes the accepted validation and readiness checks.
There is no initialization marker or version.

Success means ordinary standalone startup can load the resulting Agent Home
under the same declared credential environment. Initialization then exits.

## 10. Ordinary startup

Ordinary standalone startup no longer calls missing-document bootstrap. A
missing config fails before Runtime creation with bounded guidance to run:

```text
my-agent --initialize --agent-home <path>
```

Existing strict configuration loading remains unchanged. The Platform
Configuration bootstrap API may remain for other explicit callers; this Change
only stops ordinary Standalone Host use of it.

## 11. Failure behavior

- cancellation never reports success;
- invalid input stays in the bounded prompt step;
- validation, readiness, filesystem, or concurrent-write failure aborts;
- failure does not publish `config.json`;
- secrets and raw response bodies do not appear in errors;
- no fallback Provider, Model, directory, or default config is selected.

## 12. Compatibility

Existing Agent Homes may be deleted. There is no migration, version, dual
behavior, Feature Flag, or repair path.

ADR-011's ordinary Standalone empty-config bootstrap is superseded. Its
Platform Configuration ownership and strict loading decisions remain.

## 13. Acceptance

- initialization routes without constructing `RuntimeApp`;
- non-TTY and invalid combinations fail before mutation;
- existing config is preserved and rejected;
- cancellation or failure does not publish config;
- Root and fixed named Agent files are created without overwrite;
- generated configuration uses the accepted global `agents` execution-policy
  fields and contains no `runner` namespace or Role-level call limit;
- selected Provider/Model configuration is explicit and valid;
- accepted readiness verification passes before publication;
- ordinary startup gives initialization guidance for missing config;
- initialization followed by ordinary startup succeeds;
- no non-Standalone production module changes;
- package, Unit, integration, lint, build, link, diff, manual terminal, and
  independent review checks pass as affected.

## 14. Open questions

No product-behavior question remains open. Delivery remains gated on evidence
that implementation tests preserve the verified public-API path without
modifying non-Standalone production modules.
