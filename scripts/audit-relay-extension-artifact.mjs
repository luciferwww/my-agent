import { execFile } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { RELAY_ARTIFACT_FILES } from './build-relay-extension-artifact.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const artifactRoot = join(
  repositoryRoot,
  'dist',
  'extension-artifacts',
  'copilot-relay-provider',
);
const buildRoot = join(repositoryRoot, 'dist');
const runtimeFiles = RELAY_ARTIFACT_FILES.filter((file) => file.endsWith('.js'));

auditImportScannerFixtures();
await auditArtifactContents();
await auditRelocatedAcquisitionAndInvocation();
console.log(`Relay Extension artifact audit passed (${RELAY_ARTIFACT_FILES.length} files).`);

async function auditArtifactContents() {
  const entries = await readdir(artifactRoot, { withFileTypes: true });
  const actualFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (entries.some((entry) => !entry.isFile())
    || JSON.stringify(actualFiles) !== JSON.stringify(RELAY_ARTIFACT_FILES)) {
    throw new Error(`Relay artifact allowlist mismatch: ${actualFiles.join(', ')}`);
  }

  const packageJson = JSON.parse(await readFile(join(artifactRoot, 'package.json'), 'utf8'));
  if (JSON.stringify(packageJson) !== JSON.stringify({ type: 'module' })) {
    throw new Error('Relay artifact package.json must only mark the ESM package scope.');
  }

  const descriptor = JSON.parse(await readFile(join(artifactRoot, 'extension.json'), 'utf8'));
  if (descriptor.manifestVersion !== 1
    || descriptor.id !== 'copilot-relay-provider'
    || descriptor.entry !== 'entry.js'
    || typeof descriptor.version !== 'string'
    || !descriptor.version
    || descriptor.configSchema?.$schema !== 'http://json-schema.org/draft-07/schema#'
    || descriptor.configSchema?.type !== 'object'
    || descriptor.configSchema?.additionalProperties !== false) {
    throw new Error('Relay artifact extension.json does not satisfy the v1 Descriptor contract.');
  }

  const importsByFile = new Map();
  for (const file of runtimeFiles) {
    const path = join(artifactRoot, file);
    const source = await readFile(path, 'utf8');
    if (source.includes('sourceMappingURL=') || source.includes('sourceURL=')) {
      throw new Error(`Relay artifact includes source metadata in ${file}.`);
    }
    const specifiers = collectRuntimeModuleSpecifiers(source, file);
    const dependencies = [];
    for (const specifier of specifiers) {
      if (!isAllowedRuntimeSpecifier(specifier)) {
        throw new Error(`Relay artifact ${file} has forbidden runtime import ${specifier}.`);
      }
      const target = resolve(dirname(path), specifier);
      if (!isContainedPath(artifactRoot, target)) {
        throw new Error(`Relay artifact ${file} has escaping runtime import ${specifier}.`);
      }
      const targetName = relative(artifactRoot, target).replaceAll('\\', '/');
      if (!runtimeFiles.includes(targetName)) {
        throw new Error(`Relay artifact ${file} imports non-allowlisted file ${targetName}.`);
      }
      dependencies.push(targetName);
    }
    importsByFile.set(file, dependencies);
  }

  const reachable = new Set();
  const visit = (file) => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const dependency of importsByFile.get(file) ?? []) visit(dependency);
  };
  visit('entry.js');
  const unreachable = runtimeFiles.filter((file) => !reachable.has(file));
  if (unreachable.length > 0) {
    throw new Error(`Relay artifact has runtime files outside the entry closure: ${unreachable.join(', ')}`);
  }
}

function collectRuntimeModuleSpecifiers(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`Relay artifact contains invalid JavaScript in ${file}.`);
  }
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        throw new Error(`Relay artifact ${file} has a non-literal module specifier.`);
      }
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const [argument] = node.arguments;
      if (!argument || !ts.isStringLiteral(argument)) {
        throw new Error(`Relay artifact ${file} has a non-literal runtime import.`);
      }
      specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function auditImportScannerFixtures() {
  const found = collectRuntimeModuleSpecifiers([
    'import value from "./static.js";',
    'export { value } from "./exported.js";',
    'await import("./dynamic.js");',
    'require("./required.js");',
  ].join('\n'), 'audit-fixture.js');
  if (found.join(',') !== './static.js,./exported.js,./dynamic.js,./required.js') {
    throw new Error('Relay artifact import scanner rejected its syntax fixtures.');
  }
  for (const forbidden of ['../escape.js', 'node:fs', 'typescript', 'file:///escape.js']) {
    if (isAllowedRuntimeSpecifier(forbidden)) {
      throw new Error(`Relay artifact import policy accepted forbidden fixture ${forbidden}.`);
    }
  }
}

