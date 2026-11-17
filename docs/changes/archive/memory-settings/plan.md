# Global Memory Settings and Embedding Download Diagnostics

> Status: Accepted
> Date: 2026-11-16
> Owner: Project owner
> Classification: Architecture Slice
> Design: [Validated Specification](specification.md)
> Authorization: Owner authorized document preparation, reviewed the design, then authorized controlled checks and implementation with "继续" on 2026-11-16 at 16:23. Owner completed manual testing with no issues, accepted delivery, and separately authorized archive and a scoped commit on 2026-11-17. Push and merge remain unauthorized.

## Outcome

Expose one global Memory enablement switch in existing Agent Settings, make
local embedding loading failures actionable, and support `HF_ENDPOINT`.
Preserve startup-only Memory initialization and Tool registration.

The configuration destination is `agents.memory`, not `agents.defaults.memory`.
This intentionally changes the existing Agent-scoped configuration/override
contract; it is not merely a UI addition or removal of unused fields.

## Evidence and boundaries

- Before this Change, configuration put Memory in AgentDefaults and supported
  named-Agent/environment/caller overrides. The
  [configuration types](../../../../src/platform/config/types.ts) and
  [resolution](../../../../src/platform/config/loader.ts) now keep it global.
- [Bootstrap](../../../../src/runtime/composition/bootstrap.ts) creates one
  manager from global `agents.memory`. The
  [Memory Tool contribution](../../../../src/builtins/tools/memory/contribution.ts)
  binds Tools to that shared manager; Subagents have no separate Memory store
  or lifecycle.
- [Local model loading](../../../../src/core/memory/internal/LocalEmbeddingProvider.ts)
  uses Transformers.js. Its progress callback supplies file-retrieval context,
  not reliable network-start, failing-file or cache-hit information.
- [SettingsManager](../../../../src/runtime/settings/settings-manager.ts) owns
  section revisions and serialized saves. Existing persistence and client
  patterns are reused, not replaced.

Read source/focused tests and the owning
[Configuration](../../../specifications/configuration.md),
[Channel](../../../specifications/channel.md) and
[Runtime Composition](../../../specifications/runtime-composition.md) contracts
before Delivery.

## Scope and non-goals

In scope:

- Compose the complete global Memory config under `agents.memory`; remove it
  from Agent defaults, named overrides and Agent-resolution override inputs.
- One independent restart-required `agents:memory` section editing only enabled.
- Shared local embedding endpoint adaptation and actionable loading diagnostics.
- Direct updates to affected maintained callers/examples/fixtures, focused tests
  and directly owning documentation.

Out of scope:

- Automatic/manual migration tooling, compatibility readers, dual-path
  precedence or startup configuration write-back.
- Dynamic enablement, deferred first-Tool-call manager initialization,
  hot-unloading, per-Subagent Memory instances or new access-control settings.
- Model/Provider/search/chunking editors, automatic retry/mirror switching,
  a downloader, generic Settings infrastructure or additional log-redaction work.
- Unrelated dirty worktree changes, paid model calls, push/merge
  and broad Agent Home cleanup.

No index format change is proposed. If an affected Home needs a reset, identify
the exact regenerable index files first; retain Memory sources and unrelated
state. No deletion is part of document preparation.

## Artifact rationale and gates

Use a Plan and Module Specification because this changes the public
configuration shape, override semantics and cross-owner Settings behavior.
No new ADR is currently proposed: Core Memory, Platform Configuration, Runtime
Settings and Runtime resource ownership/dependency directions stay unchanged.
Reassess before Delivery if a durable ownership decision must change.

First verify the SDK's error shapes with a small controlled check. No real model
download is needed. If supported APIs cannot substantiate the agreed diagnostic
contract without invasive hooks, pause and revise the Spec; use a separately
accepted Spike if the unknown would change the architecture.

| Item | Status | Exit criterion |
|---|---|---|
| MS-1: Accept design and validation scope | Completed | Owner authorized implementation after design review; no migration/old-field checks or expanded redaction work |
| MS-2: Verify SDK failure evidence | Completed | Loopback HTTP 403 and connection-refusal checks established actual error/cause/code/URL and initiate-only callback evidence |
| MS-3: Cut over global Memory configuration | Completed | Types, defaults, validation, resolution, startup and maintained callers/tests use global Memory; focused tests and root type-check pass |
| MS-4: Implement endpoint and diagnostics | Completed | Shared loading path, HF_ENDPOINT and evidence-based diagnostics implemented; 15 focused cases pass |
| MS-5: Implement Memory Settings section | Completed | Independent persistence, restart reversal, unchanged runtime policies, parser and UI tests pass |
| MS-6: Validate and synchronize authority | Completed | Focused regression, real WebSocket integration, serial Fitness, lint/build, asset/Host audits, desktop/narrow browser and documentation checks passed; direct implementation review completed |
| MS-7: Accept delivery | Completed | Owner reported successful manual testing with no issues and separately authorized archive and a scoped commit on 2026-11-17; no push/merge authorization |

