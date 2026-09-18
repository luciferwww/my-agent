# Prompt Composition

> Status: Current Authority
> Authority: Current implemented prompt behavior
> Verified: 2026-09-18
> Ownership: System and User prompt composition, Context Hook prepending, and normalized media placement
> Ownership key: prompt-and-context-hooks

## 1. Boundary

`src/core/prompt/` owns deterministic System and User prompt construction and the library-level Context Hook prepender. Runtime supplies the current Context files, visible Tool names, Agent Home, available Subagent summaries, safety settings, and already normalized media blocks.

Prompt does not own configuration precedence, canonical Tool schemas, Channel wire delivery, [media validation and normalization](media.md), [Model Resolution](model-resolution.md), [Provider conversion](providers.md), or [Agent Context file loading](agent-context.md).

## 2. System prompt construction

`SystemPromptBuilder.build()` defaults to `mode: 'full'`. It emits applicable sections in this stable order:

| Order | Section | Full | Minimal |
|---:|---|:---:|:---:|
| 1 | Identity | yes | no |
| 2 | Current Date & Time | yes | yes |
| 3 | Behavior Rules | yes | no |
| 4 | Safety | unless `safetyLevel` is `relaxed` | unless `safetyLevel` is `relaxed` |
| 5 | Memory Recall | when an exact supported Memory Tool name is visible | no |
| 6 | Project Context | when non-empty Context files exist | when non-empty Context files exist |
| 7 | Agent Home | when `agentHome` exists | when `agentHome` exists |
| 8 | Available Subagents | when entries are supplied | no |

`mode: 'none'` returns an empty string regardless of the other inputs. Safety defaults to `normal`; `strict` selects stronger constraints and `relaxed` omits the section.

Tool names are a narrow capability projection used only for conditional prompt text. The Memory Recall section recognizes the exact names `memory_search`, `memory_get`, and the retained compatibility name `search_memory`; nearby names do not match. Tool definitions themselves travel through the Model Invocation request rather than being duplicated in the System prompt.

Project Context omits files whose path or content is blank. Each retained file is rendered under its path, and the presence of a file named `SOUL.md` adds the persona-and-tone guidance. Prompt consumes these files but does not load or cache them.

## 3. User prompt and Context Hooks

```text
UserPromptBuilder.build(input)
  1. invoke registered Context Hooks sequentially in registration order
  2. omit null, empty, and whitespace-only results
  3. join accepted chunks with blank lines
  4. append the original user text last
  5. return the text, unchanged attachments, and optional debug data
```

`ContextPrepender` owns registration and removal. For every `prepend()` call it passes the raw input, caller metadata, and a zero-based monotonically increasing `turnIndex` to each provider. Hook provider errors propagate to the caller; this layer does not add an error-isolation policy.

On the library Builder surface, attachments default to an empty array and otherwise pass through unchanged. The Builder neither embeds them in text nor converts them to Provider wire objects.

## 4. Runtime placement in normalized media

Runtime applies User-prompt prepending only to text:

1. A string message is replaced by the built User-prompt text.
2. For a normalized block array, the first text block is the prepend host; all other blocks keep their order and values.
3. If no text block exists, Runtime inserts a new text block containing the built prompt before the original blocks.

Prompt does not revalidate, optimize, reorder, or convert media. Runtime intake tests prove block forwarding and position preservation; Prompt tests separately prove Context Hook composition. There is no dedicated test combining a non-empty Context Hook with media blocks.

## 5. Runtime projection

`runtime/prompt-factory.ts` maps only Runtime-owned inputs into `SystemPromptBuildParams`: prompt mode, effective safety level, Context files, visible Tool names, Agent Home, and available Subagent entries. Even when prompt mode is `none`, Runtime selects the full Context-load mode so its cache remains warm; `minimal` selects minimal Context loading.

Context-file initialization and loading belong to [Agent Context](agent-context.md). Runtime generation and Subagent lifecycle belong to [Runtime](runtime.md).

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [SystemPromptBuilder.ts](../../src/core/prompt/SystemPromptBuilder.ts), [UserPromptBuilder.ts](../../src/core/prompt/UserPromptBuilder.ts), [ContextPrepender.ts](../../src/core/prompt/ContextPrepender.ts), [prompt types](../../src/core/prompt/types.ts), [prompt-factory.ts](../../src/runtime/prompt-factory.ts), [RuntimeApp.ts](../../src/runtime/RuntimeApp.ts) |
| Tests | [SystemPromptBuilder.test.ts](../../src/core/prompt/SystemPromptBuilder.test.ts), [UserPromptBuilder.test.ts](../../src/core/prompt/UserPromptBuilder.test.ts), [ContextPrepender.test.ts](../../src/core/prompt/ContextPrepender.test.ts), [prompt-factory.test.ts](../../src/runtime/prompt-factory.test.ts), [RuntimeApp.intake.test.ts](../../src/runtime/RuntimeApp.intake.test.ts) |
| Controlling authority | [Attachments Support](../specifications/attachments-support.md), [Tools and Hooks](../specifications/tools-and-hooks.md), [Runner Turn Flow](../specifications/runner-turn-flow.md) |
