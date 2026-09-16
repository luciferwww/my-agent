# Agent Context

> Status: Current Authority
> Authority: Current implemented Agent Context behavior
> Verified: 2026-09-16
> Ownership: Agent Context initialization and allowlisted Context-file loading
> Ownership key: agent-context-initialization-and-loading

---

## 1. Purpose and boundary

`src/core/agent-context/` owns two filesystem operations:

1. `ensureAgentContext(agentHome)` creates a missing Agent Home and any missing default Context files there.
2. `loadContextFiles(agentHome, options)` reads the allowlisted Context files from Agent Home, while `loadContextFilesFromDir(absDir, options)` reads the same allowlist from an explicit Context directory.

Agent Context owns neither configuration precedence, caching, nor prompt rendering. [Configuration](configuration.md) owns the loading budgets. [Runtime](runtime.md) owns when files are initialized, loaded, cached, and reloaded. [Prompt](prompt.md) owns how a supplied `ContextFile[]` is rendered.

Agent Context is persistent Agent state under `agentHome`. It is distinct from the non-owning `workingDir` represented by the system prompt's `# Workspace` section and used by project-oriented Tools.

## 2. Source layout

```text
src/core/agent-context/
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

## 3. Initialization

`ensureAgentContext(agentHome)` recursively creates Agent Home when needed. It processes `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, and `TOOLS.md` in that order, loading packaged templates and writing each target with exclusive-create semantics. Existing files are never overwritten; other filesystem failures propagate.

Initialization does not create Session, Memory, Subagent, Logger, Extension, or working-directory content.

## 4. Context-file loading

### 4.1 Allowlist, modes, and order

Both public loaders share one fixed allowlist and order:

| Mode | Files considered, in order |
|---|---|
| `full` or omitted | `IDENTITY.md` → `SOUL.md` → `AGENTS.md` → `TOOLS.md` |
| `minimal` | `IDENTITY.md` → `SOUL.md` |

Missing, unreadable, and whitespace-only files are skipped. Files outside the allowlist are never loaded. `loadContextFilesFromDir()` supports explicitly located Subagent Context while retaining the same allowlist and loading behavior.

### 4.2 Truncation and total budget

For a file exceeding its current budget, the loader retains `floor(fileBudget × 0.7)` characters from the head and `floor(fileBudget × 0.2)` from the tail, then adds a marker reporting the retained and original lengths. The rendered result length is deducted from the remaining total budget.

Before each file, the loader stops when no budget remains and warns and skips the remainder when fewer than 64 characters remain. The defaults are `maxFileChars = 20_000` and `maxTotalChars = 150_000`; Runtime supplies resolved `agents.defaults.context` values during bootstrap and reload.

## 5. Runtime integration

`ContextFile` contains an allowlisted filename in `path` and trimmed or truncated text in `content`. Runtime loads full mode during bootstrap, stores the immutable resource projection, and supplies it through the narrow prompt projection for each Turn.

`reloadContextFiles()` replaces the cache only after a successful load, increments `contextVersion`, and emits `context_reload`; a failed load retains the previous cache. Subagent preparation may load an explicit Agent Context directory with `loadContextFilesFromDir()`.

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [Agent Context initialization](../../src/core/agent-context/init.ts), [Context loader](../../src/core/agent-context/loader.ts), [Context-file type](../../src/core/agent-context/types.ts), [Runtime bootstrap](../../src/runtime/bootstrap.ts), [Runtime reload and Turn integration](../../src/runtime/RuntimeApp.ts), [prompt parameter projection](../../src/runtime/prompt-factory.ts) |
| Tests | [initialization tests](../../src/core/agent-context/init.test.ts), [loader tests](../../src/core/agent-context/loader.test.ts), [Runtime tests](../../src/runtime/RuntimeApp.test.ts), [prompt projection tests](../../src/runtime/prompt-factory.test.ts) |
| Controlling authority | [ADR-010](../decisions/adr-010-install-and-agent-home-ownership.md), [Runtime Composition](../specifications/runtime-composition.md) |
