import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { ToolsConfig } from '../platform/config/types.js';
import type { ApplicationToolPolicy } from '../core/tools/types.js';
import { matchesAny } from './glob-match.js';

const DIRECT_PATH_TOOLS = new Set([
  'list_dir',
  'read_file',
  'write_file',
  'edit_file',
  'file_search',
  'grep_search',
]);

export function createApplicationToolPolicy(
  tools: ToolsConfig,
  agentHome: string,
): ApplicationToolPolicy {
  const allow = Object.freeze([...(tools.allow ?? [])]);
  const deny = Object.freeze([...(tools.deny ?? [])]);
  const normalizedAgentHome = resolve(agentHome);

  return Object.freeze({
    isDenied(toolName: string): boolean {
      return matchesAny(toolName, deny);
    },
    decide(
      toolName: string,
      input: Readonly<Record<string, unknown>>,
      hasApprovalCapability: boolean,
      permissionMode = 'manual',
    ) {
      if (matchesAny(toolName, deny)) return 'deny' as const;
      if (permissionMode === 'allow_all') return 'allow' as const;
      if (toolName === 'exec') {
        return hasApprovalCapability ? 'requires_approval' as const : 'deny' as const;
      }
      if (touchesExternalPath(toolName, input, normalizedAgentHome)) {
        return hasApprovalCapability ? 'requires_approval' as const : 'deny' as const;
      }
      if (matchesAny(toolName, allow)) return 'allow' as const;
      return hasApprovalCapability ? 'requires_approval' as const : 'deny' as const;
    },
  });
}

function touchesExternalPath(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  agentHome: string,
): boolean {
  const paths = declaredStructuredPaths(toolName, input);
  if (paths === undefined) return false;
  return paths.some((path) => isExternalPath(agentHome, path));
}

function declaredStructuredPaths(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  if (DIRECT_PATH_TOOLS.has(toolName)) {
    return typeof input.path === 'string' && input.path.trim() ? [input.path] : [];
  }
  if (toolName !== 'apply_patch') return undefined;
  if (typeof input.input !== 'string') return [];

  const paths: string[] = [];
  for (const line of input.input.split(/\r?\n/)) {
    for (const marker of [
      '*** Add File: ',
      '*** Delete File: ',
      '*** Update File: ',
      '*** Move to: ',
    ]) {
      if (line.startsWith(marker)) {
        paths.push(line.slice(marker.length));
        break;
      }
    }
  }
  return paths;
}

function isExternalPath(agentHome: string, inputPath: string): boolean {
  const target = resolve(agentHome, inputPath);
  const rel = relative(agentHome, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
