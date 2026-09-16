import { describe, expect, it } from 'vitest';

import { auditNpmPackage } from './audit-npm-package.mjs';

const expectedBin = './dist/host/hosts/standalone/entry.js';

describe('npm package audit', () => {
  it('accepts the explicit Host-only package surface and matching bin metadata', () => {
    expect(auditNpmPackage(packResult(), manifest(), lockfile())).toContain(
      'dist/host/hosts/standalone/entry.js',
    );
  });

  it('rejects files outside the accepted tarball root', () => {
    const result = packResult();
    result[0].files.push({ path: 'src/hosts/standalone/entry.ts' });

    expect(() => auditNpmPackage(result, manifest(), lockfile()))
      .toThrow(/unexpected package file/u);
  });

  it('rejects missing runtime assets and divergent package metadata', () => {
    const result = packResult();
    result[0].files = result[0].files.filter(
      ({ path }) => path !== 'dist/host/core/agent-context/templates/IDENTITY.md',
    );
    const staleLock = lockfile();
    staleLock.packages[''].bin['my-agent'] = 'dist/host/scripts/standalone-host.js';

    expect(() => auditNpmPackage(result, { ...manifest(), files: ['dist'] }, staleLock))
      .toThrow(/files allowlist|missing package file|package lock/u);
  });
});

function packResult() {
  return [{
    filename: 'my-agent-0.1.0.tgz',
    files: [
      { path: 'package.json' },
      { path: 'README.md' },
      { path: 'dist/host/hosts/standalone/entry.js' },
      { path: 'dist/host/core/agent-context/templates/IDENTITY.md' },
      { path: 'dist/host/core/agent-context/templates/SOUL.md' },
      { path: 'dist/host/core/agent-context/templates/AGENTS.md' },
      { path: 'dist/host/core/agent-context/templates/TOOLS.md' },
    ],
  }];
}

function manifest() {
  return { files: ['dist/host'], bin: { 'my-agent': expectedBin } };
}

function lockfile() {
  return { packages: { '': { bin: { 'my-agent': expectedBin.slice(2) } } } };
}