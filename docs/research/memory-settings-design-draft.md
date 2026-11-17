# Memory Settings and Embedding Download Diagnostics Design Draft

> Status: Non-authoritative design draft
> Date: 2026-11-16
> Discussion update: Owner agreed to the diagnostic log presentation in section 3.1 on 2026-11-16; this is not acceptance of a Change or implementation authorization.
> Discussion update: Owner chose no migration or compatibility implementation, permits scoped index cleanup when needed, and excludes additional log-redaction work.
> Follow-up: Owner authorized the [Accepted Change Plan](../changes/archive/memory-settings/plan.md) and implementation after design review on 2026-11-16. The [validated Specification](../changes/archive/memory-settings/specification.md) and Plan record delivery checks, successful owner manual acceptance and separately authorized archive/scoped commit on 2026-11-17. This document remains non-authoritative discussion provenance.
> Scope: Local embedding download diagnostics, HF_ENDPOINT support, and global Memory enablement in Settings.
> Authorization: Discussion only; not a Change, implementation authorization, or Spike authorization.
> This draft does not override Current Architecture, accepted Decisions, or stable Specifications. Any subsequent delivery follows the [Development Workflow](../governance/development-workflow.md).

## 1. Purpose and scope

Make local Memory startup failures actionable, support a compatible Hugging Face
download endpoint, and expose only `agents.memory.enabled` in Settings.
This draft proposes bounded additions to existing Memory and Settings behavior,
plus a correction to the configuration model that currently represents a global
Runtime resource as an Agent capability. It does not introduce per-Subagent
Memory instances or a new Memory architecture.

Non-goals: model or Provider selection, chunking/search editors, dynamic Memory
start/stop, automatic retries or mirror switching, a download manager, a new
Settings framework, and changes to existing fallback behavior.

## 2. Current evidence

- [LocalEmbeddingProvider](../../src/core/memory/internal/LocalEmbeddingProvider.ts)
  logs model loading start/success but has no corresponding failure diagnostic.
  Known models load lazily; unknown models also load during dimension detection.
- The installed Transformers.js uses `env.remoteHost` and does not automatically
  consume `HF_ENDPOINT`. Its HTTP status errors can contain the file URL, but a
  rejected network fetch can propagate a generic message such as `fetch failed`.
- [Runtime bootstrap](../../src/runtime/composition/bootstrap.ts) logs
  `memory init failed, continuing without memory` with `error.message`, and emits
  `MEMORY_INIT_FAILED`. This identifies Memory initialization failure, not its
  download stage, network cause, or remedy.
- [Runtime construction](../../src/runtime/composition/runtime-builder.ts)
  skips Memory creation when the resolved enabled flag is false.
- Runtime creates one `MemoryManager` for the fixed Root Agent and conditionally
  registers one shared Memory Tool contribution. Entries in `agents.list` are
  Subagent profiles; they are not selectable Root-Agent types and do not own
  separate Memory managers, stores, indexes or lifecycles.
- The current configuration model contradicts that topology:
  [types.ts](../../src/platform/config/types.ts) places `memory` in
  `AgentDefaults`, `AgentEntry` inherits `DeepPartial<AgentDefaults>`, and
  [loader.ts](../../src/platform/config/loader.ts) consequently merges Memory
  through named-Agent, environment and CLI Agent overrides. Bootstrap then reads
  `resolvedConfig.memory`, allowing an Agent-resolution path to decide whether
  the one global manager exists without creating Agent-scoped Memory.
- Existing `agents:defaults` Settings edits Tool permissions only. It must not be
  silently repurposed as an editor for all Agent defaults.

These are source observations, not a reproduction of the owner's actual failure.
Controlled failure reproduction is needed to validate the proposed diagnosis.

## 3. Proposed behavior

### 3.1 Actionable loading and download diagnostics

Preserve the startup warning and existing failure propagation/fallback paths.
Add diagnostics at the shared local model-loading boundary, covering both normal
embedding initialization and unknown-model dimension detection.

An actionable failure record must identify:

- model identity and the operation that failed;
- effective download endpoint and, when reliably available, the failing file URL;
- original error message and available nested cause/code or HTTP status;
- a relevant next action.

Do not label every pipeline failure as a download failure. Distinguish an observed
network/HTTP download failure from local model loading or initialization failure.
If the library does not expose the stage or failing file, report that limitation
honestly rather than inventing a URL or diagnosis. An endpoint is not a file URL.

