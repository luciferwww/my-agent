# Agent Home Initialization Specification

> Status: Accepted
> Date: 2026-10-15
> Owner: Project owner
> Related Plan: [Agent Home Initialization Plan](plan.md)
> Related Decision: [ADR-022](../../../decisions/adr-022-explicit-standalone-agent-home-initialization.md)
> Prerequisites: [Shared Configured Agents Specification](../../archive/shared-configured-agents/specification.md) and [Extension Initialization Metadata Specification](../../archive/extension-initialization-metadata/specification.md)

## 1. Purpose

Initialize or edit a standalone Agent Home through:

```text
my-agent --initialize [--agent-home <path>]
```

This is a separate Standalone execution path. It does not start `RuntimeApp`
and does not create Runtime-owned state. A missing `config.json` enters
Initialize mode. An existing valid `config.json` requires explicit
confirmation and enters Edit mode.

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
- An existing configuration prompts `Edit existing configuration?` with a
  default of `false`. Declining leaves the Agent Home unchanged.
- Edit mode does not provide destructive full reset in this version.

## 4. Wizard flow and terminal copy

The first version uses an in-memory Draft controlled by a repeatable main menu.
Completing a section returns to the menu; `Esc` cancels the entire
initialization, while the final review provides an explicit return to
configuration. The menu presents:

| Menu action | State and behavior |
|---|---|
| LLM Providers and Models | show configured Provider and verified Model counts; enter the repeatable Provider flow |
| Default Model | disabled until at least one Model is verified; show the selected exact Provider/Model pair |
| Agent Runtime Settings | show defaults or the authored maximum LLM calls per Turn |
| Restore recommended Root Tool defaults | Edit mode only; replace `agents.defaults.tools` with the generated recommendation without Tool discovery |
| Extensions | show discovered, configured, modified, pending-validation, and disabled Extension instances |
| Initialize Agent Home and exit / Save changes and exit | disabled with a reason until the Draft is publishable |
| Cancel | cancel the whole initialization without publication |

The section and publication prompts are:

| Step | Prompt behavior | Terminal copy |
|---|---|---|
| Introduction | `intro` | `Initialize a new my-agent home` |
| Path | read-only note | `Agent Home: <absolute path>` |
| Main menu | repeatable `select` | `What would you like to configure?` |
| Provider source | repeatable `select` | `Select an LLM provider to configure` |
| Built-in protocol | conditional `select` | `Select the model protocol` |
| Built-in endpoint | conditional required `text` | `Enter the provider base URL` |
| Extension configuration | conditional Schema-driven prompts | use Schema `title`, or the property key when omitted |
| Sensitive source | conditional `select` | `How should <field label> be supplied?` |
| Sensitive literal | conditional masked `password` | `Enter <field label>` |
| Environment reference | conditional required `text` | `Enter the environment variable name` |
| Model | required `text` | `Enter the model ID` |
| Additional Model | `confirm` | `Add another Model for this Provider?` |
| Candidate verification | `confirm` | `Verify these Models with live LLM calls?` |
| Verification result | non-secret read-only note | show each successful or failed Provider/Model without response content |
| Default Model | `select` when more than one Model succeeded | `Select the default Model` |
| Turn limit | optional positive-integer `text` | `Maximum LLM calls per Turn (leave blank for unlimited)` |
| Root Tool defaults | direct Edit-mode menu action | replace only `agents.defaults.tools`, preserve every other Agent field, and report `Root Agent Tool permissions will be restored to the recommended defaults.` |
| Summary | non-secret read-only note | show Agent Home, retained Providers, verified Models, Default Model, credential sources, and effective Turn limit |
| Final review | `select` | `Initialize Agent Home and exit` or `Back to configuration` |
| Validation | `spinner` | `Validating configuration` |
| Readiness | `spinner` per candidate batch | `Verifying model access` |
| Publication | `spinner` | `Creating Agent Home` |
| Success | `outro` | `Agent Home initialized successfully.` followed by the ordinary startup command |

`Initialize Agent Home and exit` is enabled only when at least one Model is
verified, the Default Model is one of the currently verified exact pairs, and
the retained Provider contributions have no combined identity conflict.
Unselected discovered Extensions do not block publication. The same readiness
predicate guards the action after selection; final configuration validation
and publication preflight run again before writing.

Provider source choices contain the Built-in Provider followed by installed
Extension candidates whose Descriptor includes `provider`, ordered by the
existing deterministic discovery result and displayed by Descriptor `name`,
falling back to Descriptor `id`. Discovery reads no Extension entry. A
discovery diagnostic does not become a selectable choice.

