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
    const provider = new LocalEmbeddingProvider();

    await expect(provider.embed([])).resolves.toEqual([]);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it('lazily creates the pipeline and truncates vectors to the configured dimensions', async () => {
    const pipeFn = vi.fn()
      .mockResolvedValueOnce({ data: Float32Array.from([0.1, 0.2, 0.3, 0.4]) })
      .mockResolvedValueOnce({ data: Float32Array.from([0.5, 0.6, 0.7, 0.8]) });
    pipelineMock.mockResolvedValue(pipeFn);

    const provider = new LocalEmbeddingProvider('mock-model', 3);
    const embeddings = await provider.embed(['alpha', 'beta']);

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'mock-model');
    expect(pipeFn).toHaveBeenNthCalledWith(1, 'alpha', { pooling: 'mean', normalize: true });
    expect(pipeFn).toHaveBeenNthCalledWith(2, 'beta', { pooling: 'mean', normalize: true });
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(3);
    expect(embeddings[1]).toHaveLength(3);
    expect(embeddings[0]?.[0]).toBeCloseTo(0.1);
    expect(embeddings[0]?.[1]).toBeCloseTo(0.2);
    expect(embeddings[0]?.[2]).toBeCloseTo(0.3);
    expect(embeddings[1]?.[0]).toBeCloseTo(0.5);
    expect(embeddings[1]?.[1]).toBeCloseTo(0.6);
    expect(embeddings[1]?.[2]).toBeCloseTo(0.7);
  });

  it('reuses the same pipeline promise across concurrent embed calls', async () => {
    const pipeFn = vi.fn(async (text: string) => ({
      data: text === 'first'
        ? Float32Array.from([1, 2, 3])
        : Float32Array.from([4, 5, 6]),
    }));

    let resolvePipeline: ((value: typeof pipeFn) => void) | undefined;
    const provider = new LocalEmbeddingProvider('shared-model', 2);
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

    await expect(firstCall).resolves.toEqual([[1, 2]]);
    await expect(secondCall).resolves.toEqual([[4, 5]]);
    expect(pipeFn).toHaveBeenCalledTimes(2);
  });
});

describe('createEmbeddingProvider', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
  });

  it('creates a local provider by default', async () => {
    const provider = await createEmbeddingProvider();

    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider?.modelId).toBe('Xenova/all-MiniLM-L6-v2');
    expect(provider?.dimensions).toBe(384);
  });

  it('creates a local provider with the requested model', async () => {
    const provider = await createEmbeddingProvider({ provider: 'local', model: 'custom-model' });

    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider?.modelId).toBe('custom-model');
  });

  it('returns null for unsupported provider types', async () => {
    await expect(createEmbeddingProvider({ provider: 'openai' })).resolves.toBeNull();
  });
});