For connectivity failures, guidance should explain checking network access and
setting `HF_ENDPOINT` to a trusted Hugging Face-compatible mirror, then restarting.
HTTP authorization/not-found failures and local initialization failures need
appropriate guidance instead of an unconditional mirror recommendation.

Use the existing Logger and normal error information; do not introduce a URL or
error-text redaction subsystem, cross-layer sanitization, or related test matrix.
Do not add credential/header dumps. Do not log every download chunk or manufacture
progress events. Preserve the original error for callers rather than replacing
it with a generic message.

#### Library observability limits

The installed Transformers.js accepts `progress_callback` on `pipeline()`.
File events include `initiate`, `download`, `progress` and `done`; `ready` indicates
pipeline readiness. There is no dedicated failure event; failures reject the
loading Promise.

These events do not expose request URLs, HTTP status or cache-hit flags.
`download` also occurs for cached/local reads, and a network connection can fail
before that event. Files load concurrently, so the last reported file is not
necessarily the failed file. Do not infer a failed file from event order or
incomplete progress; no independent download-task query API was found in the
inspected loading interface.

Use the callback for file-retrieval context, not as proof of network activity.
Catch loading failures at the shared boundary and retain available original
error/cause information. Include an actual file URL only when exposed by
the failure. Do not add a downloader or intercept global `fetch` to manufacture
missing observability.

#### Agreed log presentation

Use a concise English message and structured context through the existing
Logger. The examples below illustrate fields, not a new multiline log renderer.
Only include `cause`, `code`, HTTP status and `url` when actually available.

Loading begins:

```text
INFO  Loading local embedding model; missing files may be downloaded.
      model=Xenova/all-MiniLM-L6-v2
      endpoint=https://huggingface.co/
```

An identified network request failure, without a reliable failing-file URL:

```text
ERROR Embedding model loading failed: network request failed.
      model=Xenova/all-MiniLM-L6-v2
      endpoint=https://huggingface.co/
      error=fetch failed
      cause=connect timeout
      code=UND_ERR_CONNECT_TIMEOUT
      hint=Check network access. If the source is unreachable, set HF_ENDPOINT to a trusted Hugging Face-compatible mirror and restart.
```

An HTTP failure with an actual file URL:

```text
ERROR Embedding model file request failed.
      model=Xenova/all-MiniLM-L6-v2
      url=https://example.com/Xenova/all-MiniLM-L6-v2/resolve/main/config.json
      error=403 Forbidden
      hint=Check repository access and download endpoint configuration.
```

A confirmed local initialization failure uses
`Local embedding model initialization failed.` with the model and original error.
If the failure stage cannot be established, use
`Embedding model loading failed.` instead; do not guess the stage or cause.

Success uses `Local embedding model loaded.` with the model identity only after
the pipeline is successfully created, not when an individual file finishes.
Do not log every percentage update or describe a cached read as a download.

Retain the existing startup warning to explain the application-level consequence
when startup continues without Memory. Do not emit that consequence from the
provider itself: the caller still owns the actual fallback decision.

### 3.2 `HF_ENDPOINT`

- Treat it as process-level local embedding download configuration, not a new
  `config.json` field or a Settings-editable environment variable.
- If absent, preserve the current library download host and cache behavior.
- If present, require a nonblank HTTP(S) base URL without credentials, query, or
  fragment. Normalize the trailing slash before applying `env.remoteHost`.
  Invalid values produce an explicit configuration diagnostic, not silent fallback.
- Apply it before model loading, consistently for known models and dimension
  detection. Document restart as the supported way to change the environment.
- Keep the library's existing model/revision path template and cache behavior.
  A mirror must serve the Hugging Face-compatible repository layout; this does
  not imply arbitrary ModelScope URL support.
- Reuse a single loading/configuration path. Do not patch dependencies, replace
  global `fetch`, or introduce another downloader to implement this setting.

### 3.3 Settings: global Memory enablement

Place Memory alongside the existing Agent global controls in
`Settings -> Agents -> Global settings`; do not create a top-level Memory page or
put the switch inside the Tool-permission editor.

Propose one independent `agents:memory` section, editing only:

```json
{ "enabled": false }
```

The persisted destination is `agents.memory.enabled`. Use the
Memory-owned default when the field is omitted; do not duplicate that default in
the client. Saving requires an explicit boolean and must preserve other Memory
fields, Agent defaults, named Subagent overrides, and unrelated document content.
No per-Subagent Memory switch or editor is introduced.

The document shape is therefore:

