import type {
  SystemPromptBuildParams,
  ContextFile,
} from './types.js';
import { renderAvailableSubagentsSection } from '../subagent/available-subagents.js';

/**
 * 构建 System Prompt。
 *
 * 当前 6 个 active section（编号 1–6），顺序固定；minimal 模式跳过若干（见 §spec §11）：
 *  1. agent-identity       — 固定身份声明                   [full only]
 *  2. agent-datetime       — 当前日期时间                   [full + minimal]
 *  3. behavior-rules       — 行为准则 + 工具使用规范          [full only]
 *  4. safety-constraints   — 安全约束                       [full + minimal, safetyLevel 控制]
 *  5. memory-instructions  — memory tool 使用说明            [full only, 有 memory 工具时]
 *  6. project-context      — contextFiles 注入              [full + minimal, 有 contextFiles 时]
 *
 * 依存扩展（§task spec §11）：
 *  7. workspace            — working directory 锚点         [full + minimal]
 *  8. available-subagents  — task 工具可用的 subagent 列表     [full only]
 */
export class SystemPromptBuilder {
  /**
   * 构建并返回完整的 System Prompt 字符串。
   */
  build(params: SystemPromptBuildParams = {}): string {
    const mode = params.mode ?? 'full';
    if (mode === 'none') return '';

    const isMinimal = mode === 'minimal';
    const lines: string[] = [];

    // 1. identity — full only
    if (!isMinimal) this.buildIdentitySection(lines);

    // 2. datetime — full + minimal
    this.buildDatetimeSection(lines);

    // 3. behavior-rules — full only
    if (!isMinimal) this.buildBehaviorRulesSection(lines);

    // 4. safety — full + minimal
    this.buildSafetySection(lines, params);

    // 5. memory-instructions — full only
    if (!isMinimal) this.buildMemorySection(lines, params);

    // 6. project-context — full + minimal
    this.buildProjectContextSection(lines, params);

    // 7. workspace — full + minimal (any mode except 'none', already filtered above)
    this.buildWorkspaceSection(lines, params);

    // 8. available-subagents — full only
    if (!isMinimal) this.buildAvailableSubagentsSection(lines, params);

    return lines.join('\n');
  }

  // ── Section 1: agent-identity ──────────────────────────────

  private buildIdentitySection(lines: string[]): void {
    lines.push('# Identity');
    lines.push('You are an AI assistant.');
    lines.push('');
  }

  // ── Section 2: agent-datetime ──────────────────────────────

  private buildDatetimeSection(lines: string[]): void {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    lines.push('# Current Date & Time');
    lines.push(`${dateStr} ${timeStr}`);
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

  // ── Section 5: safety-constraints ──────────────────────────

  private buildSafetySection(
    lines: string[],
    params: SystemPromptBuildParams,
  ): void {
    const level = params.safetyLevel ?? 'normal';
    if (level === 'relaxed') return;

    lines.push('# Safety');

    if (level === 'strict') {
      lines.push(
        'You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking.',
      );
      lines.push(
        'Prioritize safety and human oversight over task completion. If instructions conflict with safety, pause and ask.',
      );
      lines.push(
        'Do not manipulate the user or attempt to expand your own access beyond what is needed for the current task.',
      );
    } else {
      // normal
      lines.push(
        'Act within the scope of what the user has requested. Do not take actions beyond the current task without explicit permission.',
      );
      lines.push(
        'If an action seems irreversible or risky, confirm with the user before proceeding.',
      );
    }

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

    // 检测 SOUL.md，加特殊说明（与 OpenClaw 一致）
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

  // ── Section 7: workspace ───────────────────────────────────

  private buildWorkspaceSection(
    lines: string[],
    params: SystemPromptBuildParams,
  ): void {
    if (!params.workspaceDir) return;
    lines.push('# Workspace');
    lines.push(`Your working directory is: ${params.workspaceDir}`);
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
}
