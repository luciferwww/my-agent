import { DEFAULT_MEMORY_CONFIG } from '../../core/memory/index.js';
import { DEFAULT_PROMPT_CONFIG } from '../../core/prompt/index.js';
import { DEFAULT_TOOL_POLICY_CONFIG } from '../../core/tools/index.js';
import { DEFAULT_AGENT_CONTEXT_CONFIG } from '../../core/agent-context/index.js';
import { DEFAULT_COMPACTION_CONFIG } from '../../core/runner/index.js';
import { DEFAULT_SUBAGENT_CONFIG } from '../../core/subagent/index.js';
import type { AgentDefaults } from './types.js';

export function createDefaultAgentConfig(): AgentDefaults {
  return {
    memory: structuredClone(DEFAULT_MEMORY_CONFIG),
    prompt: structuredClone(DEFAULT_PROMPT_CONFIG),
    tools: structuredClone(DEFAULT_TOOL_POLICY_CONFIG),
    context: structuredClone(DEFAULT_AGENT_CONTEXT_CONFIG),
    compaction: structuredClone(DEFAULT_COMPACTION_CONFIG),
    subagents: structuredClone(DEFAULT_SUBAGENT_CONFIG),
  };
}