```json
{
  "agents": {
    "memory": { "enabled": false },
    "defaults": {},
    "list": []
  }
}
```

Only `agents.memory.enabled` is editable in this Settings scope; the example does
not require writing empty `defaults` or `list` values.

Reuse Settings revisions, serialized persistence, safe errors and independent
drafts. Memory save does not publish a dynamic Agent policy or start/stop Memory.
Compare saved global enablement against the startup `agents.memory.enabled`
baseline for restart status; saving back to the startup value clears this
section's restart marker. There is no selected-Agent effective Memory value.

Suggested UI copy:

> Memory uses a local embedding model. When required files are not cached, it
> downloads them from Hugging Face on first use. If the source is unreachable,
> set HF_ENDPOINT to a trusted Hugging Face-compatible mirror and restart.

Show an explicit "Saved changes require a service restart" notice. Saving or
viewing Settings must not trigger a model download. Keep the existing running
Memory instance and Tool availability unchanged until restart.

#### UI consistency

The owner requires consistency with existing Settings components. Reuse the
current Agent global-settings navigation, section layout, enablement control,
help-text styling, Save/Reload controls and feedback. Use the existing unsaved,
restart-required, busy, error and revision-conflict presentation rather than
introducing Memory-specific visual variants or a separate save flow.

Keep the download and `HF_ENDPOINT` guidance as ordinary inline help. No new
dialog, custom switch, download-progress panel or standalone Memory page is
needed for this scope.

#### Confirmed rationale for restart-required saves

The owner confirmed retaining restart-required behavior on 2026-11-16:

- Enabling Memory can require loading or downloading the embedding model and
  indexing memory files, which may take substantial time. Preserve the existing
  startup scan and incremental indexing; this does not mean a full index rebuild
  on every startup or enablement.
- Enablement also determines whether Memory Tools are registered. Runtime
  switching would require coordinating Tool availability, potentially slow
  initialization, failures and in-flight Turns. Avoid introducing that lifecycle
  complexity merely to expose the existing boolean in Settings.

Saving changes only the persisted flag and restart status; it does not download
models, index files, or register/unregister Tools. After restart, use the existing
startup initialization and conditional Tool-registration flow. Dynamic enablement,
first-Tool-call initialization and resource hot-unloading remain out of scope.

#### Runtime and Subagent semantics

There is one fixed Root Agent and zero or more task-oriented Subagents. Global
Memory enablement determines whether Runtime constructs its single
`MemoryManager` and registers the shared Memory Tools. It does not select a Root
Agent type and is not inherited or overridden by a Subagent profile.

When Memory is disabled globally, no Memory Tools are registered for either Root
or Child Turns. This draft introduces no special per-Subagent Memory access
setting. Existing ordinary Tool policy remains unchanged: if it affects Memory
Tool visibility, that is access control rather than Memory enablement. Tool
policy projection removes denied definitions before an LLM request, and the
prompt builder adds Memory Recall guidance only when the projected Memory Tools
are visible. Execution-time denial remains a safety fallback; the design does
not depend on repeatedly presenting unusable tools to the model.

### 3.4 Required correction to existing code

Delivery must correct the existing global-versus-Agent ambiguity together with
the Settings work. Merely changing the UI persistence path would leave the
Runtime contract inconsistent.

1. **Configuration types and defaults:** move `memory: MemoryConfig` from
   `AgentDefaults` to `AgentsConfig`, and add `memory?: DeepPartial<MemoryConfig>`
   under the document-level `agents` object. `AgentEntry` must no longer acquire
   Memory fields through `DeepPartial<AgentDefaults>`. Compose the Memory-owned
   defaults once at `agents.memory`, separately from Subagent defaults.
2. **Validation and projection:** validate and project `agents.memory` as the one
   global Memory configuration. Remove Memory from Agent-leaf projection and
   validation, so `agents.defaults.memory` and `agents.list[].memory` cannot be
   interpreted as Agent capabilities. Do not add special old-field rejection
   or migration checks; retain ordinary unsupported-field projection.
3. **Resolution and overrides:** remove Memory from `resolveAgentConfig()` and its
   named-Agent merge. Existing environment/CLI override objects typed as
   `DeepPartial<AgentDefaults>` must no longer carry Memory. If a non-file startup
   override remains necessary, model it as an explicitly global Memory override,
   not as an Agent override.
