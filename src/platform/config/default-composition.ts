import { DEFAULT_TOOL_POLICY_CONFIG } from '../../core/tools/index.js';
import { DEFAULT_AGENT_CONTEXT_CONFIG } from '../../core/agent-context/index.js';
import { DEFAULT_COMPACTION_CONFIG } from '../../core/runner/index.js';
import { DEFAULT_SKILLS } from '../../core/skills/index.js';
import type { AgentDefaults } from './types.js';

export function createDefaultAgentConfig(): AgentDefaults {
  return {
    tools: structuredClone(DEFAULT_TOOL_POLICY_CONFIG),
    context: structuredClone(DEFAULT_AGENT_CONTEXT_CONFIG),
    compaction: structuredClone(DEFAULT_COMPACTION_CONFIG),
    skills: [...DEFAULT_SKILLS],
  };
}
