import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import WebSocket from 'ws';

import { auditNpmPackage } from './audit-npm-package.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROCESS_TIMEOUT_MS = 60_000;

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'my-agent-package-'));
  const installationProject = join(temporaryRoot, 'installation-project');
  const startupCwd = join(temporaryRoot, 'startup-cwd');
  const firstStartHomeDirectory = join(temporaryRoot, 'first-start-home');
  const firstStartAgentHome = join(firstStartHomeDirectory, '.my-agent');
  const explicitHomeDirectory = join(temporaryRoot, 'explicit-fallback-home');
  const explicitAgentHome = join(temporaryRoot, 'explicit-agent-home');
  const configuredHomeDirectory = join(temporaryRoot, 'configured-home');
  const configuredAgentHome = join(configuredHomeDirectory, '.my-agent');
  let host;
  let packageFileCount;
  let failure;
  let failed = false;
  try {
    await Promise.all([
      mkdir(installationProject, { recursive: true }),
      mkdir(startupCwd, { recursive: true }),
      mkdir(explicitHomeDirectory, { recursive: true }),
      mkdir(configuredAgentHome, { recursive: true }),
    ]);
    const manifest = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
    const lockfile = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package-lock.json'), 'utf8'));
    const relayManifest = JSON.parse(await readFile(
      join(REPOSITORY_ROOT, 'extensions', 'copilot-relay-provider', 'package.json'),
      'utf8',
    ));
    const packResult = await runNpm(
      ['pack', '--json', '--pack-destination', temporaryRoot],
      REPOSITORY_ROOT,
    );
    const packed = parsePackResult(packResult.stdout);
    const files = auditNpmPackage(packed, manifest, lockfile, [relayManifest]);
    const tarball = join(temporaryRoot, basename(packed[0].filename));

    await writeFile(join(installationProject, 'package.json'), '{"private":true,"type":"module"}\n');
    await runNpm(
      ['install', '--no-audit', '--no-fund', tarball],
      installationProject,
      PROCESS_TIMEOUT_MS,
    );
    await access(join(installationProject, 'node_modules', '.bin', executableName('my-agent')));
    await verifyInstalledExtensionApiTypes(installationProject);
    await verifyInstalledExtensionAcquisition(installationProject);

    const isolatedEnvironment = createIsolatedHomeEnvironment(configuredHomeDirectory);

    const fatal = await runInstalledCommand(
      installationProject,
      startupCwd,
      ['--unknown-package-smoke'],
      PROCESS_TIMEOUT_MS,
      isolatedEnvironment,
    );
    assert(fatal.code === 1, `Installed command fatal smoke exited with ${String(fatal.code)}.`);
    assert(
      fatal.stdout === '',
      'Installed command emitted unexpected standard output at the fatal boundary.',
    );
    assert(
      fatal.stderr === 'HOST_ARGUMENT_INVALID: Unknown argument --unknown-package-smoke.\n',
      'Installed command emitted an unexpected fatal diagnostic.',
    );

    const installDir = join(installationProject, 'node_modules', 'my-agent');
    const firstStartInstallationBefore = await snapshotTree(installDir);
    const firstStartStartupCwdBefore = await snapshotTree(startupCwd);
    host = startInstalledCommand(
      installationProject,
      startupCwd,
      [],
      createIsolatedHomeEnvironment(firstStartHomeDirectory),
    );
    await waitForFileContent(
      join(firstStartAgentHome, 'config.json'),
      '{}\n',
      host,
      PROCESS_TIMEOUT_MS,
    );
    await stopChild(host);
    host = undefined;
    assert(
      await readFile(join(firstStartAgentHome, 'config.json'), 'utf8') === '{}\n',
      'First-start Agent configuration bytes changed after bootstrap.',
    );
    assertTreeUnchanged(
      firstStartInstallationBefore,
      await snapshotTree(installDir),
      'Installed package during first start',
    );
    assertTreeUnchanged(
      firstStartStartupCwdBefore,
      await snapshotTree(startupCwd),
      'Startup CWD during first start',
    );

    const explicitInstallationBefore = await snapshotTree(installDir);
    const explicitStartupCwdBefore = await snapshotTree(startupCwd);
    const explicitFallbackHomeBefore = await snapshotTree(explicitHomeDirectory);
    host = startInstalledCommand(
      installationProject,
      startupCwd,
      ['--agent-home', explicitAgentHome, '--builtin-channels', 'none'],
      createIsolatedHomeEnvironment(explicitHomeDirectory),
    );
    await waitForFileContent(
      join(explicitAgentHome, 'config.json'),
      '{}\n',
      host,
      PROCESS_TIMEOUT_MS,
    );
    await stopChild(host);
    host = undefined;
    assert(
      await readFile(join(explicitAgentHome, 'config.json'), 'utf8') === '{}\n',
      'Explicit Agent Home configuration bytes changed after bootstrap.',
    );
    assertTreeUnchanged(
      explicitInstallationBefore,
      await snapshotTree(installDir),
      'Installed package during explicit Agent Home first start',
    );
    assertTreeUnchanged(
      explicitStartupCwdBefore,
      await snapshotTree(startupCwd),
      'Startup CWD during explicit Agent Home first start',
    );
    assertTreeUnchanged(
      explicitFallbackHomeBefore,
      await snapshotTree(explicitHomeDirectory),
      'Fallback home during explicit Agent Home first start',
    );

    await writeFile(join(configuredAgentHome, 'config.json'), `${JSON.stringify({
      host: { mode: 'websocket' },
    }, null, 2)}\n`);
    const retiredHost = await runInstalledCommand(
      installationProject,
      startupCwd,
      ['--builtin-channels=none'],
      PROCESS_TIMEOUT_MS,
      isolatedEnvironment,
    );
    assert(retiredHost.code === 1, 'Installed command accepted the retired Host namespace.');
    assert(retiredHost.stdout === '', 'Retired Host rejection emitted unexpected standard output.');
    assert(
      retiredHost.stderr === 'Agent configuration contains unknown top-level namespace "host".\n',
      'Installed command emitted an unexpected retired Host diagnostic.',
    );
    await writeFile(join(configuredAgentHome, 'config.json'), '{}\n');
    const installationBefore = await snapshotTree(installDir);
    const startupCwdBefore = await snapshotTree(startupCwd);
    host = startInstalledCommand(
      installationProject,
      startupCwd,
      [],
      isolatedEnvironment,
    );
    const client = await connectWithRetry(
      'ws://127.0.0.1:8787/ws',
      host,
      PROCESS_TIMEOUT_MS,
    );
    try {
      client.send(JSON.stringify({ type: 'hello', clientId: 'installed-package-smoke' }));
      const message = await nextJsonMessage(client, PROCESS_TIMEOUT_MS);
      assert(message.type === 'hello_ack', 'Installed Host returned no WebSocket hello acknowledgement.');
      assert(
        message.clientId === 'installed-package-smoke',
        'Installed Host returned an unexpected WebSocket client identity.',
      );
    } finally {
      client.close();
    }
    await stopChild(host);
    host = undefined;
    await Promise.all([
      access(join(configuredAgentHome, 'config.json')),
      access(join(configuredAgentHome, 'IDENTITY.md')),
      access(join(configuredAgentHome, 'SOUL.md')),
      access(join(configuredAgentHome, 'AGENTS.md')),
      access(join(configuredAgentHome, 'TOOLS.md')),
      access(join(configuredAgentHome, 'memory.sqlite')),
    ]);
    assertTreeUnchanged(
      installationBefore,
      await snapshotTree(installDir),
      'Installed package',
    );
    assertTreeUnchanged(
      startupCwdBefore,
      await snapshotTree(startupCwd),
      'Startup CWD',
    );

    packageFileCount = files.length;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const cleanupErrors = [];
    if (host) {
      await attemptCleanup(() => stopChild(host), cleanupErrors);
    }
    await attemptCleanup(
      () => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      cleanupErrors,
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        failed ? [failure, ...cleanupErrors] : cleanupErrors,
        'npm package verification cleanup failed.',
      );
    }
  }
  if (failed) throw failure;
  console.log(
    `Verified npm package (${packageFileCount} files), Host-neutral default WebSocket startup, explicit Builtin selection, legacy Host rejection, and installed my-agent command.`,
  );
}

