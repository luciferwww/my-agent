# Core Prompt Current Architecture

> Status: Current Authority
> Verified: 2026-09-09
> Ownership: prompt composition, Context Hooks, and normalized media placement
> Ownership key: prompt-and-context-hooks

## 1. Boundary

`src/core/prompt/` owns deterministic System/User prompt construction and Context Hook prepending. Runtime supplies current Context files, visible Tool names, workspace, Subagent summaries, safety settings, and already normalized media blocks. Prompt does not own Config precedence, canonical Tool schemas, Channel wire protocol, [Media](./core_media.md) validation, Model Resolution, or Provider SDK conversion.

## 2. SystemPromptBuilder

`SystemPromptBuilder.build()` emits sections in stable order when their conditions hold:

| Order | Section | Full | Minimal |
|---:|---|:---:|:---:|
| 1 | Identity | yes | no |
| 2 | Current Date & Time | yes | yes |
| 3 | Behavior Rules | yes | no |
| 4 | Safety | unless relaxed | unless relaxed |
| 5 | Memory Recall | when a Memory Tool is visible | no |
| 6 | Project Context | when Context files exist | when Context files exist |
| 7 | Workspace | when `workspaceDir` exists | when `workspaceDir` exists |
| 8 | Available Subagents | when supplied | no |

`mode='none'` returns an empty string. Tool names are a narrow capability projection used only for conditional prompt text; Prompt never stores or converts Tool schemas.

## 3. UserPromptBuilder and Context Hooks

```text
UserPromptBuilder.build(input)
  1. execute registered Context Hooks in registration order
  2. omit null/empty hook results
  3. prepend accepted chunks
  4. append the original user text last
  5. return text, pass-through attachments and optional debug data
```

`ContextPrepender` owns registration/removal and sequential provider invocation. Hook failures are isolated according to its implementation contract. User attachments on the library Builder surface are returned unchanged; the Builder does not encode Provider wire objects.

## 4. Normalized media placement

Runtime applies Context Hook text to the first text block while preserving every other normalized block position; if no text block exists, it inserts the prepended text before the media blocks. Prompt does not revalidate, optimize, reorder, or convert media.

This placement is direct `RuntimeApp` source behavior. Prompt tests prove Context Hook output and Runtime intake tests prove normalized block forwarding/order separately; there is no dedicated integration test that combines a non-empty Context Hook with media blocks.

[Media](./core_media.md) owns inbound validation and canonical normalization. [Channel](./adapter_channel.md) owns wire delivery and summary broadcasting. [Model Resolution](./core_model_resolution.md) checks requested media capabilities, and [Provider Adapter](./adapter_llm.md) owns Anthropic wire conversion.

## 5. Runtime projection

`runtime/prompt-factory.ts` maps only the current generation's visible Tool names and Runtime-owned inputs into `SystemPromptBuildParams`. Context files are cached/reloaded by Runtime and consumed here; their initialization/loading contract belongs to [Workspace](./core_workspace.md).

## 6. Evidence

| Kind | Evidence |
|---|---|
| Source | [SystemPromptBuilder.ts](../../../src/core/prompt/SystemPromptBuilder.ts), [UserPromptBuilder.ts](../../../src/core/prompt/UserPromptBuilder.ts), [ContextPrepender.ts](../../../src/core/prompt/ContextPrepender.ts), [prompt types](../../../src/core/prompt/types.ts), [prompt-factory.ts](../../../src/runtime/prompt-factory.ts), [RuntimeApp.ts](../../../src/runtime/RuntimeApp.ts) |
| Tests | [SystemPromptBuilder.test.ts](../../../src/core/prompt/SystemPromptBuilder.test.ts), [UserPromptBuilder.test.ts](../../../src/core/prompt/UserPromptBuilder.test.ts), [ContextPrepender.test.ts](../../../src/core/prompt/ContextPrepender.test.ts), [prompt-factory.test.ts](../../../src/runtime/prompt-factory.test.ts), [RuntimeApp.intake.test.ts](../../../src/runtime/RuntimeApp.intake.test.ts) |
| Controlling authority | [Attachments Support Spec](../attachments-support-spec.md), [Tool/Hook Module Spec](../tool-hook-module-spec.md), [Core Runner Turn Flow Spec](../core-runner-turn-flow-spec.md) |
