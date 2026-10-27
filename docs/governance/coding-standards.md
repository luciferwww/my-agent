# Coding Standards

> Created: 2026-04-07\
> Scope: All TypeScript code in the my-agent project

This document summarizes the conventions used in the existing codebase. New code should follow them consistently.

---

## 1. File Naming

| Type | Naming Style | Examples |
|------|---------|------|
| Classes/main modules | PascalCase | `AgentRunner.ts`, `SessionManager.ts` |
| Tools/helper functions | kebab-case | `read-file.ts`, `run-command.ts`, `path-policy.ts` |
| Type definitions | `types.ts` | One per module, or a `types/` subdirectory |
| Module entry points | `index.ts` | Re-exports only; no implementation |
| Tests | Source file name + `.test.ts` | `AgentRunner.test.ts`, `lock.test.ts` |

---

## 2. Directory Naming

Always use **kebab-case**:

```
agent-runner/    llm-client/    prompt-builder/    session/    tools/
```

---

## 3. Naming Rules

| Category | Style | Examples |
|------|------|------|
| Classes | PascalCase, without prefixes or suffixes | `AgentRunner`, `SessionManager` |
| Interfaces | PascalCase, without an `I` prefix | `RunParams`, `ToolResult`, `SessionEntry` |
| Functions | camelCase | `loadStore()`, `extractText()`, `createMemoryTools()` |
| Variables | camelCase | `sessionManager`, `currentText`, `workspaceDir` |
| Constants | UPPER_SNAKE_CASE | `DEFAULT_MAX_TOKENS`, `SESSIONS_DIR` |
| Private members | `private` keyword + camelCase | `private invocationPort`, `private transcripts` |

### Interface Naming Suffix Conventions

| Suffix | Purpose | Examples |
|------|------|------|
| `Config` / `Options` | Constructor parameters and configuration | `AgentRunnerConfig`, `LoadContextFilesOptions` |
| `Params` / `Input` / `Request` | Method parameters | `RunParams`, `ModelInvocationRequest`, `UserPromptInput` |
| `Result` / `Response` | Return values | `RunResult`, `ModelInvocationResponse`, `ToolResult` |
| `Entry` / `Record` | Data entries | `SessionEntry`, `MessageRecord` |
| `Event` | Events | `AgentEvent`, `ModelStreamEvent` |
| `Definition` | Definitions/descriptions | `ToolDefinition`, `ChatToolDefinition` |

---

## 4. Module Structure

Typical module organization:

```
module-name/
├── ClassName.ts           # Main class (PascalCase)
├── helper-name.ts         # Helper functions (kebab-case)
├── types.ts               # Interfaces and types
├── index.ts               # Public API re-exports
├── ClassName.test.ts      # Main class tests
└── helper-name.test.ts    # Helper function tests
```

- Keep interfaces in `types.ts` (or a `types/` subdirectory); do not create a separate file for each interface.
- Use `index.ts` only for re-exports, without implementation logic.
- Use kebab-case for helper function files (such as `store.ts`, `lock.ts`, and `transcript.ts`).

---

## 5. Imports and Exports

### Imports

```typescript
// Value imports
import { SessionManager } from './SessionManager.js';
import { readFile } from 'fs/promises';
import { join } from 'node:path';

// Type imports (separate import type statements)
import type { SessionEntry, MessageRecord } from './types.js';
import type { ModelInvocationPort, ChatMessage } from '../model-invocation/types.js';
```

Rules:
- Always include the `.js` extension in relative paths.
- Use separate `import type` statements for type imports.
- Node.js built-in modules may be imported with or without the `node:` prefix.

### Exports

```typescript
// Classes and functions: named exports
export class AgentRunner { }
export function loadStore() { }
export const execTool: Tool = { };

// Re-exports in index.ts
export { AgentRunner } from './AgentRunner.js';
export type { RunParams, RunResult, AgentEvent } from './types.js';
```

Rules:
- Use named exports, not default exports.
- Use `export type` for type-only re-exports.

---

## 6. Comments

### JSDoc — Public APIs

```typescript
/**
 * Agent execution engine that coordinates all modules for a complete conversation loop.
 *
 * Two nested loops:
 * - Outer loop: handles followUp messages
 * - Inner loop: LLM calls + tool use loop
 */
export class AgentRunner { }
```

### Inline Comments — Explaining Logic

```typescript
// Load session history and convert it to ChatMessage[].
const history = this.loadHistory(params.sessionId);
```

### Separators — Sections Within a File

```typescript
// ── Section 1: agent-identity ──────────────────────────────
// ── Internal methods ──────────────────────────────────────
```

- Comments may be in Chinese or English; keep the style consistent within each file.
- Avoid redundant `@param` / `@returns` tags when TypeScript types already convey the information.

---

## 7. Error Handling

```typescript
// Throw errors with explicit messages.
throw new Error(`Session "${sessionId}" not found`);

// Catch errors using a type guard.
try {
  await operation();
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));
  throw error;
}

// Return tool errors with the isError flag.
return {
  content: `Error: ${message}`,
  isError: true,
};

// Silently skip expected errors, such as a missing file.
try {
  rawContent = await readFile(filePath, 'utf-8');
} catch {
  continue; // File does not exist; skip it.
}
```

---

## 8. Asynchronous Patterns

```typescript
// Standard: async/await
async run(params: RunParams): Promise<RunResult> {
  const result = await this.callLLM(params);
  return result;
}

// Streaming: AsyncIterable
async *chatStream(request: ModelInvocationRequest): AsyncIterable<ModelStreamEvent> {
  for await (const event of stream) {
    yield event;
  }
}

// Callbacks: use optional callbacks for simple cases.
onEvent?: (event: AgentEvent) => void;
```

---

## 9. Testing

Framework: **Vitest**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('SessionManager', () => {
  let workspaceDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'test-'));
    manager = new SessionManager(workspaceDir);
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  describe('createSession', () => {
    it('creates a session with UUID and JSONL file', async () => {
      const entry = await manager.createSession('main');
      expect(entry.sessionId).toBeDefined();
    });
  });
});
```

Rules:
- Create temporary directories with `mkdtemp()` and clean them up in `afterEach`.
- Group tests by feature with `describe`; describe specific behavior with `it`.
- Keep each test independent; do not share mutable state.
- Create mock objects inline.

---

## 10. Other Conventions

| Convention | Description |
|------|------|
| File encoding | UTF-8; explicitly specify `'utf-8'` when reading and writing files |
| Module system | ES Modules (`"type": "module"`) |
| TypeScript | `strict: true`, ES2022 target |
| Logging | Do not use third-party logging libraries; emit events (`this.emit()`) or use a `warn` callback |
| Platform | Detect with `process.platform`; avoid hard-coded path separators |
| In-memory state | Manage with `Map` (such as `Map<string, TranscriptState>`) |
