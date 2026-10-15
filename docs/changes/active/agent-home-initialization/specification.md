# Agent Home Initialization Specification

> Status: Draft
> Date: 2026-10-14
> Owner: Project owner
> Related Plan: [Agent Home Initialization Plan](plan.md)
> Related Decision: [ADR-022](../../../decisions/adr-022-explicit-standalone-agent-home-initialization.md)
> Prerequisites: [Shared Configured Agents Specification](../../archive/shared-configured-agents/specification.md) and [Extension Initialization Metadata Specification](../../archive/extension-initialization-metadata/specification.md)

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
| Provider source | `select` | `Select an LLM provider` |
| Built-in protocol | conditional `select` | `Select the model protocol` |
| Built-in endpoint | conditional required `text` | `Enter the provider base URL` |
| Extension configuration | conditional Schema-driven prompts | use Schema `title`, or the property key when omitted |
| Sensitive source | conditional `select` | `How should <field label> be supplied?` |
| Sensitive literal | conditional masked `password` | `Enter <field label>` |
| Environment reference | conditional required `text` | `Enter the environment variable name` |
| Provider | conditional `select` when the selected Extension registers more than one | `Select the Provider` |
| Model | Built-in required `text`; Extension Catalog `select` | `Enter the model ID` or `Select the Model` |
| Turn limit | optional positive-integer `text` | `Maximum LLM calls per Turn (leave blank for unlimited)` |
| Summary | non-secret read-only note | show Agent Home, Provider source, effective non-secret configuration, Provider/Model, credential sources, and effective Turn limit |
| Confirmation | `confirm` | `Create this Agent Home?` |
| Validation | `spinner` | `Validating configuration` |
| Readiness | `spinner` | `Verifying model access` |
| Publication | `spinner` | `Creating Agent Home` |
| Success | `outro` | `Agent Home initialized successfully.` followed by the ordinary startup command |

Provider source choices contain the Built-in Provider followed by installed
Extension candidates whose Descriptor includes `provider`, ordered by the
existing deterministic discovery result and displayed by Descriptor `name`,
falling back to Descriptor `id`. Discovery reads no Extension entry. A
discovery diagnostic does not become a selectable choice.

For the Built-in route, Protocol choices are exactly:

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

For each sensitive string, Credential Source choices are:

```text
Enter API key now
Use an environment variable
No credential
```

`Enter now` is the default highlighted choice. `No credential` is offered only
when the property is not required. Before confirmation, a literal-sensitive
summary includes:

```text
The sensitive value will be stored as plaintext in config.json and may be accessible
to processes and Tools running with your user permissions.
```

The summary never contains the literal Secret or resolved environment value.
The environment-reference summary displays only the variable name.

Extension configuration prompts support only direct root properties with these
bounded Draft-07 shapes:

| Schema shape | Prompt |
|---|---|
| `type: "string"` | `text` |
| `type: "integer"` or `"number"` | numeric `text` |
| `type: "boolean"` | `confirm` |
| scalar `enum` | `select` |
| `type: "string", writeOnly: true` | sensitive-source flow |

`title` is optional and falls back exactly to the property key.
`description` is optional and omitted from the prompt when absent.
`writeOnly` omission has its Draft-07 behavior of `false`. Supported scalar
constraints and `required` are validated locally. A blank optional value is
omitted; accepting a displayed Schema default also leaves that property
unauthored so Acquisition applies the effective default.

Nested objects, arrays, references, composition, conditionals, dynamic
properties, and mixed-type schemas are not interactively configured in this
version. Selecting a Provider Extension that requires an unsupported authored
shape fails before importing its entry:

```text
<Extension display name> cannot be configured by this version of the initializer.
Unsupported configuration field: <property key>.
```

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

## 6. Installed content and generated configuration

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

The Built-in route generates this semantic shape:

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

The Provider Extension route instead generates:

