import { join } from 'node:path';
import type { SubagentConfigEntry } from '../../platform/config/types.js';
import type { SubagentProfile } from './types.js';

// ── Constants ────────────────────────────────────────────────

/** ID must be kebab/snake-case, 1..64 chars, starting with an alnum. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Reserved ids that user configs cannot use. `general-purpose` is the
 *  built-in anonymous subagent (built by {@link buildGeneralPurposeProfile}). */
const RESERVED_IDS = new Set<string>(['general-purpose']);

/** Path segments appended to `workspaceDir` to derive a subagent's `agentDir`. */
const SUBAGENT_DIR_SEGMENTS = ['.agent', 'subagents'] as const;

/** Built into v1 capabilities; subagents cannot grant themselves `task`
 *  to spawn further subagents (spec §13 overflow protection). */
const TASK_TOOL_NAME = 'task';

// ── Helpers ──────────────────────────────────────────────────

function deriveAgentDir(workspaceDir: string, id: string): string {
  return join(workspaceDir, ...SUBAGENT_DIR_SEGMENTS, id);
}

/** A glob entry contains `*` or `?`. Glob lookups bypass the registered-name
 *  check because expansion happens later at tool-registration time. */
function isGlob(name: string): boolean {
  return /[*?]/.test(name);
}

// ── Public API ───────────────────────────────────────────────

/**
 * Validate user-provided `SubagentConfigEntry[]` and project them into
 * `SubagentProfile[]`.
 *
 * Validation rules (each violation throws — bootstrap.ts converts the
 * error into a fatal startup failure):
 *
 * - `id` must match {@link ID_PATTERN} (kebab/snake-case, 1..64 chars).
 * - `id` cannot be in {@link RESERVED_IDS} (e.g. `general-purpose`).
 * - `id` must be unique across the list.
 * - `description` is required.
 * - `tools.allow` cannot contain `'task'` in v1 (no nested spawning).
 * - Every exact name (non-glob) in `tools.allow` must be a registered tool.
 *   Glob entries (`*` / `?`) are passed through without name checking.
 *
 * `agentDir` is ALWAYS derived from `workspaceDir + id` (spec §8.1). Whether
 * the directory actually exists is probed later by the SubagentRunner.
 */
export function loadSubagentProfiles(
  list: SubagentConfigEntry[],
  workspaceDir: string,
  registeredToolNames: ReadonlySet<string>,
): SubagentProfile[] {
  const seen = new Set<string>();
  const profiles: SubagentProfile[] = [];

  for (const entry of list) {
    if (!entry.id || !ID_PATTERN.test(entry.id)) {
      throw new Error(`subagents.list[]: invalid id "${entry.id}"`);
    }
    if (RESERVED_IDS.has(entry.id)) {
      throw new Error(`subagents.list["${entry.id}"]: reserved id, cannot be used`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`subagents.list: duplicate id "${entry.id}"`);
    }
    if (!entry.description) {
      throw new Error(`subagents.list["${entry.id}"]: description is required`);
    }
    if (entry.tools?.allow?.includes(TASK_TOOL_NAME)) {
      throw new Error(
        `subagents.list["${entry.id}"]: allow cannot contain "${TASK_TOOL_NAME}" in v1`,
      );
    }
    if (entry.tools?.allow) {
      for (const name of entry.tools.allow) {
        if (!isGlob(name) && !registeredToolNames.has(name)) {
          throw new Error(
            `subagents.list["${entry.id}"]: allow references unknown tool "${name}"`,
          );
        }
      }
    }
    seen.add(entry.id);

    profiles.push({
      id: entry.id,
      description: entry.description,
      agentDir: deriveAgentDir(workspaceDir, entry.id),
      model: entry.model,
      tools: entry.tools,
      maxLlmCalls: entry.maxLlmCalls,
    });
  }

  return profiles;
}

/**
 * Build the built-in anonymous subagent profile.
 *
 * `agentDir` is derived by the same rule as named profiles (keeps the
 * type invariant `agentDir: string`). The directory normally does not
 * exist on disk; the SubagentRunner detects that at run time and falls
 * back to the parent's contextFiles (spec §6 decision 10 — anonymous
 * subagent behavior).
 *
 * `model` / `tools` / `maxLlmCalls` are left unset so the runner
 * inherits them all from the parent.
 */
export function buildGeneralPurposeProfile(workspaceDir: string): SubagentProfile {
  return {
    id: 'general-purpose',
    description:
      'General-purpose task executor. Use when no named subagent matches the request.',
    agentDir: deriveAgentDir(workspaceDir, 'general-purpose'),
  };
}
