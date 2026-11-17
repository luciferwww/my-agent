# Global Memory Settings and Embedding Download Diagnostics Specification

> Status: Validated
> Date: 2026-11-16
> Owner: Project owner
> Related Plan: [Accepted Plan](plan.md)
> Existing Decision: [ADR-024](../../../decisions/adr-024-settings-contract-and-model-test-ownership.md)
> Authorization: Owner authorized implementation after design review on 2026-11-16 at 16:23. Delivery checks passed; owner completed manual testing with no issues, accepted delivery and separately authorized archive and a scoped commit on 2026-11-17. Push and merge remain unauthorized.

## Purpose and observable outcome

Users can configure global Memory enablement from existing Settings and
understand local embedding loading failures well enough to take a relevant next
step. `HF_ENDPOINT` can redirect model-file retrieval to a compatible mirror.
Saving Memory settings never initiates model loading or changes running Tools.

## Scope

- Move the complete Memory configuration to `agents.memory`.
- Add one independently saved enablement section in Agent global Settings.
- Apply HF_ENDPOINT consistently to both local embedding loading paths.
- Log loading start/success and actionable failure details through the existing
  Logger, within the SDK's actual observability limits.

## Non-goals

No migration tooling, legacy read compatibility, dynamic enablement,
first-Tool-call manager initialization, per-Subagent Memory instances, model or
advanced parameter editors, automatic retries/mirror switching, new downloader,
generic Settings framework or additional log-redaction subsystem.
Do not change index format, storage location, cache location, ordinary Tool
policy or current error-propagation/fallback behavior.

## Boundaries and dependency direction

- Core Memory owns leaf contracts/defaults/validation, embedding endpoint
  adaptation, model loading and diagnostics.
- Platform Configuration composes global Memory, validates document fields and
  owns narrow section edits/file publication. Core Memory does not import it.
- Runtime Bootstrap owns startup manager creation; Runtime keeps its existing
  manager cleanup ownership and conditional Memory Tool registration.
- Runtime Settings owns views, revisions, serialization and saved-versus-startup
  status. This edit does not publish through dynamic AgentPolicyState.
- The client consumes Settings views and reuses existing presentation. It does
  not read files, infer running health or copy Memory default literals.

Preserve [ADR-024](../../../decisions/adr-024-settings-contract-and-model-test-ownership.md)
and the existing transport-neutral Settings capability.

## Public and structural contracts

### Global configuration

Resolved AgentsConfig contains one complete `memory: MemoryConfig`.
The document accepts optional `agents.memory` with the Memory leaf's existing
partial nested shape. All existing enabled/embedding/chunking/search defaults
remain Memory-owned and are composed once into the global configuration.
Validate the merged leaf as well as supplied values, retaining cross-field
constraints such as overlap smaller than chunk size.

Remove Memory from AgentDefaults, AgentEntry, Agent capability projection and
Agent-scoped environment/caller override types. Global Memory resolution is
`module defaults -> agents.memory`; agentId and named-Agent resolution cannot
change it. Programmatic startup configuration uses the existing Application
projection's `agents.memory`, without another override API.

Do not add legacy-field detection, rejection helpers, migration messages or
old/new-path conflict handling. Keep existing unsupported-field projection
behavior; implement and validate the new global configuration only.

### Settings section

Use the existing `load` and `update` actions; add no transport action.
One section has ID `agents:memory`, display name `Memory`, its own revision,
`settings: { enabled: boolean }`, restartRequired and applicationStatus.
The view reports resolved saved enablement, using the Memory default if omitted,
without materializing defaults merely on inspection.

Load returns this section together with the other Settings sections. As today,
Reload Settings reads the server's saved-document view, not an arbitrary external
file reread or configuration hot reload.

Update accepts only `{ enabled: boolean }` plus the existing section/revision
envelope, without credentials. It modifies only `agents.memory.enabled`,
preserving all other Memory fields, Agent defaults/list entries and unrelated
document content. No empty defaults/list objects need to be written.
The logical save boundary is this section, although file publication atomically
replaces the full merged document under the existing persistence contract.

Use current when resolved saved enabled equals the immutable resolved startup
enabled baseline; otherwise report restart_required and restartRequired=true.
Saving back to the baseline clears this section's restart marker. A startup
initialization failure does not alter that baseline or make the saved switch a
health indicator.

### Download endpoint

`HF_ENDPOINT` is process-level download configuration, not a document field or a
UI-editable environment variable. Absent means retain the library default host.
If present, require a nonblank HTTP(S) base URL without userinfo, query or fragment,
normalize its trailing slash and apply env.remoteHost before loading.
Invalid input produces an explicit diagnostic, not silent default-host fallback.

Keep the library's model/revision path template and cache behavior. Endpoints
must serve the Hugging Face-compatible layout; arbitrary ModelScope download
URLs are not promised. Environment changes require restart.
Use one shared loading/configuration path for normal lazy initialization and
unknown-model dimension detection.

## Behavior and invariants

### Enablement

Bootstrap reads `appConfig.agents.memory`, not Agent-resolved Memory.
When enabled, preserve current manager initialization and startup incremental
indexing; unchanged files are not automatically fully re-embedded.
Register the shared Memory Tool contribution once when manager creation succeeds.
When disabled or startup yields no manager, register no Memory Tools.

Root and Child share the manager; no Subagent Memory override is introduced.
Ordinary Tool policies can still hide/deny Memory Tools. Prompt construction
uses projected Tool names and existing prompt-mode rules, not a separate Memory
access switch. Do not change Root capability resolution for unrelated fields.

### Diagnostics

Messages are English and structured context uses the existing Logger:

