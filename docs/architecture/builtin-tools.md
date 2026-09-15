# Builtin Tools

> Status: Current Authority
> Authority: Current implemented builtin Tool behavior
> Verified: 2026-09-14
> Ownership: Builtin inventory and concrete filesystem, search, web, Exec, and Process behavior
> Ownership key: builtin-tool-capabilities

## 1. Publication and ownership

`src/core/tools/builtin/` contains the implementations. `src/runtime-modules/builtin-tools.ts` is the production registration authority.

| Capability | Tools | Publication condition |
|---|---|---|
| Filesystem | `list_dir`, `read_file`, `apply_patch`, `write_file`, `edit_file` | Workspace-bound factories |
| Search | `file_search`, `grep_search` | Workspace-bound factories |
| Web | `web_fetch` | Enabled by the workspace Tool Unit option |
| Exec/Process | `exec`, `process` | Independently enabled by workspace Tool Unit options |
| Memory | `memory_search`, `memory_get`, `memory_write` | Memory manager and Unit are created; behavior belongs to [Memory](memory.md) |
| Subagent | `task` | Subagent Tool Unit is created; orchestration belongs to [Runtime](runtime.md) |

The default Runtime builder enables web, Exec, and Process, while explicit Unit options remain the publication control. All Builtins enter the same portable Tool Registry path described by [Tool Contract and Policy](tools.md); this page does not redefine generic validation, policy, approval, or Hook semantics.

## 2. Workspace path policy

Filesystem factories bind `workspaceDir` and `workspaceOnly` at creation. Relative inputs resolve from the bound workspace root rather than `process.cwd()`. With `workspaceOnly` omitted, the default is `true`.

`resolveWorkspacePath()` returns resolved root, absolute target, and display path. It throws `WorkspacePathError` with `inputPath` and `workspaceRoot` when a restricted target is outside the workspace. Display paths use forward slashes: paths inside the workspace are relative (`.` for the root), while allowed external targets are absolute.

Filesystem Tools catch input/path/I/O failures at their execution boundary and report `outcome: 'failed'`. Search factories are always workspace-bound and have no `workspaceOnly` switch.

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
| `file_search` | `query`, `maxResults?` | Case-insensitive path substring search or anchored glob-like `*`, `**`, and `?` matching |
| `grep_search` | `query`, `isRegexp`, `includePattern?`, `maxResults?` | Case-insensitive literal or regular-expression line search with optional glob-like path filtering |

Both Tools walk regular files recursively in deterministic directory-entry order, skip `.git` and `node_modules` directories, ignore non-file/non-directory entries, and return forward-slash workspace-relative paths. `grep_search` skips files that cannot be read as UTF-8 and reports 1-based line numbers. Positive integral result limits stop or slice output; omission returns all matches.

## 5. Web fetch

`web_fetch` accepts `url`, optional `extractMode` (`markdown` or `text`), and optional positive integral `maxChars`. It accepts only HTTP(S), follows redirects, uses a fixed 30-second implementation timeout, and defaults to 50,000 output characters.

For HTML, it removes script, style, and noscript content, maps common structural tags to readable whitespace/list text, strips remaining tags, and decodes a small set of HTML entities. Non-HTML responses are trimmed as text. Both extraction modes currently use this same lightweight readable-text extraction; the selected mode is reported in output. Non-success HTTP status, timeout, protocol, and fetch errors are failed Tool executions.

The singleton binds no workspace. Its timeout is not a Tool input and it uses its own timeout controller rather than `ToolExecutionContext.signal`.

## 6. Exec modes

`exec` accepts:

```text
command: string
cwd?: string
                        # resolved from process.cwd(), not workspaceDir
env?: Record<string, string>
timeout?: number        # seconds; must be positive when supplied
yieldMs?: number        # positive milliseconds
background?: boolean
```

Only `string:string` environment entries are accepted and merged over string-valued `process.env` entries. Execution uses an explicit `cmd.exe /d /s /c` wrapper on Windows and `/bin/sh -c` on Unix; `shell` is false. Unix managed commands use detached process groups.

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
| Registration | [builtin-tools.ts](../../src/runtime-modules/builtin-tools.ts), [builtin-tools.test.ts](../../src/runtime-modules/builtin-tools.test.ts) |
| Filesystem and search source | [path-policy.ts](../../src/core/tools/builtin/common/path-policy.ts), [workspace-walk.ts](../../src/core/tools/builtin/common/workspace-walk.ts), [list-dir.ts](../../src/core/tools/builtin/fs/list-dir.ts), [read-file.ts](../../src/core/tools/builtin/fs/read-file.ts), [write-file.ts](../../src/core/tools/builtin/fs/write-file.ts), [edit-file.ts](../../src/core/tools/builtin/fs/edit-file.ts), [apply-patch.ts](../../src/core/tools/builtin/fs/apply-patch.ts), [file-search.ts](../../src/core/tools/builtin/search/file-search.ts), [grep-search.ts](../../src/core/tools/builtin/search/grep-search.ts) |
| Web and process source | [web-fetch.ts](../../src/core/tools/builtin/web/web-fetch.ts), [exec.ts](../../src/core/tools/builtin/exec/exec.ts), [process.ts](../../src/core/tools/builtin/exec/process.ts), [process-registry.ts](../../src/core/tools/builtin/exec/process-registry.ts), [run-command.ts](../../src/core/tools/builtin/exec/run-command.ts), [kill-process-tree.ts](../../src/core/tools/builtin/exec/kill-process-tree.ts), [resolve-command-invocation.ts](../../src/core/tools/builtin/exec/resolve-command-invocation.ts) |
| Tests | [list-dir.test.ts](../../src/core/tools/builtin/fs/list-dir.test.ts), [read-file.test.ts](../../src/core/tools/builtin/fs/read-file.test.ts), [write-file.test.ts](../../src/core/tools/builtin/fs/write-file.test.ts), [edit-file.test.ts](../../src/core/tools/builtin/fs/edit-file.test.ts), [apply-patch.test.ts](../../src/core/tools/builtin/fs/apply-patch.test.ts), [file-search.test.ts](../../src/core/tools/builtin/search/file-search.test.ts), [grep-search.test.ts](../../src/core/tools/builtin/search/grep-search.test.ts), [web-fetch.test.ts](../../src/core/tools/builtin/web/web-fetch.test.ts), [exec.test.ts](../../src/core/tools/builtin/exec/exec.test.ts), [process.test.ts](../../src/core/tools/builtin/exec/process.test.ts), [process-registry.test.ts](../../src/core/tools/builtin/exec/process-registry.test.ts), [run-command.test.ts](../../src/core/tools/builtin/exec/run-command.test.ts), [kill-process-tree.test.ts](../../src/core/tools/builtin/exec/kill-process-tree.test.ts) |
| Controlling authority | [Tools and Hooks](../specifications/tools-and-hooks.md), [Configuration](../specifications/configuration.md) |
