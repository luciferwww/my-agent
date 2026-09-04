/**
 * Subagent session-key utilities.
 *
 * Session-key format:
 *
 *   `<rootLabel>:subagent:<runId>:<depth>`
 *
 * Subagent runs are nested by repeating the `:subagent:<runId>:<depth>`
 * suffix, e.g. `main:subagent:abc:1:subagent:def:2` for a depth-2 grandchild.
 * The number of `:subagent:` separators in the key equals the depth.
 *
 * See spec §10 (subagent session-key derivation) for the rationale.
 */

export interface ParsedSubagentKey {
  rootLabel: string;
  runId: string;
  depth: number;
}

const SEPARATOR = ':subagent:';

/** Build a subagent session-key from its components. */
export function formatSubagentSessionKey(opts: {
  rootLabel: string;
  runId: string;
  depth: number;
}): string {
  return `${opts.rootLabel}${SEPARATOR}${opts.runId}:${opts.depth}`;
}

/** Returns true if `key` contains any subagent suffix. */
export function isSubagentSessionKey(key: string): boolean {
  return key.includes(SEPARATOR);
}

/** Count of `:subagent:` separators in `key` — equal to nesting depth. */
export function getSubagentDepth(key: string): number {
  return (key.match(/:subagent:/g) ?? []).length;
}

/**
 * Parse a subagent session-key into its components.
 *
 * Callers SHOULD verify {@link isSubagentSessionKey} returns `true` first.
 * For non-subagent keys (no `:subagent:` separator) the returned `depth`
 * is `NaN` — guard accordingly.
 *
 * The `rootLabel` is everything before the FIRST `:subagent:`; the
 * `runId` and `depth` come from the LAST `:subagent:<runId>:<depth>`
 * trailing segment (so nesting collapses to the deepest child's id).
 */
export function parseSubagentSessionKey(key: string): ParsedSubagentKey {
  const parts = key.split(SEPARATOR);
  const rootLabel = parts[0] ?? '';
  const lastSegment = parts[parts.length - 1] ?? '';
  const colonIdx = lastSegment.lastIndexOf(':');
  const runId = colonIdx >= 0 ? lastSegment.slice(0, colonIdx) : lastSegment;
  const depth = colonIdx >= 0 ? Number.parseInt(lastSegment.slice(colonIdx + 1), 10) : Number.NaN;
  return { rootLabel, runId, depth };
}
