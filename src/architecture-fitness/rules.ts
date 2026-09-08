import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import ts from 'typescript';

export interface SourceInput {
  path: string;
  content: string;
}

interface ModuleReference {
  specifier: string;
  symbols: string[];
  namespaceImport?: string;
}

interface NamedDeclaration {
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration;
  sourceFile: ts.SourceFile;
  sourcePath: string;
}

export interface Ft06FixtureManifest {
  identities: string[];
  corePaths: string[];
}

export interface TypeScriptFixtureDiagnostic {
  code: number;
  file?: string;
}

export interface ContractSurfaceEntry {
  contract: string;
  source: string;
  kind: string;
}

export interface ContractInventoryEntry extends ContractSurfaceEntry {
  positive: string[];
  negative: string[];
}

export interface GovernedDocument {
  path: string;
  category: string;
}

type Boundary = 'Application' | 'Domain/Application' | 'Infrastructure' | 'Composition' | 'Mixed';

const MIXED_PRODUCTION_PATHS = new Set([
  'src/runtime/bootstrap.ts',
  'src/runtime/errors.ts',
  'src/runtime/glob-match.ts',
  'src/runtime/index.ts',
  'src/runtime/prompt-factory.ts',
  'src/runtime/queue-types.ts',
  'src/runtime/RuntimeApp.ts',
  'src/runtime/subagent-orchestration.ts',
  'src/runtime/summarize-assembled.ts',
  'src/runtime/tool-approval-policy.ts',
  'src/runtime/types.ts',
  'src/core/session/index.ts',
  'src/core/session/lock.ts',
  'src/core/session/SessionManager.ts',
  'src/core/session/store.ts',
  'src/core/session/transcript.ts',
  'src/core/session/types.ts',
  'src/core/workspace/index.ts',
  'src/core/workspace/init.ts',
  'src/core/workspace/loader.ts',
  'src/core/workspace/types.ts',
  'src/core/media/attachment-pipeline.ts',
  'src/core/media/constants.ts',
  'src/core/media/image-metadata.ts',
  'src/core/media/image-optimize.ts',
  'src/core/media/index.ts',
  'src/platform/logger/ConsoleAdapter.ts',
  'src/platform/logger/FileAdapter.ts',
  'src/platform/logger/index.ts',
  'src/platform/logger/Logger.ts',
  'src/platform/logger/types.ts',
]);

const SDK_ALLOWLIST = new Map([
  ['@anthropic-ai/sdk', ['src/adapters/llm/']],
  ['ws', ['src/adapters/channel/']],
]);

const LEGACY_DOCUMENT_ROOTS = ['docs/architecture/v1.0/', 'docs/legacy/'] as const;

export async function loadTypeScriptSources(
  rootDir: string,
  excludedPrefixes: string[] = [],
  pathPrefix = '',
): Promise<SourceInput[]> {
  const sources: SourceInput[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) {
        continue;
      }

      const sourcePath = posix.join(pathPrefix, normalizePath(relative(rootDir, absolutePath)));
      if (excludedPrefixes.some((prefix) => sourcePath.startsWith(prefix))) {
        continue;
      }
      sources.push({ path: sourcePath, content: await readFile(absolutePath, 'utf8') });
    }
  }

  await walk(rootDir);
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

export async function loadProductionSources(repositoryRoot: string): Promise<SourceInput[]> {
  const sources = await loadTypeScriptSources(
    join(repositoryRoot, 'src'),
    ['src/architecture-fitness/', 'src/test-setup.ts'],
    'src',
  );
  return sources.filter((source) => !source.path.endsWith('.test.ts'));
}

