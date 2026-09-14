import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ExtensionAcquisitionFatalError } from './errors.js';
import type {
  ExtensionCandidate,
  ExtensionDescriptorV1,
  ExtensionDiscoveryDiagnostic,
  ExtensionDiscoveryDiagnosticCode,
  ExtensionDiscoveryResult,
} from './types.js';

const EXTENSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DRAFT_07_SCHEMA = 'http://json-schema.org/draft-07/schema#';
const MAX_DIAGNOSTIC_LOCATOR_LENGTH = 200;

export async function discoverExtensionDescriptors(
  agentHome: string,
): Promise<ExtensionDiscoveryResult> {
  const extensionsRoot = join(agentHome, 'extensions');
  const rootState = await resolveDiscoveryRoot(agentHome, extensionsRoot);
  if (rootState === undefined) return emptyResult();

  let entries;
  try {
    entries = await readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    throw invalidDiscoveryRoot('Extension discovery root could not be read.');
  }

  const candidates: ExtensionCandidate[] = [];
  const diagnostics: ExtensionDiscoveryDiagnostic[] = [];
  const sortedEntries = [...entries].sort((left, right) => compareCodeUnits(left.name, right.name));

  for (const entry of sortedEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const outcome = await inspectCandidate(
      rootState.canonicalAgentHome,
      rootState.canonicalExtensionsRoot,
      extensionsRoot,
      entry.name,
      entry.isSymbolicLink(),
    );
    if ('candidate' in outcome) candidates.push(outcome.candidate);
    else diagnostics.push(outcome.diagnostic);
  }

  const byId = new Map<string, ExtensionCandidate[]>();
  for (const candidate of candidates) {
    const group = byId.get(candidate.descriptor.id) ?? [];
    group.push(candidate);
    byId.set(candidate.descriptor.id, group);
  }

  const uniqueCandidates: ExtensionCandidate[] = [];
  for (const [extensionId, group] of byId) {
    if (group.length === 1) {
      uniqueCandidates.push(group[0]!);
      continue;
    }
    for (const candidate of group) {
      diagnostics.push(createDiagnostic(
        'duplicate_identity',
        'duplicate_identity',
        basename(candidate.installationPath),
        extensionId,
      ));
    }
  }

  uniqueCandidates.sort((left, right) =>
    compareCodeUnits(left.descriptor.id, right.descriptor.id));
  diagnostics.sort(compareDiagnostics);

  return Object.freeze({
    candidates: Object.freeze(uniqueCandidates),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function resolveDiscoveryRoot(
  agentHome: string,
  extensionsRoot: string,
): Promise<Readonly<{
  canonicalAgentHome: string;
  canonicalExtensionsRoot: string;
}> | undefined> {
  let rootStats;
  try {
    rootStats = await lstat(extensionsRoot);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw invalidDiscoveryRoot('Extension discovery root could not be inspected.');
  }
  if (!rootStats.isDirectory() && !rootStats.isSymbolicLink()) {
    throw invalidDiscoveryRoot('Extension discovery root must be a directory.');
  }

  let canonicalAgentHome: string;
  let canonicalExtensionsRoot: string;
  try {
    [canonicalAgentHome, canonicalExtensionsRoot] = await Promise.all([
      realpath(agentHome),
      realpath(extensionsRoot),
    ]);
  } catch {
    throw invalidDiscoveryRoot('Extension discovery root could not be resolved.');
  }
  if (!isContainedPath(canonicalAgentHome, canonicalExtensionsRoot)) {
    throw invalidDiscoveryRoot('Extension discovery root escapes Agent Home.');
  }
  return Object.freeze({ canonicalAgentHome, canonicalExtensionsRoot });
}

async function inspectCandidate(
  canonicalAgentHome: string,
  canonicalExtensionsRoot: string,
  extensionsRoot: string,
  installationName: string,
  direntIsSymbolicLink: boolean,
): Promise<Readonly<{ candidate: ExtensionCandidate }> | Readonly<{
  diagnostic: ExtensionDiscoveryDiagnostic;
}>> {
  const installationPath = join(extensionsRoot, installationName);
  if (direntIsSymbolicLink) {
    return diagnosticOutcome('candidate_reparse_point', installationName);
  }

  let canonicalInstallationPath: string;
  try {
    const stats = await lstat(installationPath);
    if (stats.isSymbolicLink()) {
      return diagnosticOutcome('candidate_reparse_point', installationName);
    }
    if (!stats.isDirectory()) return diagnosticOutcome('candidate_unreadable', installationName);
    canonicalInstallationPath = await realpath(installationPath);
  } catch {
    return diagnosticOutcome('candidate_unreadable', installationName);
  }

  if (!isContainedPath(canonicalAgentHome, canonicalInstallationPath)
    || !isContainedPath(canonicalExtensionsRoot, canonicalInstallationPath)) {
    return diagnosticOutcome('candidate_reparse_point', installationName);
  }

  const descriptorPath = join(installationPath, 'extension.json');
  let descriptorSource: string;
  try {
    const descriptorStats = await lstat(descriptorPath);
    if (descriptorStats.isSymbolicLink() || !descriptorStats.isFile()) {
      return diagnosticOutcome('descriptor_unreadable', installationName);
    }
    descriptorSource = await readFile(descriptorPath, 'utf8');
  } catch (error) {
    return diagnosticOutcome(
      hasErrorCode(error, 'ENOENT') ? 'descriptor_missing' : 'descriptor_unreadable',
      installationName,
    );
  }

  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(descriptorSource);
  } catch {
    return diagnosticOutcome('descriptor_invalid_json', installationName);
  }

  const descriptor = parseDescriptor(descriptorValue);
  if (descriptor === undefined) {
    return diagnosticOutcome('descriptor_invalid', installationName);
  }

  const entryPath = resolveDescriptorEntry(canonicalInstallationPath, descriptor.entry);
  if (entryPath === undefined) {
    return diagnosticOutcome('entry_invalid', installationName, descriptor.id);
  }

  let canonicalEntryPath: string;
  try {
    const entryStats = await lstat(entryPath);
    if (entryStats.isSymbolicLink()) {
      return diagnosticOutcome('entry_reparse_point', installationName, descriptor.id);
    }
    if (!entryStats.isFile()) {
      return diagnosticOutcome('entry_invalid', installationName, descriptor.id);
    }
    canonicalEntryPath = await realpath(entryPath);
  } catch {
    return diagnosticOutcome('entry_invalid', installationName, descriptor.id);
  }

  if (!isContainedPath(canonicalAgentHome, canonicalEntryPath)
    || !isContainedPath(canonicalInstallationPath, canonicalEntryPath)) {
    return diagnosticOutcome('entry_invalid', installationName, descriptor.id);
  }

  return Object.freeze({
    candidate: Object.freeze({
      descriptor,
      installationPath: canonicalInstallationPath,
      entryPath: canonicalEntryPath,
    }),
  });
}

function parseDescriptor(value: unknown): ExtensionDescriptorV1 | undefined {
  if (!isPlainObject(value)
    || value['manifestVersion'] !== 1
    || typeof value['id'] !== 'string'
    || !EXTENSION_ID.test(value['id'])
    || typeof value['version'] !== 'string'
    || value['version'].length === 0
    || typeof value['entry'] !== 'string'
    || !isValidEntrySpecifier(value['entry'])
    || !isValidConfigSchema(value['configSchema'])) {
    return undefined;
  }

  return Object.freeze({
    manifestVersion: 1,
    id: value['id'],
    version: value['version'],
    entry: value['entry'],
    configSchema: freezeJsonObject(value['configSchema']),
  });
}

function isValidEntrySpecifier(value: string): boolean {
  if (value.length === 0
    || value.includes('\0')
    || isAbsolute(value)
    || /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)
    || !value.endsWith('.js')) {
    return false;
  }
  const segments = value.split(/[\\/]/);
  return !segments.includes('..');
}

function resolveDescriptorEntry(
  canonicalInstallationPath: string,
  entry: string,
): string | undefined {
  const entryPath = resolve(canonicalInstallationPath, entry);
  return isContainedPath(canonicalInstallationPath, entryPath) ? entryPath : undefined;
}

/** A1 preflight only; Ajv strict Draft-07 compilation remains an A2 gate. */
function isValidConfigSchema(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)
    || value['$schema'] !== DRAFT_07_SCHEMA
    || value['type'] !== 'object'
    || value['additionalProperties'] !== false) {
    return false;
  }
  return hasOnlyResolvableInternalReferences(value, value);
}

