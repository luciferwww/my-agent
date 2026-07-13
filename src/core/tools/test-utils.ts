import type { ToolContext } from './types.js';

/**
 * Canonical `ToolContext` for tests. Use as the second argument to
 * `tool.execute(input, TEST_TOOL_CONTEXT)` in unit tests.
 *
 * Fields are deliberately fixed strings so tests can also assert on them
 * (e.g. via spies on the executor wrapper).
 */
export const TEST_TOOL_CONTEXT: ToolContext = {
  sessionKey: 'test-session',
  turnId: 'test-turn',
  toolUseId: 'test-tool-use',
};
