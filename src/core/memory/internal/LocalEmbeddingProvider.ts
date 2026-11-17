import type { EmbeddingProvider } from '../types.js';
import { DEFAULT_MEMORY_CONFIG } from '../config.js';
import { Logger } from '../../../platform/logger/index.js';
import type { FeatureExtractionPipeline } from '@xenova/transformers';

const log = Logger.get('LocalEmbeddingProvider');

/**
 * Known model dimensions avoid loading a pipeline just to probe its output.
 */
const KNOWN_DIMENSIONS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2':       384,
  'Xenova/all-mpnet-base-v2':      768,
  'Xenova/bge-base-en-v1.5':       768,
  'Xenova/multilingual-e5-small':  384,
  'Xenova/multilingual-e5-base':   768,
  'Xenova/multilingual-e5-large':  1024,
};

/**
 * Local embeddings with lazy pipeline loading and the library's existing cache.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(modelId: string, dimensions: number) {
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const pipe = await this.ensurePipeline();
    const results: number[][] = [];

    for (const text of texts) {
      const output = await pipe(text, {
        pooling: 'mean',
        normalize: true,
      });

      const embedding = Array.from(output.data as Float32Array);
      results.push(embedding);
    }

    return results;
  }

  private ensurePipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = this.initPipeline();
    }
    return this.pipelinePromise;
  }

  private initPipeline(): Promise<FeatureExtractionPipeline> {
    return loadEmbeddingPipeline(this.modelId);
  }
}

async function loadEmbeddingPipeline(model: string): Promise<FeatureExtractionPipeline> {
  let endpoint: string | undefined;
  try {
    const { pipeline, env } = await import('@xenova/transformers');
    const configuredEndpoint = process.env['HF_ENDPOINT'];
    if (configuredEndpoint !== undefined) {
      let url: URL;
      try {
        url = new URL(configuredEndpoint);
      } catch {
        throw new Error('Invalid HF_ENDPOINT: expected a nonblank HTTP(S) base URL.');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid HF_ENDPOINT: use an HTTP(S) base URL without credentials, query or fragment.');
      }
      env.remoteHost = `${url.href.replace(/\/+$/u, '')}/`;
    }
    endpoint = env.remoteHost;
    log.info('Loading local embedding model; missing files may be downloaded.', { model, endpoint });
    const pipe = await pipeline('feature-extraction', model);
    log.info('Local embedding model loaded.', { model });
    return pipe;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;
    const code = errorCode(cause) ?? errorCode(error);
    const network = code !== undefined && /^(?:ECONN|ENOTFOUND|EAI_|ETIMEDOUT|UND_ERR_)/u.test(code);
    const fileFailure = /^(?:.+ error occurred while trying to load file|Unauthorized access to file|Forbidden access to file|Could not locate file|Error \(\d+\) occurred while trying to load file): "(https?:\/\/[^"]+)"\.$/u.exec(message);
    log.error(network ? 'Embedding model loading failed: network request failed.'
      : fileFailure ? 'Embedding model file request failed.' : 'Embedding model loading failed.', {
      model, endpoint, error: message,
      ...(cause instanceof Error ? { cause: cause.message } : {}),
      ...(code === undefined ? {} : { code }),
      ...(fileFailure ? { url: fileFailure[1] } : {}),
      hint: network
        ? 'Check network access. If the source is unreachable, set HF_ENDPOINT to a trusted Hugging Face-compatible mirror and restart.'
        : fileFailure ? 'Check repository access and download endpoint configuration.'
          : 'Check the reported model-loading error and local embedding configuration.',
    });
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

async function detectDimensions(modelId: string): Promise<number> {
  const pipe = await loadEmbeddingPipeline(modelId);
  const output = await pipe('', { pooling: 'mean', normalize: true });
  return (output.data as Float32Array).length;
}

/**
 * Return null when unavailable so callers retain keyword-only fallback.
 */
export async function createEmbeddingProvider(
  config?: { provider?: string; model?: string },
): Promise<EmbeddingProvider | null> {
  const providerType = config?.provider ?? 'local';
  if (providerType !== 'local') return null;

  const model = config?.model ?? DEFAULT_MEMORY_CONFIG.embedding.model;

  let dimensions = KNOWN_DIMENSIONS[model];
  if (dimensions === undefined) {
    try {
      dimensions = await detectDimensions(model);
      log.info('Detected embedding dimensions for unknown model', { model, dimensions });
    } catch (err) {
      log.warn('Failed to detect embedding dimensions, falling back to keyword-only search', {
        model,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  try {
    return new LocalEmbeddingProvider(model, dimensions);
  } catch (err) {
    log.warn('Failed to create local embedding provider, falling back to keyword-only search', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
