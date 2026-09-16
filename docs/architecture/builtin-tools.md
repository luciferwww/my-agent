# Builtin Tools

> Status: Current Authority
> Authority: Current implemented builtin Tool behavior
> Verified: 2026-09-16
> Ownership: Builtin inventory and concrete filesystem, search, web, Exec, and Process behavior
> Ownership key: builtin-tool-capabilities

## 1. Publication and ownership

`src/builtins/tools/` contains the concrete implementations and package-local Runtime Contribution entries. `src/core/tools/` retains only the canonical Tool contract and portable validation surface.

| Capability | Tools | Publication condition |
|---|---|---|
| Filesystem | `list_dir`, `read_file`, `apply_patch`, `write_file`, `edit_file` | Agent Home-anchored Environment factories |
| Search | `file_search`, `grep_search` | Agent Home-anchored Environment factories with optional call-level roots |
| Web | `web_fetch` | Enabled by the Environment contribution option |
| Exec/Process | `exec`, `process` | Independently enabled by Environment contribution options |
| Memory | `memory_search`, `memory_get`, `memory_write` | Memory manager and Unit are created; behavior belongs to [Memory](memory.md) |
| Subagent | `task` | Subagent Tool Unit is created; orchestration belongs to [Runtime](runtime.md) |

The default Runtime builder enables web, Exec, and Process, while explicit Unit options remain the publication control. All Builtins enter the same portable Tool Registry path described by [Tool Contract and Policy](tools.md); this page does not redefine generic validation, policy, approval, or Hook semantics.

## 2. Environment path and Approval policy

Filesystem and Search factories receive `agentHome`. Relative structured paths resolve from Agent Home rather than `process.cwd()`. File Search and Grep Search accept an optional call-level `path`; omission selects Agent Home.

`resolveEnvironmentPath()` returns the resolved Agent Home, absolute target, and display path. Display paths use forward slashes: paths inside Agent Home are relative (`.` for the root), while external targets are absolute. The helper resolves paths but does not authorize them or reject external targets.

After Hook transformation and schema validation, Application Tool Policy examines each declared structured target before Tool execution. Tool-name deny is final. Any lexically external target requires the existing current-call Approval even when the Tool name is allowed; missing Approval capability fails closed. Internal targets follow ordinary deny/allow/per-call Approval policy. Apply Patch classification includes add, delete, update, and move targets.

Approval is call-scoped and origin-bound; it creates no persistent resource grant. Classification is lexical and does not canonicalize symlinks. Agent Home is therefore a relative-path anchor, not a sandbox or hard filesystem boundary. Filesystem Tools catch input/path/I/O failures at their execution boundary and report `outcome: 'failed'`.

## 3. Filesystem Tools

| Tool | Inputs | Current behavior |
|---|---|---|
| `list_dir` | `path` | Lists direct children only, sorts by name, and marks directories with `/` |
| `read_file` | `path`, `startLine?`, `endLine?` | Reads inclusive 1-based line ranges; defaults to the first 200 lines when no range is supplied |
| `write_file` | `path`, `content` | Creates parent directories and creates or overwrites UTF-8 content; reports creation and byte count |
| `edit_file` | `path`, `oldText`, `newText` | Replaces exactly one literal occurrence; zero or multiple matches fail |
| `apply_patch` | `input` | Applies a multi-file `*** Begin Patch` / `*** End Patch` patch |

`read_file` normalizes CRLF for line selection, rejects non-positive/non-integral ranges and `startLine > endLine`, and fails when the start exceeds file length. Empty files have an explicit successful result.

`apply_patch` supports add, delete, update, and move-to hunks. Update matching proceeds in order, supports optional change-context and end-of-file markers, and tries exact, trailing-whitespace-normalized, then trimmed line matching. Updated files and non-empty added files end with a newline. Hunks are processed sequentially; the implementation does not claim a cross-file transaction or rollback.

## 4. Search Tools

