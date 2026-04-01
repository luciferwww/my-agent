import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * 内置模板，首次初始化时写入工作区。
 * 与 OpenClaw 不同，模板内容直接内置在代码中，无需外部 templates 目录。
 */
const TEMPLATES: Record<string, string> = {
  'IDENTITY.md': `# Identity

- **Name:** _(your agent's name)_
- **Role:** _(what it does)_
- **Emoji:** _(signature emoji)_
`,
  'SOUL.md': `# Soul

Be genuinely helpful, not performatively helpful.
Have opinions. Be concise when needed, thorough when it matters.
`,
  'AGENTS.md': `# Agents

_(Define task execution rules and workflows here)_
`,
  'TOOLS.md': `# Tools - Local Notes

_(Add environment-specific tool usage notes here)_
`,
};

/** .agent 子目录名称 */
const AGENT_DIR = '.agent';

/**
 * 将内容写入文件，仅当文件不存在时。
 * 使用 flag: "wx"（exclusive write），已存在则跳过。
 * 与 OpenClaw 的 writeFileIfMissing() 实现一致。
 */
async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (err) {
    const error = err as { code?: string };
    if (error.code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

/**
 * 确保工作区 .agent/ 目录和模板文件存在。
 * 文件已存在则跳过，不覆盖用户已编辑的内容。
 *
 * 参考 OpenClaw 的 ensureAgentWorkspace()（src/agents/workspace.ts）。
 *
 * @param workspaceDir - 工作区根目录路径
 */
export async function ensureWorkspace(workspaceDir: string): Promise<void> {
  const agentDir = join(workspaceDir, AGENT_DIR);

  // 确保 .agent/ 目录存在
  await mkdir(agentDir, { recursive: true });

  // 逐个写入模板文件（已存在则跳过）
  for (const [name, content] of Object.entries(TEMPLATES)) {
    await writeFileIfMissing(join(agentDir, name), content);
  }
}
