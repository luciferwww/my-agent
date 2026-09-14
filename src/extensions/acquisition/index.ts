export { resolveAgentHome } from './agent-home.js';
export { ExtensionAcquisitionFatalError } from './errors.js';
export { discoverExtensionDescriptors } from './discovery.js';
export { readHostExtensionsConfig } from './host-config.js';

export type {
  AgentHomeResolutionOptions,
  ExtensionAcquisitionFatalCode,
  ExtensionCandidate,
  ExtensionDescriptorV1,
  ExtensionDiscoveryDiagnostic,
  ExtensionDiscoveryDiagnosticCode,
  ExtensionDiscoveryResult,
  HostConfig,
  HostExtensionEntry,
  ResolvedHostExtensionsConfig,
} from './types.js';
