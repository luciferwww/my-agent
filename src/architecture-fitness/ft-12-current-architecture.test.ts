import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface CurrentAuthoritySurfaceEntry {
  id: string;
  role: 'overview' | 'topic';
  path: string;
  ownershipKey: string;
  ownedModules: string[];
}

interface CurrentAuthorityDocument extends CurrentAuthoritySurfaceEntry {
  absolutePath: string;
  content: string;
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CURRENT_ROOT = join(REPOSITORY_ROOT, 'docs', 'architecture', 'current');
const SURFACE_PATH = fileURLToPath(new URL('./ft-12-current-architecture-surface.json', import.meta.url));
const VERIFIED_DATE = '2026-09-09';
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
];

let surface: CurrentAuthoritySurfaceEntry[];
let documents: CurrentAuthorityDocument[];

describe('FT-12 Current Architecture authority', () => {
  beforeAll(async () => {
    surface = JSON.parse(await readFile(SURFACE_PATH, 'utf8')) as CurrentAuthoritySurfaceEntry[];
    documents = await Promise.all(surface.map(async (entry) => ({
      ...entry,
      absolutePath: join(REPOSITORY_ROOT, ...entry.path.split('/')),
      content: await readFile(join(REPOSITORY_ROOT, ...entry.path.split('/')), 'utf8'),
    })));
  });

  it('locks one overview, unique topic ownership, and complete current module coverage', async () => {
    expect(surface.length).toBeGreaterThan(1);
    expect(new Set(surface.map((entry) => entry.id)).size).toBe(surface.length);
    expect(new Set(surface.map((entry) => entry.path)).size).toBe(surface.length);
    expect(new Set(surface.map((entry) => entry.ownershipKey)).size).toBe(surface.length);
    expect(surface.filter((entry) => entry.role === 'overview')).toHaveLength(1);

    const currentFiles = (await readdir(CURRENT_ROOT))
      .filter((name) => name.endsWith('.md'))
      .map((name) => posix.join('docs/architecture/current', name))
      .sort();
    expect(currentFiles).toEqual(surface.map((entry) => entry.path).sort());

    for (const document of documents) {
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
      'sole entry point for verified Current Architecture',
    );
    for (const topic of surface.filter((entry) => entry.role === 'topic')) {
      const relativeTarget = `./${posix.basename(topic.path)}`;
      expect(markdownDestinations(overview.content)).toContain(relativeTarget);
      expect(metadata(requireDocument(topic.id).content, 'Authority')).toBeUndefined();
    }
  });

  it('requires existing source, test, and controlling-authority evidence on every page', async () => {
    for (const document of documents) {
      expect(document.content).toMatch(/^## \d+\. Evidence$/mu);
      const sourceLinks = evidenceLinks(document.content, 'Source');
      const testLinks = evidenceLinks(document.content, 'Tests');
      const authorityLinks = evidenceLinks(document.content, 'Controlling authority');
      expect(sourceLinks.length, `${document.id} source evidence`).toBeGreaterThan(0);
      expect(testLinks.length, `${document.id} test evidence`).toBeGreaterThan(0);
      expect(authorityLinks.length, `${document.id} controlling authority`).toBeGreaterThan(0);

      for (const destination of [...sourceLinks, ...testLinks, ...authorityLinks]) {
        const [targetPath, fragment] = destination.split('#', 2);
        const target = resolve(dirname(document.absolutePath), targetPath ?? '');
        expect((await stat(target)).isFile(), `${document.id} missing ${destination}`).toBe(true);
        if (fragment) {
          const targetContent = await readFile(target, 'utf8');
          expect(
            hasMarkdownAnchor(targetContent, fragment),
            `${document.id} missing fragment ${destination}`,
          ).toBe(true);
        }
      }
      expect(sourceLinks.every((link) => link.includes('/src/') || link.includes('/scripts/'))).toBe(true);
      expect(testLinks.every((link) => link.endsWith('.test.ts'))).toBe(true);
      expect(authorityLinks.every((link) => link.endsWith('.md'))).toBe(true);
    }
  });

  it('rejects stale authority and pre-Slice-5 composition claims', () => {
    for (const document of documents) {
      for (const pattern of STALE_CURRENT_CLAIMS) {
        expect(document.content, `${document.id} matches ${pattern}`).not.toMatch(pattern);
      }
    }

    const runtime = requireDocument('runtime').content;
    expect(runtime).toContain('`RuntimeApp.create()` is delegation-only');
    expect(runtime).toContain('Child Turns use the Parent\'s Snapshot');
    expect(runtime).toContain('`CompositionCoordinator`');

    const runner = requireDocument('runner').content;
    expect(runner).toContain('`request_end` 关闭尚未启动的 queued request');
    expect(runner).toContain(
      '`signal.aborted` is checked before quota, steering injection, `llm_call`, and invocation.',
    );

    const channel = requireDocument('channel').content;
    expect(channel).toContain('send(event: AgentEvent): void | Promise<void>');
    expect(channel).toContain('queued `request_end` 没有 session/turn');

    const config = requireDocument('configuration').content;
    expect(config).toContain('## 3. Five-stage precedence');
    expect(config).toContain('does not establish canonical model identity');
    expect(config).toContain('## 6. Config Wizard');

    const provider = requireDocument('model-invocation-provider').content;
    expect(provider).toContain('API-M04 residual');
    expect(provider).toContain('Alias/path removal remains separately gated');

    const modelResolution = requireDocument('model-resolution').content;
    expect(modelResolution).toContain('sole owner of canonical Model identity');
    expect(modelResolution).toContain('`ModelResolutionError.category`');

    const media = requireDocument('media').content;
    expect(media).toContain('pure attachment/media pipeline');
    expect(media).toContain('`processInboundMessage()`');
  });
});

async function currentSourceModules(): Promise<string[]> {
  const roots = ['core', 'adapters', 'platform'] as const;
  const modules = ['src/runtime', 'src/runtime-modules', 'src/core/tools/builtin'];
  for (const root of roots) {
    const entries = await readdir(join(REPOSITORY_ROOT, 'src', root), { withFileTypes: true });
    modules.push(...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => posix.join('src', root, entry.name)));
  }
  return modules;
}

function requireDocument(id: string): CurrentAuthorityDocument {
  const document = documents.find((entry) => entry.id === id);
  if (!document) throw new Error(`Missing Current Authority document: ${id}`);
  return document;
}

function metadata(content: string, label: string): string | undefined {
  return new RegExp(`^> ${escapeRegExp(label)}: (.+)$`, 'mu').exec(content)?.[1]?.trim();
}

function evidenceLinks(content: string, label: string): string[] {
  const row = content.split(/\r?\n/u).find((line) => line.startsWith(`| ${label} |`));
  return row ? markdownDestinations(row) : [];
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
  const explicitAnchors = [...content.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1]?.toLowerCase());
  if (explicitAnchors.includes(fragment)) return true;

  return [...content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)]
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
