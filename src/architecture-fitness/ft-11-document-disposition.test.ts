import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectFt11ApiM04Baseline,
  collectFt11DocumentReferenceAudit,
  findFt11DocumentDispositionViolations,
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
const AUDIT_METADATA = new Set([
  'docs/architecture/slice-6-document-disposition-manifest.json',
  'src/architecture-fitness/ft-11-document-disposition.test.ts',
  'src/architecture-fitness/ft-11-document-surface.json',
  'src/architecture-fitness/rules.ts',
  'src/architecture-fitness/ft-12-current-architecture-surface.json',
]);
const ACTIVE_NAVIGATION_DOCUMENTS = new Set([
  'README.md',
  posix.join('docs', 'README.md'),
  posix.join('docs', 'agent-capabilities.md'),
]);
const REFERENCE_TEXT_EXTENSIONS = [
  '.cjs', '.css', '.html', '.js', '.json', '.jsonc', '.md', '.mjs', '.ps1', '.sh',
  '.toml', '.ts', '.tsx', '.yaml', '.yml',
];
const S6_D4_DELETED_IDS = new Set([
  'DOC-A01', 'DOC-A02', 'DOC-A03', 'DOC-A07',
  'DOC-A10', 'DOC-A11', 'DOC-A12', 'DOC-A13', 'DOC-A14', 'DOC-A15', 'DOC-A16',
  'DOC-A17', 'DOC-A18', 'DOC-A19', 'DOC-A20', 'DOC-A21', 'DOC-A22', 'DOC-A23',
  'DOC-A24', 'DOC-A25', 'DOC-A26', 'DOC-A27',
]);
const S6_D5_DEFERRED_IDS = new Set(['DOC-A04', 'DOC-A05']);
const S6_D6_DELETED_IDS = new Set(Array.from({ length: 12 }, (_, index) => (
  `DOC-V${String(index + 1).padStart(2, '0')}`
)));
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
      {
        path: 'scripts/manual.json',
        content: '{"guide":"docs/architecture/v1.0/platform-config-wizard-design.md"}',
        category: 'scripts',
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
          scripts: ['scripts/manual.json'],
          clients: [],
        },
      },
      governanceLedgers: {
        'docs/architecture/legacy-migration-inventory.md': ['DOC-V10'],
      },
    });
  });
  // FT11_FIXTURE_REFERENCES_END

  it('locks 52 entries, exact inbound references, and the S6-D6 disposition boundary', () => {
    expect(findFt11DocumentDispositionViolations(
      manifest,
      expectedDocuments,
      availablePaths,
      actualReferences,
      actualApiM04Baseline,
    )).toEqual([]);
    expect(inventoryDocuments).toEqual(expectedDocuments
      .map(({ proposedDisposition: _ignored, s6D6Successors: _ignoredSuccessors, ...entry }) => entry)
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
      .filter(([id]) => !id.startsWith('DOC-C')
        && id !== 'DOC-A08'
        && id !== 'DOC-A09'
        && !S6_D5_DEFERRED_IDS.has(id)
        && id !== 'DOC-A06'
        && !S6_D4_DELETED_IDS.has(id)
        && !S6_D6_DELETED_IDS.has(id))).toEqual([]);
    expect(['DOC-A08', 'DOC-A09'].every((id) => {
      const state = manifest.entryStateById[id];
      return state?.transitionState === 'Migrated'
        && state.finalDisposition === 'Retain Active Navigation';
    })).toBe(true);
    expect([...S6_D4_DELETED_IDS].every((id) => {
      const state = manifest.entryStateById[id];
      const entry = manifest.candidates.find((candidate) => candidate.id === id);
      const review = manifest.s6D4DeletionReviewById?.[id];
      return state?.transitionState === 'Deleted'
        && state.uniqueValueConclusion === 'no-unique-value-after-migration'
        && state.finalDisposition === 'Delete After Migration'
        && entry !== undefined
        && review?.stateHistory.join('>') === 'Pending>Migrating>Migrated>Reviewed>Deleted'
        && review.verifiedCurrentFact === 'no-migrated-to-current'
        && review.durableDecision === 'no-migrated-to-accepted-authority'
        && review.unfinishedApprovedWork === 'no-explicitly-rejected'
        && review.executedEvidence === 'no-reconstructible-from-source-tests-git'
        && review.stableHistoricalLocator === 'no'
        && review.rationaleForRetainedAuthority === 'no'
        && Object.values(entry.inbound).every((references) => references.length === 0)
        && !availablePaths.has(entry.path);
    })).toBe(true);
    expect([...S6_D5_DEFERRED_IDS].every((id) => {
      const state = manifest.entryStateById[id];
      const decision = manifest.s6D5DecisionById?.[id];
      const entry = manifest.candidates.find((candidate) => candidate.id === id);
      return state?.transitionState === 'Reviewed'
        && state.finalDisposition === 'Retain Deferred Input'
        && decision?.stateHistory.join('>') === 'Pending>Migrating>Migrated>Reviewed'
        && decision.owner === 'Project Owner'
        && decision.foundationFreeze === 'active-until-separate-post-foundation-authorization'
        && decision.nonAuthorizing === true
        && decision.successor === 'docs/roadmap/architecture-foundation-plan.md#post-foundation-subagent-concurrency-deferred-tracker'
        && entry?.inbound.activeDocs.every((path) => !path.startsWith('docs/architecture/current/'))
        && availablePaths.has(entry.path);
    })).toBe(true);
    const closedState = manifest.entryStateById['DOC-A06'];
    const closedDecision = manifest.s6D5DecisionById?.['DOC-A06'];
    const closedEntry = manifest.candidates.find((candidate) => candidate.id === 'DOC-A06');
    expect(closedState).toMatchObject({
      transitionState: 'Deleted',
      uniqueValueConclusion: 'no-unique-value-after-migration',
      finalDisposition: 'Delete After Migration',
    });
    expect(closedDecision?.stateHistory.join('>')).toBe('Pending>Migrating>Migrated>Reviewed>Deleted');
    expect(Object.values(closedEntry?.inbound ?? {}).every((references) => references.length === 0)).toBe(true);
    expect(closedEntry && availablePaths.has(closedEntry.path)).toBe(false);
    expect([...S6_D6_DELETED_IDS].every((id) => {
      const state = manifest.entryStateById[id];
      const entry = manifest.candidates.find((candidate) => candidate.id === id);
      const review = manifest.s6D6DeletionReviewById?.[id];
      const expectedSuccessors = expectedDocuments.find((document) => document.id === id)?.s6D6Successors;
      return state?.transitionState === 'Deleted'
        && state.uniqueValueConclusion === 'no-unique-value-after-migration'
        && state.finalDisposition === 'Delete After Migration'
        && entry !== undefined
        && review?.stateHistory.join('>') === 'Pending>Migrating>Migrated>Reviewed>Deleted'
        && review.verifiedCurrentFact === 'no-migrated-to-current'
        && review.durableDecision === 'no-migrated-to-accepted-authority'
        && review.unfinishedApprovedWork === 'no-explicitly-rejected'
        && review.executedEvidence === 'no-reconstructible-from-source-tests-git'
        && review.rationaleForRetainedAuthority === 'no'
        && JSON.stringify(entry.currentFactSuccessor) === JSON.stringify(expectedSuccessors?.currentFactSuccessor)
        && JSON.stringify(entry.durableDecisionAuthority) === JSON.stringify(expectedSuccessors?.durableDecisionAuthority)
        && entry.unfinishedWorkSuccessor.length === 1
        && entry.unfinishedWorkSuccessor[0] === 'rejected in S6-D6: no owner-approved unfinished work remains'
        && entry.evidenceSuccessor.length > 0
        && Object.values(entry.inbound).every((references) => references.length === 0)
        && !availablePaths.has(entry.path);
    })).toBe(true);
    expect(['DOC-V01', 'DOC-V03', 'DOC-V06', 'DOC-V08', 'DOC-V11'].every((id) => (
      manifest.s6D6DeletionReviewById?.[id]?.stableHistoricalLocator
        === 'no-git-history-preserves-delta'
    ))).toBe(true);
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
    invalid.s6D4IndependentReviewStatus = 'passed-before-re-review';
    const deletionReview = invalid.s6D4DeletionReviewById?.['DOC-A01'];
    if (!deletionReview) throw new Error('Missing S6-D4 deletion review fixture');
    deletionReview.stateHistory.splice(3, 1);
    deletionReview.verifiedCurrentFact = 'yes-unmigrated';
    invalid.s6D5IndependentReviewStatus = 'accepted-without-review';
    const deferredDecision = invalid.s6D5DecisionById?.['DOC-A04'];
    const closedDecision = invalid.s6D5DecisionById?.['DOC-A06'];
    if (!deferredDecision || !closedDecision) throw new Error('Missing S6-D5 decision fixtures');
    deferredDecision.owner = 'Unowned';
    deferredDecision.nonAuthorizing = false;
    closedDecision.stateHistory.splice(3, 1);
    closedDecision.unfinishedApprovedWork = 'yes-untracked';
    invalid.s6D6IndependentReviewStatus = 'accepted-without-review';
    const v1ChangeReview = invalid.s6D6DeletionReviewById?.['DOC-V01'];
    const v1DesignReview = invalid.s6D6DeletionReviewById?.['DOC-V02'];
    if (!v1ChangeReview || !v1DesignReview) throw new Error('Missing S6-D6 review fixtures');
    v1ChangeReview.stateHistory.splice(3, 1);
    v1ChangeReview.stableHistoricalLocator = 'yes-unmapped-evidence';
    v1DesignReview.verifiedCurrentFact = 'yes-unmigrated';
    const deferredEntry = invalid.candidates.find((entry) => entry.id === 'DOC-A04');
    const deferredSpecEntry = invalid.candidates.find((entry) => entry.id === 'DOC-A05');
    const closedEntry = invalid.candidates.find((entry) => entry.id === 'DOC-A06');
    if (!deferredEntry || !deferredSpecEntry || !closedEntry) {
      throw new Error('Missing S6-D5 candidate fixtures');
    }
    deferredEntry.currentFactSuccessor.push('docs/architecture/current/runtime.md');
    deferredSpecEntry.unfinishedWorkSuccessor = ['future accepted Subagent Plan/Spec'];
    closedEntry.evidenceSuccessor.pop();
    invalid.referenceAudit.governanceLedgers.pop();
    invalid.apiM04Baseline.facadePathImports.productionSource.pop();
    const docV10 = invalid.candidates.find((entry) => entry.id === 'DOC-V10');
    const docV02 = invalid.candidates.find((entry) => entry.id === 'DOC-V02');
    const docV03 = invalid.candidates.find((entry) => entry.id === 'DOC-V03');
    const docV04 = invalid.candidates.find((entry) => entry.id === 'DOC-V04');
    if (!docV10 || !docV02 || !docV03 || !docV04) throw new Error('Missing S6-D6 candidate fixtures');
    docV02.currentFactSuccessor = ['docs/architecture/current/runtime.md'];
    docV03.unfinishedWorkSuccessor = ['future work retained'];
    docV04.evidenceSuccessor = [];
    docV10.inbound.productionSource.push('src/platform/config/wizard/fields.ts');
    docV10.inbound.tests.push('src/architecture-fitness/ft-09-doc-governance.test.ts');

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
    expect(diagnostics).toContain('FT-11 manifest field=s6D4IndependentReviewStatus violation=invalid-review-state');
    expect(diagnostics).toContain('FT-11 entry=DOC-A01 field=stateHistory violation=missing-reviewed-delete-transition');
    expect(diagnostics).toContain('FT-11 entry=DOC-A01 field=uniqueValueReview.verifiedCurrentFact violation=unresolved');
    expect(diagnostics).toContain('FT-11 manifest field=s6D5IndependentReviewStatus violation=invalid-review-state');
    expect(diagnostics).toContain('FT-11 entry=DOC-A04 field=deferredMetadata violation=incomplete');
    expect(diagnostics).toContain('FT-11 entry=DOC-A06 field=stateHistory violation=missing-reviewed-delete-transition');
    expect(diagnostics).toContain('FT-11 entry=DOC-A06 field=uniqueValueReview violation=unresolved');
    expect(diagnostics).toContain('FT-11 entry=DOC-A04 field=currentFactSuccessor violation=s6-d5-successor-drift');
    expect(diagnostics).toContain('FT-11 entry=DOC-A05 field=unfinishedWorkSuccessor violation=s6-d5-successor-drift');
    expect(diagnostics).toContain('FT-11 entry=DOC-A06 field=evidenceSuccessor violation=s6-d5-successor-drift');
    expect(diagnostics).toContain('FT-11 manifest field=s6D6IndependentReviewStatus violation=invalid-review-state');
    expect(diagnostics).toContain('FT-11 entry=DOC-V01 field=stateHistory violation=missing-reviewed-delete-transition');
    expect(diagnostics).toContain('FT-11 entry=DOC-V01 field=uniqueValueReview violation=unresolved');
    expect(diagnostics).toContain('FT-11 entry=DOC-V02 field=uniqueValueReview violation=unresolved');
    expect(diagnostics).toContain('FT-11 entry=DOC-V02 field=currentFactSuccessor violation=s6-d6-successor-drift');
    expect(diagnostics).toContain('FT-11 entry=DOC-V03 field=unfinishedWorkSuccessor violation=s6-d6-work-unresolved');
    expect(diagnostics).toContain('FT-11 entry=DOC-V04 field=evidenceSuccessor violation=missing-s6-d6-evidence');
    expect(diagnostics).toContain('FT-11 entry=DOC-V10 field=successor/inbound violation=wizard-closeout-incomplete');
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
    const recordedPath = /\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/.exec(line)?.[1]
      ?? /`([^`]+\.md)`/.exec(line)?.[1];
    if (!id || !recordedPath || documents.some((document) => document.id === id)) continue;
    documents.push({
      id,
      path: posix.normalize(posix.join('docs/architecture', recordedPath)),
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
    loadTextSources(join(REPOSITORY_ROOT, 'docs'), REFERENCE_TEXT_EXTENSIONS, 'docs'),
    loadTextSources(join(REPOSITORY_ROOT, 'src'), REFERENCE_TEXT_EXTENSIONS, 'src'),
    loadTextSources(join(REPOSITORY_ROOT, 'scripts'), REFERENCE_TEXT_EXTENSIONS, 'scripts'),
    loadTextSources(join(REPOSITORY_ROOT, 'clients'), REFERENCE_TEXT_EXTENSIONS, 'clients'),
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
  if (AUDIT_METADATA.has(sourcePath)) return undefined;
  if (GOVERNANCE_LEDGERS.has(sourcePath)) return 'governanceLedger';
  if (ACTIVE_NAVIGATION_DOCUMENTS.has(sourcePath)) return 'activeDocs';
  if (candidatePaths.has(sourcePath) && sourcePath.endsWith('.md')) return 'candidateDocs';
  if (sourcePath.startsWith('docs/')) return 'activeDocs';
  if (sourcePath.startsWith('scripts/')) return 'scripts';
  if (sourcePath.startsWith('clients/')) return 'clients';
  if (/\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(sourcePath)
    || sourcePath.startsWith('src/architecture-fitness/')) {
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
