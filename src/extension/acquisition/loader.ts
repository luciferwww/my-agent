import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createJiti } from 'jiti';

import { Logger } from '../../platform/logger/index.js';
import type {
  ExtensionLoadContext,
  ExtensionLogger,
} from '../api/contracts.js';
import type { LoadedRuntimeUnit } from '../../runtime/runtime-unit.js';
import { prepareExtensionConfig } from './configuration.js';
import { discoverExtensionDescriptors } from './discovery.js';
import type {
  ExtensionAcquisitionDiagnostic,
  ExtensionAcquisitionOptions,
  ExtensionAcquisitionResult,
  ExtensionCandidate,
  ExtensionLoaderDiagnostic,
  ExtensionLoaderDiagnosticCategory,
  ExtensionLoaderDiagnosticCode,
  ResolvedHostExtensionsConfig,
} from './types.js';

const MAX_DIAGNOSTIC_FIELD_LENGTH = 200;
const log = Logger.get('ExtensionAcquisition');
const extensionModuleLoader = createJiti(import.meta.url, {
  alias: {
    'my-agent/extension-api': fileURLToPath(new URL('../api/index.js', import.meta.url)),
  },
  interopDefault: false,
  sourceMaps: true,
  tryNative: false,
});
const EMPTY_RESULT: ExtensionAcquisitionResult = Object.freeze({
  loadedUnits: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

export async function acquireExtensions(
  options: ExtensionAcquisitionOptions,
): Promise<ExtensionAcquisitionResult> {
  log.info('extension acquisition started', { root: options.extensionsDir });
  if (!options.extensionsConfig.enabled) {
    log.info('extension acquisition completed', { loadedCount: 0, extensionIds: [] });
    return EMPTY_RESULT;
  }

  const discovery = await discoverExtensionDescriptors(options.extensionsDir);
  const diagnostics: ExtensionAcquisitionDiagnostic[] = [...discovery.diagnostics];
  const installedIds = new Set(discovery.candidates.map((candidate) => candidate.descriptor.id));
  for (const diagnostic of discovery.diagnostics) {
    if (diagnostic.extensionId !== undefined) installedIds.add(diagnostic.extensionId);
  }

  for (const configuredId of Object.keys(options.extensionsConfig.entries)) {
    if (!installedIds.has(configuredId)) {
      diagnostics.push(createLoaderDiagnostic(
        'config_invalid',
        'stale_configured_id',
        configuredId,
      ));
    }
  }

  const loadedUnits: LoadedRuntimeUnit[] = [];
  for (const candidate of discovery.candidates) {
    const outcome = await loadExtensionCandidate(
      candidate,
      options.extensionsDir,
      options.extensionsConfig,
      options.environment ?? process.env,
    );
    if ('unit' in outcome) {
      loadedUnits.push(outcome.unit);
    }
    else diagnostics.push(outcome.diagnostic);
  }

  diagnostics.sort(compareDiagnostics);
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== 'disabled') {
      log.warn('extension acquisition warning', diagnosticLogContext(diagnostic));
    }
  }
  const result = Object.freeze({
    loadedUnits: Object.freeze(loadedUnits),
    diagnostics: Object.freeze(diagnostics),
  });
  log.info('extension acquisition completed', {
    loadedCount: result.loadedUnits.length,
    extensionIds: result.loadedUnits.map((unit) => unit.unitId),
  });
  return result;
}