Dependencies: MS-2 and MS-3 require MS-1; MS-4 requires MS-2; MS-5 requires MS-3;
MS-6 requires MS-3, MS-4 and MS-5; MS-7 requires MS-6.
These dependencies do not require concurrent implementation or builds.

## Risks and validation

- Do not add old-field checks, migration messages or compatibility handling.
  Update maintained configuration inputs/callers directly to the new shape.
- Do not mistake callback order or cached reads for evidence of a failed
  network download; preserve original failures and existing fallback decisions.
- Settings save must not download, index, register Tools or apply unrelated
  saved changes to running policy.
- Compare resolved saved enablement with the immutable resolved startup
  baseline, including omission and reversal.
- Preserve unrelated dirty files and sensitive local connection configuration.

The [Specification](specification.md#acceptance-and-validation) defines the
validation matrix. Run the smallest falsifying check after the first substantive
code change, then relevant integration checks, lint and builds. Do not overlap
builds with tests consuming mutable output.

At verified delivery, synchronize current configuration/runtime architecture,
configuration/channel contracts and the configuration guide where behavior
actually changed. Keep discussion provenance here; do not make current authority
depend on Research or this Change.

## Current state

Implemented, verified and owner-accepted on 2026-11-17. No existing Agent Home
or index cleanup, external model download, paid Model call or publication was
performed during delivery. The isolated browser-validation server was stopped
and its task-owned temporary Home removed. The Change was archived on
2026-11-17 with owner authorization for a scoped commit, excluding unrelated
worktree changes. No push or merge is authorized.

### Owner acceptance

On 2026-11-17, the owner reported: "I'v manual tested the current chage, no issues found."
This closed delivery validation and acceptance. The owner subsequently stated
"OK, archive it and commit." on the same day. That separately authorizes archive
and a scoped commit, not push or merge.

### SDK evidence

The installed Transformers.js 2.17.2 was exercised against a loopback-only server,
with local lookup and filesystem/browser caches disabled for that process.
HTTP 403 exposed the actual `tokenizer.json` URL in the original message, but no
structured status/code. Connection refusal exposed `fetch failed` with an
`ECONNREFUSED` cause/code and no file URL. Both emitted only file `initiate` events
before failure. The server was closed; no model/cache files were downloaded.
This supports structured evidence extraction, not last-progress attribution.

### Validation results

- Initial global-config regressions failed before implementation, then passed.
- 399 affected Unit cases: 398 passed; one obsolete test expectation was
  corrected to the new global shape.
- Follow-up 226 cases across section editing, Settings, policy, WebSocket wire,
  client parsing and SettingsPanel passed, including the corrected expectation.
- Root TypeScript no-emit check passed after updating dependent callers.
- Dedicated old-field rejection logic and its tests were removed on owner
  correction. Existing unsupported-field behavior is unchanged.
- Final combined regression: 533 Unit cases across 17 affected files passed.
- All three Extension acquisition/real WebSocket integration cases passed,
  including global Memory load/save, unchanged Tool catalog, restart reversal
  and independent execution/Tools/Skills/LLM sections.
- Eight Fitness cases passed with one worker and the existing five-second
  timeout. The earlier parallel source scans timed out; serial execution
  resolved contention without changing test code or timeout policy.
- `npm run lint`, Host and client builds passed. Client asset verification
  passed for 62 files; the Host build audit passed for 400 files.
  Vite retains its advisory over-500-kB bundle warning; no bundle splitting was
  added to this Change.
- Browser verification used an isolated loopback Host, initially disabled
  Memory and no configured Model. At 1280x900 and 390x844, the existing controls,
  help and fixed Save footer fit without horizontal overflow. Enabling saved
  immediately with a restart marker, closing/reopening retained that marker,
  saving the disabled startup value cleared it, and reload discarded an
  unsaved enabled draft. No service restart or model request was performed.
- Direct implementation review confirmed the global startup source, narrow
  persistence, immutable startup comparison, no Memory policy publication,
  shared endpoint-loading path and original-error propagation. No blocking
  implementation issue remains in this scope.
- Current configuration/runtime architecture, stable configuration/channel/
  Runtime contracts and the user guide are synchronized. Local documentation
  links, JSON examples and whitespace checks passed.

Follow [Development Workflow](../../../governance/development-workflow.md).
