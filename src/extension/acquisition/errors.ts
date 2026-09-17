import type { ExtensionAcquisitionFatalCode } from './types.js';

export class ExtensionAcquisitionFatalError extends Error {
  readonly code: ExtensionAcquisitionFatalCode;

  constructor(code: ExtensionAcquisitionFatalCode, message: string) {
    super(message);
    this.name = 'ExtensionAcquisitionFatalError';
    this.code = code;
  }
}
