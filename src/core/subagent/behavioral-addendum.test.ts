import { describe, it, expect } from 'vitest';
import { buildSubagentBehavioralAddendum } from './behavioral-addendum.js';

describe('buildSubagentBehavioralAddendum', () => {
  it('includes the task description verbatim', () => {
    const out = buildSubagentBehavioralAddendum({
      taskDescription: 'audit the payment module',
      depth: 1,
      canSpawn: false,
    });
    expect(out).toContain('Task: audit the payment module');
  });

  it('includes the depth value', () => {
    const out = buildSubagentBehavioralAddendum({
      taskDescription: 'x',
      depth: 2,
      canSpawn: false,
    });
    expect(out).toContain('Depth: 2');
  });

  it('starts with the # Subagent Instructions header', () => {
    const out = buildSubagentBehavioralAddendum({
      taskDescription: 'x',
      depth: 1,
      canSpawn: false,
    });
    expect(out.startsWith('# Subagent Instructions\n')).toBe(true);
  });

  it('omits the "cannot spawn subagents" guideline when canSpawn=true', () => {
    const out = buildSubagentBehavioralAddendum({
      taskDescription: 'x',
      depth: 1,
      canSpawn: true,
    });
    expect(out).not.toContain('cannot spawn');
    expect(out).not.toContain('task tool is not available');
  });

  it('includes the "cannot spawn subagents" guideline when canSpawn=false', () => {
    const out = buildSubagentBehavioralAddendum({
      taskDescription: 'x',
      depth: 1,
      canSpawn: false,
    });
    expect(out).toContain('cannot spawn subagents (task tool is not available)');
  });

  it('does NOT echo sessionKey or prompt-like content', () => {
    const out = buildSubagentBehavioralAddendum({
      taskDescription: 'do thing',
      depth: 1,
      canSpawn: false,
    });
    expect(out.toLowerCase()).not.toContain('sessionkey');
    expect(out).not.toContain('Prompt:');
  });

  it('always ends with a trailing blank line', () => {
    const out = buildSubagentBehavioralAddendum({
      taskDescription: 'x',
      depth: 1,
      canSpawn: true,
    });
    expect(out.endsWith('\n')).toBe(true);
  });
});