export async function loadExtensionCandidate(
  candidate: ExtensionCandidate,
  extensionsDir: string,
  extensionsConfig: ResolvedHostExtensionsConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<{ unit: LoadedRuntimeUnit }> | Readonly<{
  diagnostic: ExtensionLoaderDiagnostic;
}>> {
  const extensionId = candidate.descriptor.id;
  const locator = formatDiagnosticLocator(basename(candidate.installationPath));
  const rawEntry = extensionsConfig.entries[extensionId];

  if (rawEntry === undefined) {
    return diagnosticOutcome('disabled', 'extension_disabled', extensionId, locator);
  }
  if (!isPlainObject(rawEntry)) {
    return diagnosticOutcome('config_invalid', 'entry_config_invalid', extensionId, locator);
  }

  const enabled = rawEntry['enabled'];
  if (enabled === false) {
    return diagnosticOutcome('disabled', 'extension_disabled', extensionId, locator);
  }
  if (enabled !== undefined && enabled !== true
    || Object.keys(rawEntry).some((key) => key !== 'enabled' && key !== 'config')) {
    return diagnosticOutcome('config_invalid', 'entry_config_invalid', extensionId, locator);
  }

  const rawConfig = rawEntry['config'] ?? {};
  if (!isPlainObject(rawConfig)) {
    return diagnosticOutcome('config_invalid', 'entry_config_invalid', extensionId, locator);
  }

  const configuration = prepareExtensionConfig(
    rawConfig,
    candidate.descriptor.configSchema,
    environment,
  );
  if (!configuration.ok) {
    return Object.freeze({
      diagnostic: createLoaderDiagnostic(
        configuration.category,
        configuration.code,
        extensionId,
        locator,
        configuration.referencePath,
        configuration.environmentVariable,
      ),
    });
  }

  const revalidatedEntryPath = await revalidateEntryPath(candidate, extensionsDir);
  if (revalidatedEntryPath === undefined) {
    return diagnosticOutcome(
      'entry_load_failed',
      'entry_revalidation_failed',
      extensionId,
      locator,
    );
  }

  let loadedModule: unknown;
  try {
    loadedModule = await extensionModuleLoader.import(pathToFileURL(revalidatedEntryPath).href);
  } catch {
    return diagnosticOutcome('entry_load_failed', 'entry_import_failed', extensionId, locator);
  }

  const factory = readExtensionFactory(loadedModule);
  if (factory === undefined) {
    return diagnosticOutcome('entry_load_failed', 'entry_export_invalid', extensionId, locator);
  }

  let returnedUnit: unknown;
  try {
    returnedUnit = factory(Object.freeze({
      config: configuration.config,
      logger: createExtensionLogger(extensionId),
    }));
  } catch {
    return diagnosticOutcome(
      'extension_config_rejected',
      'factory_failed',
      extensionId,
      locator,
    );
  }

  const unit = normalizeExternalUnit(returnedUnit, extensionId);
  if (unit === undefined) {
    return diagnosticOutcome('unit_invalid', 'unit_metadata_invalid', extensionId, locator);
  }
  return Object.freeze({ unit });
}

async function revalidateEntryPath(
  candidate: ExtensionCandidate,
  extensionsDir: string,
): Promise<string | undefined> {
  try {
    const [canonicalExtensionsDir, installationStats, entryStats] = await Promise.all([
      realpath(extensionsDir),
      lstat(candidate.installationPath),
      lstat(candidate.entryPath),
    ]);
    if (!installationStats.isDirectory()
      || installationStats.isSymbolicLink()
      || !entryStats.isFile()
      || entryStats.isSymbolicLink()) {
      return undefined;
    }

    const [canonicalInstallationPath, canonicalEntryPath] = await Promise.all([
      realpath(candidate.installationPath),
      realpath(candidate.entryPath),
    ]);
    if (canonicalInstallationPath !== candidate.installationPath
      || canonicalEntryPath !== candidate.entryPath
      || !isContainedPath(canonicalExtensionsDir, canonicalInstallationPath)
      || !isContainedPath(canonicalInstallationPath, canonicalEntryPath)) {
      return undefined;
    }
    return canonicalEntryPath;
  } catch {
    return undefined;
  }
}

function readExtensionFactory(
  value: unknown,
): ((context: ExtensionLoadContext) => unknown) | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  const exportedKeys = Object.keys(value);
  if (exportedKeys.length !== 1 || exportedKeys[0] !== 'createExtension') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'createExtension');
  if (descriptor === undefined) return undefined;
  try {
    // Vite represents ESM live bindings as accessors; Node exposes the same
    // binding as a data property. Read the namespace export normally so both
    // conforming representations preserve the exact single-export contract.
    const factory = Reflect.get(value, 'createExtension');
    return typeof factory === 'function'
      ? factory as (context: ExtensionLoadContext) => unknown
      : undefined;
  } catch {
    return undefined;
  }
}

function createExtensionLogger(extensionId: string): ExtensionLogger {
  const logger = Logger.get(`Extension:${extensionId}`);
  return Object.freeze({
    debug: (message: string, context?: Readonly<Record<string, unknown>>) => {
      logger.debug(message, mutableLogContext(context));
    },
    info: (message: string, context?: Readonly<Record<string, unknown>>) => {
      logger.info(message, mutableLogContext(context));
    },
    warn: (message: string, context?: Readonly<Record<string, unknown>>) => {
      logger.warn(message, mutableLogContext(context));
    },
    error: (message: string, context?: Readonly<Record<string, unknown>>) => {
      logger.error(message, mutableLogContext(context));
    },
  });
}

