import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadProductionSources, loadTypeScriptSources } from './rules.js';
import type { SourceInput } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
let productionSources: SourceInput[];
let migratedCallerSources: SourceInput[];

const DELETED_IDENTIFIERS = [
  'buildRegistrySnapshot',
  'stageRegistryCandidate',
  'ChannelLifecycleSet',
  'activateRegistryChannels',
  'ActivatedRegistry',
  'ChannelLifecycleReport',
  'ChannelShutdownHandoff',
  'startup:1',
] as const;
const DELETED_PROVIDER_SEAM = ['createProvider', 'Projection'].join('');

describe('FT-10 Runtime composition deletion', () => {
  beforeAll(async () => {
    productionSources = await loadProductionSources(REPOSITORY_ROOT);
    const [srcSources, scriptSources] = await Promise.all([
      loadTypeScriptSources(
        `${REPOSITORY_ROOT}/src`,
        ['src/architecture-fitness/'],
        'src',
      ),
      loadTypeScriptSources(`${REPOSITORY_ROOT}/scripts`, [], 'scripts'),
    ]);
    migratedCallerSources = [
      ...srcSources.filter((candidate) => candidate.path.endsWith('.test.ts')),
      ...scriptSources,
    ];
  });

  it('keeps deleted startup and Channel lifecycle authorities at zero definitions and callers', () => {
    const violations = productionSources.flatMap((source) => DELETED_IDENTIFIERS
      .filter((symbol) => source.content.includes(symbol))
      .map((symbol) => `${source.path}: ${symbol}`));

    expect(violations).toEqual([]);
  });

  it('keeps migrated test and script callers off deleted composition authorities', () => {
    const violations = migratedCallerSources.flatMap((source) => DELETED_IDENTIFIERS
      .filter((symbol) => source.content.includes(symbol))
      .map((symbol) => `${source.path}: ${symbol}`));

    expect(violations).toEqual([]);
  });

  it('keeps the naked Provider projection seam deleted from production and migrated callers', () => {
    const violations = [...productionSources, ...migratedCallerSources]
      .filter((candidate) => candidate.content.includes(DELETED_PROVIDER_SEAM))
      .map((candidate) => candidate.path);

    expect(violations).toEqual([]);
  });

  it('keeps RuntimeApp.create delegation-only and composition out of bootstrap', () => {
    const runtimeApp = source('src/runtime/RuntimeApp.ts');
    const bootstrap = source('src/runtime/bootstrap.ts');
    const resourceTypes = source('src/runtime/types.ts');
    const runtimeBuilder = source('src/runtime/runtime-builder.ts');
    const anthropicModule = source('src/runtime-modules/anthropic-provider.ts');
    const subagent = source('src/runtime/subagent-orchestration.ts');

    expect(runtimeApp.content).toMatch(
      /static async create\(options: RuntimeAppOptions\): Promise<RuntimeHandle> \{\s*return buildRuntimeHandle\(options, RuntimeApp\.createKernel\);\s*\}/,
    );
    expect(bootstrap.content).not.toContain(DELETED_PROVIDER_SEAM);
    expect(bootstrap.content).not.toContain('createTaskToolModule');
    expect(bootstrap.content).not.toContain('createSubagentDelegationPort');
    expect(bootstrap.content).not.toContain('createLoadedRuntimeUnit');
    expect(bootstrap.content).not.toContain('ModelResolver');
    const resources = objectTypeBody(resourceTypes.content, 'RuntimeResourceSet');
    const dependencies = objectTypeBody(resourceTypes.content, 'RuntimeDependencies');
    expect(resources).not.toMatch(/\b(?:registrySnapshot|modelResolver)\s*:/);
    expect(resourceTypes.content).toContain(
      'createBundledProviderUnit(options: RuntimeProviderOptions): LoadedRuntimeUnit;',
    );
    expect(dependencies).not.toContain('ProviderProjectionEntry');
    expect(dependencies).not.toMatch(/create\w*Provider\w*\([^)]*\):\s*readonly\s+\w+\[\]/u);
    expect(resourceTypes.content).not.toContain(DELETED_PROVIDER_SEAM);
    expect(runtimeBuilder.content).toContain('dependencies.createBundledProviderUnit({');
    expect(runtimeBuilder.content).not.toContain(DELETED_PROVIDER_SEAM);
    expect(runtimeBuilder.content).not.toContain('new AnthropicProvider(');
    expect(runtimeBuilder.content).not.toContain('adapters/provider/anthropic');
    expect(runtimeBuilder.content).not.toContain('.registerProvider(');
    expect(runtimeBuilder.content).not.toContain('defaultProviderId');
    expect(runtimeBuilder.content).not.toContain('registrySnapshot.providers[0]?.id');
    expect(runtimeBuilder.content.indexOf('kernel = createApplication({')).toBeLessThan(
      runtimeBuilder.content.indexOf("type: 'app_ready'"),
    );
    expect(anthropicModule.content).toContain("unitId: ANTHROPIC_PROVIDER_MODULE_ID");
    expect(anthropicModule.content).toContain('const provider = new AnthropicProvider(capturedOptions);');
    expect(anthropicModule.content).toContain('api.registerProvider(provider.entry);');
    expect(subagent.content).toContain('new ModelResolver(parent.registrySnapshot.providers)');
    expect(subagent.content).toContain('toolProjection: parent.registrySnapshot.tools');
    expect(subagent.content).toContain('hookProjection: parent.registrySnapshot.hooks');
    expect(subagent.content).not.toMatch(/(?:currentSnapshot|currentRegistry|latestSnapshot)\s*\(/);
  });

  it('keeps reload state reduction behind the one CompositionCoordinator command gate', () => {
    const coordinator = source('src/runtime/composition-coordinator.ts').content;
    const reload = source('src/runtime/reload-coordinator.ts').content;
    const manager = source('src/runtime/runtime-composition-manager.ts').content;

    expect(coordinator).toContain('runReloadCommand<T>');
    expect(coordinator).not.toMatch(/\b(?:prepare|cleanup|retire)\s*\(/);
    expect(reload).toContain('private readonly compositionCoordinator: CompositionCoordinator');
    expect(reload).toContain('this.compositionCoordinator.runReloadCommand(operation, reduce)');
    expect(manager).toContain('new RuntimeReloadStateMachine(this.coordinator, hooks');
    expect(manager).not.toContain('.admitReload(');
  });

  it('keeps canonical Root intake fields and process force ownership', async () => {
    const runtimeTypes = source('src/runtime/types.ts').content;
    const queueTypes = source('src/runtime/queue-types.ts').content;
    const websocket = source('src/adapters/channel/WebSocketChannel.ts').content;
    const host = await readFile(`${REPOSITORY_ROOT}/scripts/runtime-host.ts`, 'utf8');
    const processEntries = await Promise.all(['cli.ts', 'server.ts', 'websocket.ts'].map(
      (name) => readFile(`${REPOSITORY_ROOT}/scripts/${name}`, 'utf8'),
    ));
    const html = await readFile(`${REPOSITORY_ROOT}/clients/html/chat.html`, 'utf8');

    expect(objectTypeBody(runtimeTypes, 'RunTurnParams')).not.toMatch(/\b(?:model|maxTokens)\??\s*:/);
    expect(objectTypeBody(queueTypes, 'QueuedChannelTurn')).not.toMatch(/\b(?:model|maxTokens)\??\s*:/);
    expect(websocket).toContain('model_reference');
    expect(websocket).toContain('request_override');
    expect(html).toContain('model_reference');
    expect(processEntries.every((content) => !content.includes('process.exit('))).toBe(true);
    expect(host).toContain('process.exit(code)');
    expect(host).toContain('overallTimeoutMs ?? 60_000');
    expect(host).toContain('setTimeout(() => forceExit(1), overallTimeoutMs)');
    expect(source('src/runtime/RuntimeApp.ts').content).not.toMatch(
      /this\.resources\.(?:memoryManager|sessionManager|agentRunner)\.close\s*\(/,
    );
    expect(processEntries.every((content) =>
      content.includes('RuntimeApp.create(') && content.includes('createRuntimeHost('))).toBe(true);
  });
});

function source(path: string): SourceInput {
  const found = productionSources.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`Missing production source: ${path}`);
  return found;
}

function objectTypeBody(content: string, name: string): string {
  const match = new RegExp(
    `export (?:interface ${name}|type ${name} =) \\{([\\s\\S]*?)\\n\\}`,
  ).exec(content);
  if (!match?.[1]) throw new Error(`Missing object contract: ${name}`);
  return match[1];
}