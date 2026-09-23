import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface CurrentAuthoritySurfaceEntry {
  id: string;
  role: 'index' | 'overview' | 'topic';
  path: string;
  ownershipKey: string;
  ownedModules: string[];
}

interface CurrentAuthorityDocument extends CurrentAuthoritySurfaceEntry {
  absolutePath: string;
  content: string;
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CURRENT_ROOT = join(REPOSITORY_ROOT, 'docs', 'architecture');
const MODULE_OWNERSHIP_PATH = fileURLToPath(new URL('./ft-12-module-ownership.json', import.meta.url));
const VERIFIED_DATE = '2026-09-18';
const STALE_CURRENT_CLAIMS = [
  /基准版本/u,
  /设计文档/u,
  /代码与 v1\.0/u,
  /已知规划项/u,
  /one immutable startup Snapshot/iu,
  /config\.tools\.(?:execTimeout|readMaxLines|webFetchTimeout|webFetchMaxChars)/u,
  /private currentParams:\s*RunParams/iu,
  /agentRunner\.on\(['"]before_tool_call['"]/iu,
  /所有事件都带\s*`sessionKey`/u,
  /createProviderProjection/u,
  /src\/adapters\/llm\//u,
];

let surface: CurrentAuthoritySurfaceEntry[];
let documents: CurrentAuthorityDocument[];

describe('FT-12 Current Architecture authority', () => {
  beforeAll(async () => {
    const moduleOwnership = JSON.parse(
      await readFile(MODULE_OWNERSHIP_PATH, 'utf8'),
    ) as Record<string, string[]>;
    const currentFiles = (await readdir(CURRENT_ROOT))
      .filter((name) => name.endsWith('.md'))
      .sort();
    documents = await Promise.all(currentFiles.map(async (name) => {
      const absolutePath = join(CURRENT_ROOT, name);
      const content = await readFile(absolutePath, 'utf8');
      const id = name === 'README.md' ? 'index' : name.slice(0, -'.md'.length);
      const role = name === 'README.md' ? 'index' : name === 'overview.md' ? 'overview' : 'topic';
      return {
        id,
        role,
        path: posix.join('docs/architecture', name),
        ownershipKey: role === 'index' ? 'navigation-only' : metadata(content, 'Ownership key') ?? '',
        ownedModules: moduleOwnership[name] ?? [],
        absolutePath,
        content,
      };
    }));
    surface = documents;

    const topicFiles = documents
      .filter((entry) => entry.role === 'topic')
      .map((entry) => posix.basename(entry.path))
      .sort();
    expect(Object.keys(moduleOwnership).sort()).toEqual(topicFiles);
  });

  it('locks one index, one overview, unique topic ownership, and complete current module coverage', async () => {
    expect(surface).toHaveLength(17);
    expect(surface.filter((entry) => entry.role !== 'index')).toHaveLength(16);
    expect(new Set(surface.map((entry) => entry.id)).size).toBe(surface.length);
    expect(new Set(surface.map((entry) => entry.path)).size).toBe(surface.length);
    expect(new Set(surface.map((entry) => entry.ownershipKey)).size).toBe(surface.length);
    expect(surface.filter((entry) => entry.role === 'index')).toHaveLength(1);
    expect(surface.filter((entry) => entry.role === 'overview')).toHaveLength(1);

    const currentFiles = (await readdir(CURRENT_ROOT))
      .filter((name) => name.endsWith('.md'))
      .map((name) => posix.join('docs/architecture', name))
      .sort();
    expect(currentFiles).toEqual(surface.map((entry) => entry.path).sort());

    for (const document of documents) {
      if (document.role === 'index') {
        expect(metadata(document.content, 'Status')).toBe('Current Architecture Authority');
        expect(metadata(document.content, 'Authority')).toBeTruthy();
        continue;
      }
      expect(metadata(document.content, 'Status')).toBe('Current Authority');
      expect(metadata(document.content, 'Verified')).toBe(VERIFIED_DATE);
      expect(metadata(document.content, 'Ownership')).toBeTruthy();
      expect(metadata(document.content, 'Ownership key')).toBe(document.ownershipKey);
    }

    const ownedModules = surface.flatMap((entry) => entry.ownedModules);
    expect(new Set(ownedModules).size).toBe(ownedModules.length);
    expect(ownedModules.sort()).toEqual((await currentSourceModules()).sort());

    const overviewEntry = surface.find((entry) => entry.role === 'overview');
    if (!overviewEntry) throw new Error('Missing Current Architecture overview');
    expect(overviewEntry.ownedModules).toEqual([]);
    const overview = requireDocument(overviewEntry.id);
    expect(metadata(overview.content, 'Authority')).toBe(
      'Current Architecture entry and module ownership map',
    );
    expect(markdownDestinations(requireDocument('index').content)).toContain('overview.md');
    for (const topic of surface.filter((entry) => entry.role === 'topic')) {
      const relativeTarget = posix.basename(topic.path);
      expect(markdownDestinations(overview.content)).toContain(relativeTarget);
      expect(metadata(requireDocument(topic.id).content, 'Authority')).toBeTruthy();
    }
  });

  it('requires existing source, test, and controlling-authority evidence on every page', async () => {
    const missingEvidence: string[] = [];
    for (const document of documents.filter((entry) => entry.role !== 'index')) {
      expect(document.content).toMatch(/^## \d+\. Evidence$/mu);
      const sourceLinks = evidenceLinks(document.content, /source$/iu);
      const testLinks = evidenceLinks(document.content, /tests$/iu);
      const authorityLinks = evidenceLinks(document.content, 'Controlling authority');
      expect(sourceLinks.length, `${document.id} source evidence`).toBeGreaterThan(0);
      expect(testLinks.length, `${document.id} test evidence`).toBeGreaterThan(0);
      expect(authorityLinks.length, `${document.id} controlling authority`).toBeGreaterThan(0);

      for (const destination of [...sourceLinks, ...testLinks, ...authorityLinks]) {
        const [targetPath, fragment] = destination.split('#', 2);
        const target = resolve(dirname(document.absolutePath), targetPath ?? '');
        try {
          expect((await stat(target)).isFile(), `${document.id} missing ${destination}`).toBe(true);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            missingEvidence.push(`${document.id}:${destination}`);
            continue;
          }
          throw error;
        }
        if (fragment) {
          const targetContent = await readFile(target, 'utf8');
          expect(
            hasMarkdownAnchor(targetContent, fragment),
            `${document.id} missing fragment ${destination}`,
          ).toBe(true);
        }
      }
      expect(sourceLinks.every((link) => (
        link.includes('/src/') || link.includes('/scripts/') || link.includes('/extensions/')
      ))).toBe(true);
      expect(testLinks.some((link) => link.endsWith('.test.ts'))).toBe(true);
      expect(authorityLinks.every((link) => link.endsWith('.md'))).toBe(true);
    }
    expect(missingEvidence).toEqual([]);
  });

  it('rejects stale authority and pre-Slice-5 composition claims', () => {
    for (const document of documents) {
      for (const pattern of STALE_CURRENT_CLAIMS) {
        expect(document.content, `${document.id} matches ${pattern}`).not.toMatch(pattern);
      }
    }

    const runtime = requireDocument('runtime').content;
    expect(runtime).toContain('`RuntimeApp.create()` delegates to the Builder');
    expect(runtime).toContain('A Child never recaptures the latest generation');
    expect(runtime).toContain('`CompositionCoordinator`');
    expect(runtime).toContain('An immutable Snapshot with no Providers is valid');
    expect(runtime).toContain('Runtime does not invent an implicit Provider');
    expect(runtime).toContain('`unitId` and `phase=create`');
    expect(runtime).toContain('Candidate cleanup failure remains fail-closed');
    expect(runtime).toContain('`runtime.steeringEnabled` is `true`');
    expect(runtime).toContain('promotes every unread inbox item into the existing normal queue');
    expect(runtime).toContain('`deny` is final');
    expect(runtime).toContain('`SessionPermissionRegistry` is Runtime-owned process-local state');

    const runner = requireDocument('runner').content;
    expect(runner).toContain('`request_end` closes a queued request that never started');
    expect(runner).toContain('check Abort before quota, steering injection, event emission, and invocation');
    expect(runner).toContain('Omitted `maxLlmCalls` means no Model-call count limit');
    expect(runner).toContain('one ready batch produces one continuation Model call');

    const channel = requireDocument('channels').content;
    expect(channel).toContain('send(event: AgentEvent): void | Promise<void>');
    expect(channel).toContain('A queued `request_end` has no Session ID');
    expect(channel).toContain('generic configured-limit notice');
    expect(channel).toContain('`/permission manual` and `/permission allow_all`');
    expect(channel).toContain(
      'Strict `get_session_permission_mode` and `set_session_permission_mode`',
    );

    const builtinTools = requireDocument('builtin-tools').content;
    expect(builtinTools).toContain(
      'In `manual` Session mode every Exec call requires current-call Approval',
    );
    expect(builtinTools).toContain(
      'In `allow_all`, non-denied Exec calls are automatically authorized',
    );

    const session = requireDocument('session').content;
    expect(session).toContain(
      'Each live root Session also has a process-local `manual | allow_all` permission state',
    );
    expect(session).toContain(
      'Transient Child Sessions have no independent permission state',
    );

    const config = requireDocument('configuration').content;
    expect(config).toContain('## 3. Precedence and merge');
    expect(config).toContain('[Model Resolution](model-resolution.md) owns canonical identity');
    expect(config).toContain('| `runtime` | `steeringEnabled=false` |');
    expect(config).toContain('omitted means no Model-call count limit');
    expect(config).toContain('Runtime and Runner are global Application policy');
    expect(config).toContain('Agent selection, environment overrides, and caller Agent overrides cannot change them');
    expect(config).toContain('## 6. Evidence');

    const provider = requireDocument('providers').content;
    expect(provider).toContain('`src/core/model-invocation/` owns the Provider-neutral invocation port');
    expect(provider).not.toContain('maxTokens: number');
    expect(provider).toContain('src/builtins/providers/builtin/');
    expect(provider).toContain('runtime-unit.ts');
    expect(provider).toContain('required, initially enabled Unit `builtin-llm-provider`');
    expect(provider).toContain('Provider construction is deferred until Unit `create()`');
    expect(provider).toContain('`toModelInvocationError(value)` is the Runtime canonicalization entry');
    expect(provider).toContain('neither runtime-imports nor subclasses Host `ModelInvocationError`');

    const modelResolution = requireDocument('model-resolution').content;
    expect(modelResolution).toContain('sole owner of canonical Model identity');
    expect(modelResolution).toContain('`ModelResolutionError.category`');
    expect(modelResolution).toContain(
      'Runtime supplies one complete structured reference from the Turn or configured default',
    );
    expect(modelResolution).toContain('Resolution never selects the first Provider/model, reprioritizes Providers');

    const overview = requireDocument('overview').content;
    expect(overview).toContain('model-invocation/');
    expect(overview).toContain('extension/acquisition/');

    const media = requireDocument('media').content;
    expect(media).toContain('owns the attachment pipeline');
    expect(media).toContain('processInboundMessage(...)');
  });

  it('locks the structural Model Invocation error authority and Relay dependency direction', async () => {
    const [coreErrors, runtime, relay] = await Promise.all([
      readFile(
        join(REPOSITORY_ROOT, 'src', 'core', 'model-invocation', 'errors.ts'),
        'utf8',
      ),
      readFile(join(REPOSITORY_ROOT, 'src', 'runtime', 'RuntimeApp.ts'), 'utf8'),
      readFile(
        join(REPOSITORY_ROOT, 'extensions', 'copilot-relay-provider', 'responses-client.ts'),
        'utf8',
      ),
    ]);

    expect(coreErrors).toContain("readonly protocol = MODEL_INVOCATION_ERROR_PROTOCOL;");
    expect(coreErrors).toContain('readonly version = 1 as const;');
    expect(coreErrors).toContain('export function toModelInvocationError(');
    expect(runtime).toContain('const canonical = toModelInvocationError(current);');
    expect(runtime).toContain("Object.getOwnPropertyDescriptor(error, 'cause')");
    expect(runtime).toContain('model: formatModelIdForOperator(diagnostics.request.model)');

    expect(relay).toContain('implements ModelInvocationStructuralErrorV1');
    expect(relay).toContain("readonly protocol = 'my-agent.model-invocation-error';");
    expect(relay).not.toContain('extends ModelInvocationError');
    expect(relay).not.toMatch(/import\s*\{[^}]*\bModelInvocationError\b[^}]*\}\s*from/u);

    const runtimeCurrent = requireDocument('runtime').content;
    expect(runtimeCurrent).toContain('walks at most eight same-realm `Error` nodes');
    expect(runtimeCurrent).toContain('bounds/escapes the model identifier');
  });

  it('grounds Current Architecture claims in source and behavioral evidence', async () => {
    const [runtimeTypes, builder, builtinUnit, builderTests] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, 'src', 'runtime', 'types.ts'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'src', 'runtime', 'runtime-builder.ts'), 'utf8'),
      readFile(
        join(REPOSITORY_ROOT, 'src', 'builtins', 'providers', 'builtin', 'runtime-unit.ts'),
        'utf8',
      ),
      readFile(join(REPOSITORY_ROOT, 'src', 'runtime', 'runtime-builder.test.ts'), 'utf8'),
    ]);

