import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectFt11ApiM04Baseline,
  collectFt11DocumentReferenceAudit,
  findFt11DocumentDispositionViolations,
  loadTypeScriptSources,
} from './rules.js';
import type {
  Ft11DispositionManifest,
  Ft11DocumentCategory,
  Ft11DocumentReferenceAudit,
  Ft11ExpectedDocument,
  Ft11FrozenDocument,
  Ft11ApiM04Baseline,
  Ft11ReferenceCategory,
  Ft11ReferenceSource,
  SourceInput,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MANIFEST_PATH = fileURLToPath(
  new URL('../../docs/architecture/slice-6-document-disposition-manifest.json', import.meta.url),
);
const SURFACE_PATH = fileURLToPath(
  new URL('./ft-11-document-surface.json', import.meta.url),
);
const INVENTORY_PATH = fileURLToPath(
  new URL('../../docs/architecture/legacy-migration-inventory.md', import.meta.url),
);
const GOVERNANCE_LEDGERS = new Set([
  'docs/architecture/legacy-migration-inventory.md',
  'docs/architecture/slice-6-documentation-legacy-closeout-spec.md',
]);
const ACTIVE_NAVIGATION_DOCUMENTS = new Set([
  'README.md',
  posix.join('docs', 'README.md'),
  posix.join('docs', 'agent-capabilities.md'),
]);
let manifest: Ft11DispositionManifest;
let expectedDocuments: Ft11FrozenDocument[];
let inventoryDocuments: Ft11ExpectedDocument[];
let referenceSources: Ft11ReferenceSource[];
let availablePaths: Set<string>;
let actualReferences: Ft11DocumentReferenceAudit;
let actualApiM04Baseline: Ft11ApiM04Baseline;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

describe('FT-11 Slice 6 document disposition manifest', () => {
  beforeAll(async () => {
    manifest = await readJson<Ft11DispositionManifest>(MANIFEST_PATH);
    expectedDocuments = await readJson<Ft11FrozenDocument[]>(SURFACE_PATH);
    inventoryDocuments = await loadExpectedDocuments();
    referenceSources = await loadReferenceSources(expectedDocuments);
    availablePaths = new Set(referenceSources.map((source) => source.path));
    actualReferences = collectFt11DocumentReferenceAudit(referenceSources, expectedDocuments);
    actualApiM04Baseline = collectFt11ApiM04Baseline(referenceSources);
  });

  // FT11_FIXTURE_REFERENCES_BEGIN
  it('collects Markdown and source references by role', () => {
    const documents: Ft11ExpectedDocument[] = [
      { id: 'DOC-C01', path: 'docs/architecture/current/overview.md', category: 'current-fact' },
      { id: 'DOC-V10', path: 'docs/architecture/v1.0/platform-config-wizard-design.md', category: 'v1.0-candidate' },
    ];
    const sources: Ft11ReferenceSource[] = [
      {
        path: 'docs/README.md',
        content: '[Current][current]\n\n[current]: architecture/current/overview.md#module-map',
        category: 'activeDocs',
      },
      {
        path: 'docs/navigation.md',
        content: '<a href="architecture/current/overview.md">Current</a>\n```md\n[ignored](architecture/v1.0/platform-config-wizard-design.md)\n```',
        category: 'activeDocs',
      },
      {
        path: 'docs/architecture/legacy-migration-inventory.md',
        content: '[Wizard](v1.0/platform-config-wizard-design.md)',
        category: 'governanceLedger',
      },
      {
        path: 'src/config.ts',
        content: '// See docs\\architecture\\v1.0\\platform-config-wizard-design.md',
        category: 'productionSource',
      },
    ];

    expect(collectFt11DocumentReferenceAudit(sources, documents)).toEqual({
      candidates: {
        'DOC-C01': {
          activeDocs: ['docs/README.md', 'docs/navigation.md'],
          candidateDocs: [],
          productionSource: [],
          tests: [],
          scripts: [],
          clients: [],
        },
        'DOC-V10': {
          activeDocs: [],
          candidateDocs: [],
          productionSource: ['src/config.ts'],
          tests: [],
          scripts: [],
          clients: [],
        },
      },
      governanceLedgers: {
        'docs/architecture/legacy-migration-inventory.md': ['DOC-V10'],
      },
    });
  });
  // FT11_FIXTURE_REFERENCES_END

  it('locks 52 entries, exact inbound references, and the S6-D3 migration boundary', () => {
    expect(findFt11DocumentDispositionViolations(
      manifest,
      expectedDocuments,
      availablePaths,
      actualReferences,
      actualApiM04Baseline,
    )).toEqual([]);
    expect(inventoryDocuments).toEqual(expectedDocuments
      .map(({ proposedDisposition: _ignored, ...entry }) => entry)
      .sort((left, right) => left.id.localeCompare(right.id)));
    expect(categoryCounts(expectedDocuments)).toEqual({
      'current-fact': 13,
      'root-candidate': 27,
      'v1.0-candidate': 12,
    });
    expect(Object.entries(manifest.entryStateById)
      .filter(([id]) => id.startsWith('DOC-C'))
      .every(([, state]) => state.transitionState === 'Migrated'
        && state.finalDisposition === 'Retain Current Authority')).toBe(true);
    expect(Object.entries(manifest.entryStateById)
      .filter(([id]) => !id.startsWith('DOC-C') && id !== 'DOC-A08' && id !== 'DOC-A09')
      .every(([, state]) => state.transitionState === 'Pending'
        && state.finalDisposition === null)).toBe(true);
    expect(['DOC-A08', 'DOC-A09'].every((id) => {
      const state = manifest.entryStateById[id];
      return state?.transitionState === 'Migrated'
        && state.finalDisposition === 'Retain Active Navigation';
    })).toBe(true);
    expect(manifest.candidates.find((entry) => entry.id === 'DOC-V10')?.inbound).toMatchObject({
      productionSource: [
        'src/platform/config/wizard/diff.ts',
        'src/platform/config/wizard/display.ts',
        'src/platform/config/wizard/fields.ts',
        'src/platform/config/wizard/prompts.ts',
        'src/platform/config/wizard/run-wizard.ts',
      ],
      tests: ['src/architecture-fitness/ft-09-doc-governance.test.ts'],
    });
  });

  it('routes active navigation to Current Architecture without pending candidate links', () => {
    const activeNavigation = ['README.md', 'docs/README.md', 'docs/agent-capabilities.md'];

    for (const sourcePath of activeNavigation) {
      const source = referenceSources.find((entry) => entry.path === sourcePath);
      expect(source, `missing active navigation ${sourcePath}`).toBeDefined();
    }
    expect(actualReferences.candidates['DOC-C01']?.activeDocs).toEqual(
      expect.arrayContaining(activeNavigation),
    );

    const pendingCandidateLinks = expectedDocuments
      .filter((entry) => !entry.id.startsWith('DOC-C') && entry.id !== 'DOC-A08' && entry.id !== 'DOC-A09')
      .flatMap((entry) => (actualReferences.candidates[entry.id]?.activeDocs ?? [])
        .filter((sourcePath) => activeNavigation.includes(sourcePath))
        .map((sourcePath) => `${sourcePath} -> ${entry.path}`));
    expect(pendingCandidateLinks).toEqual([]);
  });

  it('requires local Markdown successor paths and fragments to resolve', () => {
    const markdownByPath = new Map(
      referenceSources
        .filter((source) => source.path.endsWith('.md'))
        .map((source) => [source.path, source.content]),
    );

    for (const entry of manifest.candidates) {
      for (const field of [
        'currentFactSuccessor',
        'durableDecisionAuthority',
        'unfinishedWorkSuccessor',
      ] as const) {
        for (const destination of entry[field]) {
          if (!destination.split('#')[0]?.endsWith('.md')) continue;
          const [targetPath, fragment] = destination.split('#', 2);
          const targetContent = targetPath ? markdownByPath.get(targetPath) : undefined;
          expect(targetContent, `${entry.id} ${field} missing ${destination}`).toBeDefined();
          if (targetContent && fragment) {
            expect(
              hasMarkdownAnchor(targetContent, fragment),
              `${entry.id} ${field} missing fragment ${destination}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it('rejects identity, path, category, field, ledger, disposition, state, and API drift', () => {
    const invalid = structuredClone(manifest);
    const first = invalid.candidates[0];
    const second = invalid.candidates[1];
    const third = invalid.candidates[2];
    if (!first || !second || !third) throw new Error('FT-11 fixture requires at least three candidates');

    first.id = second.id;
    third.path = second.path;
    second.category = 'root-candidate';
    second.proposedDisposition = 'Delete After Migration';
    delete (second as Partial<typeof second>).evidenceSuccessor;
    delete (first.inbound as Partial<typeof first.inbound>).clients;
    (invalid.entryDefaults as { finalDisposition: string | null }).finalDisposition = 'Deleted';
    invalid.entryDefaults.validation.status = 'completed';
    invalid.entryDefaults.validation.linkAudit = 'passed';
    invalid.entryDefaults.validation.fitness = 'passed';
    const pendingExpectedId = expectedDocuments.find((entry) => entry.category !== 'current-fact')?.id;
    if (!pendingExpectedId) throw new Error('FT-11 surface must include a pending non-Current entry');
    const state = invalid.entryStateById[pendingExpectedId];
    if (!state) throw new Error(`Missing FT-11 state: ${pendingExpectedId}`);
    state.transitionState = 'Reviewed';
    invalid.referenceAudit.governanceLedgers.pop();
    invalid.apiM04Baseline.facadePathImports.productionSource.pop();
    const docV10 = invalid.candidates.find((entry) => entry.id === 'DOC-V10');
    if (!docV10) throw new Error('Missing DOC-V10 fixture');
    docV10.inbound.productionSource.pop();
    docV10.inbound.tests.pop();

    const invalidReferences = structuredClone(actualReferences);
    invalidReferences.governanceLedgers['docs/architecture/legacy-migration-inventory.md']?.pop();
    const invalidAvailablePaths = new Set(availablePaths);
    const missingPath = expectedDocuments[3]?.path;
    if (missingPath) invalidAvailablePaths.delete(missingPath);

    const diagnostics = findFt11DocumentDispositionViolations(
      invalid,
      expectedDocuments,
      invalidAvailablePaths,
      invalidReferences,
      actualApiM04Baseline,
    );

    expect(diagnostics).toContain('FT-11 manifest field=id violation=duplicate-entry');
    expect(diagnostics).toContain('FT-11 manifest field=path violation=duplicate-entry');
    expect(diagnostics).toContain('FT-11 defaults field=finalDisposition violation=premature-review');
    expect(diagnostics).toContain('FT-11 defaults field=validation.status violation=premature-review');
    expect(diagnostics).toContain('FT-11 defaults field=validation.linkAudit violation=invalid-value');
    expect(diagnostics).toContain('FT-11 defaults field=validation.fitness violation=invalid-value');
    expect(diagnostics).toContain(`FT-11 entry=${second.id} field=inbound.clients violation=missing-baseline-field`);
    expect(diagnostics).toContain(`FT-11 entry=${pendingExpectedId} field=transitionState violation=premature-transition`);
    expect(diagnostics).toContain('FT-11 manifest field=referenceAudit.governanceLedgers violation=reference-drift');
    expect(diagnostics).toContain('FT-11 ledger=docs/architecture/legacy-migration-inventory.md violation=incomplete-candidate-coverage');
    expect(diagnostics).toContain('FT-11 manifest field=apiM04Baseline violation=reference-drift');
    expect(diagnostics).toContain('FT-11 entry=DOC-V10 field=inbound.productionSource violation=reference-drift');
    expect(diagnostics).toContain('FT-11 entry=DOC-V10 field=inbound.tests violation=reference-drift');
    expect(diagnostics.some((diagnostic) => diagnostic.includes('field=evidenceSuccessor violation=missing-baseline-field'))).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.includes('field=category') && diagnostic.includes('violation=mismatch'))).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.includes('field=proposedDisposition') && diagnostic.includes('violation=mismatch'))).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.includes('violation=missing-document'))).toBe(true);
  });
});

async function loadExpectedDocuments(): Promise<Ft11ExpectedDocument[]> {
  const inventory = await readFile(INVENTORY_PATH, 'utf8');
  const documents: Ft11ExpectedDocument[] = [];

  for (const line of inventory.split(/\r?\n/)) {
    const id = /^\| (DOC-[CAV]\d{2}) \|/.exec(line)?.[1];
    const linkedPath = /\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/.exec(line)?.[1];
    if (!id || !linkedPath || documents.some((document) => document.id === id)) continue;
    documents.push({
      id,
      path: posix.normalize(posix.join('docs/architecture', linkedPath)),
      category: categoryForId(id),
    });
  }

  return documents.sort((left, right) => left.id.localeCompare(right.id));
}

function categoryForId(id: string): Ft11DocumentCategory {
  if (id.startsWith('DOC-C')) return 'current-fact';
  if (id.startsWith('DOC-A')) return 'root-candidate';
  return 'v1.0-candidate';
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

async function loadReferenceSources(
  expectedDocuments: Ft11ExpectedDocument[],
): Promise<Ft11ReferenceSource[]> {
  const candidatePaths = new Set(expectedDocuments.map((document) => document.path));
  const [documents, sourceFiles, scriptFiles, clientFiles] = await Promise.all([
    loadTextSources(join(REPOSITORY_ROOT, 'docs'), ['.md'], 'docs'),
    loadTypeScriptSources(join(REPOSITORY_ROOT, 'src'), [], 'src'),
    loadTypeScriptSources(join(REPOSITORY_ROOT, 'scripts'), [], 'scripts'),
    loadTextSources(join(REPOSITORY_ROOT, 'clients'), ['.html', '.js', '.md', '.ts'], 'clients'),
  ]);
  const rootReadme: SourceInput = {
    path: 'README.md',
    content: await readFile(join(REPOSITORY_ROOT, 'README.md'), 'utf8'),
  };

  return [rootReadme, ...documents, ...sourceFiles, ...scriptFiles, ...clientFiles]
    .map((source) => source.path === 'src/architecture-fitness/ft-11-document-disposition.test.ts'
      ? { ...source, content: stripFixtureReferences(source.content) }
      : source)
    .map((source) => ({ ...source, category: referenceCategory(source.path, candidatePaths) }))
    .filter((source): source is Ft11ReferenceSource => source.category !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function stripFixtureReferences(content: string): string {
  return content.replace(
    /\s*\/\/ FT11_FIXTURE_REFERENCES_BEGIN[\s\S]*?\/\/ FT11_FIXTURE_REFERENCES_END/g,
    '\n',
  );
}

function categoryCounts(
  documents: Ft11ExpectedDocument[],
): Record<Ft11DocumentCategory, number> {
  return documents.reduce<Record<Ft11DocumentCategory, number>>(
    (counts, document) => ({ ...counts, [document.category]: counts[document.category] + 1 }),
    { 'current-fact': 0, 'root-candidate': 0, 'v1.0-candidate': 0 },
  );
}

function referenceCategory(
  sourcePath: string,
  candidatePaths: Set<string>,
): Ft11ReferenceCategory | undefined {
  if (GOVERNANCE_LEDGERS.has(sourcePath)) return 'governanceLedger';
  if (ACTIVE_NAVIGATION_DOCUMENTS.has(sourcePath)) return 'activeDocs';
  if (candidatePaths.has(sourcePath) && sourcePath.endsWith('.md')) return 'candidateDocs';
  if (sourcePath.endsWith('.md')) return 'activeDocs';
  if (sourcePath.startsWith('scripts/')) return 'scripts';
  if (sourcePath.startsWith('clients/')) return 'clients';
  if (sourcePath.endsWith('.test.ts') || sourcePath.startsWith('src/architecture-fitness/')) {
    return 'tests';
  }
  if (sourcePath.startsWith('src/')) return 'productionSource';
  return undefined;
}

async function loadTextSources(
  root: string,
  extensions: string[],
  pathPrefix: string,
): Promise<SourceInput[]> {
  const sources: SourceInput[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        sources.push({
          path: posix.join(pathPrefix, relative(root, absolutePath).replaceAll('\\', '/')),
          content: await readFile(absolutePath, 'utf8'),
        });
      }
    }
  }

  await walk(root);
  return sources;
}
