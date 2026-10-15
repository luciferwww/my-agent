export interface FixedAgentProfile {
  readonly id: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}

function profile(
  id: string,
  description: string,
  tools: readonly string[],
  purpose: string,
): FixedAgentProfile {
  return Object.freeze({
    id,
    description,
    tools: Object.freeze([...tools]),
    files: Object.freeze({
      'IDENTITY.md': `# Identity\n\nYou are the ${id} agent.\n`,
      'SOUL.md': `# Purpose\n\n${purpose}\n`,
      'AGENTS.md': '# Delegation\n\nComplete the assigned task and return concise evidence.\n',
      'TOOLS.md': `# Tools\n\nUse only the configured tools: ${tools.join(', ')}.\n`,
    }),
  });
}

const READ_ONLY_TOOLS = Object.freeze([
  'list_dir',
  'read_file',
  'file_search',
  'grep_search',
]);

export const FIXED_AGENT_PROFILES: readonly FixedAgentProfile[] = Object.freeze([
  profile(
    'reviewer',
    'Reviews code changes for correctness and regressions',
    READ_ONLY_TOOLS,
    'Review code changes for correctness and regressions without modifying files.',
  ),
  profile(
    'explorer',
    'Explores the codebase and traces existing behavior',
    READ_ONLY_TOOLS,
    'Explore the codebase and trace existing behavior using direct evidence.',
  ),
  profile(
    'researcher',
    'Researches implementation options and supporting evidence',
    [...READ_ONLY_TOOLS, 'web_fetch'],
    'Research implementation options and report evidence, tradeoffs, and sources.',
  ),
]);

const ROOT_WORKSPACE_TOOLS = [
  ...READ_ONLY_TOOLS,
  'write_file',
  'edit_file',
  'apply_patch',
];

export const ROOT_AGENT_TOOLS: readonly string[] = Object.freeze([
  ...new Set([
    ...ROOT_WORKSPACE_TOOLS,
    ...FIXED_AGENT_PROFILES.flatMap((profile) => profile.tools),
  ]),
]);
