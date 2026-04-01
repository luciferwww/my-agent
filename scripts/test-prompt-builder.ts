/**
 * 打印真实的 System Prompt 和 User Prompt 构建结果。
 *
 * 用法：
 *   npx tsx scripts/test-prompt-builder.ts
 */

import { ensureWorkspace, loadContextFiles } from '../src/workspace/index.js';
import { SystemPromptBuilder } from '../src/prompt-builder/system/SystemPromptBuilder.js';
import { UserPromptBuilder } from '../src/prompt-builder/user/UserPromptBuilder.js';

const workspaceDir = './test-workspace';

// ── 1. 初始化工作区 + 加载上下文文件 ────────────────────────

console.log('=== 初始化工作区 ===\n');
await ensureWorkspace(workspaceDir);
const contextFiles = await loadContextFiles(workspaceDir);
console.log(`加载了 ${contextFiles.length} 个上下文文件: ${contextFiles.map(f => f.path).join(', ')}\n`);

// ── 2. 构建 System Prompt ───────────────────────────────────

console.log('=== System Prompt (full mode) ===\n');

const systemBuilder = new SystemPromptBuilder();
const systemPrompt = systemBuilder.build({
  tools: [
    { name: 'search_web', description: 'Search the internet for latest information' },
    { name: 'search_memory', description: 'Search local knowledge base and history' },
    { name: 'read_file', description: 'Read local file contents' },
    { name: 'write_file', description: 'Write content to a file' },
  ],
  contextFiles,
});

console.log(systemPrompt);
console.log(`\n--- (${systemPrompt.length} chars) ---\n`);

// ── 3. 构建 User Prompt ────────────────────────────────────

console.log('=== User Prompt (with context hook) ===\n');

const userBuilder = new UserPromptBuilder()
  .useContextHook({
    id: 'memory-recall',
    provider: async (rawInput) => {
      // 模拟记忆召回
      return `<relevant_memories>\n- 2026-03-31: 讨论了 prompt builder 的设计\n- 2026-03-30: 分析了 OpenClaw 的架构\n</relevant_memories>`;
    },
  })
  .useContextHook({
    id: 'system-status',
    provider: () => {
      return '[System: workspace initialized, 4 context files loaded]';
    },
  });

const userPrompt = await userBuilder.build({
  text: '上次我们讨论的项目进度怎么样了？',
});

console.log(userPrompt.text);
console.log(`\n--- (${userPrompt.text.length} chars) ---`);
console.log(`attachments: ${userPrompt.attachments.length}`);
console.log(`_debug:`, userPrompt._debug);

// ── 4. 清理提示 ────────────────────────────────────────────

console.log(`\n清理: rm -rf ${workspaceDir}`);
