import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../../platform/logger/index.js';

const { pipelineMock, envMock } = vi.hoisted(() => ({
  pipelineMock: vi.fn(),
  envMock: { remoteHost: 'https://huggingface.co/' },
}));

vi.mock('@xenova/transformers', () => ({
  pipeline: pipelineMock,
  env: envMock,
}));

import { LocalEmbeddingProvider, createEmbeddingProvider } from './LocalEmbeddingProvider.js';

beforeEach(() => {
  vi.stubEnv('HF_ENDPOINT', undefined);
  envMock.remoteHost = 'https://huggingface.co/';
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

    // Record actual dimensions without truncating output vectors.
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

  it('uses the configured mirror before lazy loading without changing the model', async () => {
    vi.stubEnv('HF_ENDPOINT', 'https://mirror.example/models///');
    pipelineMock.mockImplementation(async () => {
      expect(envMock.remoteHost).toBe('https://mirror.example/models/');
      return async () => ({ data: Float32Array.from([1, 2]) });
    });
    await expect(new LocalEmbeddingProvider('mock-model', 2).embed(['text'])).resolves.toEqual([[1, 2]]);
  });

  it.each(['', 'file:///models', 'https://user:password@mirror.example', 'https://mirror.example/?token=x'])(
    'reports invalid HF_ENDPOINT without falling back to the default host: %s',
    async endpoint => {
      vi.stubEnv('HF_ENDPOINT', endpoint);
      const errorLog = vi.spyOn(Logger.get('LocalEmbeddingProvider'), 'error');
      await expect(new LocalEmbeddingProvider('mock-model', 2).embed(['text'])).rejects.toThrow('Invalid HF_ENDPOINT');
      expect(pipelineMock).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith('Embedding model loading failed.', expect.objectContaining({
        error: expect.stringContaining('HF_ENDPOINT'),
      }));
    },
  );

  it('reports the network cause and remedy while preserving the original failure', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' });
    const error = new TypeError('fetch failed', { cause });
    pipelineMock.mockRejectedValue(error);
    const errorLog = vi.spyOn(Logger.get('LocalEmbeddingProvider'), 'error');
    await expect(new LocalEmbeddingProvider('mock-model', 2).embed(['text'])).rejects.toBe(error);
    expect(errorLog).toHaveBeenCalledWith(
      'Embedding model loading failed: network request failed.',
      expect.objectContaining({
        model: 'mock-model', endpoint: 'https://huggingface.co/', error: 'fetch failed',
        cause: cause.message, code: 'ECONNREFUSED', hint: expect.stringContaining('HF_ENDPOINT'),
      }),
    );
    expect(errorLog.mock.calls[0]?.[1]).not.toHaveProperty('url');
  });

  it('reports an actual HTTP file URL but does not mislabel local failures', async () => {
    const url = 'https://mirror.example/model/resolve/main/config.json';
    const errorLog = vi.spyOn(Logger.get('LocalEmbeddingProvider'), 'error');
    pipelineMock.mockRejectedValueOnce(new Error(`Forbidden access to file: "${url}".`));
    await expect(new LocalEmbeddingProvider('mock-model', 2).embed(['text'])).rejects.toThrow('Forbidden');
    expect(errorLog).toHaveBeenLastCalledWith('Embedding model file request failed.', expect.objectContaining({ url }));
    pipelineMock.mockRejectedValueOnce(new Error('Invalid ONNX model'));
    await expect(new LocalEmbeddingProvider('mock-model', 2).embed(['text'])).rejects.toThrow('Invalid ONNX');
    expect(errorLog).toHaveBeenLastCalledWith('Embedding model loading failed.', expect.not.objectContaining({ url }));
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
    vi.stubEnv('HF_ENDPOINT', 'https://mirror.example');
    const probePipe = vi.fn().mockResolvedValue({
      data: Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    });
    pipelineMock.mockResolvedValue(probePipe);

    const provider = await createEmbeddingProvider({
      provider: 'local',
      model: 'unknown-model',
    });

    expect(provider).toBeInstanceOf(LocalEmbeddingProvider);
    expect(provider?.modelId).toBe('unknown-model');
    expect(provider?.dimensions).toBe(12);
    expect(envMock.remoteHost).toBe('https://mirror.example/');
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
