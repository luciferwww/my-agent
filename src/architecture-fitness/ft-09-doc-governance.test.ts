import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt09DocumentGovernanceViolations,
  findFt09LegacySourceReferences,
  loadProductionSources,
} from './rules.js';
import type { GovernedDocument, SourceInput } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../../test-fixtures/architecture-fitness/ft-09', import.meta.url));
const ACTIVE_DOCUMENTS: GovernedDocument[] = [
  { path: 'docs/development-workflow.md', category: 'governance' },
  { path: 'docs/architecture/architecture-principles.md', category: 'governance' },
  { path: 'docs/architecture/domain-glossary.md', category: 'governance' },
  { path: 'docs/architecture/target-architecture.md', category: 'governance' },
  { path: 'docs/architecture/adr-001-tool-result-closure-and-recovery.md', category: 'adr' },
  { path: 'docs/architecture/adr-002-context-budgeting-and-compaction-recovery.md', category: 'adr' },
  { path: 'docs/architecture/approval-lifecycle-spec.md', category: 'spec' },
  { path: 'docs/roadmap/architecture-foundation-plan.md', category: 'plan' },
  { path: 'docs/roadmap/af-03-target-architecture-plan.md', category: 'plan' },
  { path: 'docs/roadmap/af-04-characterization-fitness-plan.md', category: 'plan' },
];
const LEGACY_DOCUMENTS: GovernedDocument[] = [
  { path: 'docs/architecture/v1.0/platform-config-wizard-design.md', category: 'legacy' },
];

async function loadDocuments(root: string, governed: GovernedDocument[]): Promise<SourceInput[]> {
  const documents = await Promise.all(governed.map(async ({ path }) => {
    try {
      return { path, content: await readFile(join(root, path), 'utf8') };
    } catch {
      return undefined;
    }
  }));
  return documents.filter((document): document is SourceInput => document !== undefined);
}

describe('FT-09 documentation governance', () => {
  it('accepts governed metadata and diagnoses missing status, Legacy authority, and missing successor', async () => {
    const fixtureActive = [{ path: 'docs/architecture/module-spec.md', category: 'spec' }];
    const fixtureLegacy = [{ path: 'docs/architecture/v1.0/old-spec.md', category: 'legacy' }];
    const passDocuments = await loadDocuments(`${FIXTURE_ROOT}/pass`, [...fixtureActive, ...fixtureLegacy]);
    const failDocuments = await loadDocuments(`${FIXTURE_ROOT}/fail`, [...fixtureActive, ...fixtureLegacy]);
    const passSource = await readFile(`${FIXTURE_ROOT}/pass/src/module.ts`, 'utf8');
    const failSource = await readFile(`${FIXTURE_ROOT}/fail/src/module.ts`, 'utf8');

    expect(findFt09DocumentGovernanceViolations(passDocuments, fixtureActive, fixtureLegacy)).toEqual([]);
    expect(findFt09LegacySourceReferences([{ path: 'src/module.ts', content: passSource }])).toEqual([]);
    expect(findFt09DocumentGovernanceViolations(failDocuments, fixtureActive, fixtureLegacy)).toEqual([
      'FT-09 doc=docs/architecture/module-spec.md category=spec field=status violation=missing-status',
      'FT-09 doc=docs/architecture/module-spec.md category=spec field=相关重要决策 target=docs/architecture/v1.0/old-spec.md violation=legacy-authority-link',
      'FT-09 doc=docs/architecture/module-spec.md category=spec field=相关重要决策 target=docs/legacy/old-spec.md violation=legacy-authority-link',
      'FT-09 doc=docs/architecture/v1.0/old-spec.md category=legacy field=successor violation=missing-successor-link',
    ]);
    expect(findFt09LegacySourceReferences([{ path: 'src/module.ts', content: failSource }])).toEqual([
      'FT-09 source=src/module.ts target=docs/architecture/v1.0/旧规范.md violation=legacy-source-reference',
      'FT-09 source=src/module.ts target=docs/legacy/旧规范.md violation=legacy-source-reference',
    ]);
  });

  it('locks the narrow active-document manifest and six current Legacy diagnostics', async () => {
    const documents = await loadDocuments(REPOSITORY_ROOT, [...ACTIVE_DOCUMENTS, ...LEGACY_DOCUMENTS]);
    const productionSources = await loadProductionSources(REPOSITORY_ROOT);

    expect(findFt09DocumentGovernanceViolations(
      documents,
      ACTIVE_DOCUMENTS,
      LEGACY_DOCUMENTS,
    )).toEqual([
      'FT-09 doc=docs/architecture/v1.0/platform-config-wizard-design.md category=legacy field=successor violation=missing-successor-link',
    ]);
    expect(findFt09LegacySourceReferences(productionSources)).toEqual([
      'FT-09 source=src/platform/config/wizard/diff.ts target=docs/architecture/v1.0/platform-config-wizard-design.md violation=legacy-source-reference',
      'FT-09 source=src/platform/config/wizard/display.ts target=docs/architecture/v1.0/platform-config-wizard-design.md violation=legacy-source-reference',
      'FT-09 source=src/platform/config/wizard/fields.ts target=docs/architecture/v1.0/platform-config-wizard-design.md violation=legacy-source-reference',
      'FT-09 source=src/platform/config/wizard/prompts.ts target=docs/architecture/v1.0/platform-config-wizard-design.md violation=legacy-source-reference',
      'FT-09 source=src/platform/config/wizard/run-wizard.ts target=docs/architecture/v1.0/platform-config-wizard-design.md violation=legacy-source-reference',
    ]);
  });
});
