import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineMock = vi.hoisted(() => vi.fn());

vi.mock('@xenova/transformers', () => ({
  pipeline: pipelineMock,
}));

import { LocalEmbeddingProvider, createEmbeddingProvider } from './LocalEmbeddingProvider.js';

describe('LocalEmbeddingProvider', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it('returns no embeddings for an empty input without loading the pipeline', async () => {
    const provider = new LocalEmbeddingProvider('mock-model', 384);

    await expect(provider.embed([])).resolves.toEqual([]);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('lazily creates the pipeline and returns full vectors (no truncation)', async () => {
    const pipeFn = vi.fn()
      .mockResolvedValueOnce({ data: Float32Array.from([0.1, 0.2, 0.3, 0.4]) })
      .mockResolvedValueOnce({ data: Float32Array.from([0.5, 0.6, 0.7, 0.8]) });
    pipelineMock.mockResolvedValue(pipeFn);

    // dimensions 参数仅作记录；embed 不再 slice。设为 4 以匹配真实输出长度
    const provider = new LocalEmbeddingProvider('mock-model', 4);
    const embeddings = await provider.embed(['alpha', 'beta']);

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'mock-model');
    expect(pipeFn).toHaveBeenNthCalledWith(1, 'alpha', { pooling: 'mean', normalize: true });
    expect(pipeFn).toHaveBeenNthCalledWith(2, 'beta', { pooling: 'mean', normalize: true });
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(4);
    expect(embeddings[1]).toHaveLength(4);
    expect(embeddings[0]?.[3]).toBeCloseTo(0.4);
    expect(embeddings[1]?.[3]).toBeCloseTo(0.8);
  });

  it('reuses the same pipeline promise across concurrent embed calls', async () => {
    const pipeFn = vi.fn(async (text: string) => ({
      data: text === 'first'
        ? Float32Array.from([1, 2, 3])
        : Float32Array.from([4, 5, 6]),
    }));

    let resolvePipeline: ((value: typeof pipeFn) => void) | undefined;
    // dimensions 必填但 embed 不再截断；用实际向量长度 3
    const provider = new LocalEmbeddingProvider('shared-model', 3);
    const initPipelineSpy = vi.spyOn(
      provider as unknown as { initPipeline: () => Promise<typeof pipeFn> },
      'initPipeline',
    ).mockImplementation(
      () => new Promise((resolve) => {
        resolvePipeline = resolve;
      }),
    );

    const firstCall = provider.embed(['first']);
    const secondCall = provider.embed(['second']);

    expect(initPipelineSpy).toHaveBeenCalledTimes(1);
    expect(resolvePipeline).toBeTypeOf('function');
    resolvePipeline!(pipeFn);

    await expect(firstCall).resolves.toEqual([[1, 2, 3]]);
    await expect(secondCall).resolves.toEqual([[4, 5, 6]]);
    expect(pipeFn).toHaveBeenCalledTimes(2);
  });
});

describe('createEmbeddingProvider', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it('creates a local provider by default with KNOWN dimensions sync (no pipeline load)', async () => {
    const provider = await createEmbeddingProvider();

    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider?.modelId).toBe('Xenova/all-MiniLM-L6-v2');
    expect(provider?.dimensions).toBe(384);
    // 默认模型命中 KNOWN_DIMENSIONS 表，创建阶段不加载 pipeline
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('uses KNOWN_DIMENSIONS for a known non-default model (e.g. bge-base, 768)', async () => {
    const provider = await createEmbeddingProvider({
      provider: 'local',
      model: 'Xenova/bge-base-en-v1.5',
    });

    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider?.modelId).toBe('Xenova/bge-base-en-v1.5');
    expect(provider?.dimensions).toBe(768);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('detects dimensions for unknown model by running one probe inference', async () => {
    // 未知 model → 加载 pipeline 跑一次推理看输出长度
    const probePipe = vi.fn().mockResolvedValue({
      data: Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // 12 维
    });
    pipelineMock.mockResolvedValue(probePipe);

    const provider = await createEmbeddingProvider({
      provider: 'local',
      model: 'unknown-model',
    });

    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider?.modelId).toBe('unknown-model');
    expect(provider?.dimensions).toBe(12);
    expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'unknown-model');
    expect(probePipe).toHaveBeenCalledWith('', { pooling: 'mean', normalize: true });
  });

  it('returns null when detection fails for an unknown model', async () => {
    pipelineMock.mockRejectedValue(new Error('model not found'));

    const provider = await createEmbeddingProvider({
      provider: 'local',
      model: 'broken-model',
    });

    expect(provider).toBeNull();
  });

  it('returns null for unsupported provider types', async () => {
    await expect(createEmbeddingProvider({ provider: 'openai' })).resolves.toBeNull();
  });
});