async function verifyInstalledExtensionAcquisition(installationProject) {
  const installDir = join(installationProject, 'node_modules', 'my-agent');
  const acquisitionModule = await import(pathToFileURL(join(
    installDir,
    'dist',
    'host',
    'extension',
    'acquisition',
    'index.js',
  )).href);
  const result = await acquisitionModule.acquireExtensions({
    extensionsDir: join(installDir, 'extensions'),
    extensionsConfig: {
      enabled: true,
      entries: { 'copilot-relay-provider': {} },
    },
    environment: {},
  });
  assert(result.diagnostics.length === 0, 'Installed Relay Extension produced diagnostics.');
  assert(
    result.loadedUnits.length === 1
      && result.loadedUnits[0]?.unitId === 'copilot-relay-provider',
    'Installed Relay Extension did not load through Host acquisition.',
  );
}

async function verifyInstalledExtensionApiTypes(installationProject) {
  const sourcePath = join(installationProject, 'extension-consumer.ts');
  const configPath = join(installationProject, 'tsconfig.json');
  await Promise.all([
    writeFile(sourcePath, [
      "import { createLoadedRuntimeUnit, type ExtensionLoadContext } from 'my-agent/extension-api';",
      '',
      'export function createExtension(context: ExtensionLoadContext) {',
      '  void context.config;',
      '  return createLoadedRuntimeUnit({',
      "    registration: { id: 'consumer', source: 'external', register() {} },",
      '    required: false,',
      '  });',
      '}',
      '',
    ].join('\n')),
    writeFile(configPath, `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['./extension-consumer.ts'],
    }, null, 2)}\n`),
  ]);

  const compiler = join(REPOSITORY_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = await collectChild(spawnManaged(process.execPath, [compiler, '--project', configPath], {
    cwd: installationProject,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }), PROCESS_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new Error(
      `Installed Extension API typecheck failed with exit ${String(result.code)}:\n${redactSubprocessOutput(result.stderr || result.stdout, installationProject)}`,
    );
  }
}

async function waitForFileContent(path, expectedContent, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await readFile(path, 'utf8') === expectedContent) return;
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Installed Host exited before first-start bootstrap with ${String(child.exitCode)}.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('Installed Host first-start configuration bootstrap timed out.');
}

