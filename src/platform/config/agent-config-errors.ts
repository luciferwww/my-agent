export type AgentConfigErrorCode =
  | 'AGENT_HOME_CREATE_FAILED'
  | 'FILE_CREATE_FAILED'
  | 'FILE_MISSING'
  | 'FILE_UNREADABLE'
  | 'INVALID_JSON'
  | 'ROOT_INVALID'
  | 'UNKNOWN_NAMESPACE'
  | 'NAMESPACE_INVALID';

const MAX_FIELD_PATH_LENGTH = 200;

/** A secret-free, document-level Agent configuration failure. */
export class AgentConfigError extends Error {
  readonly code: AgentConfigErrorCode;
  readonly fieldPath?: string;

  constructor(code: AgentConfigErrorCode, message: string, fieldPath?: string) {
    super(message);
    this.name = 'AgentConfigError';
    this.code = code;
    if (fieldPath !== undefined) this.fieldPath = boundFieldPath(fieldPath);
  }
}

export function invalidAgentConfigField(fieldPath: string): AgentConfigError {
  const boundedPath = boundFieldPath(fieldPath);
  return new AgentConfigError(
    'NAMESPACE_INVALID',
    `Agent configuration field ${JSON.stringify(boundedPath)} has invalid structure.`,
    boundedPath,
  );
}

export function unknownAgentConfigNamespace(namespace: string): AgentConfigError {
  const boundedNamespace = boundFieldPath(namespace);
  return new AgentConfigError(
    'UNKNOWN_NAMESPACE',
    `Agent configuration contains unknown top-level namespace ${JSON.stringify(boundedNamespace)}.`,
    boundedNamespace,
  );
}

function boundFieldPath(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_FIELD_PATH_LENGTH) return value;
  return `${codePoints.slice(0, MAX_FIELD_PATH_LENGTH - 3).join('')}...`;
}