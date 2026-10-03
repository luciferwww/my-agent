import type { CanonicalToolResult, ToolDefinition } from './index.js';

export const PORTABLE_TOOL_DEFINITION: ToolDefinition = Object.freeze({
  name: 'search',
  description: 'Search documents',
  inputSchema: Object.freeze({
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
    additionalProperties: false,
  }),
});

export const PORTABLE_TOOL_DEFINITION_ANTHROPIC_WIRE = Object.freeze({
  name: 'search',
  description: 'Search documents',
  input_schema: PORTABLE_TOOL_DEFINITION.inputSchema,
});

export const PORTABLE_TOOL_DEFINITION_OPENAI_WIRE = Object.freeze({
  type: 'function' as const,
  function: Object.freeze({
    name: 'search',
    description: 'Search documents',
    parameters: PORTABLE_TOOL_DEFINITION.inputSchema,
  }),
});

export const PORTABLE_FAILED_TOOL_RESULT: CanonicalToolResult = Object.freeze({
  callId: 'call-1',
  outcome: 'failed',
  content: 'search unavailable',
});

export const PORTABLE_FAILED_TOOL_RESULT_ANTHROPIC_WIRE = Object.freeze({
  type: 'tool_result' as const,
  tool_use_id: 'call-1',
  content: 'search unavailable',
  is_error: true as const,
});

export const PORTABLE_FAILED_TOOL_RESULT_OPENAI_WIRE = Object.freeze({
  role: 'tool' as const,
  tool_call_id: 'call-1',
  content: 'search unavailable',
});