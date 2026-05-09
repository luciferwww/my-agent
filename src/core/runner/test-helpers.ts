import { randomUUID } from 'node:crypto';
import type { RunParams } from './types.js';

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
    model: 'test',
    systemPrompt: '',
    turnId: randomUUID(),
    ...overrides,
  };
}
