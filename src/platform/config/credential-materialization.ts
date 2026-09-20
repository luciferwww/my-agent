const ENVIRONMENT_REFERENCE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u;

export class CredentialMaterializationError extends Error {
  readonly environmentVariable?: string;
  readonly secretUnavailable: boolean;

  constructor(options: {
    readonly environmentVariable?: string;
    readonly secretUnavailable?: boolean;
  } = {}) {
    const detail = options.environmentVariable === undefined
      ? ''
      : ` Environment variable ${JSON.stringify(options.environmentVariable)} is unavailable.`;
    super(`Credential configuration is invalid.${detail}`);
    this.name = 'CredentialMaterializationError';
    this.environmentVariable = options.environmentVariable;
    this.secretUnavailable = options.secretUnavailable === true;
  }
}

/** Resolves only a complete `${ENV_VAR}` credential reference; other strings remain literal. */
export function materializeExactStringCredential(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new CredentialMaterializationError();

  const reference = ENVIRONMENT_REFERENCE.exec(value);
  if (reference !== null) {
    const environmentVariable = reference[1]!;
    const resolved = environment[environmentVariable];
    if (resolved === undefined || resolved.trim().length === 0) {
      throw new CredentialMaterializationError({
        environmentVariable,
        secretUnavailable: true,
      });
    }
    return resolved;
  }

  if (/^\$\{.*\}$/u.test(value)) throw new CredentialMaterializationError();
  return value.trim().length === 0 ? undefined : value;
}
