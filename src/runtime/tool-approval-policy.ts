import type { ToolsConfig } from '../platform/config/types.js';
import { matchesAny } from './glob-match.js';

/**
 * 根据工具策略和 channel 能力决定执行动作。
 *
 * 三档（spec §5.1）：
 *   - allow 命中 → 'allow'（直接执行，免审批）
 *   - deny  命中 → 'deny'（理论上 deny 已在注册时被 applyDenyFilter 过滤掉，
 *                          运行时不应到这里；防御性保留分支）
 *   - 都没命中 + 有 channel → 'prompt'
 *   - 都没命中 + 无 channel → 'deny'（fail-closed）
 *
 * deny 优先于 allow（同一工具同时出现在两者中时按 deny 处理）。
 *
 * 条目语法：精确名 或 glob（`*` `?`，见 [glob-match.ts](./glob-match.ts)）。
 * v1 起不再支持 `group:*` 简写——这类字符串会被当作字面名，不展开。
 */
export function resolveToolPolicy(
  toolName: string,
  tools: ToolsConfig,
  hasApprovalCapability: boolean,
): 'allow' | 'deny' | 'prompt' {
  const allow = tools.allow ?? [];
  const deny = tools.deny ?? [];

  if (matchesAny(toolName, deny)) return 'deny';
  if (matchesAny(toolName, allow)) return 'allow';
  return hasApprovalCapability ? 'prompt' : 'deny';
}
