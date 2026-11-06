import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { loadProductionSources } from './rules.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('FT-10 process exit ownership', () => {
  it('keeps direct process termination in the standalone Runtime Host', async () => {
    const sources = await loadProductionSources(REPOSITORY_ROOT);
    const violations: string[] = [];
    for (const source of sources) {
      if (source.path === 'src/hosts/standalone/runtime-host.ts') continue;
      const sourceFile = ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === 'process'
          && node.expression.name.text === 'exit') {
          violations.push(`${source.path}: process.exit`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
