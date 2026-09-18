import type { SubagentCapabilities, SubagentRole } from './types.js';

/**
 * Resolve role + spawn capability from an explicit subagent depth.
 *
 * | depth        | role           | canSpawn |
 * |--------------|----------------|----------|
 * | `0`          | `main`         | `true`   |
 * | `< maxDepth` | `orchestrator` | `true`   |
 * | `>= maxDepth`| `leaf`         | `false`  |
 *
 * When `maxDepth === 0`, the main agent itself is a `leaf` and cannot
 * spawn — used for forcing single-level test runs.
 *
 * See spec §6 (depth model) and §13 (overflow protection).
 */
export function resolveSubagentCapabilities(
  depth: number,
  maxDepth: number,
): SubagentCapabilities {
  let role: SubagentRole;
  if (depth >= maxDepth) {
    role = 'leaf';
  } else if (depth === 0) {
    role = 'main';
  } else {
    role = 'orchestrator';
  }
  return { depth, role, canSpawn: role !== 'leaf' };
}
