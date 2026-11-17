import type { SubagentProfile } from './types.js';

/**
 * Result of resolving a subagent's effective tool policy against its
 * latest applied shared Tool defaults.
 *
 * - `allow`: explicit child allow REPLACES shared allow; omission uses shared allow.
 * - `deny`: when the child sets `tools.deny`, entries are APPENDED to the
 *   shared deny. Parent-specific denies do not participate.
 *
 * This function deliberately does NOT cross-filter `allow` against `deny`.
 * The Application Tool Policy owns deny precedence and Provider-definition
 * visibility from the immutable Tool projection.
 */
export interface ResolvedSubagentTools {
  allow: string[];
  deny: string[];
}

/**
 * Merge a subagent profile's own override with current shared Tool defaults.
 *
 * Returned arrays are fresh copies — never shared with parent references —
 * so callers can mutate them safely.
 */
export function resolveSubagentTools(
  profile: SubagentProfile,
  sharedAllow: readonly string[],
  sharedDeny: readonly string[],
): ResolvedSubagentTools {
  const allow =
    profile.tools?.allow !== undefined
      ? [...profile.tools.allow] // replace
      : [...sharedAllow];

  const deny =
    profile.tools?.deny !== undefined
      ? [...sharedDeny, ...profile.tools.deny]
      : [...sharedDeny];

  return { allow, deny };
}
