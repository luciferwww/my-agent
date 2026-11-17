import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export async function replaceAgentConfigFile(
  agentHome: string,
  content: string,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  const temporaryPath = join(agentHome, `config.json.${randomUUID()}.tmp`);
  const file = await open(temporaryPath, 'wx');
  try {
    try {
      await file.writeFile(content, 'utf8');
    } finally {
      await file.close();
    }
    await beforeReplace?.();
    await rename(temporaryPath, join(agentHome, 'config.json'));
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Configuration write and temporary-file cleanup failed.');
    }
    throw error;
  }
}
