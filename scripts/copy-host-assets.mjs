import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const source = join(repositoryRoot, 'src', 'core', 'agent-context', 'templates');
const destination = join(repositoryRoot, 'dist', 'host', 'core', 'agent-context', 'templates');

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