function parsePackResult(stdout) {
  const jsonStart = stdout.lastIndexOf('\n[');
  const candidates = [stdout.trim(), ...(jsonStart < 0 ? [] : [stdout.slice(jsonStart + 1).trim()])];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0]?.filename === 'string') {
        return parsed;
      }
    } catch {
      // Expected when npm includes prepack lifecycle output before its JSON report.
    }
  }
  throw new Error('Could not parse the npm pack --json result.');
}

async function runNpm(args, cwd, timeoutMs = PROCESS_TIMEOUT_MS) {
  const npmCli = process.env['npm_execpath'];
  const child = spawnManaged(npmCli === undefined ? npmCommand() : process.execPath, [
    ...(npmCli === undefined ? [] : [npmCli]),
    ...args,
  ], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(npmCli === undefined && process.platform === 'win32' ? { shell: true } : {}),
  });
  const result = await collectChild(child, timeoutMs);
  if (result.code !== 0) {
    throw new Error(
      `npm ${args[0]} failed with exit ${String(result.code)}:\n${redactSubprocessOutput(result.stderr, cwd)}`,
    );
  }
  return result;
}

async function runInstalledCommand(binRoot, cwd, args, timeoutMs, environment) {
  return collectChild(startInstalledCommand(binRoot, cwd, args, environment), timeoutMs);
}

