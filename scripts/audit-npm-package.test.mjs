import { describe, expect, it } from 'vitest';

import { auditNpmPackage } from './audit-npm-package.mjs';

const expectedBin = './dist/host/hosts/standalone/entry.js';

describe('npm package audit', () => {
  it('accepts the explicit Host and Extension package surface with matching metadata', () => {
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

  it('rejects an official Extension dependency missing from the root package closure', () => {
    expect(() => auditNpmPackage(packResult(), manifest(), lockfile(), [{
      name: '@my-agent/example-extension',
      dependencies: { 'example-runtime': '^1.0.0' },
    }])).toThrow(/Extension dependency example-runtime@\^1\.0\.0/u);
  });
});

function packResult() {
  return [{
    filename: 'my-agent-0.1.0.tgz',
    files: [
      { path: 'package.json' },
      { path: 'README.md' },
      { path: 'dist/host/extension/api/index.d.ts' },
      { path: 'dist/host/extension/api/index.js' },
      { path: 'dist/host/hosts/standalone/entry.js' },
      { path: 'dist/host/core/agent-context/templates/IDENTITY.md' },
      { path: 'dist/host/core/agent-context/templates/SOUL.md' },
      { path: 'dist/host/core/agent-context/templates/AGENTS.md' },
      { path: 'dist/host/core/agent-context/templates/TOOLS.md' },
      { path: 'extensions/copilot-relay-provider/entry.ts' },
      { path: 'extensions/copilot-relay-provider/extension.json' },
      { path: 'extensions/copilot-relay-provider/package.json' },
    ],
  }];
}

function manifest() {
  return {
    files: [
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
    ],
    bin: { 'my-agent': expectedBin },
    exports: {
      './extension-api': {
        types: './dist/host/extension/api/index.d.ts',
        default: './dist/host/extension/api/index.js',
      },
    },
  };
}

function lockfile() {
  return { packages: { '': { bin: { 'my-agent': expectedBin.slice(2) } } } };
}