export function findFt01BoundaryViolations(sources: SourceInput[]): string[] {
  const diagnostics: string[] = [];

  for (const source of sources) {
    const sourceBoundary = classifyBoundary(source.path);
    if (sourceBoundary !== 'Application' && sourceBoundary !== 'Domain/Application') {
      continue;
    }

    for (const reference of collectModuleReferences(source)) {
      const target = resolveRelativeModule(source.path, reference.specifier);
      if (!target) {
        continue;
      }
      const targetBoundary = classifyBoundary(target);
      if (targetBoundary !== 'Infrastructure' && targetBoundary !== 'Composition') {
        continue;
      }
      diagnostics.push(
        `FT-01 source=${source.path} boundary=${sourceBoundary} import=${reference.specifier} target=${target} targetBoundary=${targetBoundary}`,
      );
    }
  }

  return [...new Set(diagnostics)].sort();
}

export function findUnclassifiedProductionFiles(sources: SourceInput[]): string[] {
  return sources
    .map((source) => source.path)
    .filter((sourcePath) => classifyBoundary(sourcePath) === undefined)
    .sort();
}

export function findFt01MixedInventoryDrift(sources: SourceInput[]): string[] {
  const sourcePaths = new Set(sources.map((source) => source.path));
  return [...MIXED_PRODUCTION_PATHS]
    .filter((sourcePath) => !sourcePaths.has(sourcePath))
    .map((sourcePath) => `FT-01 inventory=missing path=${sourcePath}`)
    .sort();
}

export function findFt02SdkAllowlistViolations(sources: SourceInput[]): string[] {
  const diagnostics: string[] = [];

  for (const source of sources) {
    for (const reference of collectModuleReferences(source)) {
      const packageName = packageNameFromSpecifier(reference.specifier);
      const allowedRoots = SDK_ALLOWLIST.get(packageName);
      if (!allowedRoots || allowedRoots.some((root) => source.path.startsWith(root))) {
        continue;
      }
      diagnostics.push(
        `FT-02 package=${packageName} source=${source.path} allowedRoots=${allowedRoots.map((root) => `${root}**`).join(',')}`,
      );
    }
  }

  return [...new Set(diagnostics)].sort();
}

