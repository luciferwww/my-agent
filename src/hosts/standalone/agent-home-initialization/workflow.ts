import { join } from 'node:path';

import {
  BuiltinLlmProvider,
  type BuiltinLlmProviderConfig,
  type BuiltinModelRegistration,
  type BuiltinProtocol,
  validateBuiltinLlmProviderConfig,
} from '../../../builtins/providers/builtin/index.js';
import {
  ModelResolver,
  type ProviderProjectionEntry,
  type ResolvedModel,
} from '../../../core/model-resolution/index.js';
import {
  acquireExtensions,
  discoverExtensionDescriptors,
  type ExtensionCandidate,
} from '../../../extension/acquisition/index.js';
import { loadAgentConfig } from '../../../platform/config/index.js';
import {
  resolveStagedRegistryCandidate,
  stageRegistryUnit,
  type StagedRegistryUnit,
} from '../../../runtime/registry-builder.js';
import type { AgentPathContext } from '../../path-context.js';
import { FIXED_AGENT_PROFILES, ROOT_AGENT_TOOLS } from './assets.js';
import {
  createClackInitializationPrompter,
  InitializationCancelledError,
  type InitializationPrompter,
  type PromptOption,
} from './prompts.js';
import {
  collectExtensionConfiguration,
  UnsupportedInitializationSchemaError,
} from './schema.js';
import {
  preflightAgentHome,
  publishAgentHome,
  readAgentHomeConfig,
} from './publication.js';

const READINESS_PROMPT = 'Reply with the single word OK. Do not use tools.';
const BUILTIN_SOURCE_ID = 'builtin';
const EXTENSION_SOURCE_PREFIX = 'extension:';
const BUILTIN_PROTOCOLS: readonly Readonly<{
  value: BuiltinProtocol;
  label: string;
}>[] = Object.freeze([
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-chat-completions', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
]);

export interface AgentHomeInitializationOptions {
  readonly pathContext: AgentPathContext;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly prompter?: InitializationPrompter;
  readonly interactive?: boolean;
  readonly signal?: AbortSignal;
}

interface VerifiedModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly label: string;
}

interface BuiltinCandidateState {
  readonly source: 'builtin';
  readonly authored: BuiltinLlmProviderConfig;
  readonly effective: BuiltinLlmProviderConfig;
  readonly verifiedModels: readonly VerifiedModel[];
  readonly entry: ProviderProjectionEntry;
}

interface ExtensionCandidateState {
  readonly source: 'extension';
  readonly candidate: ExtensionCandidate;
  readonly authoredConfig: Readonly<Record<string, unknown>>;
  readonly verifiedModels: readonly VerifiedModel[];
  readonly entry: ProviderProjectionEntry;
  readonly staged: StagedRegistryUnit;
}

type ProviderCandidateState = BuiltinCandidateState | ExtensionCandidateState;

interface InitializationReadiness {
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

type WorkflowMode = 'initialize' | 'edit';

export async function runAgentHomeInitialization(
  options: AgentHomeInitializationOptions,
): Promise<void> {
  const interactive = options.interactive
    ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive) {
    throw new Error('Initialization requires an interactive terminal.');
  }

  const prompter = options.prompter ?? createClackInitializationPrompter();
  const originalSerialized = await readAgentHomeConfig(options.pathContext.agentHome);
  const mode: WorkflowMode = originalSerialized === undefined ? 'initialize' : 'edit';
  if (mode === 'initialize') {
    await preflightAgentHome(options.pathContext.agentHome);
  } else {
    await loadAgentConfig({
      agentHome: options.pathContext.agentHome,
      environment: options.environment,
    });
  }
  const extensionsDir = join(options.pathContext.installDir, 'extensions');
  const discovery = await discoverExtensionDescriptors(extensionsDir);
  const providerExtensions = discovery.candidates.filter((candidate) =>
    candidate.descriptor.contributes?.includes('provider') === true);
  const states = new Map<string, ProviderCandidateState>();
  const extensionConfigurations = new Map<string, Readonly<Record<string, unknown>>>();
  const modifiedExtensionIds = new Set<string>();
  let defaultModel: VerifiedModel | undefined;
  const originalDocument = originalSerialized === undefined
    ? undefined
    : parseConfigDocument(originalSerialized);
  const originalMaxLlmCallsPerTurn = readOriginalTurnLimit(originalDocument);
  let maxLlmCallsPerTurn = originalMaxLlmCallsPerTurn;
  let llmModified = false;
  let runtimeModified = false;
  let rootToolsReset = false;

  prompter.intro(mode === 'initialize'
    ? 'Initialize a new my-agent home'
    : 'Edit an existing my-agent home');
  prompter.note(`Agent Home: ${options.pathContext.agentHome}`);

