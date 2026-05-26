import type { ToolApprovalConfig } from '../platform/config/types.js';

const TOOL_GROUPS: Record<string, string[]> = {
  'group:fs': ['read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir'],
  'group:exec': ['exec', 'process'],
  'group:search': ['grep_search', 'file_search'],
  'group:web': ['web_fetch'],
  'group:memory': ['memory_search', 'memory_get', 'memory_write'],
};

function globMatch(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(name);
}

function matchesPatterns(toolName: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const group = TOOL_GROUPS[pattern];
    if (group) {
      if (group.includes(toolName)) return true;
    } else {
      if (globMatch(toolName, pattern)) return true;
    }
  }
  return false;
}

/**
 * 根据审批配置和 channel 能力决定工具执行策略。
 *
 * - 有 approval/interaction channel 时：deny → allow → prompt
 * - 无 channel 时（fail-closed）：仅 allow 命中的工具可执行
 */
export function resolveToolApprovalAction(
  toolName: string,
  config: ToolApprovalConfig,
  hasApprovalCapability: boolean,
): 'allow' | 'deny' | 'prompt' {
  if (!hasApprovalCapability) {
    return matchesPatterns(toolName, config.allow) ? 'allow' : 'deny';
  }

  if (matchesPatterns(toolName, config.deny)) return 'deny';
  if (matchesPatterns(toolName, config.allow)) return 'allow';
  return 'prompt';
}
