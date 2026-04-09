import type { RuntimeErrorCode, RuntimeErrorInfo, RuntimeErrorScope, RuntimeErrorSeverity } from './types.js';

export class RuntimeAppError extends Error {
  readonly info: RuntimeErrorInfo;

  constructor(info: RuntimeErrorInfo) {
    super(info.message);
    this.name = 'RuntimeAppError';
    this.info = info;
  }
}

export function createRuntimeError(info: RuntimeErrorInfo): RuntimeAppError {
  return new RuntimeAppError(info);
}

export function classifyRuntimeError(scope: RuntimeErrorScope, error: unknown): RuntimeErrorInfo {
  if (error instanceof RuntimeAppError) {
    return error.info;
  }

  const cause = error instanceof Error ? error : new Error(String(error));
  const message = cause.message;

  const mapping = getDefaultMapping(scope, message);
  return {
    scope,
    severity: mapping.severity,
    code: mapping.code,
    message,
    cause,
  };
}

function getDefaultMapping(
  scope: RuntimeErrorScope,
  message: string,
): { code: RuntimeErrorCode; severity: RuntimeErrorSeverity } {
  switch (scope) {
    case 'startup':
      if (message.toLowerCase().includes('workspace')) {
        return { code: 'WORKSPACE_INIT_FAILED', severity: 'fatal' };
      }
      if (message.toLowerCase().includes('tool')) {
        return { code: 'TOOL_ASSEMBLY_FAILED', severity: 'fatal' };
      }
      return { code: 'CONFIG_INVALID', severity: 'fatal' };
    case 'reload':
      return { code: 'CONTEXT_LOAD_FAILED', severity: 'recoverable' };
    case 'shutdown':
      return { code: 'SHUTDOWN_FAILED', severity: 'recoverable' };
    case 'run':
    default:
      if (message.toLowerCase().includes('model')) {
        return { code: 'MODEL_MISSING', severity: 'recoverable' };
      }
      if (message.toLowerCase().includes('cannot run')) {
        return { code: 'RUN_REJECTED', severity: 'recoverable' };
      }
      return { code: 'RUN_FAILED', severity: 'recoverable' };
  }
}