function startInstalledCommand(binRoot, cwd, args, environment) {
  const bin = resolve(binRoot, 'node_modules', '.bin', executableName('my-agent'));
  if (process.platform === 'win32') {
    return spawnManaged(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', bin, ...args], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return spawnManaged(bin, args, {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function createIsolatedHomeEnvironment(homeDirectory, environment = process.env) {
  return {
    ...environment,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
  };
}

export async function snapshotTree(root, relativeDir = '') {
  const snapshot = {};
  const entries = await readdir(join(root, relativeDir), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      snapshot[relativePath] = 'directory';
      Object.assign(snapshot, await snapshotTree(root, relativePath));
    } else if (entry.isFile()) {
      snapshot[relativePath] = `file:${await readFile(join(root, relativePath), 'base64')}`;
    } else if (entry.isSymbolicLink()) {
      snapshot[relativePath] = `symlink:${await readlink(join(root, relativePath))}`;
    } else {
      throw new Error(`Unsupported tree entry in immutability snapshot: ${relativePath}`);
    }
  }
  return snapshot;
}

export function assertTreeUnchanged(before, after, label) {
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    `${label} changed during Runtime operation.`,
  );
}

async function attemptCleanup(action, errors) {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

export async function collectChild(child, timeoutMs) {
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  let timeout;
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const deadline = new Promise((resolveDeadline) => {
    timeout = setTimeout(() => resolveDeadline(undefined), timeoutMs);
  });
  const result = await Promise.race([exited, deadline]);
  clearTimeout(timeout);
  if (result === undefined) {
    await terminateChildTree(child);
    await exited;
    throw new Error(`Subprocess timed out after ${timeoutMs} ms.`);
  }
  return { ...result, stdout: stdout.join(''), stderr: stderr.join('') };
}

function spawnManaged(command, args, options) {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  });
}

export function redactSubprocessOutput(output, cwd, environment = process.env) {
  let redacted = output.replaceAll(cwd, '<working-directory>');
  for (const [name, value] of Object.entries(environment)) {
    if (!/(?:AUTH|CREDENTIAL|KEY|PASS|SECRET|TOKEN)/iu.test(name) || !value) continue;
    redacted = redacted.replaceAll(value, '<redacted>');
  }
  return redacted;
}

export async function connectWithRetry(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Installed Host exited before WebSocket startup with ${String(child.exitCode)}.`);
    }
    const remainingMs = deadline - Date.now();
    try {
      return await connectWebSocket(url, Math.min(1_000, remainingMs));
    } catch {
      if (Date.now() >= deadline) break;
      await new Promise((resolveDelay) => setTimeout(
        resolveDelay,
        Math.min(50, deadline - Date.now()),
      ));
    }
  }
  throw new Error('Installed Host WebSocket startup timed out.');
}

function connectWebSocket(url, timeoutMs) {
  return new Promise((resolveConnection, rejectConnection) => {
    const client = new WebSocket(url);
    const timeout = setTimeout(() => {
      client.terminate();
      rejectConnection(new Error('WebSocket connection attempt timed out.'));
    }, timeoutMs);
    client.once('open', () => {
      clearTimeout(timeout);
      resolveConnection(client);
    });
    client.once('error', (error) => {
      clearTimeout(timeout);
      rejectConnection(error);
    });
  });
}

function nextJsonMessage(client, timeoutMs) {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => rejectMessage(new Error('WebSocket reply timed out.')), timeoutMs);
    client.once('message', (data) => {
      clearTimeout(timeout);
      try {
        resolveMessage(JSON.parse(data.toString()));
      } catch (error) {
        rejectMessage(error);
      }
    });
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timeout;
  const result = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise((resolveDeadline) => {
      timeout = setTimeout(() => resolveDeadline(false), timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  return result;
}

export async function terminateChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    let treeKilled = false;
    for (let attempt = 0; attempt < 2 && !treeKilled; attempt += 1) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      treeKilled = await waitForExit(killer, 5_000) && killer.exitCode === 0;
      if (!treeKilled && (child.exitCode !== null || child.signalCode !== null)) return;
    }
    if (!treeKilled) {
      throw new Error('Windows subprocess tree termination failed after two taskkill attempts.');
    }
    if (await waitForExit(child, 2_000)) return;
    child.kill('SIGKILL');
    if (!await waitForExit(child, 2_000)) {
      throw new Error('Subprocess tree did not terminate within the cleanup deadline.');
    }
    return;
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  if (await waitForExit(child, 2_000)) return;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  if (!await waitForExit(child, 2_000)) {
    throw new Error('Subprocess tree did not terminate within the cleanup deadline.');
  }
}

async function stopChild(child) {
  await terminateChildTree(child);
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) await main();