function hasOnlyResolvableInternalReferences(
  value: unknown,
  schemaRoot: Record<string, unknown>,
): boolean {
  if (Array.isArray(value)) {
    return value.every((child) => hasOnlyResolvableInternalReferences(child, schemaRoot));
  }
  if (!isPlainObject(value)) return true;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref'
      && (typeof child !== 'string' || !resolvesInternalJsonPointer(schemaRoot, child))) {
      return false;
    }
    if (!hasOnlyResolvableInternalReferences(child, schemaRoot)) return false;
  }
  return true;
}

function resolvesInternalJsonPointer(root: Record<string, unknown>, reference: string): boolean {
  if (reference === '#') return true;
  if (!reference.startsWith('#/')) return false;

  let decodedPointer: string;
  try {
    decodedPointer = decodeURIComponent(reference.slice(2));
  } catch {
    return false;
  }

  let current: unknown = root;
  for (const encodedSegment of decodedPointer.split('/')) {
    if (/~(?:[^01]|$)/.test(encodedSegment)) return false;
    const segment = encodedSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(current) && !Array.isArray(current)) return false;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

function freezeJsonObject(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  for (const child of Object.values(value)) freezeJsonValue(child);
  return Object.freeze(value);
}

function freezeJsonValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) freezeJsonValue(child);
    Object.freeze(value);
    return;
  }
  if (isPlainObject(value)) freezeJsonObject(value);
}

