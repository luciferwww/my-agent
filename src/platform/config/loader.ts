import type { AppConfig, AgentDefaults, DeepPartial } from './types.js';
import { projectAgentCapabilities } from './agent-leaf-validation.js';

// Deep merge

/**
 * Deep-merge two objects. Defined source values override the target.
 *
 * Rules:
 * - Plain objects on both sides are merged recursively.
 * - Undefined source values preserve the target.
 * - All other source values replace the target.
 */
type MergeableObject<T> = {
  [K in keyof T]: unknown;
};

export function deepMerge<T extends MergeableObject<T>>(
  target: T,
  source: DeepPartial<T>,
): T {
  const result = { ...target } as T;

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    if (sourceVal === undefined) continue;

    const targetVal = result[key];

    if (
      isPlainObject(targetVal) &&
      isPlainObject(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as DeepPartial<Record<string, unknown>>,
      ) as T[keyof T];
    } else {
      result[key] = sourceVal as T[keyof T];
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── resolveAgentConfig ───────────────────────────────────

export interface ResolveOptions {
  /** Agent ID to look up in agents.list. */
  agentId?: string;
  /** Environment overrides. */
  envOverrides?: DeepPartial<AgentDefaults>;
  /** CLI overrides. */
  cliOverrides?: DeepPartial<AgentDefaults>;
}

/**
 * Resolve the final configuration for the selected Agent.
 *
 * Starting with module and file defaults, merge:
 *   1. The matching agents.list entry's capability overrides.
 *   2. Environment overrides.
 *   3. CLI overrides.
 *
 * Skip step 1 when agentId is absent or unmatched.
 */
export function resolveAgentConfig(
  config: AppConfig,
  options?: ResolveOptions,
): AgentDefaults {
  let resolved = { ...config.agents.defaults };

  // 1. Per-Agent overrides
  if (options?.agentId) {
    const entry = config.agents.list.find((e) => e.id === options.agentId);
    if (entry) {
      resolved = deepMerge(resolved, projectAgentCapabilities(entry, `agents.list["${entry.id}"]`));
    }
  }

  // 2. Environment overrides
  if (options?.envOverrides) {
    resolved = deepMerge(resolved, options.envOverrides);
  }

  // 3. CLI overrides
  if (options?.cliOverrides) {
    resolved = deepMerge(resolved, options.cliOverrides);
  }

  return resolved;
}
