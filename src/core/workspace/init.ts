import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/** 模板文件名列表 */
const TEMPLATE_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'TOOLS.md',
] as const;

/** .agent 子目录名称 */
const AGENT_DIR = '.agent';

/** 模板目录（相对于当前文件） */
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

/**
 * 加载模板文件内容。
 */
async function loadTemplate(name: string): Promise<string> {
  return readFile(join(TEMPLATES_DIR, name), 'utf-8');
}

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

  // 逐个加载模板并写入（已存在则跳过）
  for (const name of TEMPLATE_FILES) {
    const content = await loadTemplate(name);
    await writeFileIfMissing(join(agentDir, name), content);
  }
}