    const dependencies = objectTypeBody(runtimeTypes, 'RuntimeDependencies');
    expect(dependencies).toContain(
      'createBuiltinProviderUnit(config: BuiltinLlmProviderConfig): LoadedRuntimeUnit;',
    );
    expect(dependencies).not.toContain('ProviderProjectionEntry');
    expect(builder).not.toContain('new AnthropicProvider(');
    expect(builder).not.toContain('.registerProvider(');

    const compositionStart = builder.indexOf('await compositionManager.start()');
    const kernelConstruction = builder.indexOf('kernel = createApplication({');
    const readyEvent = builder.indexOf("type: 'app_ready'");
    expect(compositionStart).toBeGreaterThan(-1);
    expect(builder).not.toContain('defaultProviderId');
    expect(compositionStart).toBeLessThan(kernelConstruction);
    expect(kernelConstruction).toBeLessThan(readyEvent);

    const unitCreate = builtinUnit.indexOf('create() {');
    const providerConstruction = builtinUnit.indexOf(
      'new BuiltinLlmProvider(capturedConfig, capturedOptions)',
    );
    const registration = builtinUnit.indexOf('api.registerProvider(provider.entry)');
    expect(unitCreate).toBeGreaterThan(-1);
    expect(unitCreate).toBeLessThan(providerConstruction);
    expect(providerConstruction).toBeLessThan(registration);
    expect(builtinUnit).toContain('unitId: BUILTIN_LLM_PROVIDER_UNIT_ID');
    expect(builtinUnit).toContain('required: true');

