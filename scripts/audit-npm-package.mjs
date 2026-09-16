const EXPECTED_BIN = 'dist/host/hosts/standalone/entry.js';
const REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json',
  'README.md',
  EXPECTED_BIN,
  'dist/host/core/agent-context/templates/IDENTITY.md',
  'dist/host/core/agent-context/templates/SOUL.md',
  'dist/host/core/agent-context/templates/AGENTS.md',
  'dist/host/core/agent-context/templates/TOOLS.md',
]);

export function auditNpmPackage(packResult, manifest, lockfile) {
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
    if (path === 'package.json' || path === 'README.md' || path.startsWith('dist/host/')) {
      continue;
    }
    diagnostics.push(`unexpected package file: ${path}`);
  }

  if (JSON.stringify(manifest.files) !== JSON.stringify(['dist/host'])) {
    diagnostics.push('package files allowlist must be exactly ["dist/host"]');
  }
  if (normalizeBin(manifest.bin?.['my-agent']) !== EXPECTED_BIN) {
    diagnostics.push(`package bin.my-agent must target ${EXPECTED_BIN}`);
  }
  if (normalizeBin(lockfile.packages?.['']?.bin?.['my-agent']) !== EXPECTED_BIN) {
    diagnostics.push(`package lock bin.my-agent must target ${EXPECTED_BIN}`);
  }

  if (diagnostics.length > 0) {
    throw new Error(`npm package audit failed:\n${diagnostics.sort().join('\n')}`);
  }
  return Object.freeze(uniqueFiles);
}

function normalizeBin(value) {
  return typeof value === 'string' ? value.replace(/^\.\//u, '') : value;
}