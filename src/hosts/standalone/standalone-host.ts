import { homedir } from 'node:os';
import { join } from 'node:path';

import { createCliChannelUnit } from '../../builtins/channels/cli/index.js';
import { createWebSocketChannelUnit } from '../../builtins/channels/websocket/index.js';
import {
  formatAcquisitionWarning,
  formatRuntimeWarning,
  prepareStandaloneHostAcquisition,
  type StandaloneHostAcquisition,
} from './host-startup.js';
import {
  getEnvOverrides,
  loadAgentConfig,
  type StandaloneHostConfigProjection,
  type AgentConfigSnapshot,
} from '../../platform/config/index.js';
import { RuntimeApp, type RuntimeHandle } from '../../runtime/index.js';
import type { LoadedRuntimeUnit } from '../../runtime/runtime-unit.js';
import type { AgentPathContext } from '../path-context.js';
import { resolveStandaloneHostPathContext } from './path-context.js';
import { createRuntimeHost } from './runtime-host.js';

export interface StandaloneHostRunOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly resolvePathContext?: () => Promise<AgentPathContext>;
  readonly loadConfig?: typeof loadAgentConfig;
  readonly prepareAcquisition?: (
    extensionsDir: string,
    extensionsConfig: AgentConfigSnapshot['extensions'],
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<StandaloneHostAcquisition>;
  readonly createRuntime?: typeof RuntimeApp.create;
  readonly createHost?: typeof createRuntimeHost;
}

export function parseStandaloneHostArguments(
  argv: readonly string[],
): void {
  if (argv.length > 0) {
    throw new Error(`HOST_ARGUMENT_INVALID: Unknown argument ${argv[0]}.`);
  }
}

export function validateStandaloneHostComposition(snapshot: AgentConfigSnapshot): void {
  if (snapshot.host.mode === 'cli' && snapshot.application.logger.console?.enabled !== false) {
    throw new Error(
      'HOST_OUTPUT_CONFLICT: CLI Channel and Console Logger cannot be enabled together.',
    );
  }
}

export function createBuiltinHostUnits(
  host: StandaloneHostConfigProjection,
): readonly LoadedRuntimeUnit[] {
  switch (host.mode) {
    case 'websocket':
      return Object.freeze([createWebSocketChannelUnit(host.websocket)]);
    case 'cli':
      return Object.freeze([createCliChannelUnit(host.cli)]);
    case 'headless':
      return Object.freeze([]);
  }
}

export async function runStandaloneHost(
  options: StandaloneHostRunOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  parseStandaloneHostArguments(options.argv ?? process.argv.slice(2));
  const pathContext = await (options.resolvePathContext ?? (() =>
    resolveStandaloneHostPathContext({
      moduleUrl: import.meta.url,
      homeDirectory: homedir(),
      workingDirectory: process.cwd(),
    })))();
  const snapshot = await (options.loadConfig ?? loadAgentConfig)({
    agentHome: pathContext.agentHome,
  });
  validateStandaloneHostComposition(snapshot);

  const acquisition = await (options.prepareAcquisition ?? prepareStandaloneHostAcquisition)(
    join(pathContext.installDir, 'extensions'),
    snapshot.extensions,
    env,
  );
  reportDiagnostics(acquisition, stderr);

  const builtinUnits = createBuiltinHostUnits(snapshot.host);
  const runtime = await (options.createRuntime ?? RuntimeApp.create)({
    agentHome: pathContext.agentHome,
    workingDir: pathContext.workingDir,
    applicationConfig: snapshot.application,
    envOverrides: getEnvOverrides(env),
    loadedUnits: Object.freeze([...acquisition.result.loadedUnits, ...builtinUnits]),
    onEvent(event) {
      if (event.type === 'warning') stderr.write(`${formatRuntimeWarning(event.info)}\n`);
    },
  });
  await awaitHostLifetime(runtime, snapshot.host, options.createHost ?? createRuntimeHost, stderr);
}

async function awaitHostLifetime(
  runtime: RuntimeHandle,
  hostConfig: StandaloneHostConfigProjection,
  createHost: typeof createRuntimeHost,
  stderr: Pick<NodeJS.WriteStream, 'write'>,
): Promise<void> {
  const host = createHost(runtime);
  if (hostConfig.mode === 'headless') {
    await host.completion;
    return;
  }

  try {
    const completion = await runtime.application.waitForChannelCompletion(hostConfig.mode);
    if (completion.outcome === 'failed') {
      process.exitCode = 1;
      stderr.write(`Channel ${hostConfig.mode} failed; shutting down.\n`);
    }
  } finally {
    await host.shutdown(`builtin ${hostConfig.mode} channel completed`);
  }
}

function reportDiagnostics(
  acquisition: StandaloneHostAcquisition,
  stderr: Pick<NodeJS.WriteStream, 'write'>,
): void {
  for (const diagnostic of acquisition.result.diagnostics) {
    const warning = formatAcquisitionWarning(diagnostic);
    if (warning !== undefined) stderr.write(`${warning}\n`);
  }
}