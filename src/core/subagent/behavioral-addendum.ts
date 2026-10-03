/**
 * Options for {@link buildSubagentBehavioralAddendum}.
 *
 * - `taskDescription` comes from the delegation request description (i.e. the
 *   `description` argument of the `task` tool call). Not the user `prompt`,
 *   which already lives in the first user message and need not be repeated.
 * - `depth` is the subagent's nesting depth, passed explicitly by Runtime.
 * - `canSpawn` is whether further `task` calls are permitted at this depth
 *   (i.e. role is `'main'` or `'orchestrator'`, not `'leaf'`). When `false`,
 *   the addendum explicitly tells the model the `task` tool is unavailable
 *   to keep it from inventing tool calls that would fail.
 */
export interface BehavioralAddendumOpts {
  taskDescription: string;
  depth: number;
  canSpawn: boolean;
}

/**
 * Build the per-run "behavioral addendum" appended to a subagent's system
 * prompt (after `SystemPromptBuilder.build({ mode: 'minimal' })`).
 *
 * 刻意不回显 `sessionId` 或 `prompt`：
 * - `sessionId` 是内部标识，对 LLM 没有价值。
 * - `prompt` is already injected as the first user message of the turn;
 *   echoing it would double the cost without adding information.
 *
 * Pure string concatenation, no side effects — safe to snapshot in tests.
 */
export function buildSubagentBehavioralAddendum(opts: BehavioralAddendumOpts): string {
  const lines: string[] = [
    '# Subagent Instructions',
    '',
    'You are a subagent running in an isolated context.',
    `Task: ${opts.taskDescription}`,
    `Depth: ${opts.depth}`,
    '',
    'Guidelines:',
    '- Focus only on the task above. Do not pretend to be the parent agent.',
    '- Return a clear, complete answer as your final response.',
    '- Do not include internal tool call details in your final response unless asked.',
  ];
  if (!opts.canSpawn) {
    lines.push('- You cannot spawn subagents (task tool is not available).');
  }
  lines.push('');
  return lines.join('\n');
}
