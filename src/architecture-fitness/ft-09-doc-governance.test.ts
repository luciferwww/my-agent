import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findFt09LegacySourceReferences,
  loadFt09GovernedSources,
} from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-09 documentation governance', () => {
  it('diagnoses stale authority paths and preserves explicit historical comments', () => {
    expect(findFt09LegacySourceReferences([
      { path: 'src/bare-reference.js', content: 'const guide = "docs/legacy/bare.md";' },
      { path: 'src/old-current.ts', content: 'const guide = "docs/architecture/current/runtime.md";' },
      { path: 'src/old-tree.ts', content: 'const guide = "docs_old/README.md";' },
      { path: 'clients/history.html', content: '<!-- Historical migration note: docs/legacy/old.md is not authoritative. -->' },
    ])).toEqual([
      'FT-09 source=src/bare-reference.js target=docs/legacy/bare.md violation=legacy-source-reference',
      'FT-09 source=src/old-current.ts target=docs/architecture/current/runtime.md violation=legacy-source-reference',
      'FT-09 source=src/old-tree.ts target=docs_old/README.md violation=legacy-source-reference',
    ]);
  });

  it('keeps active source and documentation free of stale authority paths', async () => {
    const governedSources = await loadFt09GovernedSources(REPOSITORY_ROOT);
    expect(findFt09LegacySourceReferences(governedSources)).toEqual([]);
  }, 15_000);
});