  try {
    if (mode === 'edit' && !(await prompter.confirm(
      'Agent Home is already configured. Edit existing configuration?',
      false,
    ))) {
      prompter.outro('Agent Home was not changed.');
      return;
    }
    while (true) {
      defaultModel = reconcileDefaultModel(states, defaultModel);
      const readiness = evaluateReadiness(
        mode,
        states,
        defaultModel,
        llmModified,
        runtimeModified,
        modifiedExtensionIds,
      );
      const action = await promptMainMenu(
        prompter,
        mode,
        states,
        defaultModel,
        maxLlmCallsPerTurn,
        readiness,
        llmModified,
        runtimeModified,
        rootToolsReset,
        discovery.candidates,
        extensionConfigurations,
      );

      if (action === 'extensions') {
        const selectedExtension = await selectExtensionCandidate(
          prompter,
          discovery.candidates,
          states,
          extensionConfigurations,
        );
        if (selectedExtension === undefined) continue;
        if (selectedExtension.descriptor.contributes?.includes('provider') !== true) {
          const config = await collectExtensionConfiguration(
            selectedExtension.descriptor,
            prompter,
            options.environment,
          );
          extensionConfigurations.set(selectedExtension.descriptor.id, Object.freeze(config));
          modifiedExtensionIds.add(selectedExtension.descriptor.id);
          continue;
        }
        if (mode === 'edit' && !llmModified && !(await prompter.confirm(
          'Replace the existing LLM Providers and Models configuration?',
          false,
        ))) {
          continue;
        }
        const verifiedBefore = verifiedModels(states).length;
        await collectProviderCandidate({
          states,
          providerExtensions,
          extensionsDir,
          environment: options.environment,
          prompter,
          signal: options.signal,
          includeBuiltin: false,
          selectedSourceId: extensionStateKey(selectedExtension.descriptor.id),
        });
        if (verifiedModels(states).length > verifiedBefore) llmModified = true;
        continue;
      }
      if (action === 'providers') {
        if (mode === 'edit' && !llmModified && !(await prompter.confirm(
          'Replace the existing LLM Providers and Models configuration?',
          false,
        ))) {
          continue;
        }
        const verifiedBefore = verifiedModels(states).length;
        await collectProviderCandidate({
          states,
          providerExtensions,
          extensionsDir,
          environment: options.environment,
          prompter,
          signal: options.signal,
          includeBuiltin: true,
        });
        if (verifiedModels(states).length > verifiedBefore) llmModified = true;
        continue;
      }
      if (action === 'default-model') {
        const selected = await selectDefaultModel(states, prompter);
        if (selected !== undefined) defaultModel = selected;
        continue;
      }
      if (action === 'runtime') {
        maxLlmCallsPerTurn = await promptTurnLimit(prompter);
        runtimeModified = rootToolsReset
          || maxLlmCallsPerTurn !== originalMaxLlmCallsPerTurn;
        continue;
      }
      if (action === 'restore-root-tools') {
        rootToolsReset = true;
        runtimeModified = true;
        prompter.note(
          'Root Agent Tool permissions will be restored to the recommended defaults.',
          'Agent defaults',
        );
        continue;
      }
      if (action === 'discard-llm') {
        states.clear();
        defaultModel = undefined;
        llmModified = false;
        continue;
      }
      if (action === 'cancel') throw new InitializationCancelledError();
      if (!readiness.ready || (llmModified && defaultModel === undefined)) {
        prompter.note(readiness.blockers.join('\n'), 'Initialization is not ready');
        continue;
      }

      if (llmModified) validateCombinedCandidates(states);
      const document = mode === 'initialize'
        ? createConfigDocument(
            states,
            defaultModel!,
            extensionConfigurations,
            maxLlmCallsPerTurn,
          )
        : mergeEditedConfig(
            originalDocument!,
            states,
            defaultModel,
            maxLlmCallsPerTurn,
            providerExtensions,
            extensionConfigurations,
            modifiedExtensionIds,
            llmModified,
            runtimeModified,
            rootToolsReset,
          );
      const serialized = `${JSON.stringify(document, null, 2)}\n`;
      await loadAgentConfig(
        { agentHome: options.pathContext.agentHome, environment: options.environment },
        { readTextFile: async () => serialized },
      );
      prompter.note(renderFinalSummary(
        options.pathContext.agentHome,
        states,
        defaultModel,
        maxLlmCallsPerTurn,
        mode,
        originalDocument,
        rootToolsReset,
      ), 'Initialization summary');
      const reviewAction = await prompter.select(
        mode === 'initialize' ? 'Review initialization' : 'Review changes',
        [
          {
            value: 'initialize',
            label: mode === 'initialize'
              ? 'Initialize Agent Home and exit'
              : 'Save changes and exit',
          },
          { value: 'back', label: 'Back to configuration' },
        ],
        'initialize',
      );
      if (reviewAction === 'back') continue;

      await prompter.progress(
        mode === 'initialize' ? 'Creating Agent Home' : 'Saving Agent Home',
        () => publishAgentHome(
          options.pathContext.agentHome,
          serialized,
          originalSerialized,
        ),
      );
      prompter.outro(
        `${mode === 'initialize'
          ? 'Agent Home initialized successfully.'
          : 'Agent Home configuration saved successfully.'}\nRun my-agent --agent-home ${JSON.stringify(options.pathContext.agentHome)}.`,
      );
      return;
    }
  } catch (error) {
    if (error instanceof InitializationCancelledError) {
      prompter.outro(error.message);
      return;
    }
    throw error;
  }
}

