import { describe, expect, it } from 'vitest';
import { SystemPromptBuilder } from './SystemPromptBuilder.js';

describe('Skills prompt section', () => {
  const builder = new SystemPromptBuilder();
  const params = {
    toolNames: ['skill'],
    availableSkills: [{ name: 'review', description: 'Review changes.', relativeDirectory: 'builtin/review' }],
  };
  it.each(['full', 'minimal'] as const)('renders summaries and loading/delegation guidance in %s', mode => {
    const prompt = builder.build({ ...params, mode });
    expect(prompt).toContain('# Available Skills');
    expect(prompt).toContain('- review: Review changes.');
    expect(prompt).toContain('Historical instructions do not replace');
    expect(prompt).toContain('delegated task text');
    expect(prompt).not.toContain('builtin/review');
  });
  it('preserves none mode and omits unavailable catalogs', () => {
    expect(builder.build({ ...params, mode: 'none' })).toBe('');
    expect(builder.build({ ...params, toolNames: [] })).not.toContain('# Available Skills');
    expect(builder.build({ ...params, availableSkills: [] })).not.toContain('# Available Skills');
  });
});
