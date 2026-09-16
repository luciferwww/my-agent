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
  ensureAgentConfigDocument,
  getEnvOverrides,
  loadAgentConfig,
  type StandaloneHostConfigProjection,
  type AgentConfigSnapshot,
} from '../../platform/config/index.js';
import { RuntimeApp, type RuntimeHandle } from '../../runtime/index.js';
import type { LoadedRuntimeUnit } from '../../runtime/runtime-unit.js';
import type { AgentPathContext } from '../path-context.js';
import {
  resolveStandaloneHostPathContext,
  type StandaloneHostPathResolutionOptions,
} from './path-context.js';
import { createRuntimeHost } from './runtime-host.js';

export interface StandaloneHostRunOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly moduleUrl?: string;
  readonly homeDirectory?: string;
  readonly startupCwd?: string;
  readonly resolvePathContext?: (
    options: StandaloneHostPathResolutionOptions,
  ) => Promise<AgentPathContext>;
  readonly ensureConfig?: typeof ensureAgentConfigDocument;
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
): Readonly<{ agentHomeArgument?: string }> {
  let agentHomeArgument: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--agent-home') {
      if (agentHomeArgument !== undefined) {
        throw new Error('HOST_ARGUMENT_INVALID: Duplicate argument --agent-home.');
      }
      const value = argv[index + 1];
      if (value === undefined || !value.trim() || value.startsWith('-')) {
        throw new Error('HOST_ARGUMENT_INVALID: Missing value for --agent-home.');
      }
      agentHomeArgument = value;
      index += 1;
      continue;
    }

    if (token.startsWith('--agent-home=')) {
      if (agentHomeArgument !== undefined) {
        throw new Error('HOST_ARGUMENT_INVALID: Duplicate argument --agent-home.');
      }
      const value = token.slice(token.indexOf('=') + 1);
      if (!value.trim()) {
        throw new Error('HOST_ARGUMENT_INVALID: Missing value for --agent-home.');
      }
      agentHomeArgument = value;
      continue;
    }

    throw new Error(`HOST_ARGUMENT_INVALID: Unknown argument ${token}.`);
  }

  return Object.freeze(agentHomeArgument === undefined ? {} : { agentHomeArgument });
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
  const parsedArguments = parseStandaloneHostArguments(options.argv ?? process.argv.slice(2));
  const pathOptions: StandaloneHostPathResolutionOptions = {
    moduleUrl: options.moduleUrl ?? import.meta.url,
    homeDirectory: options.homeDirectory ?? homedir(),
    startupCwd: options.startupCwd ?? process.cwd(),
    ...parsedArguments,
  };
  const pathContext = await (options.resolvePathContext ?? resolveStandaloneHostPathContext)(
    pathOptions,
  );
  await (options.ensureConfig ?? ensureAgentConfigDocument)({
    agentHome: pathContext.agentHome,
  });
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