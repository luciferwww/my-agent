import { join } from 'node:path';
import type { ModelReference } from '../model-resolution/index.js';
import type { SubagentProfile } from './types.js';

interface ConfiguredAgentProfileEntry {
  readonly id: string;
  readonly description: string;
  readonly model?: ModelReference;
  readonly tools?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
}

// ── Constants ────────────────────────────────────────────────

/** ID must be kebab/snake-case, 1..64 chars, starting with an alnum. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Reserved ids that user configs cannot use. `general-purpose` is the
 *  built-in anonymous subagent (built by {@link buildGeneralPurposeProfile}). */
const RESERVED_IDS = new Set<string>(['general-purpose']);

/** Path segments appended to `agentHome` to derive a configured Agent's directory. */
const AGENT_DIR_SEGMENTS = ['agents'] as const;

// ── Helpers ──────────────────────────────────────────────────

function deriveAgentDir(agentHome: string, id: string): string {
  return join(agentHome, ...AGENT_DIR_SEGMENTS, id);
}

/** A glob entry contains `*` or `?`. Glob lookups bypass the registered-name
 *  check because expansion happens later at tool-registration time. */
function isGlob(name: string): boolean {
  return /[*?]/.test(name);
}

function resolveModelSelection(
  model: ModelReference | undefined | unknown,
  profileId: string,
): SubagentProfile['model'] {
  if (model === undefined) {
    return 'inherit';
  }
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error(
      `agents.list["${profileId}"]: model must be a native Model Reference`,
    );
  }

  const candidate = model as Record<string, unknown>;
  const allowedKeys = new Set(['providerId', 'modelId']);
  const unknownKey = Object.keys(candidate).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`agents.list["${profileId}"].model: unknown field "${unknownKey}"`);
  }
  if (typeof candidate.modelId !== 'string' || candidate.modelId.trim() === '') {
    throw new Error(`agents.list["${profileId}"].model: modelId must be nonblank`);
  }
  if (typeof candidate.providerId !== 'string' || candidate.providerId.trim() === '') {
    throw new Error(`agents.list["${profileId}"].model: providerId must be nonblank`);
  }

  return Object.freeze({
    providerId: candidate.providerId.trim(),
    modelId: candidate.modelId,
  });
}

// ── Public API ───────────────────────────────────────────────

/**
 * Validate configured Agent entries and project their Subagent-supported
 * fields into
 * `SubagentProfile[]`.
 *
 * Validation rules (each violation throws — bootstrap.ts converts the
 * error into a fatal startup failure):
 *
 * - `id` must match {@link ID_PATTERN} (kebab/snake-case, 1..64 chars).
 * - `id` cannot be in {@link RESERVED_IDS} (e.g. `general-purpose`).
 * - `id` must be unique across the list.
 * - `description` is required.
 * - Every exact name (non-glob) in `tools.allow` must be a registered tool.
 *   Glob entries (`*` / `?`) are passed through without name checking.
 *
 * `agentDir` is ALWAYS derived from `agentHome + id` (spec §8.1). Whether
 * the directory actually exists is probed later by the Child executor.
 */
export function loadConfiguredAgentProfiles(
  list: readonly ConfiguredAgentProfileEntry[],
  agentHome: string,
  registeredToolNames: ReadonlySet<string>,
): SubagentProfile[] {
  const seen = new Set<string>();
  const profiles: SubagentProfile[] = [];

  for (const entry of list) {
    if (!entry.id || !ID_PATTERN.test(entry.id)) {
      throw new Error(`agents.list[]: invalid id "${entry.id}"`);
    }
    if (RESERVED_IDS.has(entry.id)) {
      throw new Error(`agents.list["${entry.id}"]: reserved id, cannot be used`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`agents.list: duplicate id "${entry.id}"`);
    }
    if (!entry.description) {
      throw new Error(`agents.list["${entry.id}"]: description is required`);
    }
    const model = resolveModelSelection(entry.model, entry.id);
    if (entry.tools?.allow) {
      for (const name of entry.tools.allow) {
        if (!isGlob(name) && !registeredToolNames.has(name)) {
          throw new Error(
            `agents.list["${entry.id}"]: allow references unknown tool "${name}"`,
          );
        }
      }
    }
    seen.add(entry.id);

    profiles.push({
      id: entry.id,
      description: entry.description,
      agentDir: deriveAgentDir(agentHome, entry.id),
      model,
      tools: entry.tools === undefined
        ? undefined
        : {
            ...(entry.tools.allow === undefined ? {} : { allow: [...entry.tools.allow] }),
            ...(entry.tools.deny === undefined ? {} : { deny: [...entry.tools.deny] }),
          },
    });
  }

  return profiles;
}

/**
 * Build the built-in anonymous subagent profile.
 *
 * `agentDir` is derived by the same rule as named Agents. The directory
 * normally does not exist; the Child executor falls back to Root Context.
 *
 * The built-in profile explicitly inherits the Parent effective Model
 * Reference. Other optional execution settings remain unset.
 */
export function buildGeneralPurposeProfile(agentHome: string): SubagentProfile {
  return {
    id: 'general-purpose',
    description:
      'General-purpose task executor. Use when no named subagent matches the request.',
    agentDir: deriveAgentDir(agentHome, 'general-purpose'),
    model: 'inherit',
  };
}