4. **Bootstrap and registration:** construct the singleton manager from
   `appConfig.agents.memory`, not `resolvedConfig.memory`. Continue registering
   the Memory Tool contribution exactly once when manager creation succeeds, and
   omit it when global Memory is disabled or initialization falls back.
5. **Settings ownership:** add the independent `agents:memory` section and a
   narrow editor that changes only `agents.memory.enabled`. Do not route this
   restart-required edit through the dynamically applied Agent/Subagent policy
   state. Its application status compares the saved value with the immutable
   startup global baseline.
6. **Tests and fixtures:** update configuration loader/resolver, Bootstrap,
   Runtime construction, Settings persistence/restart status and client tests.
   Add explicit coverage proving that named Subagents cannot override Memory,
   the Root startup path is independent of `agentId`, and disabled global Memory
   does not register or advertise Memory Tools.

## 4. Ownership and compatibility

Core Memory owns model loading, endpoint adaptation and detailed diagnostics.
Platform Configuration owns the narrow document edit and validation; Runtime
Settings owns revisions, persistence and startup-baseline restart reporting.
The WebSocket client consumes that section and owns its switch/help presentation.
Retain the boundaries in [ADR-024](../decisions/adr-024-settings-contract-and-model-test-ownership.md)
and the [Settings contract](../specifications/channel.md).

No dependency-direction change or new generic framework is proposed. However,
moving Memory from `agents.defaults` to `agents` changes the configuration and
Runtime ownership contract, so it must be reflected in the subsequent accepted
Decision/Specification rather than treated as a UI-only edit.

The owner chose a direct cutover, with no automatic migration, compatibility
reader, dual-path merge or startup write-back. Update affected maintained
configuration examples, fixtures and call sites directly to `agents.memory`.
Do not add old-field detection, rejection helpers, migration guidance or
old/new-path conflict handling. Implement only the new configuration shape.
`agents.list[].memory` must not become an alternative global setting.

If affected Agent Homes need their indexes reset, remove only their explicitly
identified, regenerable Memory index files and let the existing startup indexing
recreate them. Do not add a generic cleanup/migration facility. Do not delete
`MEMORY.md`, source files under `memory/`, configuration, recall history or model
caches as part of index cleanup. The global configuration move itself does not
change the index format or require a cache relocation.

This draft does not execute or authorize an unspecified file deletion. Identify
the affected Agent Homes and exact derived files before any implementation-time
cleanup.

## 5. Suggested validation

1. Reproduce controlled network and HTTP failures without external model
   downloads. Capture what the real library and current application expose.
   Verify how to identify stages/file URLs using supported library APIs; if this
   cannot meet the diagnostic requirement without invasive hooks, stop and
   revise the affected design before implementation.
2. Verify absent/valid/invalid `HF_ENDPOINT`, normalization, both loading paths,
   unchanged caching, concurrent lazy-load reuse, and original-error propagation.
3. Verify that network failure logs identify the model, download context and
   underlying cause, with actionable guidance. Verify local initialization
   failures are not mislabeled. No additional redaction subsystem is in scope.
4. Verify Settings load/save, boolean validation, revision conflicts, omitted
   global defaults, field preservation, restart-marker reversal, independent
   drafts and no download or live Memory lifecycle changes on save. Verify the
   new global configuration behavior without adding legacy-field checks.
   If index cleanup is needed, verify it is limited to the identified derived
   files and that startup recreates the index from retained Memory sources.
5. Run focused provider/config/Settings/client tests and relevant WebSocket
   integration, lint and build checks. Validate the switch/help/restart UX in the
   browser. Do not overlap builds with tests consuming mutable build outputs.
6. If delivery is subsequently authorized, update directly owning current
   documentation and the configuration guide after verification. Delivery state
   and validation results belong to the subsequent Change, not this draft.

## 6. Open questions and next steps

- Callback capability and limits are recorded in section 3.1. Controlled failures
  still need to verify the actual error/cause shapes and how much stage/file-URL
  evidence survives each path. Do not promise exact failing-file URLs for all
  errors or hide missing evidence behind an invented diagnosis.
- No migration or compatibility implementation is planned. Any needed index
  cleanup still requires identification of the affected Homes and derived files.
- The proposed section ID, new global configuration path,
  validation rules and restart-state projection remain discussion proposals, not
  accepted public contracts.
- Review the design direction first. Only with separate owner authorization
  should this discussion become a Change with the appropriate Plan/Specification
  and, if necessary, Spike artifacts.

No Change creation, production changes, paid model calls, commit, push or delivery
acceptance are authorized by this draft.
