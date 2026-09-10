import type { ToolDefinition } from '../../../core/tools/index.js';

export interface AnthropicToolDefinitionWire {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

export function encodeAnthropicToolDefinition(
  definition: ToolDefinition,
): AnthropicToolDefinitionWire {
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    input_schema: definition.inputSchema,
  });
}