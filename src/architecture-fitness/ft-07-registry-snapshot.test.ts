import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { HookProjection, RegistrySnapshot, ToolProjection } from '../core/registry/index.js';

type ReadonlyCollections<T> = {
  readonly [Key in keyof T]: T[Key] extends readonly unknown[] ? Readonly<T[Key]> : T[Key];
};

describe('FT-07 immutable Registry Snapshot contract', () => {
  it('exposes readonly production Snapshot fields and projection collections', () => {
    expectTypeOf<RegistrySnapshot>().toEqualTypeOf<ReadonlyCollections<RegistrySnapshot>>();
    expectTypeOf<HookProjection>().toEqualTypeOf<ReadonlyCollections<HookProjection>>();
    expectTypeOf<Pick<ToolProjection, 'definitions'>>()
      .toEqualTypeOf<ReadonlyCollections<Pick<ToolProjection, 'definitions'>>>();

    // Vitest erases type assertions; check this file against the real production types.
    const sourcePath = fileURLToPath(import.meta.url);
    const configPath = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
      throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
    expect(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')))
      .toEqual([]);
    const program = ts.createProgram([sourcePath], parsed.options);
    const source = program.getSourceFile(sourcePath);
    if (!source) throw new Error(`Missing Registry contract test source: ${sourcePath}`);
    const diagnostics = [
      ...program.getSyntacticDiagnostics(source),
      ...program.getSemanticDiagnostics(source),
    ];
    expect(diagnostics.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')))
      .toEqual([]);
  });
});
