import { homedir } from 'node:os';

import { createCliChannelUnit } from '../../builtins/channels/cli/index.js';
import { createWebSocketChannelUnit } from '../../builtins/channels/websocket/index.js';
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

export type BuiltinChannelName = 'websocket' | 'cli';

export interface StandaloneHostArguments {
  readonly agentHomeArgument?: string;
  readonly builtinChannels: readonly BuiltinChannelName[];
}

const DEFAULT_BUILTIN_CHANNELS = Object.freeze<BuiltinChannelName[]>(['websocket']);
const NO_BUILTIN_CHANNELS = Object.freeze<BuiltinChannelName[]>([]);
const WEBSOCKET_CHANNEL_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 8787,
  path: '/ws',
  approval: true,
});
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
  let builtinChannels: readonly BuiltinChannelName[] | undefined;

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

    if (token === '-bc' || token === '--builtin-channels') {
      if (builtinChannels !== undefined) {
        throw new Error('HOST_ARGUMENT_INVALID: Duplicate argument --builtin-channels.');
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('HOST_ARGUMENT_INVALID: Missing value for --builtin-channels.');
      }
      builtinChannels = parseBuiltinChannels(value);
      index += 1;
      continue;
    }

    if (token.startsWith('--builtin-channels=')) {
      if (builtinChannels !== undefined) {
        throw new Error('HOST_ARGUMENT_INVALID: Duplicate argument --builtin-channels.');
      }
      builtinChannels = parseBuiltinChannels(token.slice(token.indexOf('=') + 1));
      continue;
    }

    throw new Error(`HOST_ARGUMENT_INVALID: Unknown argument ${token}.`);
  }

  return Object.freeze({
    ...(agentHomeArgument === undefined ? {} : { agentHomeArgument }),
    builtinChannels: builtinChannels ?? DEFAULT_BUILTIN_CHANNELS,
  });
}

function parseBuiltinChannels(value: string): readonly BuiltinChannelName[] {
  if (value === 'none') return NO_BUILTIN_CHANNELS;
  const names = value.split(',');
  if (
    names.length === 0
    || names.some((name) => name !== 'websocket' && name !== 'cli')
    || new Set(names).size !== names.length
  ) {
    throw new Error(`HOST_ARGUMENT_INVALID: Invalid Builtin Channel list ${value}.`);
  }
  return Object.freeze(
    (['websocket', 'cli'] as const).filter((name) => names.includes(name)),
  );
}

export function validateStandaloneHostComposition(
  snapshot: AgentConfigSnapshot,
  builtinChannels: readonly BuiltinChannelName[],
): void {
  if (
    builtinChannels.includes('cli')
    && snapshot.application.logger.console?.enabled !== false
  ) {
    throw new Error(
      'HOST_OUTPUT_CONFLICT: CLI Channel and Console Logger cannot be enabled together.',
    );
  }
}

export function createBuiltinHostUnits(
  builtinChannels: readonly BuiltinChannelName[],
): readonly LoadedRuntimeUnit[] {
  return Object.freeze([
    ...(builtinChannels.includes('websocket')
      ? [createWebSocketChannelUnit(WEBSOCKET_CHANNEL_CONFIG)]
      : []),
    ...(builtinChannels.includes('cli')
      ? [createCliChannelUnit(CLI_CHANNEL_CONFIG)]
      : []),
  ]);
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
  validateStandaloneHostComposition(snapshot, parsedArguments.builtinChannels);

  const builtinUnits = createBuiltinHostUnits(parsedArguments.builtinChannels);
  const runtime = await (options.createRuntime ?? RuntimeApp.create)({
    agentHome: pathContext.agentHome,
    startupContext: {
      installDir: pathContext.installDir,
      configuration: snapshot,
      environment: env,
    },
    loadedUnits: builtinUnits,
  });
  await awaitHostLifetime(
    runtime,
    parsedArguments.builtinChannels,
    options.createHost ?? createRuntimeHost,
  );
}

async function awaitHostLifetime(
  runtime: RuntimeHandle,
  builtinChannels: readonly BuiltinChannelName[],
  createHost: typeof createRuntimeHost,
): Promise<void> {
  const host = createHost(runtime);
  const controllingChannel = builtinChannels.includes('websocket')
    ? 'websocket'
    : builtinChannels.includes('cli')
      ? 'cli'
      : undefined;
  if (controllingChannel === undefined) {
    await host.completion;
    return;
  }

  try {
    const completion = await runtime.application.waitForChannelCompletion(controllingChannel);
    if (completion.outcome === 'failed') {
      process.exitCode = 1;
    }
  } finally {
    await host.shutdown(`builtin ${controllingChannel} channel completed`);
  }
}
