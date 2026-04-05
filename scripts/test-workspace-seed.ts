/**
 * Validate workspace initialization and template seeding.
 *
 * Usage:
 *   npx tsx scripts/test-workspace-seed.ts [workspaceDir]
 *
 * Default workspace directory: ./test-workspace
 */

import { ensureWorkspace, loadContextFiles } from '../src/workspace/index.js';
import { readdir } from 'fs/promises';
import { join } from 'path';

const workspaceDir = process.argv[2] || './test-workspace';
const agentDir = join(workspaceDir, '.agent');

console.log(`\n=== Workspace Seed Validation ===\n`);
console.log(`Workspace directory: ${workspaceDir}`);
console.log(`Context files directory: ${agentDir}\n`);

// Step 1: initialize the workspace
console.log('--- Step 1: Initialize Workspace ---');
await ensureWorkspace(workspaceDir);
const files = await readdir(agentDir);
console.log(`Files in .agent/: ${files.join(', ')}`);

// Step 2: load context files
console.log('\n--- Step 2: Load Context Files ---');
const contextFiles = await loadContextFiles(workspaceDir);
for (const file of contextFiles) {
  console.log(`\n[${file.path}] (${file.content.length} chars)`);
  console.log(file.content);
}

// Step 3: initialize again to verify files are not overwritten
console.log('\n--- Step 3: Initialize Again (Verify No Overwrite) ---');
await ensureWorkspace(workspaceDir);
const contextFiles2 = await loadContextFiles(workspaceDir);
const unchanged = contextFiles.every((f, i) => f.content === contextFiles2[i]?.content);
console.log(`File contents unchanged: ${unchanged ? '✅ yes' : '❌ no'}`);

console.log('\n=== Validation Complete ===');
console.log(`\nTip: you can manually edit files under ${agentDir} and run this script again to verify loading behavior.`);
console.log(`Cleanup: rm -rf ${workspaceDir}\n`);
