import type { RuntimeContributionUnit, ExtensionRegistrationApi } from '../../../core/registry/index.js';
import type { Tool, ToolExecutionContext } from '../../../core/tools/types.js';
import { getToolTurnAuthority } from '../../../core/tools/execution.js';
import { loadSkill, SkillLibraryError } from '../../../core/skills/index.js';
import { Logger } from '../../../platform/logger/index.js';

const log = Logger.get('skill');

export interface SkillToolDeps {
  readonly agentHome: string;
  readonly getTurn: (turnId: string) => {
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly skills: readonly string[];
  } | undefined;
}

export function createSkillTool(deps: SkillToolDeps): Tool {
  return {
    name: 'skill',
    description: 'Load current instructions for an enabled Skill by name before using it. Loading grants no additional Tool permissions.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The exact Skill name.' } },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(input: Readonly<Record<string, unknown>>, context: ToolExecutionContext) {
      try {
        const turn = deps.getTurn(context.turnId);
        if (!turn || turn.sessionId !== context.sessionId
          || turn.signal !== getToolTurnAuthority(context) || turn.signal.aborted || context.signal.aborted) {
          throw new SkillLibraryError('Skill loading requires an active matching Turn.');
        }
        if (typeof input.name !== 'string' || !turn.skills.includes(input.name)) {
          throw new SkillLibraryError(`Skill "${String(input.name)}" is not enabled for this Agent Turn.`);
        }
        const loaded = await loadSkill(deps.agentHome, input.name);
        if (context.signal.aborted || turn.signal.aborted) {
          throw new SkillLibraryError('Skill loading was interrupted.');
        }
        return {
          outcome: 'success',
          content: `Skill: ${loaded.name}\nResource base directory: ${loaded.directory}\n\n${loaded.content}`,
        };
      } catch (error) {
        if (!(error instanceof SkillLibraryError)) throw error;
        log.warn('Skill loading failed', { turnId: context.turnId, message: error.message });
        return { outcome: 'failed', content: error.message };
      }
    },
  };
}

export function createSkillToolContribution(deps: SkillToolDeps): RuntimeContributionUnit {
  return Object.freeze({
    id: 'builtin-skill-tools',
    source: 'builtin' as const,
    register(api: ExtensionRegistrationApi) { api.registerTool(createSkillTool(deps)); },
  });
}
