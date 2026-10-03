import { homedir } from 'node:os';

import { createCliChannelUnit } from '../../builtins/channels/cli/index.js';
import {
  ensureAgentConfigDocument,
  loadAgentConfig,
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

export interface StandaloneHostArguments {
  readonly agentHomeArgument?: string;
  readonly cli: boolean;
}

const CLI_CHANNEL_CONFIG = Object.freeze({
  prompt: '> ',
  approval: true,
});

export interface StandaloneHostRunOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly moduleUrl?: string;
  readonly homeDirectory?: string;
  readonly startupCwd?: string;
  readonly resolvePathContext?: (
    options: StandaloneHostPathResolutionOptions,
  ) => Promise<AgentPathContext>;
  readonly ensureConfig?: typeof ensureAgentConfigDocument;
  readonly loadConfig?: typeof loadAgentConfig;
  readonly createRuntime?: typeof RuntimeApp.create;
  readonly createHost?: typeof createRuntimeHost;
}

export function parseStandaloneHostArguments(
  argv: readonly string[],
): Readonly<StandaloneHostArguments> {
  let agentHomeArgument: string | undefined;
  let cli = false;
  let cliSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '-ah' || token === '--agent-home') {
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

    if (token === '--cli') {
      if (cliSeen) {
        throw new Error('HOST_ARGUMENT_INVALID: Duplicate argument --cli.');
      }
      cli = true;
      cliSeen = true;
      continue;
    }

    throw new Error(`HOST_ARGUMENT_INVALID: Unknown argument ${token}.`);
  }

  return Object.freeze({
    ...(agentHomeArgument === undefined ? {} : { agentHomeArgument }),
    cli,
  });
}

export function validateStandaloneHostComposition(
  snapshot: AgentConfigSnapshot,
  cliEnabled: boolean,
): void {
  if (
    cliEnabled
    && snapshot.application.logger.console?.enabled !== false
  ) {
    throw new Error(
      'HOST_OUTPUT_CONFLICT: CLI Channel and Console Logger cannot be enabled together.',
    );
  }
}

export function createStandaloneHostUnits(
  cliEnabled: boolean,
): readonly LoadedRuntimeUnit[] {
  return Object.freeze(cliEnabled ? [createCliChannelUnit(CLI_CHANNEL_CONFIG)] : []);
}

export async function runStandaloneHost(
  options: StandaloneHostRunOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const parsedArguments = parseStandaloneHostArguments(options.argv ?? process.argv.slice(2));
  const pathOptions: StandaloneHostPathResolutionOptions = {
    moduleUrl: options.moduleUrl ?? import.meta.url,
    homeDirectory: options.homeDirectory ?? homedir(),
    startupCwd: options.startupCwd ?? process.cwd(),
    ...(parsedArguments.agentHomeArgument === undefined
      ? {}
      : { agentHomeArgument: parsedArguments.agentHomeArgument }),
  };
  const pathContext = await (options.resolvePathContext ?? resolveStandaloneHostPathContext)(
    pathOptions,
  );
  await (options.ensureConfig ?? ensureAgentConfigDocument)({
    agentHome: pathContext.agentHome,
  });
  const snapshot = await (options.loadConfig ?? loadAgentConfig)({
    agentHome: pathContext.agentHome,
    environment: env,
  });
  validateStandaloneHostComposition(snapshot, parsedArguments.cli);

  const hostUnits = createStandaloneHostUnits(parsedArguments.cli);
  const runtime = await (options.createRuntime ?? RuntimeApp.create)({
    agentHome: pathContext.agentHome,
    startupContext: {
      installDir: pathContext.installDir,
      configuration: snapshot,
      environment: env,
    },
    loadedUnits: hostUnits,
  });
  await awaitHostLifetime(
    runtime,
    parsedArguments.cli,
    options.createHost ?? createRuntimeHost,
  );
}

async function awaitHostLifetime(
  runtime: RuntimeHandle,
  cliEnabled: boolean,
  createHost: typeof createRuntimeHost,
): Promise<void> {
  const host = createHost(runtime);
  if (!cliEnabled) {
    await host.completion;
    return;
  }

  try {
    const completion = await runtime.application.waitForChannelCompletion('cli');
    if (completion.outcome === 'failed') {
      process.exitCode = 1;
    }
  } finally {
    await host.shutdown('cli channel completed');
  }
}
