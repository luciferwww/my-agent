import { randomUUID } from 'node:crypto';
import type { ModelInvocationPort } from '../model-invocation/index.js';
import type { HookProjection, ToolProjection } from '../registry/index.js';
import type { ApplicationToolPolicy } from '../tools/index.js';
import type { RunParams } from './types.js';

const unusedInvocationPort: ModelInvocationPort = {
  async *chatStream() {
    throw new Error('No invocation response configured for this test fixture.');
  },
  async chat() {
    throw new Error('No invocation response configured for this test fixture.');
  },
};

const emptyToolProjection: ToolProjection = Object.freeze({
  definitions: Object.freeze([]),
  resolve: () => undefined,
  visibleDefinitions: () => Object.freeze([]),
});

const emptyHookProjection: HookProjection = Object.freeze({
  beforeToolCall: Object.freeze([]),
  afterToolCall: Object.freeze([]),
  beforeCompaction: Object.freeze([]),
  afterCompaction: Object.freeze([]),
});

const denyAllTools: ApplicationToolPolicy = Object.freeze({
  isDenied: () => true,
  decide: () => 'deny' as const,
});

/**
 * 构造 RunParams 的测试 helper。
 *
 * 提供合理的默认值，避免每个测试都要写 sessionKey/model/systemPrompt/turnId 全套字段。
 * turnId 自动生成 UUID（每次调用唯一），需要稳定值时通过 overrides 覆盖。
 */
export function makeRunParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    sessionKey: 'main',
    message: '',
    resolvedModel: {
      identity: { providerId: 'test', modelId: 'test' },
      referenceSource: 'native',
      protocol: 'test',
      endpointId: 'test',
      invocationPort: unusedInvocationPort,
      facts: {
        effectiveContextLimit: { value: 200_000, source: 'deployment-config' },
        maximumOutputTokens: { value: 4096, source: 'deployment-config' },
      },
      limits: { maxTokens: 4096, maxTokensSource: 'policy-default' },
    },
    systemPrompt: '',
    turnId: randomUUID(),
    toolProjection: emptyToolProjection,
    hookProjection: emptyHookProjection,
    toolPolicy: denyAllTools,
    ...overrides,
  };
}
