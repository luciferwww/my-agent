import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

export const CLIENT_CONFIG_TOKEN = '__MY_AGENT_CLIENT_CONFIG_JSON__';

export interface ClientHttpResource {
  readonly body: Buffer;
  readonly cacheControl: string;
  readonly contentType: string;
}

export async function loadBuiltClientResources(options: {
  readonly directoryPath: string;
  readonly clientPath: string;
  readonly webSocketPath: string;
}): Promise<ReadonlyMap<string, ClientHttpResource>> {
  const root = await realpath(options.directoryPath);
  const files = await inventoryDirectory(root, root);
  const index = files.find(file => file.relativePath === 'index.html');
  if (!index) {
    throw new Error('WebSocketChannel.start: client dist is missing index.html');
  }
  if (files.some(file => file.relativePath !== 'index.html' && extname(file.relativePath) === '.html')) {
    throw new Error('WebSocketChannel.start: client dist contains an unexpected HTML asset');
  }

  const indexSource = (await readFile(index.path)).toString('utf8');
  if (countOccurrences(indexSource, CLIENT_CONFIG_TOKEN) !== 1) {
    throw new Error('WebSocketChannel.start: client asset must contain exactly one config token');
  }
  const configJson = JSON.stringify({ webSocketPath: options.webSocketPath })
    .replaceAll('<', '\\u003c');
  const resources = new Map<string, ClientHttpResource>([[
    options.clientPath,
    Object.freeze({
      body: Buffer.from(indexSource.replace(CLIENT_CONFIG_TOKEN, configJson)),
      cacheControl: 'no-store',
      contentType: 'text/html; charset=utf-8',
    }),
  ]]);

  for (const file of files) {
    if (file === index) continue;
    if (extname(file.relativePath) === '.map') {
      throw new Error('WebSocketChannel.start: client dist contains a source map');
    }
    const requestPath = new URL(
      `./${file.relativePath}`,
      `http://localhost${options.clientPath}`,
    ).pathname;
    if (requestPath === options.webSocketPath || resources.has(requestPath)) {
      throw new Error(`WebSocketChannel.start: duplicate client resource path "${requestPath}"`);
    }
    resources.set(requestPath, Object.freeze({
      body: await readFile(file.path),
      cacheControl: 'public, max-age=31536000, immutable',
      contentType: contentType(file.relativePath),
    }));
  }

  return resources;
}

interface InventoriedFile {
  readonly path: string;
  readonly relativePath: string;
}

async function inventoryDirectory(
  root: string,
  directory: string,
): Promise<readonly InventoriedFile[]> {
  const files: InventoriedFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('WebSocketChannel.start: client dist contains a symbolic link');
    }
    if (entry.isDirectory()) {
      files.push(...await inventoryDirectory(root, path));
      continue;
    }
    if (!entry.isFile() || !(await lstat(path)).isFile()) {
      throw new Error('WebSocketChannel.start: client dist contains an unsupported entry');
    }
    files.push(Object.freeze({
      path,
      relativePath: relative(root, path).split(sep).join('/'),
    }));
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function countOccurrences(value: string, token: string): number {
  return value.split(token).length - 1;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css': return 'text/css; charset=utf-8';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.jpeg':
    case '.jpg': return 'image/jpeg';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.webp': return 'image/webp';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}