| Situation | Message and context |
|---|---|
| Loading begins | `Loading local embedding model; missing files may be downloaded.` with model and effective endpoint |
| Success | `Local embedding model loaded.` with model, only after successful pipeline creation |
| Identified network failure | `Embedding model loading failed: network request failed.` with model, endpoint, original error and available cause/code |
| Identified HTTP file failure | `Embedding model file request failed.` with actual URL/status when exposed |
| Confirmed local initialization failure | `Local embedding model initialization failed.` with model and original error |
| Unknown failure stage | `Embedding model loading failed.` with available evidence, without guessing the stage |

Use info for start/success and error for loading failures. Do not populate
unavailable fields with invented values. HTTP status or URL may remain in the
original message when no structured field is available.

For connectivity failures, advise checking network access and, if the source is
unreachable, setting HF_ENDPOINT to a trusted compatible mirror and restarting.
Authorization/not-found and local initialization errors need relevant guidance,
not an unconditional mirror recommendation.

Transformers.js progress_callback provides initiate/download/progress/done file
events and pipeline ready, but no dedicated failure event, request URL or cache
flag. Cached/local reads can emit download; connection failure may precede it.
Files load concurrently. Do not attribute failure to the last event or treat
file progress as proof of network activity. Do not log every percentage.

Catch at the shared loading boundary, log available evidence, then preserve the
original error for the existing caller. Keep the startup Memory warning and its
application-level consequence; the provider does not decide the fallback.
No global fetch interception, dependency patch or alternative downloader.

### UI

Place Memory in `Settings -> Agents -> Global settings`, not inside the
Tool-permission editor or a standalone Memory page.
Reuse current section layout, enablement control, help text, Save/Reload,
unsaved/restart/busy/error/conflict presentation and independent drafts.

Inline help explains that local embedding files download when missing, and
HF_ENDPOINT can select a compatible mirror if the source is unreachable.
Show `Saved changes require a service restart.`
Do not add a custom switch, download panel, extra dialog or new visual variants.

## Lifecycle and resource ownership

Viewing/saving Settings does not create/close Memory, index files, download
models, or register/unregister Tools. Existing Turns and Tool availability remain
unchanged until restart.

Restart-only behavior intentionally avoids coordinating potentially slow model
loading/indexing with live Tool-set changes and in-flight work.
Keep existing startup indexing, model lazy-loading/promise reuse, manager
ownership and shutdown order; do not add a second lifecycle path.

## Failure, Abort, deadline, and concurrency semantics

Reuse revision-conflict handling, serialized updates, pre-commit shutdown checks,
atomic file publication and explicit persistence failures.
Loads wait for pending saves under the current Settings contract.
Unsuccessful saves do not claim new persisted state or alter Runtime Memory.
Independent Agent saves must not apply pending-restart Memory configuration.

This section does not perform Runtime application and needs no LLM-style
application rollback. It reports saved configuration plus restart status.
Do not add new download deadlines, retry loops or unsupported cancellation
claims. Preserve current concurrent pipeline initialization behavior.

## Security and capabilities

Retain existing local Settings access and Tool approval/deny policies.
Do not log credential/header dumps or add environment-editing capabilities.
No new URL/error-text redaction framework or cross-layer sanitization project
is part of this Change.

## Compatibility and migration

Direct cutover only: no conversion tool, compatibility reader, dual-path merge
or startup write-back. Update maintained callers, fixtures and examples directly.
No retired-field detection or special validation is introduced.
Existing non-Memory configuration retains its behavior.

The index format and locations do not change; index reset is not mandatory.
If a specific affected Home needs a reset, identify its exact derived index
files and ensure it is not actively using them before cleanup.
Delete neither configuration nor Memory source files, recall history or model
caches. Do not recursively remove Homes or add a generic cleanup facility.
No deletion is authorized merely by accepting or preparing these documents.

## Acceptance and validation

| Area | Required evidence |
|---|---|
| SDK check | Controlled network/HTTP failures using supported APIs establish actual error/cause/URL shapes; no external model download |
| Global config | Default/partial merge and complete validation; global Memory is resolved independently of Agent capabilities |
| Startup | Application-injected and file-loaded global config use the same path; disabled skips Memory Tools; enabled retains startup incremental indexing |
| Endpoint | Absent/valid/invalid endpoint, trailing slash and both loading paths; cache behavior and concurrent promise reuse preserved |
| Logs | Actionable network/HTTP details, honest unknown/local classification, no invented failed URL, original-error propagation and unchanged fallback |
| Settings | Unified load; independent save/revision conflict; preserve sibling fields/drafts; omitted defaults and baseline reversal; no Runtime side effects |
| UI | Reused controls/styles, help/restart status, save/error/reload behavior at desktop/narrow widths |

Add focused regressions in existing suites where possible. Run relevant real
WebSocket integration, lint, Host/client builds and existing asset verification.
Run applicable existing boundary/Fitness checks when affected; do not add
incidental textual architecture assertions. Do not overlap output-mutating
builds with consumers.

Review the implementation before delivery acceptance. Review may be direct;
do not launch a separate agent solely to duplicate a small review.
Synchronize directly owning current architecture/specifications and the user
configuration guide after verified implementation. Validate document links and
whitespace during design preparation.

## Resolved questions

- Controlled loopback checks established actual HTTP URL and connection-refusal
  cause/code evidence. Unknown stages retain the defined honest fallback; no
  dependency patch, downloader or separate Spike was needed.
- No existing Agent Home or index cleanup was needed. Only the task-owned
  temporary browser-validation Home was removed after its server stopped.
- Owner authorized implementation, then accepted delivery after successful
  manual testing and separately authorized archive and a scoped commit.
  The [Plan](plan.md) records the validation and authorization evidence.

Follow [Development Workflow](../../../governance/development-workflow.md).
