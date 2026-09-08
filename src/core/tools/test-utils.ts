import type { ToolExecutionContext } from './types.js';

/**
 * Canonical `ToolExecutionContext` for tests. Use as the second argument to
 * `tool.execute(input, TEST_TOOL_CONTEXT)` in unit tests.
 *
 * Fields are deliberately fixed strings so tests can also assert on them
 * (e.g. via spies on the executor wrapper).
 */
export const TEST_TOOL_CONTEXT: ToolExecutionContext = {
  sessionKey: 'test-session',
  turnId: 'test-turn',
  callId: 'test-tool-use',
  signal: new AbortController().signal,
};