function diagnosticOutcome(
  code: Exclude<ExtensionDiscoveryDiagnosticCode, 'duplicate_identity'>,
  installationName: string,
  extensionId?: string,
): Readonly<{ diagnostic: ExtensionDiscoveryDiagnostic }> {
  return Object.freeze({
    diagnostic: createDiagnostic('discovery_invalid', code, installationName, extensionId),
  });
}

function createDiagnostic(
  category: ExtensionDiscoveryDiagnostic['category'],
  code: ExtensionDiscoveryDiagnosticCode,
  installationLocator: string,
  extensionId?: string,
): ExtensionDiscoveryDiagnostic {
  return Object.freeze({
    category,
    code,
    ...(extensionId === undefined ? {} : { extensionId }),
    locator: formatDiagnosticLocator(installationLocator),
  });
}

function formatDiagnosticLocator(value: string): string {
  const escaped = JSON.stringify(value) ?? '""';
  if (escaped.length <= MAX_DIAGNOSTIC_LOCATOR_LENGTH) return escaped;

  const codePoints = Array.from(value);
  while (codePoints.length > 0) {
    const preview = JSON.stringify(`${codePoints.join('')}...`);
    if (preview.length <= MAX_DIAGNOSTIC_LOCATOR_LENGTH) return preview;
    codePoints.pop();
  }
  return '"..."';
}

function compareDiagnostics(
  left: ExtensionDiscoveryDiagnostic,
  right: ExtensionDiscoveryDiagnostic,
): number {
  return compareCodeUnits(left.extensionId ?? '', right.extensionId ?? '')
    || compareCodeUnits(left.locator, right.locator)
    || compareCodeUnits(left.code, right.code);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

function emptyResult(): ExtensionDiscoveryResult {
  return Object.freeze({
    candidates: Object.freeze([]),
    diagnostics: Object.freeze([]),
  });
}

function invalidDiscoveryRoot(message: string): ExtensionAcquisitionFatalError {
  return new ExtensionAcquisitionFatalError('DISCOVERY_ROOT_INVALID', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && (value as { readonly code?: unknown }).code === code;
}