    for (const evidence of [
      'runs the configured Built-in Provider through factory, create, staging, start, and publication',
      'does not create a Built-in Provider Unit when llm.builtin is absent',
      'keeps a builtin Provider first when an external Provider starts in the same Snapshot',
      'publishes an empty Provider Snapshot without inventing a default Provider',
      'attributes required Provider Unit create failure and cleans earlier candidates',
      'fails closed when earlier candidate cleanup fails after Provider create failure',
    ]) {
      expect(builderTests).toContain(evidence);
    }
  });

  it('removes public output-token controls while keeping Anthropic protocol fallback private', async () => {
    const invocationTypes = await readFile(
      join(REPOSITORY_ROOT, 'src', 'core', 'model-invocation', 'types.ts'),
      'utf8',
    );
    const anthropicClient = await readFile(
      join(
        REPOSITORY_ROOT,
        'src',
        'builtins',
        'providers',
        'builtin',
        'AnthropicMessagesClient.ts',
      ),
      'utf8',
    );
    const agentRunner = await readFile(
      join(REPOSITORY_ROOT, 'src', 'core', 'runner', 'AgentRunner.ts'),
      'utf8',
    );
    const compaction = await readFile(
      join(REPOSITORY_ROOT, 'src', 'core', 'runner', 'context', 'compaction.ts'),
      'utf8',
    );

    expect(invocationTypes).not.toMatch(/\bmaxTokens\??: number;/u);
    expect(anthropicClient).toContain("import { DEFAULT_ANTHROPIC_MAX_TOKENS } from './config.js';");
    expect(anthropicClient).toContain('max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS');
    expect(agentRunner).not.toContain('resolvedModel.limits');
    expect(compaction).not.toMatch(/\bmaxTokens\b/u);
  });
});

