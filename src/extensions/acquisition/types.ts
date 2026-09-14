import type { LoadedRuntimeUnit } from '../../runtime/runtime-unit.js';

export interface ExtensionDescriptorV1 {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly entry: string;
  readonly configSchema: Readonly<Record<string, unknown>>;
}

export interface HostExtensionEntry {
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface HostConfig {
  readonly extensions?: Readonly<{
    readonly enabled?: boolean;
    readonly entries?: Readonly<Record<string, HostExtensionEntry>>;
  }>;
}

/**
 * Parsed Host extension namespace. Individual entry values remain unknown so a
 * malformed Extension namespace can be isolated without rejecting other IDs.
 */
export interface ResolvedHostExtensionsConfig {
  readonly enabled: boolean;
  readonly entries: Readonly<Record<string, unknown>>;
}

export interface AgentHomeResolutionOptions {
  readonly explicitPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}

export interface ExtensionCandidate {
  readonly descriptor: ExtensionDescriptorV1;
  readonly installationPath: string;
  readonly entryPath: string;
}

export type ExtensionDiscoveryDiagnosticCode =
  | 'candidate_reparse_point'
  | 'candidate_unreadable'
  | 'descriptor_missing'
  | 'descriptor_unreadable'
  | 'descriptor_invalid_json'
  | 'descriptor_invalid'
  | 'entry_invalid'
  | 'entry_reparse_point'
  | 'duplicate_identity';

export interface ExtensionDiscoveryDiagnostic {
  readonly category: 'discovery_invalid' | 'duplicate_identity';
  readonly code: ExtensionDiscoveryDiagnosticCode;
  readonly extensionId?: string;
  /** JSON-escaped and bounded installation directory name. */
  readonly locator: string;
}

export interface ExtensionDiscoveryResult {
  readonly candidates: readonly ExtensionCandidate[];
  readonly diagnostics: readonly ExtensionDiscoveryDiagnostic[];
}

export interface ExtensionLoadContext {
  readonly config: Readonly<Record<string, unknown>>;
}

export interface ExternalExtensionModule {
  createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit;
}

export type ExtensionLoaderDiagnosticCategory =
  | 'disabled'
  | 'config_invalid'
  | 'secret_unavailable'
  | 'entry_load_failed'
  | 'extension_config_rejected'
  | 'unit_invalid';

export type ExtensionLoaderDiagnosticCode =
  | 'extension_disabled'
  | 'stale_configured_id'
  | 'entry_config_invalid'
  | 'environment_value_unavailable'
  | 'environment_secret_unavailable'
  | 'config_schema_invalid'
  | 'config_validation_failed'
  | 'entry_revalidation_failed'
  | 'entry_import_failed'
  | 'entry_export_invalid'
  | 'factory_failed'
  | 'unit_metadata_invalid';

export interface ExtensionLoaderDiagnostic {
  readonly category: ExtensionLoaderDiagnosticCategory;
  readonly code: ExtensionLoaderDiagnosticCode;
  readonly extensionId: string;
  /** JSON-escaped and bounded installation directory name when installed. */
  readonly locator?: string;
  /** Bounded JSON Pointer within the Extension's scoped config. */
  readonly referencePath?: string;
  /** Bounded environment variable name; never its value. */
  readonly environmentVariable?: string;
}

export type ExtensionAcquisitionDiagnostic =
  | ExtensionDiscoveryDiagnostic
  | ExtensionLoaderDiagnostic;

export interface ExtensionAcquisitionResult {
  readonly loadedUnits: readonly LoadedRuntimeUnit[];
  readonly diagnostics: readonly ExtensionAcquisitionDiagnostic[];
}

export interface ExtensionAcquisitionOptions {
  readonly agentHome: string;
  readonly hostConfig: ResolvedHostExtensionsConfig;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export type ExtensionAcquisitionFatalCode =
  | 'AGENT_HOME_INVALID'
  | 'HOST_CONFIG_INVALID'
  | 'DISCOVERY_ROOT_INVALID';
