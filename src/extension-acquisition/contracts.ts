import type { LoadedRuntimeUnit } from '../runtime/runtime-unit.js';

export interface ExtensionLoadContext {
  readonly config: Readonly<Record<string, unknown>>;
}

export interface ExternalExtensionModule {
  createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit;
}