async function currentSourceModules(): Promise<string[]> {
  const roots = ['core', 'builtins', 'platform'] as const;
  const modules = [
    'src/runtime',
    'src/extension',
    'src/hosts',
  ];
  for (const root of roots) {
    const entries = await readdir(join(REPOSITORY_ROOT, 'src', root), { withFileTypes: true });
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      if (await containsTypeScriptSource(join(REPOSITORY_ROOT, 'src', root, entry.name))) {
        modules.push(posix.join('src', root, entry.name));
      }
    }
  }
  const extensions = await readdir(join(REPOSITORY_ROOT, 'extensions'), { withFileTypes: true });
  for (const extension of extensions.filter((candidate) => candidate.isDirectory())) {
    if (await containsTypeScriptSource(join(REPOSITORY_ROOT, 'extensions', extension.name))) {
      modules.push(posix.join('extensions', extension.name));
    }
  }
  return modules;
}

async function containsTypeScriptSource(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) return true;
    if (entry.isDirectory() && await containsTypeScriptSource(join(directory, entry.name))) return true;
  }
  return false;
}

function requireDocument(id: string): CurrentAuthorityDocument {
  const document = documents.find((entry) => entry.id === id);
  if (!document) throw new Error(`Missing Current Authority document: ${id}`);
  return document;
}