The Provider loop keeps all candidates in memory. The Built-in source may
produce one retained Built-in configuration. Each Provider Extension may
produce one retained Extension entry. A source with no successfully verified
Model is discarded. The user may finish Provider collection only after at
least one Model has succeeded.

Before candidate verification, the Wizard states:

```text
Verification makes one live LLM request per Model.
The selected Provider Extension will be started temporarily and stopped after verification.
```

The second line is omitted for Built-in. No response content is displayed or
persisted.

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
Enter now
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
| scalar `enum` | `select` |
| `type: "string"` | `text` |
| `type: "integer"` or `"number"` | numeric `text` |
| required boolean, or boolean with a default | `confirm` |
| optional boolean without a default | `select`: `Leave unset`, `true`, or `false` |
| `type: "string", writeOnly: true` | sensitive-source flow |

`title` is optional and falls back exactly to the property key.
`description` is optional and omitted from the prompt when absent.
`writeOnly` omission has its Draft-07 behavior of `false`. Supported scalar
`enum` takes precedence over the base-type control. Supported scalar constraints
and `required` are validated locally. A blank optional value is omitted;
accepting a displayed Schema default also leaves that property unauthored so
Acquisition applies the effective default. An optional enum without a default
includes `Leave unset`; selecting it omits the property.

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
Initialization cancelled. Agent Home was not changed.
```

A non-interactive terminal prints:

```text
Initialization requires an interactive terminal.
```

An existing configuration prompts:

```text
Agent Home is already configured. Edit existing configuration?
```

Prompt validation remains local and actionable. It does not print raw values,
Secrets, stack traces, or response bodies.

## 5. Accepted target

Initialize mode accepts a target with no `config.json` and no conflicting
fixed Profile asset. An existing valid `config.json` is offered for explicit
Edit mode and remains unchanged when confirmation is declined.

All prompts, in-memory candidate validation, exact Provider/Model resolution,
final confirmation, readiness, and candidate cleanup complete before the
initializer creates or changes any Agent Home file. Cancellation and any
failure before Publication leave Agent Home unchanged.

Root Context retains the existing create-if-missing API behavior: existing
Root Context files are preserved and missing files are created during
Publication. For each allowlisted fixed Profile file, an existing byte-equal
packaged asset is a compatible partial result and is preserved; different
existing content is a conflict and is never overwritten. A conflict prints:

```text
Agent Home contains a conflicting initialization file: <relative path>.
The existing file was not overwritten.
```

Publication uses exclusive or create-if-missing writes. A filesystem failure
during Publication can leave only compatible Context/Profile files and no
`config.json`; rerunning preserves those files and creates what remains.

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
`agents.defaults.tools` contains the recommended Root Agent Tool allow-list
with an empty deny-list. Other `agents.defaults` fields are omitted so their
module-owned defaults remain authoritative.

The fixed Role Tool allow-lists are:

| Agent | Allowed Tools |
|---|---|
| `reviewer` | `list_dir`, `read_file`, `file_search`, `grep_search` |
| `explorer` | `list_dir`, `read_file`, `file_search`, `grep_search` |
| `researcher` | `list_dir`, `read_file`, `file_search`, `grep_search`, `web_fetch` |

The generated Root Agent Tool allow-list contains the standard workspace read
and write Tools plus the union of every fixed Role allow-list. Consequently,
the Root Agent is never initialized with a lower Tool allowance than a fixed
named Agent. The initializer does not add `task` to this allow-list; delegation
retains the existing approval behavior.

When Built-in Models and Provider Extensions are both retained, the generated
document has this combined semantic shape:

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
          "modelId": "<verified-model-id>",
          "protocol": "<selected-protocol>"
        },
        {
          "modelId": "<another-verified-model-id>",
          "protocol": "<selected-protocol>"
        }
      ]
    }
  },
  "agents": {
    "steeringEnabled": false,
    "maxLlmCallsPerTurn": "<optional positive integer; omitted when blank>",
    "maxSubagentDepth": 1,
    "defaults": {
      "tools": {
        "allow": [
          "list_dir",
          "read_file",
          "file_search",
          "grep_search",
          "write_file",
          "edit_file",
          "apply_patch",
          "web_fetch"
        ],
        "deny": []
      }
    },
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
  },
  "extensions": {
    "entries": {
      "<verified-extension-id>": {
        "config": {
          "<property>": "<only explicitly authored values>"
        }
      },
      "<another-verified-extension-id>": {
        "config": {}
      }
    }
  }
}
```

