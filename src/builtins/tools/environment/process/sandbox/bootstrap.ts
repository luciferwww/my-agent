import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const BOOTSTRAP_REQUEST_BYTES = 64 * 1024;
export const BOOTSTRAP_FRAME_BYTES = 4 * 1024;
export const OUTPUT_DRAIN_MS = 1000;
export const ROOT_VARIABLE = 'MY_AGENT_SANDBOX_ROOT';

const RESERVED_ENVIRONMENT = new Set([
  'systemroot', 'windir', 'systemdrive', 'comspec', 'path', 'pathext',
  'home', 'userprofile', 'localappdata', 'temp', 'tmp', 'tmpdir',
  ROOT_VARIABLE.toLowerCase(), 'npm_config_cache', 'npm_config_offline',
  'npm_config_update_notifier',
]);
const LINUX_RESERVED_ENVIRONMENT = new Set([
  'PATH', 'SHELL', 'HOME', 'TEMP', 'TMP', 'TMPDIR', ROOT_VARIABLE,
  'npm_config_cache', 'npm_config_offline', 'npm_config_update_notifier',
]);

export interface BootstrapRequest {
  command: string;
  root: string;
  environment: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function validateCommandEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('Exec environment must be a string record');
  const names = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const [name, content] of Object.entries(value)) {
    const normalized = process.platform === 'win32' ? name.toLowerCase() : name;
    if (!name || /[=\0]/u.test(name) || typeof content !== 'string' || content.includes('\0')) {
      throw new Error('Invalid exec environment entry');
    }
    if (names.has(normalized)) throw new Error(`Duplicate exec environment name: ${name}`);
    const reserved = process.platform === 'win32' ? RESERVED_ENVIRONMENT : LINUX_RESERVED_ENVIRONMENT;
    if (reserved.has(normalized)) throw new Error(`Reserved sandbox environment name: ${name}`);
    names.add(normalized);
    entries.push([name, content]);
  }
  return Object.fromEntries(entries);
}

export function parseBootstrapRequest(text: string): BootstrapRequest {
  if (Buffer.byteLength(text) > BOOTSTRAP_REQUEST_BYTES) throw new Error('Sandbox request exceeds 64 KiB');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid sandbox bootstrap JSON');
  }
  if (!isRecord(value) || Object.keys(value).some(name => !['command', 'root', 'environment'].includes(name))
    || typeof value.command !== 'string' || !value.command.trim() || value.command.includes('\0')
    || typeof value.root !== 'string' || !isAbsolute(value.root) || value.root.includes('\0')) {
    throw new Error('Invalid sandbox bootstrap request');
  }
  return { command: value.command, root: value.root, environment: validateCommandEnvironment(value.environment) };
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

function pathIdentity(path: string): string {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
}

export function prepareChildEnvironment(
  request: BootstrapRequest,
  bootstrapEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const boundRoot = bootstrapEnvironment[ROOT_VARIABLE];
  if (!boundRoot || pathIdentity(boundRoot) !== pathIdentity(request.root)) {
    throw new Error('Sandbox request does not match the owned temporary root');
  }
  const root = realpathSync.native(request.root);
  function prepare(path: string | undefined): string {
    if (!path || !isAbsolute(path) || !within(root, resolve(path))) {
      throw new Error('Sandbox temporary path is outside the owned root');
    }
    let parent = path;
    while (!existsSync(parent)) parent = dirname(parent);
    if (!within(root, realpathSync.native(parent))) throw new Error('Sandbox temporary path resolves outside the owned root');
    mkdirSync(path, { recursive: true });
    if (!within(root, realpathSync.native(path))) throw new Error('Sandbox temporary path resolves outside the owned root');
    return path;
  }
  if (process.platform === 'win32') {
    for (const name of ['TEMP', 'TMP', 'LOCALAPPDATA']) prepare(bootstrapEnvironment[name]);
  }
  const inherited = Object.fromEntries(Object.entries(bootstrapEnvironment)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'
      && (process.platform === 'win32'
        ? entry[0].toLowerCase() !== ROOT_VARIABLE.toLowerCase()
        : entry[0] !== ROOT_VARIABLE)));
  const platformEnvironment: Record<string, string> = process.platform === 'win32'
    ? {
        TEMP: prepare(join(root, 'tmp')),
        TMP: prepare(join(root, 'tmp')),
        LOCALAPPDATA: prepare(join(root, 'appdata')),
        USERPROFILE: prepare(join(root, 'home')),
      }
    : { TMPDIR: '/tmp', SHELL: '/bin/sh' };
  return {
    ...inherited,
    ...platformEnvironment,
    HOME: prepare(join(root, 'home')),
    npm_config_cache: prepare(join(root, 'npm-cache')),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    ...validateCommandEnvironment(request.environment),
  };
}

export function superviseChild(
  child: ChildProcess,
  output: Writable,
  errors: Writable,
  exit: (code: number) => void,
): void {
  let ready = false;
  let finished = false;
  let shellCode: number | null = null;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number, message?: string) => {
    if (finished) return;
    finished = true;
    if (drain) clearTimeout(drain);
    child.stdout?.unpipe(output);
    child.stderr?.unpipe(errors);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (message) errors.write(`${message}\n`);
    output.write('', () => errors.write('', () => exit(code)));
  };
  const failure = () => {
    if (!ready) output.write(`${JSON.stringify({ type: 'failed', message: 'Sandbox command could not start' })}\n`);
    finish(1, `Sandbox output or command failure; original Shell exit code: ${shellCode ?? 'unknown'}`);
  };
  output.on('error', () => exit(1));
  errors.on('error', () => exit(1));
  child.stdout?.on('error', failure);
  child.stderr?.on('error', failure);
  child.once('error', failure);
  child.once('spawn', () => {
    if (!child.pid || finished) return failure();
    ready = true;
    output.write(`${JSON.stringify({ type: 'started', pid: child.pid })}\n`, () => {
      if (finished) return;
      child.stdout?.pipe(output, { end: false });
      child.stderr?.pipe(errors, { end: false });
    });
  });
  child.once('exit', code => {
    shellCode = code;
    if (!finished) drain = setTimeout(() => finish(1,
      `Sandbox output incomplete after Shell exit; original Shell exit code: ${code ?? 'unknown'}`), OUTPUT_DRAIN_MS);
  });
  child.once('close', code => {
    if (!ready) return failure();
    finish(code ?? 1);
  });
}

async function readRequest(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid sandbox stdin chunk');
    length += chunk.length;
    if (length > BOOTSTRAP_REQUEST_BYTES) throw new Error('Sandbox request exceeds 64 KiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  try {
    const request = parseBootstrapRequest(await readRequest(process.stdin));
    const environment = prepareChildEnvironment(request, process.env);
    const shell = process.platform === 'win32' ? environment.ComSpec : '/bin/sh';
    if (!shell || !isAbsolute(shell)) throw new Error('Sandbox Shell is unavailable');
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', request.command] : ['-c', request.command];
    const child = spawn(shell, args, {
      cwd: process.cwd(), env: environment, shell: false,
      ...(process.platform === 'win32' ? { windowsHide: true, windowsVerbatimArguments: true } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    superviseChild(child, process.stdout, process.stderr, code => process.exit(code));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sandbox bootstrap failed';
    process.stdout.write(`${JSON.stringify({ type: 'failed', message })}\n`, () => process.exit(1));
  }
}

if (process.argv[1] && pathIdentity(process.argv[1]) === pathIdentity(fileURLToPath(import.meta.url))) {
  void main();
}
