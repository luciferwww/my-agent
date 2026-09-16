export { ExtensionAcquisitionFatalError } from './errors.js';
export { acquireExtensions } from './loader.js';
export { discoverExtensionDescriptors } from './discovery.js';

export type {
  ExtensionLoadContext,
  ExternalExtensionModule,
} from './contracts.js';
export type {
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
  ResolvedHostExtensionsConfig,
} from './types.js';
