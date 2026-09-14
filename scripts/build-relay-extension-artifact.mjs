import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELAY_ARTIFACT_FILES = Object.freeze([
  'copilot-relay-provider-unit.js',
  'copilot-relay-provider.js',
  'entry.js',
  'extension.json',
  'model-metadata.js',
  'package.json',
  'responses-client.js',
]);

const RUNTIME_FILES = RELAY_ARTIFACT_FILES.filter((file) => file.endsWith('.js'));
const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

export async function buildRelayExtensionArtifact(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
) {
  const emittedRelayRoot = join(
    repositoryRoot,
    'dist',
    'extensions',
    'copilot-relay-provider',
  );
  const sourceDescriptor = join(
    repositoryRoot,
    'src',
    'extensions',
    'copilot-relay-provider',
    'extension.json',
  );
  const artifactRoot = join(
    repositoryRoot,
    'dist',
    'extension-artifacts',
    'copilot-relay-provider',
  );

  const [descriptorSource, ...runtimeSources] = await Promise.all([
    readFile(sourceDescriptor, 'utf8'),
    ...RUNTIME_FILES.map(async (file) => stripSourceMapReference(
      await readFile(join(emittedRelayRoot, file), 'utf8'),
    )),
  ]);

  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(artifactRoot, { recursive: true });
  await Promise.all([
    writeFile(join(artifactRoot, 'extension.json'), ensureTrailingNewline(descriptorSource)),
    writeFile(join(artifactRoot, 'package.json'), '{\n  "type": "module"\n}\n'),
    ...RUNTIME_FILES.map((file, index) =>
      writeFile(join(artifactRoot, file), runtimeSources[index])),
  ]);

  console.log(`Built Relay Extension artifact at ${relativeTo(repositoryRoot, artifactRoot)}.`);
}

function stripSourceMapReference(source) {
  return ensureTrailingNewline(source.replace(
    /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/u,
    '',
  ));
}

function ensureTrailingNewline(value) {
  return `${value.replace(/[\r\n]+$/u, '')}\n`;
}

function relativeTo(root, path) {
  return path.slice(resolve(root).length + 1).replaceAll('\\', '/');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await buildRelayExtensionArtifact();
}
