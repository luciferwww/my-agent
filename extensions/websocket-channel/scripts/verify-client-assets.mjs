import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_ROOT = join(EXTENSION_ROOT, 'client', 'dist');
const CONFIG_TOKEN = '__MY_AGENT_CLIENT_CONFIG_JSON__';

const files = await inventoryDist(DIST_ROOT);
const indexPath = join(DIST_ROOT, 'index.html');
const indexHtml = await readFile(indexPath, 'utf8');

assert(count(indexHtml, CONFIG_TOKEN) === 1, 'Client HTML must contain exactly one config token.');
assert(!files.some(path => extname(path) === '.map'), 'Client dist must not contain source maps.');

const references = [...indexHtml.matchAll(/\b(?:src|href)="([^"]+)"/gu)]
  .map(match => match[1])
  .filter(reference => !reference.startsWith('data:') && !reference.startsWith('#'));
assert(references.length > 0, 'Client HTML must reference built assets.');

const fileSet = new Set(files);
for (const reference of references) {
  assert(!URL.canParse(reference), `Client HTML must not reference external asset ${reference}.`);
  const resolved = resolve(dirname(indexPath), reference);
  const relativePath = relative(DIST_ROOT, resolved);
  assert(
    relativePath !== '' && !relativePath.startsWith(`..${sep}`) && relativePath !== '..',
    `Client asset escapes dist: ${reference}.`,
  );
  const normalized = relativePath.split(sep).join('/');
  assert(fileSet.has(normalized), `Client HTML references missing asset ${reference}.`);
}

console.log(`Verified ${files.length} WebSocket Client build assets.`);

async function inventoryDist(root) {
  const canonicalRoot = await realpath(root);
  return inventoryDirectory(canonicalRoot, canonicalRoot);
}

async function inventoryDirectory(root, directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Client dist contains symlink: ${path}.`);
    if (entry.isDirectory()) {
      result.push(...await inventoryDirectory(root, path));
      continue;
    }
    if (!entry.isFile() || !(await lstat(path)).isFile()) {
      throw new Error(`Client dist contains unsupported entry: ${path}.`);
    }
    result.push(relative(root, path).split(sep).join('/'));
  }
  return result.sort();
}

function count(value, token) {
  return value.split(token).length - 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
