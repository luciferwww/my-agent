import { readdir, readFile, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUIRED_FILES = Object.freeze([
  'hosts/standalone/entry.js',
  'extension-acquisition/index.js',
  'core/agent-context/templates/IDENTITY.md',
  'core/agent-context/templates/SOUL.md',
  'core/agent-context/templates/AGENTS.md',
  'core/agent-context/templates/TOOLS.md',
]);
const FORBIDDEN_IDENTITIES = Object.freeze([
  'COPILOT_RELAY_',
  'copilot-relay-provider',
  'createCopilotRelayProviderUnit',
]);
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));

export async function auditHostBuild(repositoryRoot = DEFAULT_REPOSITORY_ROOT) {
  const hostRoot = join(repositoryRoot, 'dist', 'host');
  const files = await listFiles(hostRoot);
  const relativeFiles = files.map((file) => toPosix(relative(hostRoot, file))).sort();
  const diagnostics = [];

  for (const required of REQUIRED_FILES) {
    if (!relativeFiles.includes(required)) diagnostics.push(`missing required file: ${required}`);
  }
  const entryPath = join(hostRoot, 'hosts', 'standalone', 'entry.js');
  if (relativeFiles.includes('hosts/standalone/entry.js')) {
    const entrySource = await readFile(entryPath, 'utf8');
    if (!entrySource.startsWith('#!/usr/bin/env node\n')) {
      diagnostics.push('standalone entry is missing the Node executable shebang');
    }
  }
  for (const file of relativeFiles) {
    if (file.startsWith('extensions/')) diagnostics.push(`concrete Extension emitted: ${file}`);
    if (file.includes('/test-fixtures/') || /(?:^|\/)test-fixtures\//u.test(file)) {
      diagnostics.push(`test fixture emitted: ${file}`);
    }
    if (/\.test\.js$/u.test(file)) diagnostics.push(`test emitted: ${file}`);
  }

  const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const runtimeDependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
  for (const file of files.filter((candidate) => candidate.endsWith('.js'))) {
    const source = await readFile(file, 'utf8');
    for (const identity of FORBIDDEN_IDENTITIES) {
      if (source.includes(identity)) {
        diagnostics.push(`concrete Extension identity in ${toPosix(relative(hostRoot, file))}: ${identity}`);
      }
    }
    for (const specifier of staticModuleSpecifiers(source, file)) {
      if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier)) continue;
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        if (!isContained(hostRoot, target) || !(await isFile(target))) {
          diagnostics.push(
            `unresolved or escaping relative import in ${toPosix(relative(hostRoot, file))}: ${specifier}`,
          );
        }
        continue;
      }
      if (isAbsolute(specifier) || specifier.startsWith('file:')) {
        diagnostics.push(
          `absolute static import in ${toPosix(relative(hostRoot, file))}: ${specifier}`,
        );
        continue;
      }
      const packageRoot = packageName(specifier);
      if (!runtimeDependencies.has(packageRoot)) {
        diagnostics.push(
          `undeclared runtime package in ${toPosix(relative(hostRoot, file))}: ${specifier}`,
        );
      }
    }
  }

  if (diagnostics.length > 0) {
    throw new Error(`Host build audit failed:\n${diagnostics.sort().join('\n')}`);
  }
  return Object.freeze(relativeFiles);
}

async function listFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Host build contains a non-file entry: ${path}`);
  }
  return files;
}

function staticModuleSpecifiers(source, path) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function packageName(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function isContained(root, target) {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function toPosix(path) {
  return path.replaceAll('\\', '/');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const files = await auditHostBuild();
  console.log(`Host build audit passed (${files.length} files).`);
}
