import type { LoadedRuntimeUnit } from '../../runtime/runtime-unit.js';

export interface ExtensionLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface ExtensionLoadContext {
  readonly config: Readonly<Record<string, unknown>>;
  readonly logger: ExtensionLogger;
}

export interface ExternalExtensionModule {
  createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit;
}