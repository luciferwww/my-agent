/**
 * 验证 workspace 初始化（模板 seed）功能。
 *
 * 用法：
 *   npx tsx scripts/test-workspace-seed.ts [workspaceDir]
 *
 * 默认工作区目录：./test-workspace
 */

import { ensureWorkspace, loadContextFiles } from '../src/workspace/index.js';
import { readdir } from 'fs/promises';
import { join } from 'path';

const workspaceDir = process.argv[2] || './test-workspace';
const agentDir = join(workspaceDir, '.agent');

console.log(`\n=== Workspace Seed 验证 ===\n`);
console.log(`工作区目录: ${workspaceDir}`);
console.log(`上下文文件目录: ${agentDir}\n`);

// Step 1: 初始化
console.log('--- Step 1: 初始化工作区 ---');
await ensureWorkspace(workspaceDir);
const files = await readdir(agentDir);
console.log(`.agent/ 目录下的文件: ${files.join(', ')}`);

// Step 2: 加载
console.log('\n--- Step 2: 加载上下文文件 ---');
const contextFiles = await loadContextFiles(workspaceDir);
for (const file of contextFiles) {
  console.log(`\n[${file.path}] (${file.content.length} chars)`);
  console.log(file.content);
}

// Step 3: 再次初始化（验证不覆盖）
console.log('\n--- Step 3: 再次初始化（验证不覆盖） ---');
await ensureWorkspace(workspaceDir);
const contextFiles2 = await loadContextFiles(workspaceDir);
const unchanged = contextFiles.every((f, i) => f.content === contextFiles2[i]?.content);
console.log(`文件内容未变化: ${unchanged ? '✅ 是' : '❌ 否'}`);

console.log('\n=== 验证完成 ===');
console.log(`\n提示: 你可以手动编辑 ${agentDir} 下的文件，再次运行此脚本验证加载效果。`);
console.log(`清理: rm -rf ${workspaceDir}\n`);
