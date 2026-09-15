# Workspace

> Status: Current Authority
> Authority: Current implemented Workspace behavior
> Verified: 2026-09-15
> Ownership: workspace initialization and context-file loading
> Ownership key: workspace-initialization-and-context

---

## 1. Purpose and boundary

`src/core/workspace/` owns two filesystem operations:

1. `ensureWorkspace(workspaceDir)` creates the workspace's `.agent/` directory and any missing default context files.
2. `loadContextFiles(workspaceDir, options)` reads the allowlisted context files from `<workspaceDir>/.agent/`, while `loadContextFilesFromDir(absDir, options)` reads the same allowlist directly from an explicit directory.

Workspace owns neither context caching nor prompt rendering. [Runtime](runtime.md) owns when files are loaded, cached, and reloaded; [Prompt](prompt.md) owns how a supplied `ContextFile[]` is rendered. [Configuration](configuration.md) owns the application values that Runtime passes as loader budgets.

## 2. Source layout

```text
src/core/workspace/
├── index.ts
├── init.ts
├── loader.ts
├── types.ts
└── templates/
    ├── IDENTITY.md
    ├── SOUL.md
    ├── AGENTS.md
    └── TOOLS.md
```

## 3. Workspace initialization

`ensureWorkspace(workspaceDir)` performs the following work:

```text
create <workspaceDir>/.agent/ recursively if needed
for IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md in that order:
  load the packaged template
  write <workspaceDir>/.agent/<name> with exclusive-create semantics
  if the file already exists, leave it unchanged
  otherwise propagate the filesystem error
```

The operation is idempotent with respect to existing files. It can also create a previously absent workspace-directory chain because `.agent/` is created recursively. It does not create session or memory subdirectories.

## 4. Context-file loading

### 4.1 Allowlist, modes, and order

Both public loaders use the same fixed allowlist and order:

| Mode | Files considered, in order |
|---|---|
| `full` or omitted | `IDENTITY.md` → `SOUL.md` → `AGENTS.md` → `TOOLS.md` |
| `minimal` | `IDENTITY.md` → `SOUL.md` |

Missing, unreadable, and whitespace-only files are skipped. Files outside the allowlist are never loaded.

`loadContextFiles()` appends `.agent/` to the supplied workspace root. `loadContextFilesFromDir()` does not append anything; it reads the supplied directory directly. Runtime uses the explicit-directory form when preparing Subagent context.

### 4.2 Truncation

For a file whose trimmed content exceeds its current file budget, the loader keeps:

- `floor(fileBudget × 0.7)` characters from the head;
- `floor(fileBudget × 0.2)` characters from the tail;
- a marker naming the file and reporting the retained and original lengths.

The loader calls `warn` when it truncates a file. The head and tail allocation applies to the excerpt; the rendered marker is additional text, so the final rendered `content.length` is the value deducted from the remaining total budget.

### 4.3 Total-budget processing

The loader starts with `maxTotalChars` clamped to at least one. Before each file:

1. it stops silently if no budget remains;
2. it warns and skips all remaining files if fewer than 64 characters remain;
3. it sets the current file budget to `max(1, min(maxFileChars, remaining))`;
4. it reads, trims, optionally truncates, and appends a non-empty result;
5. it subtracts the final rendered result length and clamps the remainder to zero.

The loader defaults are `maxFileChars = 20_000`, `maxTotalChars = 150_000`, and `warn = console.warn`. During application bootstrap and reload, Runtime supplies the resolved [Configuration](configuration.md) values instead of relying on those defaults.

## 5. Data and Runtime integration

```ts
interface ContextFile {
  path: string;
  content: string;
}
```

`path` is the allowlisted filename, such as `SOUL.md`, and `content` is the trimmed or truncated text.

Runtime loads the full mode during bootstrap, stores the resulting array in its resource set, and passes the cached array through its narrow prompt-parameter projection on each Turn. `reloadContextFiles()` replaces the cache only after a successful load, increments `contextVersion`, and emits `context_reload`; a load failure retains the previous cache. Subagent preparation can load an explicitly located context directory through `loadContextFilesFromDir()` while preserving the same allowlist, order, mode, and budget behavior.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [Workspace initialization](../../src/core/workspace/init.ts), [context loader](../../src/core/workspace/loader.ts), [context-file type](../../src/core/workspace/types.ts), [Runtime bootstrap](../../src/runtime/bootstrap.ts), [Runtime reload and Turn integration](../../src/runtime/RuntimeApp.ts), [prompt parameter projection](../../src/runtime/prompt-factory.ts) |
| Tests | [initialization tests](../../src/core/workspace/init.test.ts), [loader tests](../../src/core/workspace/loader.test.ts), [Runtime tests](../../src/runtime/RuntimeApp.test.ts), [prompt projection tests](../../src/runtime/prompt-factory.test.ts) |
| Controlling authority | [Runtime Composition](../specifications/runtime-composition.md) |