function mutableLogContext(
  context: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  return context === undefined ? undefined : { ...context };
}

function normalizeExternalUnit(value: unknown, extensionId: string): LoadedRuntimeUnit | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const unitId = readOwnDataProperty(value, 'unitId');
  const source = readOwnDataProperty(value, 'source');
  const orderKey = readOwnDataProperty(value, 'orderKey');
  const required = readOwnDataProperty(value, 'required');
  const initiallyEnabled = readOwnDataProperty(value, 'initiallyEnabled');
  const dependencies = readOwnDataProperty(value, 'dependencies');
  const create = readOwnDataProperty(value, 'create');

  if (unitId !== extensionId
    || source !== 'external'
    || typeof orderKey !== 'string'
    || orderKey.length === 0
    || required !== false
    || initiallyEnabled !== true
    || !Array.isArray(dependencies)
    || dependencies.length !== 0
    || typeof create !== 'function') {
    return undefined;
  }

  const receiver = value;
  return Object.freeze({
    unitId: extensionId,
    source: 'external',
    orderKey: extensionId,
    required: false,
    initiallyEnabled: true,
    dependencies: Object.freeze([]),
    create: (signal: AbortSignal) => Reflect.apply(create, receiver, [signal]) as ReturnType<
      LoadedRuntimeUnit['create']
    >,
  });
}

function readOwnDataProperty(value: object, property: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function diagnosticOutcome(
  category: ExtensionLoaderDiagnosticCategory,
  code: ExtensionLoaderDiagnosticCode,
  extensionId: string,
  locator?: string,
): Readonly<{ diagnostic: ExtensionLoaderDiagnostic }> {
  return Object.freeze({
    diagnostic: createLoaderDiagnostic(category, code, extensionId, locator),
  });
}

function createLoaderDiagnostic(
  category: ExtensionLoaderDiagnosticCategory,
  code: ExtensionLoaderDiagnosticCode,
  extensionId: string,
  locator?: string,
  referencePath?: string,
  environmentVariable?: string,
): ExtensionLoaderDiagnostic {
  return Object.freeze({
    category,
    code,
    extensionId: boundField(extensionId),
    ...(locator === undefined ? {} : { locator }),
    ...(referencePath === undefined ? {} : { referencePath: boundField(referencePath) }),
    ...(environmentVariable === undefined
      ? {}
      : { environmentVariable: boundField(environmentVariable) }),
  });
}

function compareDiagnostics(
  left: ExtensionAcquisitionDiagnostic,
  right: ExtensionAcquisitionDiagnostic,
): number {
  return compareCodeUnits(left.extensionId ?? '', right.extensionId ?? '')
    || compareCodeUnits(left.category, right.category)
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.locator ?? '', right.locator ?? '')
    || compareCodeUnits('referencePath' in left ? left.referencePath ?? '' : '',
      'referencePath' in right ? right.referencePath ?? '' : '');
}

function formatDiagnosticLocator(value: string): string {
  const escaped = JSON.stringify(value) ?? '""';
  if (escaped.length <= MAX_DIAGNOSTIC_FIELD_LENGTH) return escaped;

  const codePoints = Array.from(value);
  while (codePoints.length > 0) {
    const preview = JSON.stringify(`${codePoints.join('')}...`);
    if (preview.length <= MAX_DIAGNOSTIC_FIELD_LENGTH) return preview;
    codePoints.pop();
  }
  return '"..."';
}

function boundField(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_DIAGNOSTIC_FIELD_LENGTH) return value;
  return `${codePoints.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH - 3).join('')}...`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function diagnosticLogContext(
  diagnostic: ExtensionAcquisitionDiagnostic,
): Record<string, unknown> {
  return {
    category: diagnostic.category,
    code: diagnostic.code,
    ...(diagnostic.extensionId === undefined ? {} : { extensionId: diagnostic.extensionId }),
    ...(diagnostic.locator === undefined ? {} : { locator: diagnostic.locator }),
    ...(!('referencePath' in diagnostic) || diagnostic.referencePath === undefined
      ? {}
      : { referencePath: diagnostic.referencePath }),
    ...(!('environmentVariable' in diagnostic) || diagnostic.environmentVariable === undefined
      ? {}
      : { environmentVariable: diagnostic.environmentVariable }),
  };
}