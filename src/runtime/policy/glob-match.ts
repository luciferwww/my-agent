/**
 * Case-sensitive glob matching: `*` matches any sequence, `?` a single character.
 *
 * Supports exact names and glob patterns in `tools.allow / deny` for
 * Application Tool Policy visibility and runtime authorization.
 */
export function globMatch(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(name);
}

/** Returns true if any pattern matches; an empty pattern list returns false. */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globMatch(name, p));
}
