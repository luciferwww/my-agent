import type {
  SystemPromptBuildParams,
  ContextFile,
} from './types.js';
import { renderAvailableSubagentsSection } from '../subagent/available-subagents.js';

/**
 * Build the system prompt.
 *
 * Four active sections retain their original numbering and fixed order:
 *  1. agent-identity       - fixed identity                  [full only]
 *  3. behavior-rules       - behavior and Tool guidance      [full only]
 *  4. memory-instructions  - memory Tool guidance            [full only, with memory Tools]
 *  5. project-context      - injected Context files          [full + minimal, with files]
 *
 * Delegation extensions (task specification section 11):
 *  6. agent-home           - Agent Home path context         [full + minimal]
 *  7. available-subagents  - Agents available to task        [full only]
 *  8. available-skills     - Skills available to load        [full + minimal]
 */
export class SystemPromptBuilder {
  /**
   * Build and return the complete system prompt string.
   */
  build(params: SystemPromptBuildParams = {}): string {
    const mode = params.mode ?? 'full';
    if (mode === 'none') return '';

    const isMinimal = mode === 'minimal';
    const lines: string[] = [];

    // 1. identity — full only
    if (!isMinimal) this.buildIdentitySection(lines);

    // 3. behavior-rules — full only
    if (!isMinimal) this.buildBehaviorRulesSection(lines);

    // 4. memory-instructions — full only
    if (!isMinimal) this.buildMemorySection(lines, params);

    // 5. project-context — full + minimal
    this.buildProjectContextSection(lines, params);

    // 6. Agent Home — full + minimal (any mode except 'none', already filtered above)
    this.buildAgentHomeSection(lines, params);

    // 7. available-subagents — full only
    if (!isMinimal) this.buildAvailableSubagentsSection(lines, params);
    this.buildSkillsSection(lines, params);

    return lines.join('\n');
  }

  // ── Section 1: agent-identity ──────────────────────────────

  private buildIdentitySection(lines: string[]): void {
    lines.push('# Identity');
    lines.push('You are an AI assistant.');
    lines.push('');
  }

  // ── Section 4: behavior-rules ──────────────────────────────

  private buildBehaviorRulesSection(lines: string[]): void {
    lines.push('# Behavior Rules');
    lines.push(
      '- Be concise and direct. Avoid unnecessary preamble or filler.',
    );
    lines.push(
      '- When uncertain, say so explicitly rather than guessing.',
    );
    lines.push(
      '- Ask for clarification when the request is ambiguous, rather than making assumptions.',
    );
    lines.push(
      '- Break down complex tasks into clear steps before executing.',
    );
    lines.push(
      '- Only call a tool when it is clearly necessary; prefer direct answers when possible.',
    );
    lines.push(
      '- Always verify tool results before relying on them in your response.',
    );
    lines.push(
      '- If a tool call fails, explain the failure clearly and suggest alternatives.',
    );
    lines.push('');
  }

  // ── Section 6: memory-instructions ─────────────────────────

  private buildMemorySection(
    lines: string[],
    params: SystemPromptBuildParams,
  ): void {
    const toolNames = params.toolNames ?? [];
    const hasMemoryTool = toolNames.some(
      (name) => name === 'search_memory' || name === 'memory_search' || name === 'memory_get',
    );
    if (!hasMemoryTool) return;

    lines.push('# Memory Recall');
    lines.push(
      'Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search first; then use only the relevant results.',
    );
    lines.push(
      'Citations: include the source path when referencing memory snippets.',
    );
    lines.push('');
  }

  // ── Section 7: project-context ─────────────────────────────

  private buildProjectContextSection(
    lines: string[],
    params: SystemPromptBuildParams,
  ): void {
    const files = params.contextFiles?.filter(
      (f: ContextFile) => f.path.trim() && f.content.trim(),
    );
    if (!files?.length) return;

    lines.push('# Project Context', '');

    // Add persona guidance when SOUL.md is present, matching OpenClaw.
    const hasSoulFile = files.some((f: ContextFile) =>
      f.path.split('/').pop()?.toLowerCase() === 'soul.md',
    );
    if (hasSoulFile) {
      lines.push(
        'If SOUL.md is present, embody its persona and tone. ' +
        'Avoid stiff, generic replies; follow its guidance.',
      );
      lines.push('');
    }

    for (const file of files) {
      lines.push(`## ${file.path}`, '', file.content, '');
    }
  }

  // ── Section 7: Agent Home ──────────────────────────────────

  private buildAgentHomeSection(
    lines: string[],
    params: SystemPromptBuildParams,
  ): void {
    if (!params.agentHome) return;
    lines.push('# Agent Home');
    lines.push(`Your agent home directory is: ${params.agentHome}`);
    lines.push('');
  }

  // ── Section 8: available-subagents ─────────────────────────

  private buildAvailableSubagentsSection(
    lines: string[],
    params: SystemPromptBuildParams,
  ): void {
    const entries = params.availableSubagents;
    if (!entries?.length) return;
    const section = renderAvailableSubagentsSection(entries);
    if (!section) return;
    lines.push(section);
    lines.push('');
  }

  private buildSkillsSection(lines: string[], params: SystemPromptBuildParams): void {
    if (!params.toolNames?.includes('skill') || !params.availableSkills?.length) return;
    lines.push('# Available Skills', '');
    for (const entry of params.availableSkills) lines.push(`- ${entry.name}: ${entry.description}`);
    lines.push(
      '',
      'Before using a Skill, call skill with its name to obtain current instructions. Historical instructions do not replace loading current content.',
      'Choose matching Skills for your task. If the user or delegated task explicitly names a Skill (for example /skill name task), load that Skill rather than reconsidering its relevance.',
      'Preserve explicit Skill requirements in delegated task text. Each Child loads the Skill under its own enabled selection.',
      'If a required Skill is unavailable, explain the failure. Do not auto-enable it, silently substitute an ordinary task, or repeatedly delegate the same unavailable request.',
      'Skill content and resources grant no additional permissions. Use existing Tools under their normal policies.',
      '',
    );
  }
}
