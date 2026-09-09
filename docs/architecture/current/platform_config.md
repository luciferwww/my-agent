# Platform Config Current Architecture

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: configuration sources, precedence, schema, defaults, and Config Wizard
> Ownership key: configuration-and-wizard

## 1. Boundary

`src/platform/config/` owns configuration shape, hardcoded defaults, file loading, merge precedence, environment extraction, and the interactive Config Wizard. Runtime is the production caller of `loadConfig()` and `resolveAgentConfig()` and maps the result into narrow module inputs.

Config may carry a default Model Reference and Provider deployment-facts input. It does not establish canonical model identity, effective limits, or Model Facts; those are validated and owned by [Model Resolution](./core_model_resolution.md) under ADR-004.

## 2. Runtime configuration file

`loadConfig({ workspaceDir })` reads `<workspaceDir>/.agent/config.json`. The file is partial and may contain:

```text
ConfigFile
├── agents.defaults?: DeepPartial<AgentDefaults>
├── agents.list?: AgentEntry[]
└── logger?: LoggerModuleConfig
```

A missing, unreadable, malformed, non-object file degrades to defaults. This permissive read is not JSON Schema validation.

## 3. Five-stage precedence

Lowest to highest precedence:

| Stage | Source | Owner/API |
|---:|---|---|
| 1 | `DEFAULT_AGENT_CONFIG` / `DEFAULT_LOGGER_CONFIG` | `loadConfig()` |
| 2 | file `agents.defaults` and `logger` | `loadConfig()` |
| 3 | matching `agents.list[]` entry | `resolveAgentConfig()` |
| 4 | environment overrides | `resolveAgentConfig()` |
| 5 | caller/CLI overrides | `resolveAgentConfig()` |

`deepMerge()` recursively merges plain objects, ignores `undefined`, and replaces arrays/scalars rather than appending them. `getEnvOverrides()` maps `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `MY_AGENT_MODEL` into the LLM configuration branch.

## 4. Current schema and defaults

| Section | Current fields and defaults |
|---|---|
| `llm` | API key/base URL/model optional; `maxTokens=4096`; legacy fallback `contextWindowTokens=200000`; optional Provider-owned `deploymentFacts[]` input |
| `runner` | `maxLlmCalls=12`; `inTurnMessageMode='followup'` |
| `memory` | enabled; local `Xenova/all-MiniLM-L6-v2`; chunk `1600/320`; search `6`, `0.25`, weights `0.7/0.3` |
| `prompt` | `safetyLevel='normal'` |
| `tools` | optional `fs.workspaceOnly=true`; `allow=[]`; `deny=[]` |
| `workspace` | `maxFileChars=20000`; `maxTotalChars=150000` |
| `compaction` | enabled; reserve `20000`; keep 3 turns; result share `0.5`; head/tail `10000/5000`; timeout 300 seconds |
| `subagents` | enabled; `maxDepth=1`; empty profile list |
| `logger` | global `info`; console enabled; file disabled |

Removed configuration concepts are not Current fields: Memory DB path, embedding dimensions, Session directory, Workspace agent directory, Tool implementation limits, nested `tools.approval`, and Logger file path/prefix/queue size are fixed or owned by their implementation boundaries.

### 4.1 Tool policy

`tools.deny` removes matching Tool definitions from the visible projection. `tools.allow` bypasses current-call approval. An unmatched Tool requests approval when an origin interaction capability exists and fails closed otherwise. Exact names and `*`/`?` globs are supported; `group:*` expansion is not.

### 4.2 Subagent policy

`subagents.list[]` carries profile identity, description, Model selection, optional LLM-call limit, and narrow Tool policy. An explicit Child allow-list replaces the Parent allow-list; an explicit Child deny-list adds to the Parent deny-list. Runtime owns delegation and generation inheritance.

## 5. Core APIs

```text
loadConfig({ workspaceDir }): AppConfig
resolveAgentConfig(appConfig, { agentId?, envOverrides?, cliOverrides? }): AgentDefaults
getEnvOverrides(): DeepPartial<AgentDefaults>
deepMerge(target, source): merged copy
```

`loadConfig()` returns `workspaceDir`, merged `agents.defaults`, unmodified `agents.list`, and merged Logger configuration. `resolveAgentConfig()` excludes `id/default` metadata from the selected per-agent entry before applying environment and caller overrides.

<a id="config-wizard"></a>

## 6. Config Wizard

The Wizard implementation is `src/platform/config/wizard/`; `scripts/config.ts` is a thin error/exit-code shell.

```text
npx tsx scripts/config.ts [--path <file>|--path=<file>] [--help|-h]
```

- Default output is `<cwd>/config.json`; use `--path <workspace>/.agent/config.json` to target the Runtime configuration file.
- `--help`/`-h` prints usage and returns normally. Unknown arguments, missing `--path` values, and empty `--path=` values throw `WizardArgError` with exit code 2; other runtime failures remain ordinary errors for the shell to report.
- Existing JSON is loaded as prompt defaults. A missing file starts empty; invalid/non-object JSON is reported and treated as empty.
- Core questions cover LLM connection/limits, Memory enablement, global Logger level, and File Logger enablement. Optional advanced groups cover Runner, Memory provider/model/chunk/search, Prompt safety, filesystem policy, Workspace limits, Compaction, and Console/File Logger levels. Conditions skip Memory, Compaction, or File Logger details when their controlling feature is disabled.
- Enter preserves the displayed value. `--` clears a currently set optional field. Parser or validator failure prints an error and retries the same question.
- Removed implementation-owned fields—embedding dimensions and File Logger directory/prefix/queue size—are not prompted or written.
- `buildNextConfig()` schema-filters existing `agents.defaults` and `logger`, records discarded leaf paths, overlays collected values, removes values equal to `DEFAULT_*`, and removes empty objects.
- Existing top-level content, including `agents.list`, is preserved unless the governed branch is rewritten.
- The dry-run reports schema-discarded paths and prints the complete prospective JSON before asking to save. Cancellation writes nothing.
- Saving an existing file first attempts `<path>.bak`; backup failure is reported but does not block the main write.
- `runWizard()` never calls `process.exit`; argument errors use `WizardArgError`, and the shell selects the exit code.
- The Wizard does not read environment variables, call Runtime loaders, or prove final Runtime assembly.

## 7. Evidence

| Kind | Evidence |
|---|---|
| Source | [types.ts](../../../src/platform/config/types.ts), [defaults.ts](../../../src/platform/config/defaults.ts), [loader.ts](../../../src/platform/config/loader.ts), [wizard/run-wizard.ts](../../../src/platform/config/wizard/run-wizard.ts), [wizard/diff.ts](../../../src/platform/config/wizard/diff.ts), [scripts/config.ts](../../../scripts/config.ts) |
| Tests | [loader.test.ts](../../../src/platform/config/loader.test.ts), [wizard/fields.test.ts](../../../src/platform/config/wizard/fields.test.ts), [wizard/diff.test.ts](../../../src/platform/config/wizard/diff.test.ts) |
| Controlling authority | [ADR-004](../adr-004-provider-model-identity-and-facts-ownership.md), [Model Resolution Module Spec](../model-resolution-module-spec.md), [Platform Config Restructure Spec](../platform-config-restructure-spec.md) |