function metadata(content: string, label: string): string | undefined {
  return new RegExp(`^> ${escapeRegExp(label)}: (.+)$`, 'mu').exec(content)?.[1]?.trim();
}

function objectTypeBody(content: string, name: string): string {
  const match = new RegExp(
    `export (?:interface ${name}|type ${name} =) \\{([\\s\\S]*?)\\n\\}`,
  ).exec(content);
  if (!match?.[1]) throw new Error(`Missing object contract: ${name}`);
  return match[1];
}

function evidenceLinks(content: string, label: string | RegExp): string[] {
  return content.split(/\r?\n/u)
    .filter((line) => line.startsWith('| '))
    .filter((line) => {
      const kind = line.split('|')[1]?.trim() ?? '';
      return typeof label === 'string' ? kind === label : label.test(kind);
    })
    .flatMap((line) => markdownDestinations(line));
}

function markdownDestinations(content: string): string[] {
  return [...content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.trim())
    .filter((destination): destination is string => Boolean(destination));
}

function hasMarkdownAnchor(content: string, encodedFragment: string): boolean {
  let fragment: string;
  try {
    fragment = decodeURIComponent(encodedFragment).toLowerCase();
  } catch {
    return false;
  }
  const withoutCodeFences = content
    .replace(/^\s*`{3,}[^\r\n]*\r?\n[\s\S]*?^\s*`{3,}\s*$/gmu, '')
    .replace(/^\s*~{3,}[^\r\n]*\r?\n[\s\S]*?^\s*~{3,}\s*$/gmu, '');
  const explicitAnchors = [...withoutCodeFences.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1]?.toLowerCase());
  if (explicitAnchors.includes(fragment)) return true;

  return [...withoutCodeFences.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)]
    .some((match) => markdownHeadingAnchor(match[1] ?? '') === fragment);
}

function markdownHeadingAnchor(heading: string): string {
  return heading
    .replace(/<[^>]+>/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
