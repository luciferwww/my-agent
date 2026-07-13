import type { SubagentProfile } from './types.js';

/**
 * Result of resolving a subagent's effective tool policy against its
 * parent's policy.
 *
 * - `allow`: when the child sets `tools.allow`, it REPLACES the parent's
 *   `allow` list. When unset, the parent's `allow` is inherited.
 * - `deny`: when the child sets `tools.deny`, entries are APPENDED to the
 *   parent's `deny`. When unset, the parent's `deny` is inherited.
 *
 * Note: this function deliberately does NOT cross-filter `allow` against
 * `deny` (i.e. it does NOT strip names that appear in both). Per spec
 * decision 5, tools listed in `deny` are filtered at tool-registration
 * time via `applyDenyFilter` and again at the run-time allow hook via
 * `resolveToolPolicy` (deny-wins is already enforced in
 * `tool-approval-policy.ts:25`). Duplicating that logic here would be
 * both redundant and would shift the deny-precedence invariant into
 * this module.
 */
export interface ResolvedSubagentTools {
  allow: string[];
  deny: string[];
}

/**
 * Merge a subagent profile's tool policy with the parent agent's policy.
 *
 * Returned arrays are fresh copies — never shared with parent references —
 * so callers can mutate them safely.
 */
export function resolveSubagentTools(
  profile: SubagentProfile,
  parentAllow: readonly string[],
  parentDeny: readonly string[],
): ResolvedSubagentTools {
  const allow =
    profile.tools?.allow !== undefined
      ? [...profile.tools.allow] // replace
      : [...parentAllow]; // inherit

  const deny =
    profile.tools?.deny !== undefined
      ? [...parentDeny, ...profile.tools.deny] // append on top of parent
      : [...parentDeny]; // inherit

  return { allow, deny };
}