```json
{
  "llm": {
    "defaultModel": {
      "providerId": "<actual-registered-provider-id>",
      "modelId": "<selected-model-id>"
    }
  },
  "agents": {
    "steeringEnabled": false,
    "maxLlmCallsPerTurn": "<optional positive integer; omitted when blank>",
    "maxSubagentDepth": 1,
    "list": ["<same fixed Agent entries as above>"]
  },
  "extensions": {
    "entries": {
      "<selected-extension-id>": {
        "config": {
          "<property>": "<only explicitly authored values>"
        }
      }
    }
  }
}
```

The Extension route omits `llm.builtin`, `extensions.enabled`, and entry
`enabled`. Empty `config` remains present because it is the selected
Extension's scoped configuration value. Schema defaults are effective during
candidate preparation but are not copied into the authored document.

## 7. Provider and Model prompts

The first version supports the Built-in Provider and one installed Provider
Extension. It does not install, update, download, or enable unrelated
Extensions.

For Built-in, the three current protocols in Section 4 remain available and
the Model ID is entered explicitly.

For an Extension route, the initializer:

1. validates that the selected Descriptor claims `provider`;
2. collects the supported Schema projection without importing the entry;
3. acquires only the selected configured Extension;
4. calls its Unit `create()` without starting it;
5. stages its registration and requires at least one actual Provider;
6. prompts for the Provider only when more than one was registered;
7. selects a Model from the chosen Provider Catalog;
8. performs readiness through that exact Provider/Model;
9. stops the created Unit instance during cleanup without starting Runtime.

A static claim with no actual staged Provider fails without publishing
configuration:

```text
<Extension display name> declares Provider support but did not register a Provider.
```

The candidate must:

- pass existing configuration validation;
- resolve the exact selected `{ providerId, modelId }` through existing public
  behavior;
- complete one real, minimal, tool-free inference before success.

The readiness request uses the candidate Provider, credential, and Model
directly. It carries no Agent Context, Session history, Tools,
attachments, or user data; it asks for a short fixed response and treats a
successful completed invocation as readiness. The request is not persisted to
Session, Transcript, Memory, or configuration.

Readiness failure prints:

```text
Could not verify the selected Model. Check the Provider configuration,
credential, and Model ID.
```

The initializer does not add Provider-specific APIs or modify a Provider. If
the required check cannot be implemented with current public APIs, Delivery is
blocked rather than expanded.

The current and prerequisite API boundary is sufficient:

- `discoverExtensionDescriptors()` provides import-free installed Provider
  Extension discovery;
- `acquireExtensions()` validates configuration and imports only the configured
  selected entry;
- selected `LoadedRuntimeUnit.create()` and `stageRegistryUnit()` expose actual
  Provider contributions without constructing Runtime;
- `loadAgentConfig()` can validate the serialized candidate through its
  injected text-reader dependency without publishing the target
  `config.json`;
- `BuiltinLlmProvider` exposes the candidate Provider projection;
- `ModelResolver` performs exact `{ providerId, modelId }` resolution;
- the resolved `ModelInvocationPort.chat()` performs the tool-free readiness
  request.

The initializer uses those APIs directly and does not construct `RuntimeApp`,
a Session, or a published Registry.

## 8. Credentials

Sensitive input is masked and never logged or included in diagnostics.
Built-in `apiKey` and Extension root strings explicitly marked
`writeOnly: true` use the same source semantics:

- `Enter now` keeps the masked value only in memory until readiness succeeds,
  then writes the literal to the selected configuration property.
- `Use an environment variable` accepts a valid environment-variable name,
  requires its current value to be nonblank for readiness, and writes the exact
  `${ENV_VAR}` reference without copying the resolved value.
- `No credential` omits an optional property and is unavailable for a required
  property.

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
- only installed Extensions statically declaring `provider` are offered;
- unsupported Extension Schema shapes fail before entry import;
- only the selected Provider Extension is acquired and created;
- a static Provider claim without actual Provider registration is rejected;
- authored Extension config omits accepted Schema defaults and default
  enablement fields;
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
