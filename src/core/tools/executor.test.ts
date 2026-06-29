import { describe, it, expect, vi } from 'vitest';
import { createToolExecutor, getToolDefinitions } from './executor.js';
import { TEST_TOOL_CONTEXT } from './test-utils.js';
import type { Tool, ToolContext } from './types.js';

// Test fixtures

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo back the input',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
  execute: async (params) => ({
    content: `Echo: ${params.message}`,
  }),
};

const failingTool: Tool = {
  name: 'failing',
  description: 'Always fails',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => {
    throw new Error('Something went wrong');
  },
};

const addTool: Tool = {
  name: 'add',
  description: 'Add two numbers',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
    },
    required: ['a', 'b'],
  },
  execute: async (params) => ({
    content: String(Number(params.a) + Number(params.b)),
  }),
};

const optionalParamTool: Tool = {
  name: 'greet',
  description: 'Greet someone',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Person name' },
      formal: { type: 'boolean', description: 'Use formal greeting' },
    },
    required: ['name'],
  },
  execute: async (params) => {
    const name = params.name as string;
    const formal = params.formal as boolean | undefined;
    return {
      content: formal ? `Good day, ${name}.` : `Hi ${name}!`,
    };
  },
};

// createToolExecutor

describe('createToolExecutor', () => {
  it('executes a registered tool', async () => {
    const executor = createToolExecutor([echoTool]);
    const result = await executor('echo', { message: 'hello' }, TEST_TOOL_CONTEXT);
    expect(result.content).toBe('Echo: hello');
    expect(result.isError).toBeUndefined();
  });

  it('returns error for unknown tool', async () => {
    const executor = createToolExecutor([echoTool]);
    const result = await executor('nonexistent', {}, TEST_TOOL_CONTEXT);
    expect(result.content).toContain('not found');
    expect(result.isError).toBe(true);
  });

  it('catches execute exception and returns error', async () => {
    const executor = createToolExecutor([failingTool]);
    const result = await executor('failing', {}, TEST_TOOL_CONTEXT);
    expect(result.content).toContain('Something went wrong');
    expect(result.isError).toBe(true);
  });

  it('finds correct tool among multiple', async () => {
    const executor = createToolExecutor([echoTool, addTool, optionalParamTool]);
    const result = await executor('add', { a: 3, b: 4 }, TEST_TOOL_CONTEXT);
    expect(result.content).toBe('7');
  });

  it('handles tool with multiple required params', async () => {
    const executor = createToolExecutor([addTool]);
    const result = await executor('add', { a: 10, b: 20 }, TEST_TOOL_CONTEXT);
    expect(result.content).toBe('30');
  });

  it('handles tool with optional params (provided)', async () => {
    const executor = createToolExecutor([optionalParamTool]);
    const result = await executor('greet', { name: 'Alice', formal: true }, TEST_TOOL_CONTEXT);
    expect(result.content).toBe('Good day, Alice.');
  });

  it('handles tool with optional params (omitted)', async () => {
    const executor = createToolExecutor([optionalParamTool]);
    const result = await executor('greet', { name: 'Bob' }, TEST_TOOL_CONTEXT);
    expect(result.content).toBe('Hi Bob!');
  });

  it('handles empty tools array', async () => {
    const executor = createToolExecutor([]);
    const result = await executor('anything', {}, TEST_TOOL_CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('forwards ToolContext to tool.execute', async () => {
    const spy = vi.fn(async (_params: Record<string, unknown>, _ctx: ToolContext) => ({
      content: 'ok',
    }));
    const spyTool: Tool = {
      name: 'spy',
      description: 'records ctx',
      inputSchema: { type: 'object', properties: {} },
      execute: spy,
    };
    const executor = createToolExecutor([spyTool]);
    const ctx: ToolContext = {
      sessionKey: 'sess-xyz',
      turnId: 'turn-7',
      toolUseId: 'tu-42',
    };
    await executor('spy', { foo: 'bar' }, ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ foo: 'bar' }, ctx);
  });
});

// getToolDefinitions

describe('getToolDefinitions', () => {
  it('converts tools to LLM definitions', () => {
    const defs = getToolDefinitions([echoTool, addTool]);
    expect(defs).toHaveLength(2);
    expect(defs[0]!.name).toBe('echo');
    expect(defs[0]!.description).toBe('Echo back the input');
    expect(defs[0]!.input_schema).toEqual(echoTool.inputSchema);
    expect(defs[1]!.name).toBe('add');
  });

  it('returns empty array for empty tools', () => {
    const defs = getToolDefinitions([]);
    expect(defs).toEqual([]);
  });

  it('does not include execute function', () => {
    const defs = getToolDefinitions([echoTool]);
    expect((defs[0] as any).execute).toBeUndefined();
  });
});