export function findFt03RunnerBoundaryViolations(sources: SourceInput[]): string[] {
  const diagnostics: string[] = [];
  const declarations = collectNamedDeclarations(sources);

  for (const source of sources.filter((candidate) => candidate.path.startsWith('src/core/runner/'))) {
    for (const reference of collectModuleReferences(source)) {
      const packageName = packageNameFromSpecifier(reference.specifier);
      if (SDK_ALLOWLIST.has(packageName)) {
        diagnostics.push(
          `FT-03 source=${source.path} symbol=${reference.specifier} violation=provider-sdk-import`,
        );
        continue;
      }

      const target = resolveRelativeModule(source.path, reference.specifier);
      if (!target) {
        continue;
      }

      let violation: string | undefined;
      if (target.startsWith('src/adapters/llm/')) {
        violation = 'provider-adapter-import';
      } else if (target.startsWith('src/platform/config/')) {
        violation = target === 'src/platform/config/loader.ts' ? 'config-loader-import' : 'config-import';
      } else if (target.startsWith('src/platform/logger/')) {
        violation = 'global-service-import';
      }

      if (violation) {
        diagnostics.push(
          `FT-03 source=${source.path} symbol=${reference.symbols.join(',') || reference.specifier} violation=${violation}`,
        );
      }
    }

    const sourceFile = createSourceFile(source);
    const visit = (node: ts.Node): void => {
      if (
        ts.isConstructorDeclaration(node)
        || (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === 'run' && !hasNonPublicModifier(node))
        || (ts.isFunctionDeclaration(node) && hasExportModifier(node))
      ) {
        for (const parameter of node.parameters) {
          if (!parameter.type) {
            continue;
          }
          const mutableRegistry = findMutableRegistrySymbol(parameter.type, sourceFile, declarations);
          if (mutableRegistry) {
            diagnostics.push(
              `FT-03 source=${source.path} symbol=${mutableRegistry} violation=mutable-registry-input`,
            );
          }
        }
      } else if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
        && hasExportModifier(node)
      ) {
        const mutableRegistry = findMutableRegistrySymbol(node, sourceFile, declarations);
        if (mutableRegistry) {
          diagnostics.push(
            `FT-03 source=${source.path} symbol=${mutableRegistry} violation=mutable-registry-input`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [...new Set(diagnostics)].sort();
}

export function findFt04LegacyDirectionViolations(
  sources: SourceInput[],
  newCoreRoots: string[],
  forbiddenRoots: string[],
): string[] {
  const diagnostics: string[] = [];

  for (const source of sources) {
    if (!newCoreRoots.some((root) => source.path.startsWith(root))) {
      continue;
    }
    for (const reference of collectModuleReferences(source)) {
      const target = resolveRelativeModule(source.path, reference.specifier);
      if (!target || !forbiddenRoots.some((root) => target.startsWith(root))) {
        continue;
      }
      diagnostics.push(`FT-04 source=${source.path} forbiddenTarget=${target}`);
    }
  }

  return [...new Set(diagnostics)].sort();
}

export function findFt05ExtensionCapabilityViolations(
  sources: SourceInput[],
  extensionRoots: string[],
): string[] {
  const diagnostics: string[] = [];
  const sourcesByPath = new Map(sources.map((source) => [source.path, source]));

  for (const source of sources.filter((candidate) => (
    extensionRoots.some((root) => candidate.path.startsWith(root))
  ))) {
    for (const reference of collectModuleReferences(source)) {
      if (referencesRuntimeApp(source, reference, sourcesByPath)) {
        diagnostics.push(
          `FT-05 source=${source.path} symbol=RuntimeApp capability=none violation=runtimeapp-import`,
        );
      }
    }

    const sourceFile = createSourceFile(source);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'get'
        && ts.isIdentifier(node.expression.expression)
        && ['container', 'serviceLocator', 'services'].includes(node.expression.expression.text)
      ) {
        diagnostics.push(
          `FT-05 source=${source.path} symbol=${node.expression.getText(sourceFile)} capability=none violation=service-locator-get`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [...new Set(diagnostics)].sort();
}

export function findFt06ChangeLocalityViolations(
  sources: SourceInput[],
  manifest: Ft06FixtureManifest,
): string[] {
  const diagnostics: string[] = [];
  const identities = new Set(manifest.identities);

  for (const source of sources.filter((candidate) => (
    manifest.corePaths.some((corePath) => (
      corePath.endsWith('/') ? candidate.path.startsWith(corePath) : candidate.path === corePath
    ))
  ))) {
    const sourceFile = createSourceFile(source);
    const visit = (node: ts.Node): void => {
      let identity: string | undefined;
      let matchedBranch: string | undefined;
      if (
        ts.isBinaryExpression(node)
        && [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(node.operatorToken.kind)
      ) {
        identity = findManifestIdentity(node, identities);
        matchedBranch = identity ? 'binary-expression' : undefined;
      } else if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
        identity = identities.has(node.expression.text) ? node.expression.text : undefined;
        matchedBranch = identity ? 'switch-case' : undefined;
      } else if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
        identity = identities.has(node.literal.text) ? node.literal.text : undefined;
        matchedBranch = identity ? 'string-union' : undefined;
      }

      if (identity && matchedBranch) {
        diagnostics.push(
          `FT-06 fixture=${identity} coreFile=${source.path} matchedBranch=${matchedBranch}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [...new Set(diagnostics)].sort();
}

export function findFt07MutableRegistryMembers(
  sources: SourceInput[],
  mutableTypeNames: string[],
): string[] {
  const declarations = collectNamedDeclarations(sources);
  const diagnostics: string[] = [];

  for (const typeName of mutableTypeNames) {
    const declaration = declarations.get(typeName);
    if (!declaration) {
      continue;
    }
    for (const mutableMember of findMutableCollectionMembers(declaration)) {
      diagnostics.push(
        `FT-07 source=${declaration.sourcePath} type=${typeName} mutableMember=${mutableMember} violation=mutable-registry-input`,
      );
    }
  }

  return diagnostics.sort();
}

export async function compileTypeScriptFixture(rootDir: string): Promise<TypeScriptFixtureDiagnostic[]> {
  const sources = await loadTypeScriptSources(rootDir);
  const rootNames = sources.map((source) => join(rootDir, source.path));
  const program = ts.createProgram({
    rootNames,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      lib: ['lib.es2022.d.ts'],
      types: [],
      noEmit: true,
    },
  });

  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file ? normalizePath(relative(rootDir, diagnostic.file.fileName)) : undefined,
  }));
}

export function findFt08ContractInventoryViolations(
  sources: SourceInput[],
  surface: ContractSurfaceEntry[],
  inventory: ContractInventoryEntry[],
  availableTestPaths: Set<string>,
): string[] {
  const diagnostics: string[] = [];
  const sourcesByPath = new Map(sources.map((source) => [source.path, source]));
  const inventoryByKey = new Map<string, ContractInventoryEntry[]>();

  for (const entry of inventory) {
    const key = `${entry.source}#${entry.contract}`;
    const entries = inventoryByKey.get(key) ?? [];
    entries.push(entry);
    inventoryByKey.set(key, entries);
  }

  const surfaceKeys = new Set(surface.map((entry) => `${entry.source}#${entry.contract}`));
  for (const entry of inventory) {
    const key = `${entry.source}#${entry.contract}`;
    if (!surfaceKeys.has(key)) {
      diagnostics.push(
        `FT-08 contract=${entry.contract} source=${entry.source} kind=${entry.kind} violation=inventory-outside-surface`,
      );
    }
  }

  for (const expected of surface) {
    const source = sourcesByPath.get(expected.source);
    if (!source || !collectExportedDeclarations(source).has(expected.contract)) {
      diagnostics.push(
        `FT-08 contract=${expected.contract} source=${expected.source} kind=${expected.kind} violation=missing-export`,
      );
      continue;
    }

    const key = `${expected.source}#${expected.contract}`;
    const entries = inventoryByKey.get(key) ?? [];
    if (entries.length === 0) {
      diagnostics.push(
        `FT-08 contract=${expected.contract} source=${expected.source} kind=${expected.kind} violation=missing-inventory-entry`,
      );
      continue;
    }
    if (entries.length > 1) {
      diagnostics.push(
        `FT-08 contract=${expected.contract} source=${expected.source} kind=${expected.kind} violation=duplicate-inventory-entry`,
      );
      continue;
    }

    const entry = entries[0];
    if (entry.positive.length === 0) {
      diagnostics.push(
        `FT-08 contract=${expected.contract} source=${expected.source} kind=${expected.kind} violation=missing-positive-coverage`,
      );
    }
    if (entry.negative.length === 0) {
      diagnostics.push(
        `FT-08 contract=${expected.contract} source=${expected.source} kind=${expected.kind} violation=missing-negative-coverage`,
      );
    }
    for (const testPath of [...entry.positive, ...entry.negative]) {
      if (!availableTestPaths.has(testPath)) {
        diagnostics.push(
          `FT-08 contract=${expected.contract} source=${expected.source} test=${testPath} violation=missing-test-file`,
        );
      }
    }
  }

  return diagnostics.sort();
}

export function findFt09DocumentGovernanceViolations(
  documents: SourceInput[],
  activeDocuments: GovernedDocument[],
  legacyDocuments: GovernedDocument[],
): string[] {
  const diagnostics: string[] = [];
  const documentsByPath = new Map(documents.map((document) => [document.path, document]));
  const validStates = new Set([
    'Accepted', 'Blocked', 'Cancelled', 'Completed', 'Deprecated', 'Draft', 'Executing',
    'Failed', 'Implemented', 'In Progress', 'In Review', 'Not Started', 'Proposed',
    'Provisional Pass', 'Rejected', 'Superseded', 'Validated',
  ]);

  for (const governed of activeDocuments) {
    const document = documentsByPath.get(governed.path);
    if (!document) {
      diagnostics.push(
        `FT-09 doc=${governed.path} category=${governed.category} field=document violation=missing-document`,
      );
      continue;
    }

    const status = readMarkdownMetadata(document.content).get('status');
    if (!status) {
      diagnostics.push(
        `FT-09 doc=${governed.path} category=${governed.category} field=status violation=missing-status`,
      );
    } else if (!validStates.has(status.value)) {
      diagnostics.push(
        `FT-09 doc=${governed.path} category=${governed.category} field=status value=${status.value} violation=invalid-status`,
      );
    }

    for (const metadata of readMarkdownMetadata(document.content).values()) {
      if (!isAuthorityMetadataField(metadata.label)) {
        continue;
      }
      for (const link of metadata.links) {
        const target = resolveMarkdownLink(governed.path, link);
        if (isLegacyDocumentPath(target)) {
          diagnostics.push(
            `FT-09 doc=${governed.path} category=${governed.category} field=${metadata.label} target=${target} violation=legacy-authority-link`,
          );
        }
      }
    }
  }

  for (const governed of legacyDocuments) {
    const document = documentsByPath.get(governed.path);
    if (!document) {
      diagnostics.push(
        `FT-09 doc=${governed.path} category=${governed.category} field=document violation=missing-document`,
      );
      continue;
    }
    const successor = readMarkdownMetadata(document.content).get('successor');
    if (!successor || successor.links.length === 0) {
      diagnostics.push(
        `FT-09 doc=${governed.path} category=${governed.category} field=successor violation=missing-successor-link`,
      );
      continue;
    }
    for (const link of successor.links) {
      const target = resolveMarkdownLink(governed.path, link);
      if (isLegacyDocumentPath(target)) {
        diagnostics.push(
          `FT-09 doc=${governed.path} category=${governed.category} field=successor target=${target} violation=legacy-successor-link`,
        );
      } else if (!documentsByPath.has(target)) {
        diagnostics.push(
          `FT-09 doc=${governed.path} category=${governed.category} field=successor target=${target} violation=missing-successor-target`,
        );
      }
    }
  }

  return diagnostics.sort();
}

export function findFt09LegacySourceReferences(
  sources: SourceInput[],
  legacyRoots: readonly string[] = LEGACY_DOCUMENT_ROOTS,
): string[] {
  const diagnostics: string[] = [];

  for (const source of sources) {
    for (const line of source.content.split(/\r?\n/)) {
      if (!/(?:详见|字段清单|依据|according\s+to|see\s+)/i.test(line)) {
        continue;
      }
      const normalizedLine = line.replaceAll('\\', '/');
      const legacyReference = /docs\/(?:architecture\/v1\.0|legacy)\/[^\s"'`)\]]+\.md/g;
      for (const target of normalizedLine.match(legacyReference) ?? []) {
        if (legacyRoots.some((root) => target.startsWith(root))) {
          diagnostics.push(`FT-09 source=${source.path} target=${target} violation=legacy-source-reference`);
        }
      }
    }
  }

  return [...new Set(diagnostics)].sort();
}

function isLegacyDocumentPath(path: string): boolean {
  return LEGACY_DOCUMENT_ROOTS.some((root) => path.startsWith(root));
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function classifyBoundary(sourcePath: string): Boundary | undefined {
  if (sourcePath.startsWith('src/core/tools/builtin/') || sourcePath.startsWith('src/core/memory/internal/')) {
    return 'Infrastructure';
  }
  if (sourcePath.startsWith('src/adapters/')) {
    return 'Infrastructure';
  }
  if (sourcePath === 'src/platform/logger/types.ts') {
    return 'Application';
  }
  if (sourcePath.startsWith('src/platform/logger/')) {
    return 'Infrastructure';
  }
  if (sourcePath.startsWith('src/platform/config/') || sourcePath === 'src/runtime/bootstrap.ts') {
    return 'Composition';
  }
  if (
    sourcePath.startsWith('src/runtime-modules/')
    || sourcePath === 'src/runtime/registry-builder.ts'
    || sourcePath === 'src/runtime/channel-lifecycle.ts'
  ) {
    return 'Composition';
  }
  if (sourcePath.startsWith('src/compat/')) {
    return 'Composition';
  }
  if (MIXED_PRODUCTION_PATHS.has(sourcePath)) {
    return 'Mixed';
  }
  if (
    sourcePath.startsWith('src/core/runner/')
    || sourcePath.startsWith('src/core/model-invocation/')
    || sourcePath.startsWith('src/core/model-resolution/')
    || sourcePath.startsWith('src/core/prompt/')
    || sourcePath.startsWith('src/core/subagent/')
    || sourcePath.startsWith('src/core/approval/')
    || sourcePath.startsWith('src/core/channel/')
    || sourcePath.startsWith('src/core/memory/')
  ) {
    return 'Application';
  }
  if (sourcePath.startsWith('src/core/tools/') || sourcePath.startsWith('src/core/registry/')) {
    return 'Domain/Application';
  }
  return undefined;
}

function createSourceFile(source: SourceInput): ts.SourceFile {
  return ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function collectModuleReferences(source: SourceInput): ModuleReference[] {
  const sourceFile = createSourceFile(source);
  const references = new Map<string, { symbols: Set<string>; namespaceImport?: string }>();

  const addReference = (specifier: string, symbols: string[] = [], namespaceImport?: string): void => {
    const existing = references.get(specifier) ?? { symbols: new Set<string>() };
    for (const symbol of symbols) {
      existing.symbols.add(symbol);
    }
    existing.namespaceImport ??= namespaceImport;
    references.set(specifier, existing);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const symbols: string[] = [];
      if (node.importClause?.name) {
        symbols.push(node.importClause.name.text);
      }
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        symbols.push(...bindings.elements.map((element) => element.propertyName?.text ?? element.name.text));
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        addReference(node.moduleSpecifier.text, symbols, bindings.name.text);
        ts.forEachChild(node, visit);
        return;
      }
      addReference(node.moduleSpecifier.text, symbols);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const symbols = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((element) => element.name.text)
        : [];
      addReference(node.moduleSpecifier.text, symbols);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      addReference(node.argument.literal.text, node.qualifier ? [node.qualifier.getText(sourceFile)] : []);
    } else if (
      ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      addReference(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...references.entries()]
    .map(([specifier, reference]) => ({
      specifier,
      symbols: [...reference.symbols].sort(),
      namespaceImport: reference.namespaceImport,
    }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
}

function collectNamedDeclarations(sources: SourceInput[]): Map<string, NamedDeclaration> {
  const declarations = new Map<string, NamedDeclaration>();
  for (const source of sources) {
    const sourceFile = createSourceFile(source);
    for (const statement of sourceFile.statements) {
      if (
        (ts.isInterfaceDeclaration(statement)
          || ts.isTypeAliasDeclaration(statement)
          || ts.isClassDeclaration(statement))
        && statement.name
      ) {
        declarations.set(statement.name.text, { node: statement, sourceFile, sourcePath: source.path });
      }
    }
  }
  return declarations;
}

function collectExportedDeclarations(source: SourceInput): Set<string> {
  const sourceFile = createSourceFile(source);
  const exported = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      hasExportModifier(statement)
      && (ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isFunctionDeclaration(statement)
        || ts.isEnumDeclaration(statement))
      && statement.name
    ) {
      exported.add(statement.name.text);
    }
  }
  return exported;
}

interface MarkdownMetadata {
  label: string;
  value: string;
  links: string[];
}

function readMarkdownMetadata(content: string): Map<string, MarkdownMetadata> {
  const metadata = new Map<string, MarkdownMetadata>();
  const linePattern = /^\s*-\s+\*\*(?<label>[^*]+?)(?::|：)\*\*\s*(?<value>.*)$/gm;
  for (const match of content.matchAll(linePattern)) {
    const label = match.groups?.label.trim() ?? '';
    const value = match.groups?.value.trim() ?? '';
    const links = [...value.matchAll(/\[[^\]]+\]\((?<target>[^)]+)\)/g)]
      .map((linkMatch) => linkMatch.groups?.target)
      .filter((target): target is string => target !== undefined);
    const normalizedLabel = label === '状态' || label === 'Status'
      ? 'status'
      : label === '后继' || label === 'Successor'
        ? 'successor'
        : label;
    metadata.set(normalizedLabel, { label, value, links });
  }
  return metadata;
}

function isAuthorityMetadataField(label: string): boolean {
  return new Set([
    '权威架构',
    '架构原则',
    '规范词汇',
    '父计划',
    '关联计划',
    '关联计划 / Spec',
    '执行计划',
    '相关重要决策',
    '架构约束',
    'Related Plan / Spec',
    'Related Plan / ADR',
  ]).has(label);
}

function resolveMarkdownLink(sourcePath: string, link: string): string {
  const pathWithoutAnchor = link.split('#')[0].split('?')[0];
  return posix.normalize(posix.join(posix.dirname(sourcePath), pathWithoutAnchor));
}

function findManifestIdentity(node: ts.Node, identities: Set<string>): string | undefined {
  let match: string | undefined;
  const visit = (candidate: ts.Node): void => {
    if (!match && ts.isStringLiteral(candidate) && identities.has(candidate.text)) {
      match = candidate.text;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return match;
}

function referencesRuntimeApp(
  source: SourceInput,
  reference: ModuleReference,
  sourcesByPath: Map<string, SourceInput>,
  visited = new Set<string>(),
): boolean {
  const target = resolveRelativeModule(source.path, reference.specifier);
  if (!target || visited.has(target)) {
    return false;
  }
  if (target === 'src/runtime/RuntimeApp.ts') {
    return true;
  }
  const requestsRuntimeApp = reference.symbols.includes('RuntimeApp')
    || (reference.namespaceImport !== undefined
      && sourceUsesNamespaceRuntimeApp(source, reference.namespaceImport));
  if (!requestsRuntimeApp) {
    return false;
  }

  const targetSource = sourcesByPath.get(target);
  if (!targetSource) {
    return false;
  }
  visited.add(target);
  return collectModuleReferences(targetSource).some((targetReference) => (
    (targetReference.symbols.length === 0 || targetReference.symbols.includes('RuntimeApp'))
    && referencesRuntimeApp(targetSource, targetReference, sourcesByPath, visited)
  ));
}

function sourceUsesNamespaceRuntimeApp(source: SourceInput, namespaceImport: string): boolean {
  const sourceFile = createSourceFile(source);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === namespaceImport
        && node.name.text === 'RuntimeApp')
      || (ts.isQualifiedName(node)
        && ts.isIdentifier(node.left)
        && node.left.text === namespaceImport
        && node.right.text === 'RuntimeApp')
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function findMutableCollectionMembers(declaration: NamedDeclaration): string[] {
  const members = ts.isTypeAliasDeclaration(declaration.node) && ts.isTypeLiteralNode(declaration.node.type)
    ? declaration.node.type.members
    : ts.isInterfaceDeclaration(declaration.node) || ts.isClassDeclaration(declaration.node)
      ? declaration.node.members
      : [];

  return members.flatMap((member) => {
    if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) {
      return [];
    }
    const memberName = member.name?.getText(declaration.sourceFile);
    if (!memberName) {
      return [];
    }
    const collectionText = member.type?.getText(declaration.sourceFile)
      ?? (ts.isPropertyDeclaration(member) ? member.initializer?.getText(declaration.sourceFile) : undefined)
      ?? '';
    return isMutableCollectionText(collectionText) ? [memberName] : [];
  }).sort();
}

function isMutableCollectionText(typeText: string): boolean {
  return /(?:^|\W)(?:Array|Map|Set|WeakMap|WeakSet)<|\[\]|new\s+(?:Map|Set|WeakMap|WeakSet)\b/.test(typeText)
    && !/(?:ReadonlyArray|ReadonlyMap|ReadonlySet|readonly\s)/.test(typeText);
}

function findMutableRegistrySymbol(
  boundaryNode: ts.Node,
  sourceFile: ts.SourceFile,
  declarations: Map<string, NamedDeclaration>,
): string | undefined {
  const referencedTypes = new Set<string>();
  const collectReferences = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      referencedTypes.add(node.typeName.text);
    }
    ts.forEachChild(node, collectReferences);
  };
  collectReferences(boundaryNode);

  for (const typeName of referencedTypes) {
    const mutableRegistry = inspectRegistryDeclaration(typeName, false, declarations, new Set());
    if (mutableRegistry) {
      return mutableRegistry;
    }
  }
  return undefined;
}

function inspectRegistryDeclaration(
  typeName: string,
  registryContext: boolean,
  declarations: Map<string, NamedDeclaration>,
  visited: Set<string>,
): string | undefined {
  if (visited.has(typeName)) {
    return undefined;
  }
  visited.add(typeName);

  const isRegistry = registryContext || /Registry|RuntimeToolBundle/.test(typeName);
  const declaration = declarations.get(typeName);
  if (!declaration) {
    return isRegistry && !/Snapshot|Projection|Readonly/.test(typeName) ? typeName : undefined;
  }

  const members = ts.isTypeAliasDeclaration(declaration.node) && ts.isTypeLiteralNode(declaration.node.type)
    ? declaration.node.type.members
    : ts.isInterfaceDeclaration(declaration.node) || ts.isClassDeclaration(declaration.node)
      ? declaration.node.members
      : [];

  for (const member of members) {
    if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
      const memberName = member.name?.getText(declaration.sourceFile) ?? '';
      const nestedRegistry = /registry/i.test(memberName);
      if (member.type) {
        const nestedTypes = collectTypeReferenceNames(member.type);
        for (const nestedType of nestedTypes) {
          const mutableRegistry = inspectRegistryDeclaration(
            nestedType,
            nestedRegistry,
            declarations,
            new Set(visited),
          );
          if (mutableRegistry) {
            return mutableRegistry;
          }
        }
      }
      if (isRegistry && isMutableProperty(member, declaration.sourceFile)) {
        return typeName;
      }
    } else if (
      isRegistry
      && (ts.isMethodSignature(member) || ts.isMethodDeclaration(member))
      && /^(?:add|clear|delete|register|remove|set|unregister|update)/.test(member.name.getText(declaration.sourceFile))
    ) {
      return typeName;
    }
  }

  return undefined;
}

function collectTypeReferenceNames(node: ts.Node): string[] {
  const names = new Set<string>();
  const visit = (candidate: ts.Node): void => {
    if (ts.isTypeReferenceNode(candidate) && ts.isIdentifier(candidate.typeName)) {
      names.add(candidate.typeName.text);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return [...names];
}

function isMutableProperty(
  property: ts.PropertySignature | ts.PropertyDeclaration,
  sourceFile: ts.SourceFile,
): boolean {
  const isReadonly = property.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
  if (!isReadonly) {
    return true;
  }
  const typeText = property.type?.getText(sourceFile) ?? '';
  return /(?:^|\W)(?:Array|Map|Set|WeakMap|WeakSet)<|\[\]/.test(typeText)
    && !/(?:ReadonlyArray|ReadonlyMap|ReadonlySet|readonly\s)/.test(typeText);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function hasNonPublicModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => (
      modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword
    )) ?? false);
}

function resolveRelativeModule(sourcePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  return posix.normalize(posix.join(posix.dirname(sourcePath), specifier)).replace(/\.(?:c|m)?js$/, '.ts');
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}
