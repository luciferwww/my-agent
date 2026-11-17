import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/** Template file names. */
const TEMPLATE_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'TOOLS.md',
] as const;

/** Template directory relative to this module. */
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

/**
 * Read a template file.
 */
async function loadTemplate(name: string): Promise<string> {
  return readFile(join(TEMPLATES_DIR, name), 'utf-8');
}

/**
 * Write content only when the file is absent.
 * Exclusive creation ("wx") preserves existing files, as in OpenClaw's
 * writeFileIfMissing().
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
 * Ensure Agent Home and its template files exist.
 * Preserve existing files, including user edits.
 *
 * @param agentHome - Root directory for Agent state.
 */
export async function ensureAgentContext(agentHome: string): Promise<void> {
  await mkdir(agentHome, { recursive: true });

  // Seed each Root template without replacing existing files.
  for (const name of TEMPLATE_FILES) {
    const content = await loadTemplate(name);
    await writeFileIfMissing(join(agentHome, name), content);
  }

  await ensureAgentDefinitions(agentHome);
}

async function ensureAgentDefinitions(agentHome: string): Promise<void> {
  const destination = join(agentHome, 'agents');
  try {
    const entry = await lstat(destination);
    if (!entry.isDirectory()) {
      throw new Error(`Agent definitions path must be a directory: ${destination}`);
    }
    return;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const temporary = await mkdtemp(join(agentHome, '.agents-'));
  try {
    await cp(join(TEMPLATES_DIR, 'agents'), temporary, { recursive: true });
    await rename(temporary, destination);
  } catch (error) {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Agent template initialization and cleanup failed.');
    }
    throw error;
  }
}