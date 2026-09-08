import type { ToolsConfig } from '../platform/config/types.js';
import type { ApplicationToolPolicy } from '../core/tools/types.js';
import { matchesAny } from './glob-match.js';

export function createApplicationToolPolicy(tools: ToolsConfig): ApplicationToolPolicy {
  const allow = Object.freeze([...(tools.allow ?? [])]);
  const deny = Object.freeze([...(tools.deny ?? [])]);

  return Object.freeze({
    isDenied(toolName: string): boolean {
      return matchesAny(toolName, deny);
    },
    decide(toolName: string, hasApprovalCapability: boolean) {
      if (matchesAny(toolName, deny)) return 'deny' as const;
      if (matchesAny(toolName, allow)) return 'allow' as const;
      return hasApprovalCapability ? 'requires_approval' as const : 'deny' as const;
    },
  });
}
