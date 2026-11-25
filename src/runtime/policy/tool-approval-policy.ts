import type { ToolPolicyConfig } from '../../core/tools/index.js';
import type { ApplicationToolPolicy } from '../../core/tools/types.js';
import { matchesAny } from './glob-match.js';

export function createApplicationToolPolicy(
  tools: ToolPolicyConfig,
): ApplicationToolPolicy {
  const allow = Object.freeze([...(tools.allow ?? [])]);
  const deny = Object.freeze([...(tools.deny ?? [])]);

  return Object.freeze({
    isDenied(toolName: string): boolean {
      return matchesAny(toolName, deny);
    },
    decide(
      toolName: string,
      _input: Readonly<Record<string, unknown>>,
      hasApprovalCapability: boolean,
      permissionMode = 'manual',
    ) {
      if (matchesAny(toolName, deny)) return 'deny' as const;
      if (permissionMode === 'allow_all') return 'allow' as const;
      if (toolName === 'exec') {
        return hasApprovalCapability ? 'requires_approval' as const : 'deny' as const;
      }
      if (matchesAny(toolName, allow)) return 'allow' as const;
      return hasApprovalCapability ? 'requires_approval' as const : 'deny' as const;
    },
  });
}
