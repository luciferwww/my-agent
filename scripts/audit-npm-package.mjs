const EXPECTED_BIN = 'dist/host/hosts/standalone/entry.js';
const EXPECTED_FILES_ALLOWLIST = Object.freeze([
  'dist/host',
  'extensions/copilot-relay-provider/copilot-relay-provider-unit.ts',
  'extensions/copilot-relay-provider/copilot-relay-provider.ts',
  'extensions/copilot-relay-provider/entry.ts',
  'extensions/copilot-relay-provider/extension.json',
  'extensions/copilot-relay-provider/index.ts',
  'extensions/copilot-relay-provider/model-metadata.ts',
  'extensions/copilot-relay-provider/package.json',
  'extensions/copilot-relay-provider/responses-client.ts',
  'extensions/copilot-relay-provider/types.ts',
  'extensions/websocket-channel/WebSocketChannel.ts',
  'extensions/websocket-channel/client/chat.html',
  'extensions/websocket-channel/config.ts',
  'extensions/websocket-channel/entry.ts',
  'extensions/websocket-channel/extension.json',
  'extensions/websocket-channel/index.ts',
  'extensions/websocket-channel/package.json',
  'extensions/websocket-channel/websocket-channel-unit.ts',
  'extensions/websocket-channel/websocket-constants.ts',
]);
const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json',
  'README.md',
  EXPECTED_BIN,
  'dist/host/extension/api/index.d.ts',
  'dist/host/extension/api/index.js',
  'extensions/copilot-relay-provider/entry.ts',
  'extensions/copilot-relay-provider/extension.json',
  'extensions/copilot-relay-provider/package.json',
  'extensions/websocket-channel/WebSocketChannel.ts',
  'extensions/websocket-channel/client/chat.html',
  'extensions/websocket-channel/entry.ts',
  'extensions/websocket-channel/extension.json',
  'extensions/websocket-channel/package.json',
  'dist/host/core/agent-context/templates/IDENTITY.md',
  'dist/host/core/agent-context/templates/SOUL.md',
  'dist/host/core/agent-context/templates/AGENTS.md',
  'dist/host/core/agent-context/templates/TOOLS.md',
]);

export function auditNpmPackage(packResult, manifest, lockfile, extensionManifests = []) {
  const diagnostics = [];
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    diagnostics.push('npm pack must report exactly one tarball');
  }

  const files = Array.isArray(packResult?.[0]?.files)
    ? packResult[0].files.map((file) => file?.path).filter((path) => typeof path === 'string')
    : [];
  const uniqueFiles = [...new Set(files)].sort();
  if (uniqueFiles.length !== files.length) diagnostics.push('tarball contains duplicate file paths');

  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!uniqueFiles.includes(required)) diagnostics.push(`missing package file: ${required}`);
  }
  for (const path of uniqueFiles) {
    if (path === 'package.json'
      || path === 'README.md'
      || path.startsWith('dist/host/')
      || path.startsWith('extensions/copilot-relay-provider/')
      || path.startsWith('extensions/websocket-channel/')) {
      continue;
    }
    diagnostics.push(`unexpected package file: ${path}`);
  }

  if (JSON.stringify(manifest.files) !== JSON.stringify(EXPECTED_FILES_ALLOWLIST)) {
    diagnostics.push('package files allowlist does not match the supported Host and Extension surface');
  }
  if (normalizeBin(manifest.bin?.['my-agent']) !== EXPECTED_BIN) {
    diagnostics.push(`package bin.my-agent must target ${EXPECTED_BIN}`);
  }
  if (normalizeBin(lockfile.packages?.['']?.bin?.['my-agent']) !== EXPECTED_BIN) {
    diagnostics.push(`package lock bin.my-agent must target ${EXPECTED_BIN}`);
  }
  if (manifest.exports?.['./extension-api']?.types !== './dist/host/extension/api/index.d.ts'
    || manifest.exports?.['./extension-api']?.default !== './dist/host/extension/api/index.js') {
    diagnostics.push('package exports must expose the supported Extension API');
  }
  for (const extensionManifest of extensionManifests) {
    for (const [dependency, range] of Object.entries(extensionManifest.dependencies ?? {})) {
      if (manifest.dependencies?.[dependency] !== range
        || lockfile.packages?.['']?.dependencies?.[dependency] !== range) {
        diagnostics.push(
          `Extension dependency ${dependency}@${range} from ${extensionManifest.name ?? '<unnamed>'} is missing from the root package closure`,
        );
      }
    }
  }

  if (diagnostics.length > 0) {
    throw new Error(`npm package audit failed:\n${diagnostics.sort().join('\n')}`);
  }
  return Object.freeze(uniqueFiles);
}

function normalizeBin(value) {
  return typeof value === 'string' ? value.replace(/^\.\//u, '') : value;
}