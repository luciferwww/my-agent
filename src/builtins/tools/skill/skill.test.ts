import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '../../../core/tools/types.js';
import { bindToolTurnAuthority } from '../../../core/tools/execution.js';
import { createSkillTool, createSkillToolContribution } from './index.js';

describe('skill Tool', () => {
  let home: string;
  let controller: AbortController;
  let context: ToolExecutionContext;
  let source: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'skill-tool-'));
    controller = new AbortController();
    context = {
      sessionId: 'session', turnId: 'turn', subagentDepth: 0, callId: 'call',
      executionId: 'execution', reportActivity: vi.fn(), signal: controller.signal,
    };
    source = '---\nname: review\ndescription: Review changes\ncompatibility: Python 3.11\n---\nDo the review.\n';
    await mkdir(join(home, 'skills', 'review'), { recursive: true });
    await writeFile(join(home, 'skills', 'review', 'SKILL.md'), source);
  });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  function tool(skills = ['review']) {
    return createSkillTool({
      agentHome: home,
      getTurn: id => id === 'turn' ? { sessionId: 'session', signal: controller.signal, skills } : undefined,
    });
  }
  it('loads current complete source using the bound Turn authority, not the per-execution signal', async () => {
    const executionContext = bindToolTurnAuthority({ ...context, signal: new AbortController().signal }, controller.signal);
    const result = await tool().execute({ name: 'review' }, executionContext);
    expect(result.outcome).toBe('success');
    expect(result.content).toContain(source);
    expect(result.content).toContain(join(home, 'skills', 'review'));
    await writeFile(join(home, 'skills', 'review', 'SKILL.md'), source + '\nChanged.');
    expect((await tool().execute({ name: 'review' }, executionContext)).content).toContain('Changed.');
  });
  it('rejects unselected names without auto-enabling', async () => {
    expect(await tool([]).execute({ name: 'review' }, context)).toMatchObject({
      outcome: 'failed', content: expect.stringContaining('not enabled'),
    });
  });
  it.each(['sessionId', 'turnId'])('rejects mismatched %s', async field => {
    expect((await tool().execute({ name: 'review' }, { ...context, [field]: 'wrong' })).outcome).toBe('failed');
  });
  it('rejects missing authority, aborted Turns and late conflicting packages', async () => {
    expect((await tool().execute({ name: 'review' }, { ...context, signal: new AbortController().signal })).outcome).toBe('failed');
    await mkdir(join(home, 'skills', 'group', 'review'), { recursive: true });
    await writeFile(join(home, 'skills', 'group', 'review', 'SKILL.md'), source);
    expect((await tool().execute({ name: 'review' }, context)).content).toContain('conflicting');
    controller.abort();
    expect((await tool().execute({ name: 'review' }, context)).outcome).toBe('failed');
  });
  it('registers a single builtin tool with a name-only closed schema', () => {
    const contribution = createSkillToolContribution({ agentHome: home, getTurn: () => undefined });
    expect(contribution.source).toBe('builtin');
    expect(tool().inputSchema).toMatchObject({ required: ['name'], additionalProperties: false });
  });
});
