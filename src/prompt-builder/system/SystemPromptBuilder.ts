import type {
  SystemPromptBuildParams,
  ToolDefinition,
  ContextFile,
} from '../types/index.js';

/**
 * 构建 System Prompt。
 *
 * 包含 7 个硬编码 Section，顺序固定：
 *  1. agent-identity       — 固定身份声明
 *  2. agent-datetime       — 当前日期时间
 *  3. tool-definitions     — 可用工具列表
 *  4. behavior-rules       — 行为准则 + 工具使用规范
 *  5. safety-constraints   — 安全约束                   [safetyLevel 控制]
 *  6. memory-instructions  — memory tool 使用说明       [full only, 有 memory 工具时]
 *  7. project-context      — contextFiles 注入          [有 contextFiles 时]
 *
 * 参考 OpenClaw 的 buildAgentSystemPrompt()（src/agents/system-prompt.ts）。
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

    this.buildIdentitySection(lines);
    this.buildDatetimeSection(lines);
    this.buildToolDefinitionsSection(lines, params);
    this.buildBehaviorRulesSection(lines);
    this.buildSafetySection(lines, params);
    if (!isMinimal) this.buildMemorySection(lines, params);
    this.buildProjectContextSection(lines, params);

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

  // ── Section 3: tool-definitions ────────────────────────────

  private buildToolDefinitionsSection(
    lines: string[],
    params: SystemPromptBuildParams,
  ): void {
    const tools = params.tools;
    if (!tools?.length) return;

    lines.push('# Available Tools');
    tools.forEach((t: ToolDefinition) => {
      lines.push(`- **${t.name}**: ${t.description}`);
    });
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
    const tools = params.tools ?? [];
    const hasMemoryTool = tools.some(
      (t: ToolDefinition) =>
        t.name === 'search_memory' ||
        t.name === 'memory_search' ||
        t.name === 'memory_get',
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
}