The placeholders above describe omission rules and are never written
literally. `llm.builtin` is omitted when no Built-in Model succeeded, and
`extensions` is omitted when no Extension was configured. `logger` and all
other optional sections are omitted.

`llm.builtin.models[]` contains only Built-in Models whose exact protocol,
endpoint, credential, and Model ID completed a live verification. An Extension
entry is retained only when at least one Model from its single registered
Provider completed a live verification. Extension Catalog Models are not
copied into authored config; the Extension remains their authority.

`llm.defaultModel` references exactly one member of the in-memory Verified
Models set. `extensions.enabled` and entry `enabled` are omitted. Empty
Extension `config` remains present because it is the retained Extension's
scoped configuration value. Schema defaults are effective during candidate
preparation but are not copied into the authored document.

## 7. Provider and Model prompts

The first version supports one Built-in configuration and multiple installed
Extensions. Every discovered Descriptor is shown in the Extensions view and
may use the bounded Schema prompt projection. A Descriptor declaring
`provider` additionally enters the Provider lifecycle and live Model
verification flow. An Extension without a declared verification policy is
structurally configured from its Schema and labeled `no declared live
verification`; absence of `contributes` does not make its Schema unavailable.
The initializer does not install, update, or download Extensions.

For Built-in, each Model candidate has an explicitly entered Model ID and one
of the three protocols in Section 4. All Built-in candidates in one
initialization share the one authored Built-in endpoint and credential.
Model IDs must be unique within that Built-in configuration.

For each Extension candidate, the initializer:

1. validates that the selected Descriptor claims `provider`;
2. collects the supported Schema projection without importing the entry;
3. collects one or more explicit Model IDs;
4. shows a non-secret candidate summary and obtains explicit consent to load,
   start, and make live requests through that Extension;
5. acquires only that configured Extension;
6. calls its Unit `create()`, which may perform bounded remote discovery;
7. stages its registration and requires exactly one actual Provider;
8. requires every candidate Model ID to exist in that Provider Catalog and
   resolve through existing public behavior;
9. calls the Unit instance `start()`;
10. performs one real, minimal, tool-free inference for each candidate Model;
11. calls the Unit instance `stop()` exactly once;
12. retains the Extension config and only the successful Model references when
    cleanup also succeeds.

Candidate Model IDs must be unique within the Extension Provider.

The one-Provider rule preserves the current Provider/Model hierarchy. A
Provider may route different Models through different protocols; the
Extension owns that mapping, so the initializer neither adds another Provider
selection layer nor asks the user for an Extension protocol.

Once Unit creation succeeds, staging, verification consent, start, all Model
checks, cancellation, failure, and cleanup remain inside one cleanup boundary.
The created instance is stopped exactly once in `finally`, including when it
was never started or `start()` failed. The initializer starts only that
explicitly selected Unit; it does not construct `RuntimeApp`, publish a
Registry, load unrelated Extensions, or start ordinary Host lifetime.

A static claim with no actual staged Provider fails without publishing
configuration:

```text
<Extension display name> declares Provider support but did not register a Provider.
```

If more than one Provider was registered:

```text
<Extension display name> registered multiple Providers.
This version of the initializer supports one Provider per Provider Extension.
```

Each Model candidate must:

- pass existing configuration validation;
- resolve the exact selected `{ providerId, modelId }` through existing public
  behavior;
- complete one real, minimal, tool-free inference before success.

A failed Model is not retained and does not invalidate another Model that
succeeded under the same Provider configuration. A Provider configuration
with no successful Model is discarded. A `start()` or `stop()` failure
discards the entire Provider candidate because no safe verified lifecycle was
completed.

Verification evidence is bound to the exact effective Provider configuration.
Adding another Model may reuse the same authored and effective configuration.
Changing Built-in endpoint or credential, or changing an Extension's authored
configuration, discards every earlier success for that Provider source and
requires all retained Models under the replacement configuration to pass
again. One Extension ID cannot produce two retained configuration entries.

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

After each Provider batch, the Wizard shows successful and failed Model IDs
without response bodies or Secrets. It then permits another Provider batch,
another Model verification batch for a retained Provider configuration, or
completion when at least one verified Model exists.

The final Default Model picker contains only exact Provider/Model pairs whose
live inference succeeded. With one verified Model it is selected
automatically. With multiple verified Models the user selects one. Choosing to
enter a different Model returns to Provider/Model collection; that Model must
complete its own live inference before it can appear in the picker. There is
no unverified manual Default Model path and no automatic first-Catalog-Model
fallback.

