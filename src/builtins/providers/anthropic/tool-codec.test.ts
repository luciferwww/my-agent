import { describe, expect, it } from 'vitest';
import {
  PORTABLE_TOOL_DEFINITION,
  PORTABLE_TOOL_DEFINITION_ANTHROPIC_WIRE,
} from '../../../core/tools/provider-portability-fixtures.js';
import { encodeAnthropicToolDefinition } from './tool-codec.js';

describe('Anthropic production Tool codec', () => {
  it('matches the canonical Anthropic Tool definition fixture', () => {
    expect(encodeAnthropicToolDefinition(PORTABLE_TOOL_DEFINITION))
      .toEqual(PORTABLE_TOOL_DEFINITION_ANTHROPIC_WIRE);
  });

  it('does not mutate the canonical input schema', () => {
    const before = structuredClone(PORTABLE_TOOL_DEFINITION.inputSchema);
    encodeAnthropicToolDefinition(PORTABLE_TOOL_DEFINITION);
    expect(PORTABLE_TOOL_DEFINITION.inputSchema).toEqual(before);
  });
});