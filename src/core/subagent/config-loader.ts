import { join } from 'node:path';
import { isNamedAgentId, type AgentDefinition } from '../agent-context/index.js';
import { normalizeModelReference, type ModelReference } from '../model-resolution/index.js';
import { validateToolPolicyConfig } from '../tools/config.js';
import type { SubagentProfile } from './types.js';

export interface AgentProfileOverride {
  readonly id: string;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly model?: 'inherit' | ModelReference;
  readonly tools?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
}

export function loadAgentProfiles(
  definitions: readonly AgentDefinition[],
  overrides: readonly AgentProfileOverride[],
  registeredToolNames: ReadonlySet<string>,
): SubagentProfile[] {
  const byId = new Map<string, AgentProfileOverride>();
  for (const entry of overrides) {
    if (!isNamedAgentId(entry.id)) throw new Error(`agents.list[]: invalid or reserved id "${entry.id}"`);
    if (byId.has(entry.id)) throw new Error(`agents.list: duplicate id "${entry.id}"`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error(`agents.list["${entry.id}"].enabled: boolean required`);
    }
    if (entry.description !== undefined
      && (typeof entry.description !== 'string' || entry.description.trim() === '')) {
      throw new Error(`agents.list["${entry.id}"].description: nonblank text required`);
    }
    if (entry.model !== undefined && entry.model !== 'inherit') {
      if (typeof entry.model !== 'object' || entry.model === null
        || typeof entry.model.modelId !== 'string' || entry.model.modelId.trim() === '') {
        throw new Error(`agents.list["${entry.id}"].model: native Model Reference or "inherit" required`);
      }
      normalizeModelReference(entry.model);
    }
    if (entry.tools !== undefined) {
      validateToolPolicyConfig(entry.tools);
      for (const name of entry.tools.allow ?? []) {
        if (!/[*?]/u.test(name) && !registeredToolNames.has(name)) {
          throw new Error(`agents.list["${entry.id}"]: allow references unknown tool "${name}"`);
        }
      }
    }
    byId.set(entry.id, entry);
  }
  return definitions.flatMap(definition => {
    const entry = byId.get(definition.id);
    if (entry?.enabled === false) return [];
    return [{
      id: definition.id,
      description: entry?.description ?? definition.description,
      agentDir: definition.agentDir,
      model: entry?.model === 'inherit' ? 'inherit'
        : entry?.model === undefined ? definition.model ?? 'inherit'
          : normalizeModelReference(entry.model),
      ...(entry?.tools === undefined ? {} : { tools: entry.tools }),
    }];
  });
}

export function buildGeneralPurposeProfile(agentHome: string): SubagentProfile {
  return {
    id: 'general-purpose',
    description: 'General-purpose task executor. Use when no named subagent matches the request.',
    agentDir: join(agentHome, 'agents', 'general-purpose'),
    model: 'inherit',
  };
}
