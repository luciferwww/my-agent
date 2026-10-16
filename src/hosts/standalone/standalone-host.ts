import { homedir } from 'node:os';

import {
  createCliChannelUnit,
  type CliChannelConfig,
} from '../../builtins/channels/cli/index.js';
import {
  AgentConfigError,
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
  readonly initialize: boolean;
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
  readonly loadConfig?: typeof loadAgentConfig;
  readonly initializeAgentHome?: (options: {
    readonly pathContext: AgentPathContext;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }) => Promise<void>;
  readonly createRuntime?: typeof RuntimeApp.create;
  readonly createHost?: typeof createRuntimeHost;
  readonly cliOutput?: NodeJS.WritableStream;
}

export function parseStandaloneHostArguments(
  argv: readonly string[],
): Readonly<StandaloneHostArguments> {
  let agentHomeArgument: string | undefined;
  let cli = false;
  let cliSeen = false;
  let initialize = false;
  let initializeSeen = false;

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

    if (token === '--initialize') {
      if (initializeSeen) {
        throw new Error('HOST_ARGUMENT_INVALID: Duplicate argument --initialize.');
      }
      initialize = true;
      initializeSeen = true;
      continue;
    }

    throw new Error(`HOST_ARGUMENT_INVALID: Unknown argument ${token}.`);
  }

  if (cli && initialize) {
    throw new Error('HOST_ARGUMENT_INVALID: --initialize and --cli are mutually exclusive.');
  }

  return Object.freeze({
    ...(agentHomeArgument === undefined ? {} : { agentHomeArgument }),
    cli,
    initialize,
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
  cliConfig: CliChannelConfig = CLI_CHANNEL_CONFIG,
): readonly LoadedRuntimeUnit[] {
  return Object.freeze(cliEnabled ? [createCliChannelUnit(cliConfig)] : []);
}

export async function runStandaloneHost(
  options: StandaloneHostRunOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const parsedArguments = parseStandaloneHostArguments(options.argv ?? process.argv.slice(2));
  const cliOutput = options.cliOutput ?? process.stdout;
  const startupStartedAt = Date.now();
  let activateCliInteraction: (() => void) | undefined;
  const cliInteractionReady = new Promise<void>((resolve) => {
    activateCliInteraction = resolve;
  });
  if (parsedArguments.cli) {
    cliOutput.write('Starting my-agent...\n');
  }
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
  if (parsedArguments.initialize) {
    const initializeAgentHome = options.initializeAgentHome
      ?? (await import('./agent-home-initialization/index.js')).runAgentHomeInitialization;
    await initializeAgentHome({ pathContext, environment: env });
    return;
  }

  let snapshot: AgentConfigSnapshot;
  try {
    snapshot = await (options.loadConfig ?? loadAgentConfig)({
      agentHome: pathContext.agentHome,
      environment: env,
    });
  } catch (error) {
    if (error instanceof AgentConfigError && error.code === 'FILE_MISSING') {
      throw new Error(
        `Agent configuration file is missing. Run my-agent --initialize --agent-home ${JSON.stringify(pathContext.agentHome)}.`,
        { cause: error },
      );
    }
    throw error;
  }
  validateStandaloneHostComposition(snapshot, parsedArguments.cli);

  const hostUnits = createStandaloneHostUnits(parsedArguments.cli, {
    ...CLI_CHANNEL_CONFIG,
    output: cliOutput,
    interactionReady: cliInteractionReady,
  });
  const runtime = await (options.createRuntime ?? RuntimeApp.create)({
    agentHome: pathContext.agentHome,
    startupContext: {
      installDir: pathContext.installDir,
      configuration: snapshot,
      environment: env,
    },
    loadedUnits: hostUnits,
  });
  if (parsedArguments.cli) {
    cliOutput.write(
      `Ready in ${formatStartupDuration(Date.now() - startupStartedAt)} · /help for commands\n`,
    );
    activateCliInteraction?.();
  }
  await awaitHostLifetime(
    runtime,
    parsedArguments.cli,
    options.createHost ?? createRuntimeHost,
  );
}

function formatStartupDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs}ms`
    : `${(durationMs / 1_000).toFixed(1)}s`;
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