Before final confirmation, the initializer combines the staged registration
facts from all retained Provider Extensions with the Built-in candidate and
uses existing Registry candidate resolution to reject Unit, Provider, Tool,
Hook, or Channel identity conflicts. It also validates the complete serialized
configuration through the existing injected-reader path. A combined conflict
does not silently remove either Provider configuration; the user must discard
or reconfigure a conflicting candidate.

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
- `resolveStagedRegistryCandidate()` validates the combined retained
  contribution identities without publishing a Registry;
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
- `Use an environment variable` accepts a name matching
  `[A-Z_][A-Z0-9_]*`, requires its current value to be nonblank for readiness,
  and writes the exact `${ENV_VAR}` reference without copying the resolved
  value.
- `No credential` omits an optional property and is unavailable for a required
  property.

For an unavailable environment variable, the prompt remains active and shows:

```text
Environment variable <name> is not set or is blank.
```

No `.env` file, credential store, Keychain integration, or claim of isolation
from same-user processes or Tools is introduced.

## 9. Draft ownership and edit semantics

The Wizard holds one in-memory Draft. UI sections are navigation views and do
not own duplicate configuration values.

- one Extension ID has one Extension configuration Draft;
- LLM, Channel, Tool, and future capability views reference that Draft;
- Built-in and Extension capabilities use the same verification-evidence
  semantics;
- entering a capability view may navigate to the shared Extension
  configuration flow, but cannot create another copy of its config.

Edit mode starts from the exact parsed existing document. Untouched content is
preserved. A section becomes modified only after a candidate is accepted:

- modifying LLM replaces the authored `llm` section;
- modifying Agent Runtime settings updates only
  `agents.steeringEnabled`, `agents.maxLlmCallsPerTurn`, and
  `agents.maxSubagentDepth`, preserving `agents.defaults` and custom
  `agents.list` entries;
- modifying an Extension replaces or removes only that exact
  `extensions.entries.<id>` value;
- `logger`, untouched Agents, untouched Extensions, and other untouched
  supported content remain unchanged.

Initialize mode creates the fixed named Agent entries and assets. Edit mode
does not replace custom Agent entries merely because another section changed.

## 10. Candidate transactions and capability verification

Configuration changes are candidates, not immediate mutations of an accepted
Draft:

```text
accepted configuration
→ candidate configuration
→ required capability verification
→ accept candidate or discard it
```

A failed candidate leaves the accepted configuration and its evidence intact.
A pending candidate blocks Save. The user may continue editing it or discard
it.

Verification policy is capability-based and source-independent. Any new,
enabled, or changed Built-in or Extension capability that requires
verification must succeed before Save. Unchanged existing configuration is
preserved without mandatory re-verification. Disabled or removed capabilities
need no readiness probe but must leave no invalid references or dependencies.

Evidence is bound to the normalized candidate configuration fingerprint and
the exact capability. For LLM Providers it is additionally bound to each exact
Provider/Model pair. Any relevant Built-in or Extension configuration change
invalidates earlier evidence. Because this version has no field-level impact
metadata, changing an Extension configuration conservatively invalidates all
verification evidence for that Extension's enabled contributions.

The Host determines required verification. An Extension may provide a
capability-specific probe, but cannot self-assert successful verification.
The current implemented capability policy is:

| Capability | Requirement |
|---|---|
| Built-in LLM Provider | exact Model resolution and one live tool-free request |
| Extension LLM Provider | create, stage, start, exact Model resolution, one live tool-free request, and exact-once stop |

Future capability policies require separate accepted behavior. They use the
same candidate and evidence invariants.

## 11. Readiness

The save action is enabled only when:

- the complete composed document is valid;
- at least one usable Model remains;
- the Default Model is an exact currently valid Model;
- there is no pending candidate;
- every new or modified capability requiring verification has matching
  successful evidence;
- all candidate lifecycle cleanup completed;
- Registry identities and dependencies are valid; and
- the original Edit-mode configuration has not changed concurrently.

Discovered but untouched Extensions do not block Save. The menu displays the
first blocker as the disabled save action hint. The same readiness predicate
guards the selected action.

## 12. Publication

Initialization has two explicit phases:

1. **Wizard and candidate validation:** perform the complete Provider/Model
   collection loops, read-only target conflict preflight, selected Extension
   acquisition and staging, live verification, exact-once candidate cleanup,
   Default Model selection, final confirmation, and serialized candidate
   validation without changing Agent Home files.
2. **Publication:** create missing Root Context, install compatible fixed
   Profile assets in Initialize mode, and publish `config.json` last.

