#!/usr/bin/env node

import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { runStandaloneHost } from './standalone-host.js';

async function main(): Promise<void> {
  try {
    await runStandaloneHost();
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// npm's POSIX bin is a symlink, while the module URL names its actual target.
if (process.argv[1] !== undefined && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  void main();
}