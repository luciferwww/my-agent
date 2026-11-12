import { isDeepStrictEqual } from 'node:util';
import type { AgentDefinitionSnapshot } from '../../core/agent-context/index.js';
import {
  buildGeneralPurposeProfile, loadAgentProfiles, resolveSubagentTools,
} from '../../core/subagent/index.js';
import type { SubagentProfile, SubagentProfileRegistry } from '../../core/subagent/types.js';
import type { ApplicationToolPolicy } from '../../core/tools/index.js';
import { DEFAULT_TOOL_POLICY_CONFIG } from '../../core/tools/config.js';
import {
  editAgentConfigSection, resolveAgentConfig, resolveAgentExecutionConfig,
  type AgentPolicyEdit, type AgentExecutionEdit, type ResolveOptions,
} from '../../platform/config/index.js';
import type { AgentConfigDocument, AgentsConfig, AppConfig } from '../../platform/config/types.js';
import { createApplicationToolPolicy } from './tool-approval-policy.js';
import { getAgentPolicySettings, ConfigEditError } from '../../platform/config/agent-config-editor.js';
import { matchesAny } from './glob-match.js';

export const SHARED_AGENT_TOOLS_SECTION = 'agents:defaults';

export interface AppliedAgentState extends SubagentProfileRegistry {
  readonly agents: AgentsConfig;
  readonly rootToolPolicy: ApplicationToolPolicy;
}

export class AgentPolicyState {
  private applied: AppliedAgentState;
  private readonly config: AppConfig;
  private readonly rootOptions: ResolveOptions;
  readonly sectionIds: readonly string[];

  constructor(
    config: AppConfig,
    readonly definitions: AgentDefinitionSnapshot,
    private readonly getToolNames: () => ReadonlySet<string>,
    rootOptions: ResolveOptions = {},
  ) {
    this.config = structuredClone(config);
    this.rootOptions = structuredClone(rootOptions);
    this.applied = this.build(this.config.agents);
    this.sectionIds = Object.freeze([
      'agents:execution',
      SHARED_AGENT_TOOLS_SECTION,
      ...[...new Set([
        ...definitions.definitions.map(definition => definition.id),
        ...config.agents.list.map(entry => entry.id),
      ])].sort().map(id => `agent:${id}`),
    ]);
  }

  capture(): AppliedAgentState { return this.applied; }

  prepare(edit: AgentPolicyEdit | AgentExecutionEdit): () => void {
    const candidate = editAgentConfigSection({ agents: this.applied.agents }, edit).document.agents;
    if (edit.kind === 'agent') {
      const tools = candidate?.list?.find(entry => entry.id === edit.agentId)?.tools;
      for (const name of tools?.allow ?? []) {
        if (!/[*?]/u.test(name) && !this.getToolNames().has(name)) {
          throw new ConfigEditError('/settings/tools/allow', `Unknown Tool "${name}".`);
        }
      }
    }
    const agents = {
      ...this.applied.agents,
      ...(edit.kind === 'agent-execution' ? resolveAgentExecutionConfig(candidate) : {}),
      defaults: {
        ...this.applied.agents.defaults,
        tools: candidate?.defaults?.tools ?? DEFAULT_TOOL_POLICY_CONFIG,
      },
      list: candidate?.list ?? [],
    };
    if (edit.kind === 'agent-execution' && candidate?.maxLlmCallsPerTurn === undefined) {
      delete agents.maxLlmCallsPerTurn;
    }
    const prepared = this.build(agents);
    return () => { this.applied = prepared; };
  }

  section(id: string, document: AgentConfigDocument) {
    const applied = this.applied;
    if (id === SHARED_AGENT_TOOLS_SECTION) {
      return {
        id, kind: 'agent-defaults', agentId: 'general-purpose', builtIn: true,
        name: 'Default Tool permissions', description: 'Shared Tool defaults for subsequent Root and Child Turns.',
        enabled: true, settings: getAgentPolicySettings(document),
        effectiveTools: applied.agents.defaults.tools,
        restartRequired: false, applicationStatus: isDeepStrictEqual(
          { ...DEFAULT_TOOL_POLICY_CONFIG, ...getAgentPolicySettings(document).tools },
          { ...DEFAULT_TOOL_POLICY_CONFIG, ...applied.agents.defaults.tools },
        ) ? 'current' : 'not_applied',
      };
    }
    const agentId = id.slice('agent:'.length);
    const definition = this.definitions.definitions.find(item => item.id === agentId);
    const saved = document.agents?.list?.find(entry => entry.id === agentId);
    const current = applied.agents.list.find(entry => entry.id === agentId);
    const settings = getAgentPolicySettings(document, agentId);
    return {
      id, kind: 'agent', agentId, name: agentId, builtIn: false,
      definitionAvailable: definition !== undefined,
      description: current?.description ?? definition?.description,
      model: current?.model ?? definition?.model ?? 'inherit',
      enabled: !applied.disabledIds.has(agentId),
      settings,
      sharedAllow: [...applied.agents.defaults.tools.allow ?? []],
      sharedDeny: [...applied.agents.defaults.tools.deny ?? []],
      sharedDeniedTools: [...this.getToolNames()]
        .filter(name => matchesAny(name, applied.agents.defaults.tools.deny ?? [])),
      effectiveTools: applied.profiles.get(agentId)?.tools,
      contextFiles: definition?.sourceFiles ?? [],
      instructionFiles: definition?.contextFiles ?? [],
      metadata: definition === undefined ? {} : {
        description: definition.description,
        ...(definition.model === undefined ? {} : { model: definition.model }),
      },
      missingFiles: definition?.missingFiles ?? ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'TOOLS.md'],
      contextRestartRequired: true,
      restartRequired: false,
      applicationStatus: isDeepStrictEqual(settings.tools, getAgentPolicySettings({ agents: applied.agents }, agentId).tools)
        && (saved?.enabled !== false) === (current?.enabled !== false) ? 'current' : 'not_applied',
    };
  }

  diagnostics() {
    const defined = new Set(this.definitions.definitions.map(item => item.id));
    return [
      ...this.definitions.diagnostics,
      ...this.applied.agents.list.filter(entry => !defined.has(entry.id)).map(entry => ({
        agentId: entry.id, code: 'definition_unavailable',
        message: 'Saved override has no valid startup definition and does not register an Agent.',
      })),
    ];
  }

  private build(agents: AgentsConfig): AppliedAgentState {
    const shared = agents.defaults.tools;
    const profiles = new Map<string, SubagentProfile>();
    for (const profile of [
      buildGeneralPurposeProfile(this.config.agentHome),
      ...loadAgentProfiles(this.definitions.definitions, agents.list, this.getToolNames()),
    ]) {
      const tools = resolveSubagentTools(profile, shared.allow ?? [], shared.deny ?? []);
      profiles.set(profile.id, Object.freeze({
        ...profile,
        model: profile.model === 'inherit' ? 'inherit' : Object.freeze({ ...profile.model }),
        tools: Object.freeze({ allow: Object.freeze(tools.allow), deny: Object.freeze(tools.deny) }),
      }));
    }
    const root = resolveAgentConfig({ ...this.config, agents }, this.rootOptions).tools;
    const rootTools = agents.maxSubagentDepth === 0
      ? { allow: root.allow, deny: [...root.deny ?? [], 'task'] } : root;
    return Object.freeze({
      agents: freeze(agents),
      profiles,
      disabledIds: new Set(agents.list.filter(entry => entry.enabled === false).map(entry => entry.id)),
      rootToolPolicy: createApplicationToolPolicy(rootTools, this.config.agentHome),
    });
  }
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
