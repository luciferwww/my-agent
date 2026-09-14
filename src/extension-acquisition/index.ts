export { resolveAgentHome } from './agent-home.js';
export { ExtensionAcquisitionFatalError } from './errors.js';
export { acquireExtensions } from './loader.js';
export { discoverExtensionDescriptors } from './discovery.js';
export { readHostExtensionsConfig } from './host-config.js';

export type {
  ExtensionLoadContext,
  ExternalExtensionModule,
} from './contracts.js';
export type {
  AgentHomeResolutionOptions,
  ExtensionAcquisitionDiagnostic,
  ExtensionAcquisitionFatalCode,
  ExtensionAcquisitionOptions,
  ExtensionAcquisitionResult,
  ExtensionCandidate,
  ExtensionDescriptorV1,
  ExtensionDiscoveryDiagnostic,
  ExtensionDiscoveryDiagnosticCode,
  ExtensionDiscoveryResult,
  ExtensionLoaderDiagnostic,
  ExtensionLoaderDiagnosticCategory,
  ExtensionLoaderDiagnosticCode,
  HostConfig,
  HostExtensionEntry,
  ResolvedHostExtensionsConfig,
} from './types.js';