function isAllowedRuntimeSpecifier(specifier) {
  return specifier.startsWith('./')
    && !specifier.includes('\\')
    && specifier.endsWith('.js');
}

async function auditRelocatedAcquisitionAndInvocation() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'my-agent-relay-artifact-'));
  const extensionsDir = join(temporaryRoot, 'installation', 'extensions');
  const installationRoot = join(extensionsDir, 'renamed-relay-directory');
  const backupBuildRoot = `${buildRoot}.artifact-audit-backup`;
  const server = createRelayServer();
  let buildRootRenamed = false;

  try {
    await mkdir(dirname(installationRoot), { recursive: true });
    await cp(artifactRoot, installationRoot, { recursive: true });
    const baseURL = await listen(server);
    const acquisition = await import(pathToFileURL(join(
      repositoryRoot,
      'dist',
      'extension-acquisition',
      'index.js',
    )).href);
    const result = await acquisition.acquireExtensions({
      extensionsDir,
      extensionsConfig: {
        enabled: true,
        entries: {
          'copilot-relay-provider': {
            enabled: true,
            config: { baseURL },
          },
        },
      },
      environment: {},
    });
    if (result.diagnostics.length !== 0
      || result.loadedUnits.length !== 1
      || result.loadedUnits[0]?.unitId !== 'copilot-relay-provider') {
      throw new Error('Relocated Relay artifact failed generic acquisition.');
    }

    const runnerPath = join(temporaryRoot, 'run-relocated-artifact.mjs');
    await writeFile(runnerPath, relocatedRunnerSource());
    await rm(backupBuildRoot, { recursive: true, force: true });
    await rename(buildRoot, backupBuildRoot);
    buildRootRenamed = true;

    await execFileAsync(process.execPath, [runnerPath], {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        RELAY_ARTIFACT_ENTRY: pathToFileURL(join(installationRoot, 'entry.js')).href,
        RELAY_BASE_URL: baseURL,
      },
      timeout: 15_000,
      windowsHide: true,
    });
  } finally {
    if (buildRootRenamed) await rename(backupBuildRoot, buildRoot);
    if (server.listening) {
      await new Promise((resolveClose, rejectClose) => server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      }));
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function createRelayServer() {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: [{
          id: 'artifact/model',
          name: 'Artifact Model',
          supported_endpoints: ['/responses'],
          capabilities: {
            limits: { max_prompt_tokens: 4096, max_output_tokens: 512 },
            supports: { tool_calls: true, vision: false },
          },
        }],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/responses') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        'data: {"type":"response.created"}',
        '',
        'data: {"type":"response.output_text.delta","delta":"artifact-ok"}',
        '',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'));
      return;
    }
    response.writeHead(404);
    response.end();
  });
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Relay audit server has no TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

function relocatedRunnerSource() {
  return `
const entryURL = process.env.RELAY_ARTIFACT_ENTRY;
const baseURL = process.env.RELAY_BASE_URL;
if (!entryURL || !baseURL) throw new Error('Relocated artifact runner is missing inputs.');
const extension = await import(entryURL);
if (Object.keys(extension).join(',') !== 'createExtension') {
  throw new Error('Relay artifact entry must expose only createExtension.');
}
const unit = extension.createExtension(Object.freeze({
  config: Object.freeze({ baseURL, discoveryTimeoutMs: 5000 }),
}));
if (unit.unitId !== 'copilot-relay-provider' || unit.dependencies.length !== 0) {
  throw new Error('Relay artifact returned invalid Unit metadata.');
}
const controller = new AbortController();
const instance = await unit.create(controller.signal);
let provider;
instance.registration.register({ registerProvider(value) { provider = value; } });
if (!provider || provider.models[0]?.modelId !== 'artifact/model') {
  throw new Error('Relay artifact did not register its discovered Model Catalog.');
}
const result = await provider.invocationPort.chat({
  model: 'artifact/model',
  maxTokens: 32,
  messages: [{ role: 'user', content: 'artifact smoke' }],
  signal: controller.signal,
});
if (result.content[0]?.type !== 'text' || result.content[0]?.text !== 'artifact-ok') {
  throw new Error('Relay artifact invocation smoke returned an unexpected response.');
}
await instance.stop();
`;
}

function isContainedPath(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}