async function promptMainMenu(
  prompter: InitializationPrompter,
  mode: WorkflowMode,
  states: ReadonlyMap<string, ProviderCandidateState>,
  defaultModel: VerifiedModel | undefined,
  maxLlmCallsPerTurn: number | undefined,
  readiness: InitializationReadiness,
  llmModified: boolean,
  runtimeModified: boolean,
  rootToolsReset: boolean,
  discoveredExtensions: readonly ExtensionCandidate[],
  extensionConfigurations: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Promise<string> {
  const models = verifiedModels(states);
  const configuredProviderExtensions = [...states.values()].filter(
    (state) => state.source === 'extension',
  ).length;
  const configuredExtensions = configuredProviderExtensions + extensionConfigurations.size;
  return prompter.select(
    'What would you like to configure?',
    [
      {
        value: 'providers',
        label: 'LLM Providers and Models',
        hint: llmModified
          ? `Modified — ${states.size} configured, ${models.length} verified`
          : mode === 'edit' ? 'Existing — unchanged' : `${states.size} configured, ${models.length} verified`,
      },
      {
        value: 'default-model',
        label: 'Default Model',
        hint: defaultModel?.label
          ?? (mode === 'edit' && !llmModified
            ? 'Existing — unchanged'
            : 'Configure and verify a Model first'),
        disabled: models.length === 0,
      },
      {
        value: 'runtime',
        label: 'Agent Runtime Settings',
        hint: `${runtimeModified ? 'Modified — ' : mode === 'edit' ? 'Existing — ' : ''}${
          maxLlmCallsPerTurn === undefined
            ? 'using defaults'
            : `${maxLlmCallsPerTurn} LLM calls per Turn`
        }`,
      },
      {
        value: 'extensions',
        label: 'Extensions',
        hint: `${discoveredExtensions.length} discovered, ${configuredExtensions} configured in this Draft`,
      },
      ...(mode === 'edit'
        ? [{
            value: 'restore-root-tools',
            label: 'Restore recommended Root Tool defaults',
            hint: rootToolsReset
              ? 'Restored in this Draft'
              : 'Replace agents.defaults.tools only',
            disabled: rootToolsReset,
          }]
        : []),
      ...(mode === 'edit' && llmModified
        ? [{ value: 'discard-llm', label: 'Discard LLM changes', hint: 'Keep existing LLM configuration' }]
        : []),
      {
        value: 'save',
        label: mode === 'initialize' ? 'Initialize Agent Home and exit' : 'Save changes and exit',
        hint: readiness.ready ? 'Ready' : readiness.blockers[0],
        disabled: !readiness.ready,
      },
      { value: 'cancel', label: 'Cancel' },
    ],
    readiness.ready ? 'save' : 'providers',
  );
}

async function selectExtensionCandidate(
  prompter: InitializationPrompter,
  candidates: readonly ExtensionCandidate[],
  states: ReadonlyMap<string, ProviderCandidateState>,
  extensionConfigurations: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Promise<ExtensionCandidate | undefined> {
  const back = 'back';
  const selected = await prompter.select(
    'Select an Extension to configure',
    [
      ...candidates.map((candidate) => {
        const provider = candidate.descriptor.contributes?.includes('provider') === true;
        const configured = provider
          ? states.has(extensionStateKey(candidate.descriptor.id))
          : extensionConfigurations.has(candidate.descriptor.id);
        return {
          value: extensionStateKey(candidate.descriptor.id),
          label: candidate.descriptor.name ?? candidate.descriptor.id,
          hint: `${provider ? 'Provider — live verification required' : 'Schema configuration — no declared live verification'}${
            configured ? ' — configured in this Draft' : ''
          }`,
        };
      }),
      { value: back, label: 'Back' },
    ],
    back,
  );
  return selected === back
    ? undefined
    : candidates.find((candidate) =>
        extensionStateKey(candidate.descriptor.id) === selected);
}

function evaluateReadiness(
  mode: WorkflowMode,
  states: ReadonlyMap<string, ProviderCandidateState>,
  defaultModel: VerifiedModel | undefined,
  llmModified: boolean,
  runtimeModified: boolean,
  modifiedExtensionIds: ReadonlySet<string>,
): InitializationReadiness {
  const models = verifiedModels(states);
  const blockers: string[] = [];
  if (mode === 'edit' && !llmModified && !runtimeModified && modifiedExtensionIds.size === 0) {
    blockers.push('Make at least one configuration change');
  }
  if ((mode === 'initialize' || llmModified) && models.length === 0) {
    blockers.push('Verify at least one Model first');
  }
  if ((mode === 'initialize' || llmModified) && models.length > 0 && defaultModel === undefined) {
    blockers.push('Select a Default Model first');
  } else if (defaultModel !== undefined && !models.some((model) =>
    sameModel(model, defaultModel))) {
    blockers.push('Select a verified Default Model');
  }
  if (blockers.length === 0 && (mode === 'initialize' || llmModified)) {
    try {
      validateCombinedCandidates(states);
    } catch {
      blockers.push('Resolve Provider contribution conflicts');
    }
  }
  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

function reconcileDefaultModel(
  states: ReadonlyMap<string, ProviderCandidateState>,
  current: VerifiedModel | undefined,
): VerifiedModel | undefined {
  const models = verifiedModels(states);
  if (current !== undefined && models.some((model) => sameModel(model, current))) return current;
  return models.length === 1 ? models[0] : undefined;
}

async function collectProviderCandidate(params: {
  readonly states: Map<string, ProviderCandidateState>;
  readonly providerExtensions: readonly ExtensionCandidate[];
  readonly extensionsDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly prompter: InitializationPrompter;
  readonly signal?: AbortSignal;
  readonly includeBuiltin?: boolean;
  readonly selectedSourceId?: string;
}): Promise<void> {
  const options: PromptOption[] = [
    ...(params.includeBuiltin === false
      ? []
      : [{
          value: BUILTIN_SOURCE_ID,
          label: params.states.has(BUILTIN_SOURCE_ID)
            ? 'Built-in Provider — add or replace Models'
            : 'Built-in Provider',
        }]),
    ...params.providerExtensions.map((candidate) => ({
      value: extensionStateKey(candidate.descriptor.id),
      label: `${candidate.descriptor.name ?? candidate.descriptor.id}${
        params.states.has(extensionStateKey(candidate.descriptor.id))
          ? ' — add or replace Models'
          : ''
      }`,
    })),
  ];
  const sourceId = params.selectedSourceId ?? await params.prompter.select(
    'Select an LLM provider to configure',
    options,
  );
  const existing = params.states.get(sourceId);
  const replace = existing === undefined
    ? false
    : (await params.prompter.select(
        'How should this Provider configuration be changed?',
        [
          { value: 'add', label: 'Add verified Models using the existing configuration' },
          { value: 'replace', label: 'Replace the configuration and reverify all Models' },
        ],
        'add',
      )) === 'replace';

  if (sourceId === BUILTIN_SOURCE_ID) {
    const result = await configureBuiltin({
      existing: replace ? undefined : asBuiltin(existing),
      environment: params.environment,
      prompter: params.prompter,
      signal: params.signal,
    });
    if (result) params.states.set(BUILTIN_SOURCE_ID, result);
    return;
  }

  const extensionId = sourceId.startsWith(EXTENSION_SOURCE_PREFIX)
    ? sourceId.slice(EXTENSION_SOURCE_PREFIX.length)
    : undefined;
  const candidate = params.providerExtensions.find((item) => item.descriptor.id === extensionId);
  if (!candidate) throw new Error('The selected Provider Extension is no longer available.');
  const result = await configureExtension({
    candidate,
    existing: replace ? undefined : asExtension(existing),
    extensionsDir: params.extensionsDir,
    environment: params.environment,
    prompter: params.prompter,
    signal: params.signal,
  });
  if (result) params.states.set(sourceId, result);
}

async function configureBuiltin(params: {
  readonly existing?: BuiltinCandidateState;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly prompter: InitializationPrompter;
  readonly signal?: AbortSignal;
}): Promise<BuiltinCandidateState | undefined> {
  const connection = params.existing
    ? {
        authoredBaseURL: params.existing.authored.baseURL,
        authoredApiKey: params.existing.authored.apiKey,
        effectiveApiKey: params.existing.effective.apiKey,
      }
    : await promptBuiltinConnection(params.prompter, params.environment);
  const existingModels = params.existing?.authored.models ?? [];
  const models = await collectBuiltinModels(params.prompter, existingModels);
  const newModels = models.filter((model) =>
    !existingModels.some((existing) => existing.modelId === model.modelId));
  if (newModels.length === 0) {
    params.prompter.note('No new Model was added.');
    return params.existing;
  }

  showVerificationWarning(params.prompter, false, newModels.length);
  if (!(await params.prompter.confirm('Verify these Models with live LLM calls?', true))) {
    return params.existing;
  }

  const authored = validateBuiltinLlmProviderConfig({
    baseURL: connection.authoredBaseURL,
    ...(connection.authoredApiKey === undefined ? {} : { apiKey: connection.authoredApiKey }),
    models,
  });
  const effective = validateBuiltinLlmProviderConfig({
    baseURL: connection.authoredBaseURL,
    ...(connection.effectiveApiKey === undefined ? {} : { apiKey: connection.effectiveApiKey }),
    models,
  });
  const provider = new BuiltinLlmProvider(effective);
  const successful = await verifyModels(
    provider.entry,
    newModels.map((model) => model.modelId),
    params.prompter,
    params.signal,
  );
  const previous = params.existing?.verifiedModels ?? [];
  const verified = mergeVerifiedModels(previous, successful);
  showVerificationResults(params.prompter, newModels.map((model) => model.modelId), successful);
  if (verified.length === 0) return undefined;

  const successfulIds = new Set(verified.map((model) => model.modelId));
  const retainedModels = models.filter((model) => successfulIds.has(model.modelId));
  const retainedAuthored = { ...authored, models: retainedModels };
  const retainedEffective = { ...effective, models: retainedModels };
  return Object.freeze({
    source: 'builtin',
    authored: Object.freeze(retainedAuthored),
    effective: Object.freeze(retainedEffective),
    verifiedModels: Object.freeze(verified),
    entry: new BuiltinLlmProvider(retainedEffective).entry,
  });
}

async function configureExtension(params: {
  readonly candidate: ExtensionCandidate;
  readonly existing?: ExtensionCandidateState;
  readonly extensionsDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly prompter: InitializationPrompter;
  readonly signal?: AbortSignal;
}): Promise<ExtensionCandidateState | undefined> {
  let authoredConfig: Readonly<Record<string, unknown>>;
  try {
    authoredConfig = params.existing?.authoredConfig
      ?? await collectExtensionConfiguration(
        params.candidate.descriptor,
        params.prompter,
        params.environment,
      );
  } catch (error) {
    if (error instanceof UnsupportedInitializationSchemaError) {
      throw new Error(
        `${params.candidate.descriptor.name ?? params.candidate.descriptor.id} cannot be configured by this version of the initializer. ${error.message}`,
      );
    }
    throw error;
  }
  const existingIds = params.existing?.verifiedModels.map((model) => model.modelId) ?? [];
  const modelIds = await collectModelIds(params.prompter, existingIds);
  const newModelIds = modelIds.filter((modelId) => !existingIds.includes(modelId));
  if (newModelIds.length === 0) {
    params.prompter.note('No new Model was added.');
    return params.existing;
  }

  showVerificationWarning(params.prompter, true, newModelIds.length);
  if (!(await params.prompter.confirm('Verify these Models with live LLM calls?', true))) {
    return params.existing;
  }

  const acquisition = await acquireExtensions({
    extensionsDir: params.extensionsDir,
    extensionsConfig: {
      enabled: true,
      entries: {
        [params.candidate.descriptor.id]: { config: authoredConfig },
      },
    },
    environment: params.environment,
  });
  const unit = acquisition.loadedUnits.find((item) =>
    item.unitId === params.candidate.descriptor.id);
  if (!unit) {
    throw new Error(
      `${params.candidate.descriptor.name ?? params.candidate.descriptor.id} could not be loaded with the supplied configuration.`,
    );
  }

  const instance = await unit.create(params.signal ?? new AbortController().signal);
  let stopStarted = false;
  try {
    const staged = stageRegistryUnit(instance.registration);
    if (staged.providers.length === 0) {
      throw new Error(
        `${params.candidate.descriptor.name ?? params.candidate.descriptor.id} declares Provider support but did not register a Provider.`,
      );
    }
    if (staged.providers.length !== 1) {
      throw new Error(
        `${params.candidate.descriptor.name ?? params.candidate.descriptor.id} registered multiple Providers. This version of the initializer supports one Provider per Provider Extension.`,
      );
    }
    const provider = staged.providers[0]!;
    await instance.start(params.signal ?? new AbortController().signal);
    const successful = await verifyModels(
      provider,
      newModelIds,
      params.prompter,
      params.signal,
    );
    showVerificationResults(params.prompter, newModelIds, successful);
    const verified = mergeVerifiedModels(params.existing?.verifiedModels ?? [], successful);
    stopStarted = true;
    await instance.stop();
    if (verified.length === 0) return undefined;
    return Object.freeze({
      source: 'extension',
      candidate: params.candidate,
      authoredConfig: Object.freeze({ ...authoredConfig }),
      verifiedModels: Object.freeze(verified),
      entry: provider,
      staged,
    });
  } finally {
    if (!stopStarted) {
      stopStarted = true;
      await instance.stop();
    }
  }
}

async function verifyModels(
  provider: ProviderProjectionEntry,
  modelIds: readonly string[],
  prompter: InitializationPrompter,
  signal?: AbortSignal,
): Promise<readonly VerifiedModel[]> {
  const resolver = new ModelResolver([provider]);
  const successful: VerifiedModel[] = [];
  for (const modelId of modelIds) {
    let resolved: ResolvedModel;
    try {
      resolved = resolver.resolve({
        reference: { providerId: provider.id, modelId },
        request: { tools: false, mediaKinds: [] },
        policy: {},
      });
      await prompter.progress(`Verifying model access: ${provider.id} / ${modelId}`, async () => {
        await resolved.invocationPort.chat({
          model: resolved.identity.modelId,
          system: 'This is a one-time setup readiness check.',
          messages: [{ role: 'user', origin: 'host', content: READINESS_PROMPT }],
          tools: [],
          outputTokenLimit: 16,
          ...(signal === undefined ? {} : { signal }),
        });
      });
      successful.push(Object.freeze({
        providerId: provider.id,
        modelId,
        label: `${provider.displayName ?? provider.id} / ${modelId}`,
      }));
    } catch {
      // The bounded result below intentionally excludes response bodies and provider errors.
    }
  }
  return Object.freeze(successful);
}

async function promptBuiltinConnection(
  prompter: InitializationPrompter,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<{
  authoredBaseURL: string;
  authoredApiKey?: string;
  effectiveApiKey?: string;
}>> {
  const authoredBaseURL = await prompter.text({
    message: 'Enter the provider base URL',
    validate: validateHttpUrl,
  });
  const source = await prompter.select(
    'How should API key be supplied?',
    [
      { value: 'literal', label: 'Enter now' },
      { value: 'environment', label: 'Use an environment variable' },
      { value: 'none', label: 'No credential' },
    ],
    'literal',
  );
  if (source === 'none') return Object.freeze({ authoredBaseURL });
  if (source === 'literal') {
    const apiKey = await prompter.text({
      message: 'Enter API key',
      masked: true,
      validate: requiredText,
    });
    return Object.freeze({
      authoredBaseURL,
      authoredApiKey: apiKey,
      effectiveApiKey: apiKey,
    });
  }
  const name = await prompter.text({
    message: 'Enter the environment variable name',
    validate: (value) => validateEnvironmentName(value, environment),
  });
  return Object.freeze({
    authoredBaseURL,
    authoredApiKey: `\${${name}}`,
    effectiveApiKey: environment[name]!,
  });
}

async function collectBuiltinModels(
  prompter: InitializationPrompter,
  existing: readonly BuiltinModelRegistration[],
): Promise<readonly BuiltinModelRegistration[]> {
  const models = [...existing];
  do {
    const protocol = await prompter.select(
      'Select the model protocol',
      BUILTIN_PROTOCOLS,
      BUILTIN_PROTOCOLS[0]!.value,
    ) as BuiltinProtocol;
    const modelId = await promptUniqueModelId(prompter, models.map((model) => model.modelId));
    models.push(Object.freeze({ modelId, protocol }));
  } while (await prompter.confirm('Add another Model for this Provider?', false));
  return Object.freeze(models);
}

async function collectModelIds(
  prompter: InitializationPrompter,
  existing: readonly string[],
): Promise<readonly string[]> {
  const modelIds = [...existing];
  do {
    modelIds.push(await promptUniqueModelId(prompter, modelIds));
  } while (await prompter.confirm('Add another Model for this Provider?', false));
  return Object.freeze(modelIds);
}

async function promptUniqueModelId(
  prompter: InitializationPrompter,
  existing: readonly string[],
): Promise<string> {
  return prompter.text({
    message: 'Enter the model ID',
    validate: (value) => {
      if (!value.trim()) return 'Model ID is required.';
      if (existing.includes(value)) return 'Model ID must be unique within this Provider.';
      return undefined;
    },
  });
}

async function selectDefaultModel(
  states: ReadonlyMap<string, ProviderCandidateState>,
  prompter: InitializationPrompter,
): Promise<VerifiedModel | undefined> {
  const models = verifiedModels(states);
  if (models.length === 0) return undefined;
  if (models.length === 1) return models[0]!;
  const configureAnother = 'configure-another';
  const selected = await prompter.select(
    'Select the default Model',
    [
      ...models.map((model, index) => ({
        value: `model:${index}`,
        label: model.label,
      })),
      { value: configureAnother, label: 'Configure and verify another Model' },
    ],
  );
  return selected === configureAnother
    ? undefined
    : models[Number(selected.slice('model:'.length))];
}

async function promptTurnLimit(prompter: InitializationPrompter): Promise<number | undefined> {
  const value = await prompter.text({
    message: 'Maximum LLM calls per Turn (leave blank for unlimited)',
    validate: (candidate) => {
      if (!candidate) return undefined;
      const parsed = Number(candidate);
      return Number.isSafeInteger(parsed) && parsed > 0
        ? undefined
        : 'Enter a positive integer or leave blank.';
    },
  });
  return value ? Number(value) : undefined;
}

function validateCombinedCandidates(
  states: ReadonlyMap<string, ProviderCandidateState>,
): void {
  const builtin = asBuiltin(states.get(BUILTIN_SOURCE_ID));
  const extensions = [...states.values()].filter(
    (state): state is ExtensionCandidateState => state.source === 'extension',
  );
  const providers = [
    ...(builtin ? [builtin.entry] : []),
    ...extensions.map((state) => state.entry),
  ];
  new ModelResolver(providers);
  const combined = resolveStagedRegistryCandidate({
    providers: builtin ? [builtin.entry] : [],
    units: extensions.map((state) => state.staged),
  });
  if (combined.diagnostics.length > 0 || combined.units.length !== extensions.length) {
    throw new Error(
      'The verified Provider Extensions have conflicting contribution identities. Reconfigure or remove a conflicting Provider.',
    );
  }
}

function createConfigDocument(
  states: ReadonlyMap<string, ProviderCandidateState>,
  defaultModel: VerifiedModel,
  extensionConfigurations: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  maxLlmCallsPerTurn: number | undefined,
): Record<string, unknown> {
  const builtin = asBuiltin(states.get(BUILTIN_SOURCE_ID));
  const extensions = [...states.values()].filter(
    (state): state is ExtensionCandidateState => state.source === 'extension',
  );
  return {
    llm: {
      defaultModel: {
        providerId: defaultModel.providerId,
        modelId: defaultModel.modelId,
      },
      ...(builtin === undefined ? {} : { builtin: builtin.authored }),
    },
    agents: {
      steeringEnabled: false,
      ...(maxLlmCallsPerTurn === undefined ? {} : { maxLlmCallsPerTurn }),
      maxSubagentDepth: 1,
      defaults: {
        tools: {
          allow: [...ROOT_AGENT_TOOLS],
          deny: [],
        },
      },
      list: FIXED_AGENT_PROFILES.map((profile) => ({
        id: profile.id,
        description: profile.description,
        tools: { allow: [...profile.tools] },
      })),
    },
    ...(extensions.length === 0 && extensionConfigurations.size === 0
      ? {}
      : {
          extensions: {
            entries: {
              ...Object.fromEntries([...extensionConfigurations].map(([id, config]) => [
                id,
                { config },
              ])),
              ...Object.fromEntries(extensions.map((state) => [
                state.candidate.descriptor.id,
                { config: state.authoredConfig },
              ])),
            },
          },
        }),
  };
}

function mergeEditedConfig(
  original: Record<string, unknown>,
  states: ReadonlyMap<string, ProviderCandidateState>,
  defaultModel: VerifiedModel | undefined,
  maxLlmCallsPerTurn: number | undefined,
  providerExtensions: readonly ExtensionCandidate[],
  extensionConfigurations: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  modifiedExtensionIds: ReadonlySet<string>,
  llmModified: boolean,
  runtimeModified: boolean,
  rootToolsReset: boolean,
): Record<string, unknown> {
  const document = structuredClone(original);
  const originalExtensions = asMutableRecord(document['extensions']);
  const extensions = originalExtensions === undefined ? {} : { ...originalExtensions };
  const entries = {
    ...(asMutableRecord(extensions['entries']) ?? {}),
  };
  if (llmModified) {
    if (defaultModel === undefined) throw new Error('A verified Default Model is required.');
    const generated = createConfigDocument(
      states,
      defaultModel,
      extensionConfigurations,
      maxLlmCallsPerTurn,
    );
    document['llm'] = generated['llm'];

    for (const candidate of providerExtensions) delete entries[candidate.descriptor.id];
    for (const state of states.values()) {
      if (state.source !== 'extension') continue;
      entries[state.candidate.descriptor.id] = { config: state.authoredConfig };
    }
  }
  for (const extensionId of modifiedExtensionIds) {
    const config = extensionConfigurations.get(extensionId);
    if (config !== undefined) entries[extensionId] = { config };
  }
  if (llmModified || modifiedExtensionIds.size > 0) {
    if (Object.keys(entries).length > 0) {
      extensions['entries'] = entries;
      document['extensions'] = extensions;
    } else if (originalExtensions !== undefined) {
      delete extensions['entries'];
      if (Object.keys(extensions).length > 0) document['extensions'] = extensions;
      else delete document['extensions'];
    }
  }

  if (runtimeModified) {
    const agents = { ...(asMutableRecord(document['agents']) ?? {}) };
    if (maxLlmCallsPerTurn === undefined) delete agents['maxLlmCallsPerTurn'];
    else agents['maxLlmCallsPerTurn'] = maxLlmCallsPerTurn;
    if (rootToolsReset) {
      const defaults = { ...(asMutableRecord(agents['defaults']) ?? {}) };
      defaults['tools'] = {
        allow: [...ROOT_AGENT_TOOLS],
        deny: [],
      };
      agents['defaults'] = defaults;
    }
    document['agents'] = agents;
  }
  return document;
}

function parseConfigDocument(serialized: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(serialized);
  const document = asMutableRecord(parsed);
  if (document === undefined) throw new Error('Agent configuration must be a JSON object.');
  return structuredClone(document);
}

function readOriginalTurnLimit(
  document: Record<string, unknown> | undefined,
): number | undefined {
  const value = asMutableRecord(document?.['agents'])?.['maxLlmCallsPerTurn'];
  return typeof value === 'number' ? value : undefined;
}

function asMutableRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function showVerificationWarning(
  prompter: InitializationPrompter,
  startsExtension: boolean,
  modelCount: number,
): void {
  prompter.note([
    `Verification makes ${modelCount} live LLM ${modelCount === 1 ? 'request' : 'requests'}.`,
    ...(startsExtension
      ? ['The selected Provider Extension will be started temporarily and stopped after verification.']
      : []),
  ].join('\n'));
}

function showVerificationResults(
  prompter: InitializationPrompter,
  attemptedIds: readonly string[],
  successful: readonly VerifiedModel[],
): void {
  const successfulIds = new Set(successful.map((model) => model.modelId));
  prompter.note(
    attemptedIds.map((modelId) =>
      `${successfulIds.has(modelId) ? 'Succeeded' : 'Failed'}: ${modelId}`).join('\n'),
    'Model verification',
  );
}

function renderFinalSummary(
  agentHome: string,
  states: ReadonlyMap<string, ProviderCandidateState>,
  defaultModel: VerifiedModel | undefined,
  maxLlmCallsPerTurn: number | undefined,
  mode: WorkflowMode,
  originalDocument: Record<string, unknown> | undefined,
  rootToolsReset: boolean,
): string {
  const models = verifiedModels(states);
  const existingDefault = asMutableRecord(
    asMutableRecord(originalDocument?.['llm'])?.['defaultModel'],
  );
  return [
    `Agent Home: ${agentHome}`,
    ...(models.length > 0
      ? [
          'Verified Models:',
          ...models.map((model) =>
            `- ${model.label}${defaultModel && sameModel(model, defaultModel) ? ' (default)' : ''}`),
        ]
      : [
          `LLM Providers and Models: ${mode === 'edit' ? 'existing configuration unchanged' : 'not configured'}`,
          ...(existingDefault === undefined
            ? []
            : [`Default Model: ${String(existingDefault['providerId'])} / ${String(existingDefault['modelId'])}`]),
        ]),
    `Maximum LLM calls per Turn: ${maxLlmCallsPerTurn ?? 'unlimited'}`,
    ...(rootToolsReset ? ['Root Tool permissions: recommended defaults restored'] : []),
  ].join('\n');
}

function verifiedModels(
  states: ReadonlyMap<string, ProviderCandidateState>,
): readonly VerifiedModel[] {
  return Object.freeze([...states.values()].flatMap((state) => state.verifiedModels));
}

function mergeVerifiedModels(
  existing: readonly VerifiedModel[],
  additions: readonly VerifiedModel[],
): readonly VerifiedModel[] {
  const byIdentity = new Map(existing.map((model) => [
    `${model.providerId}\0${model.modelId}`,
    model,
  ]));
  for (const model of additions) {
    byIdentity.set(`${model.providerId}\0${model.modelId}`, model);
  }
  return Object.freeze([...byIdentity.values()]);
}

function sameModel(left: VerifiedModel, right: VerifiedModel): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function extensionStateKey(extensionId: string): string {
  return `${EXTENSION_SOURCE_PREFIX}${extensionId}`;
}

function asBuiltin(state: ProviderCandidateState | undefined): BuiltinCandidateState | undefined {
  return state?.source === 'builtin' ? state : undefined;
}

function asExtension(
  state: ProviderCandidateState | undefined,
): ExtensionCandidateState | undefined {
  return state?.source === 'extension' ? state : undefined;
}

function requiredText(value: string): string | undefined {
  return value.trim() ? undefined : 'A value is required.';
}

function validateHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? undefined
      : 'Enter an HTTP(S) URL.';
  } catch {
    return 'Enter a valid HTTP(S) URL.';
  }
}

function validateEnvironmentName(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(value)) {
    return 'Use an environment variable name matching [A-Z_][A-Z0-9_]*.';
  }
  return environment[value]?.trim()
    ? undefined
    : `Environment variable ${value} is not set or is blank.`;
}
