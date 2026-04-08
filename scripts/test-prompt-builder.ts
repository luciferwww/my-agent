/**
 * Print real System Prompt and User Prompt build output.
 *
 * Usage:
 *   npx tsx scripts/test-prompt-builder.ts
 */

import { ensureWorkspace, loadContextFiles } from '../src/workspace/index.js';
import { SystemPromptBuilder } from '../src/prompt-builder/system/SystemPromptBuilder.js';
import { UserPromptBuilder } from '../src/prompt-builder/user/UserPromptBuilder.js';

const workspaceDir = './test-workspace';

// 1. Initialize the workspace and load context files

console.log('=== Initialize Workspace ===\n');
await ensureWorkspace(workspaceDir);
const contextFiles = await loadContextFiles(workspaceDir);
console.log(`Loaded ${contextFiles.length} context files: ${contextFiles.map(f => f.path).join(', ')}\n`);

// 2. Build the system prompt

console.log('=== System Prompt (full mode) ===\n');

const systemBuilder = new SystemPromptBuilder();
const systemPrompt = systemBuilder.build({
  tools: [
    { name: 'search_web', description: 'Search the internet for latest information' },
    { name: 'memory_search', description: 'Search local knowledge base and history' },
    { name: 'read_file', description: 'Read local file contents' },
    { name: 'write_file', description: 'Write content to a file' },
  ],
  contextFiles,
});

console.log(systemPrompt);
console.log(`\n--- (${systemPrompt.length} chars) ---\n`);

// 3. Build the user prompt

console.log('=== User Prompt (with context hook) ===\n');

const userBuilder = new UserPromptBuilder()
  .useContextHook({
    id: 'memory-recall',
    provider: async (rawInput) => {
      // Simulate memory recall.
      return `<relevant_memories>\n- 2026-03-31: Discussed the prompt builder design\n- 2026-03-30: Analyzed the OpenClaw architecture\n</relevant_memories>`;
    },
  })
  .useContextHook({
    id: 'system-status',
    provider: () => {
      return '[System: workspace initialized, 4 context files loaded]';
    },
  });

const userPrompt = await userBuilder.build({
  text: 'How is the project progress we discussed last time?',
});

console.log(userPrompt.text);
console.log(`\n--- (${userPrompt.text.length} chars) ---`);
console.log(`attachments: ${userPrompt.attachments.length}`);
console.log(`_debug:`, userPrompt._debug);

// 4. Cleanup hint

console.log(`\nCleanup: rm -rf ${workspaceDir}`);