| Tool | Inputs | Current behavior |
|---|---|---|
| `file_search` | `query`, `path?`, `maxResults?` | Case-insensitive path substring search or anchored glob-like `*`, `**`, and `?` matching below the selected root |
| `grep_search` | `query`, `isRegexp`, `path?`, `includePattern?`, `maxResults?` | Case-insensitive literal or regular-expression line search below the selected root with optional glob-like path filtering |

Both Tools walk regular files recursively in deterministic directory-entry order, skip `.git` and `node_modules` directories, ignore non-file/non-directory entries, and return forward-slash paths relative to the selected search root. `grep_search` skips files that cannot be read as UTF-8 and reports 1-based line numbers. Positive integral result limits stop or slice output; omission returns all matches.

## 5. Web fetch

`web_fetch` accepts `url`, optional `extractMode` (`markdown` or `text`), and optional positive integral `maxChars`. It accepts only HTTP(S), follows redirects, uses a fixed 30-second implementation timeout, and defaults to 50,000 output characters.

For HTML, it removes script, style, and noscript content, maps common structural tags to readable whitespace/list text, strips remaining tags, and decodes a small set of HTML entities. Non-HTML responses are trimmed as text. Both extraction modes currently use this same lightweight readable-text extraction; the selected mode is reported in output. Non-success HTTP status, timeout, protocol, and fetch errors are failed Tool executions.

The singleton binds no filesystem path. Its timeout is not a Tool input and it uses its own timeout controller rather than `ToolExecutionContext.signal`.

## 6. Exec modes

`exec` accepts:

```text
command: string
cwd?: string
                        # relative to Agent Home; omission uses Agent Home
env?: Record<string, string>
timeout?: number        # seconds; must be positive when supplied
yieldMs?: number        # positive milliseconds
background?: boolean
```

Only `string:string` environment entries are accepted and merged over string-valued `process.env` entries. Execution uses an explicit `cmd.exe /d /s /c` wrapper on Windows and `/bin/sh -c` on Unix; `shell` is false. Unix managed commands use detached process groups.

Exec is governed only by Tool-name policy. Deny blocks it; allow authorizes arbitrary Shell execution without Approval; otherwise each call requires current-call Approval and fails closed when Approval is unavailable. The full validated input, including the exact command, is the Approval subject. `cwd` is execution context, not confinement, and policy does not infer command effects from either command text or `cwd`.

| Mode | Selection | Behavior |
|---|---|---|
| Foreground | Neither `background` nor valid `yieldMs` | Waits for completion; default timeout is 30 seconds |
| Yield | Positive `yieldMs`, without `background` | Races completion against the deadline; completed commands return normally, still-running commands become background-visible |
| Background | `background: true` | Waits only for successful spawn and returns a `runId` immediately |

An explicit timeout applies to every mode. Background and yield modes have no implicit 30-second timeout. Foreground commands bypass the registry; managed yield/background commands create records. Output combines stdout and stderr chunks in observed timestamp order. Non-zero exit, timeout, and Abort are failed Tool executions; `ToolExecutionContext.signal` is passed to process execution.

## 7. Process management

`process` manages background-visible records created by `exec`:

```text
{ action: 'list' }
{ action: 'status', runId }
{ action: 'log', runId, tailLines? }
{ action: 'kill', runId }
```

`ProcessRegistry` is a module-level in-memory singleton shared by both Tools. Records track command, working directory, environment, lifecycle status, visibility, timing, PID, output chunks, aggregate output, exit data, and whether a yield promoted the process.

Pure foreground processes are not registered. Yield records start as `internal`; a still-running record becomes `background` only at the yield deadline. Immediate background records are visible from creation. `list` returns only visible records in creation order; status, log, and kill reject internal or unknown IDs. Logs may return a positive `tailLines` suffix.

`kill` is idempotent for terminal or concurrently disappeared processes and records manual termination as `aborted`. On Windows, tree termination tries `taskkill /T /PID` and escalates after a grace window to `/F /T /PID`. On Unix, it prefers process-group `SIGTERM`, falls back to a single PID when needed, and escalates to `SIGKILL` after the grace window. Timeout and Abort reuse the same tree-kill path. The registry's normal completion does not overwrite an existing terminal state; manual kill has a force-complete path to settle platform races.