`config.json` is the final publication boundary. Publication starts only after
all retained Model readiness checks, every candidate cleanup, combined
Registry conflict validation, complete configuration validation, and final
confirmation succeed. There is no initialization marker or version.

Publication rechecks fixed Profile conflicts before its first write and at
each create-if-missing operation so a concurrent conflicting write aborts
rather than being accepted. If any Publication operation fails, `config.json`
is not written. Already created Context/Profile files are not deleted because
they may have been observed or concurrently changed.

Initialize mode exclusively creates `config.json`. Edit mode records the
original file bytes, re-reads them immediately before publication, and aborts
if they changed. It writes the validated replacement to an exclusive
same-directory temporary file and atomically replaces `config.json`; failure
cleans the temporary file and preserves the prior configuration whenever the
filesystem replacement did not complete.

Success means ordinary standalone startup can load the resulting Agent Home
under the same declared credential environment. Initialization then exits.

## 13. Ordinary startup

Ordinary standalone startup no longer calls missing-document bootstrap. A
missing config fails before Runtime creation with bounded guidance to run:

```text
my-agent --initialize --agent-home <path>
```

Existing strict configuration loading remains unchanged. The Platform
Configuration bootstrap API may remain for other explicit callers; this Change
only stops ordinary Standalone Host use of it.

## 14. Failure behavior

- cancellation never reports success;
- cancellation and pre-Publication failure leave Agent Home unchanged;
- invalid input stays in the bounded prompt step;
- an individual Model readiness failure discards that Model and returns to the
  bounded Provider loop;
- Provider lifecycle, combined validation, filesystem, or concurrent-write
  failure aborts the affected candidate or Publication as specified;
- failure does not create or replace `config.json`;
- Publication failure may leave only compatible create-if-missing
  Context/Profile files;
- secrets and raw response bodies do not appear in errors;
- no fallback Provider, Model, directory, or default config is selected.

## 15. Compatibility

Existing Agent Homes can be edited in place after explicit confirmation.
There is no migration, version, Feature Flag, automatic repair, or destructive
reset path.

ADR-011's ordinary Standalone empty-config bootstrap is superseded. Its
Platform Configuration ownership and strict loading decisions remain.

## 16. Acceptance

- initialization routes without constructing `RuntimeApp`;
- non-TTY and invalid combinations fail before mutation;
- existing config requires explicit edit confirmation and remains unchanged
  when declined, cancelled, invalid, or concurrently modified;
- untouched supported sections and entries survive Edit-mode publication;
- only accepted modified sections or Extension IDs are replaced;
- Built-in and Extension capability evidence is bound to the current
  normalized candidate configuration;
- pending or stale verification disables Save;
- cancellation, validation failure, readiness failure, and candidate cleanup
  failure create no Agent Home files;
- Publication begins only after confirmation, candidate validation, readiness,
  and candidate cleanup succeed;
- Publication failure does not publish config and may preserve only compatible
  create-if-missing Context/Profile files;
- Root and fixed named Agent files are created without overwrite;
- generated configuration uses the accepted global `agents` execution-policy
  fields and contains no `runner` namespace or Role-level call limit;
- all installed Extension Descriptors are shown and supported Schema
  configuration is available regardless of capability declaration;
- a declared Provider capability cannot be retained without its required live
  verification, while an Extension with no declared policy is clearly labeled
  as having no live verification;
- unsupported Extension Schema shapes fail before entry import;
- only the Provider Extensions explicitly selected in the current candidate
  loop are acquired and created;
- a static Provider claim without actual Provider registration is rejected;
- an Extension registering zero or multiple Providers cannot produce a
  successful candidate;
- every retained Model completed its own real tool-free inference;
- only Provider configurations with at least one verified Model are authored;
- the Default Model is selected only from verified Models, and an entered
  alternative is verified before selection;
- replacing Provider configuration invalidates and reverifies its prior Model
  successes;
- the combined retained Registry candidate has no contribution identity
  conflict;
- authored Extension config omits accepted Schema defaults and default
  enablement fields;
- selected Provider/Model configuration is explicit and valid;
- accepted readiness verification passes before publication;
- ordinary startup gives initialization guidance for missing config;
- initialization followed by ordinary startup succeeds;
- no non-Standalone production module changes;
- package, Unit, integration, lint, build, link, diff, manual terminal, and
  independent review checks pass as affected.

## 17. Open questions

No product-behavior question remains open. Delivery remains gated on evidence
that implementation tests preserve the verified public-API path without
modifying non-Standalone production modules.
