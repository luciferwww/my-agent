import type { SubagentProfile } from './types.js';

/**
 * A single entry in the `<available-subagents>` system prompt section.
 *
 * Exposed only `id` + `description`: those are the two fields the parent
 * agent's LLM needs to decide which subagent to delegate to. Implementation
 * details (`agentDir`, `model`, `tools`, `maxLlmCalls`) stay private.
 */
export interface AvailableSubagentEntry {
  id: string;
  description: string;
}

/**
 * Project a profile map into the slim entry list rendered by
 * {@link renderAvailableSubagentsSection}. Iteration order follows the
 * map's insertion order — callers (typically RuntimeApp bootstrap) are
 * responsible for inserting `general-purpose` first so the LLM sees it
 * as the default fallback in the rendered list.
 */
export function collectAvailableSubagents(
  profiles: ReadonlyMap<string, SubagentProfile>,
): AvailableSubagentEntry[] {
  return [...profiles.values()].map(({ id, description }) => ({ id, description }));
}

/**
 * Render the `<available-subagents>` section appended to the parent agent's
 * system prompt by `SystemPromptBuilder` (added in PR-5 — spec §11 §8).
 *
 * Returns the empty string for an empty `entries` array, so the caller can
 * unconditionally append the result without injecting blank section headers.
 *
 * Pure function — no side effects, safe to snapshot.
 */
export function renderAvailableSubagentsSection(
  entries: readonly AvailableSubagentEntry[],
): string {
  if (entries.length === 0) return '';
  const lines = [
    '<available-subagents>',
    'You can delegate independent subtasks to specialized subagents using the `task` tool.',
    '',
    'Available subagent types:',
    ...entries.map(({ id, description }) => `- ${id}: ${description}`),
    '',
    'Guidelines:',
    '- Use `task` for independent work, especially when it would otherwise read many files into your context.',
    '- Subagents run in isolated context; pass all necessary information in the `prompt` parameter.',
    '- A subagent returns only its final text; intermediate tool calls are not visible to you.',
    '- Each `task` call is blocking.',
    '</available-subagents>',
  ];
  return lines.join('\n');
}