## 8. Evidence

| Kind | Evidence |
|---|---|
| Registration | [Environment contribution](../../src/builtins/tools/environment/contribution.ts), [Memory contribution](../../src/builtins/tools/memory/contribution.ts), [Task contribution](../../src/builtins/tools/task/contribution.ts) |
| Filesystem and search source | [path-policy.ts](../../src/builtins/tools/environment/common/path-policy.ts), [directory-walk.ts](../../src/builtins/tools/environment/common/directory-walk.ts), [list-dir-tool.ts](../../src/builtins/tools/environment/filesystem/list-dir-tool.ts), [read-file-tool.ts](../../src/builtins/tools/environment/filesystem/read-file-tool.ts), [write-file-tool.ts](../../src/builtins/tools/environment/filesystem/write-file-tool.ts), [edit-file-tool.ts](../../src/builtins/tools/environment/filesystem/edit-file-tool.ts), [apply-patch-tool.ts](../../src/builtins/tools/environment/filesystem/apply-patch-tool.ts), [file-search-tool.ts](../../src/builtins/tools/environment/search/file-search-tool.ts), [grep-search-tool.ts](../../src/builtins/tools/environment/search/grep-search-tool.ts) |
| Web and process source | [web-fetch-tool.ts](../../src/builtins/tools/environment/web/web-fetch-tool.ts), [exec-tool.ts](../../src/builtins/tools/environment/process/exec-tool.ts), [process-tool.ts](../../src/builtins/tools/environment/process/process-tool.ts), [process-registry.ts](../../src/builtins/tools/environment/process/process-registry.ts), [run-command.ts](../../src/builtins/tools/environment/process/run-command.ts), [kill-process-tree.ts](../../src/builtins/tools/environment/process/kill-process-tree.ts), [resolve-command-invocation.ts](../../src/builtins/tools/environment/process/resolve-command-invocation.ts) |
| Tests | [list-dir-tool.test.ts](../../src/builtins/tools/environment/filesystem/list-dir-tool.test.ts), [read-file-tool.test.ts](../../src/builtins/tools/environment/filesystem/read-file-tool.test.ts), [write-file-tool.test.ts](../../src/builtins/tools/environment/filesystem/write-file-tool.test.ts), [edit-file-tool.test.ts](../../src/builtins/tools/environment/filesystem/edit-file-tool.test.ts), [apply-patch-tool.test.ts](../../src/builtins/tools/environment/filesystem/apply-patch-tool.test.ts), [file-search-tool.test.ts](../../src/builtins/tools/environment/search/file-search-tool.test.ts), [grep-search-tool.test.ts](../../src/builtins/tools/environment/search/grep-search-tool.test.ts), [web-fetch-tool.test.ts](../../src/builtins/tools/environment/web/web-fetch-tool.test.ts), [exec-tool.test.ts](../../src/builtins/tools/environment/process/exec-tool.test.ts), [process-tool.test.ts](../../src/builtins/tools/environment/process/process-tool.test.ts), [process-registry.test.ts](../../src/builtins/tools/environment/process/process-registry.test.ts), [run-command.test.ts](../../src/builtins/tools/environment/process/run-command.test.ts), [kill-process-tree.test.ts](../../src/builtins/tools/environment/process/kill-process-tree.test.ts), [Environment contribution tests](../../src/builtins/tools/environment/contribution.test.ts), [Memory contribution tests](../../src/builtins/tools/memory/contribution.test.ts), [Task contribution tests](../../src/builtins/tools/task/contribution.test.ts) |
| Controlling authority | [ADR-007](../decisions/adr-007-builtin-capability-source-ownership.md), [ADR-012](../decisions/adr-012-agent-home-path-unification.md), [Tools and Hooks](../specifications/tools-and-hooks.md), [Configuration](../specifications/configuration.md) |
