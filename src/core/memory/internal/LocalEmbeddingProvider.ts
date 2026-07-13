import type { EmbeddingProvider } from '../types.js';
import { Logger } from '../../../platform/logger/index.js';

const log = Logger.get('LocalEmbeddingProvider');

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * 常见 Xenova 模型的向量维度静态映射表。
 *
 * 命中此表 → 同步取值；未命中 → 加载 pipeline 后动态探测（首次启动多一次毫秒级推理）。
 * 以后遇到新常用 model 补上即可。
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
 * 本地嵌入提供者，使用 @xenova/transformers 在 Node.js 中运行轻量级模型。
 *
 * 默认模型: Xenova/all-MiniLM-L6-v2（384 维，~90MB）
 * - 维度由 createEmbeddingProvider 工厂确定后传入（命中表或运行时探测）
 * - 首次调用 embed() 时懒加载 pipeline（避免启动延迟；探测路径会提前加载一次）
 * - 模型自动缓存到 ~/.cache/huggingface/
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  // 用 any 避免 @xenova/transformers 的复杂泛型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipelinePromise: Promise<any> | null = null;

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

      // output.data 是 Float32Array → 普通数组。
      // 不再 slice 截断：dimensions 由 model 反查得到，永远等于 output.data.length；
      // 保留截断只会掩盖维度不匹配 bug（spec §7.5）。
      const embedding = Array.from(output.data as Float32Array);
      results.push(embedding);
    }

    return results;
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 懒加载 pipeline。首次调用时初始化，后续复用同一个 Promise。
   * 多个并发调用不会重复初始化。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ensurePipeline(): Promise<any> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = this.initPipeline();
    }
    return this.pipelinePromise;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async initPipeline(): Promise<any> {
    log.info('Loading embedding model', { modelId: this.modelId });
    // 动态 import，避免未安装 @xenova/transformers 时模块加载失败
    const { pipeline } = await import('@xenova/transformers');
    const pipe = await pipeline('feature-extraction', this.modelId);
    log.info('Embedding model loaded', { modelId: this.modelId });
    return pipe;
  }
}

/**
 * 动态探测未知模型的向量维度：加载 pipeline → 跑一次空字符串推理 → 取 output.data.length。
 * 失败时抛出错误，由调用方决定如何降级。
 */
async function detectDimensions(modelId: string): Promise<number> {
  const { pipeline } = await import('@xenova/transformers');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pipe: any = await pipeline('feature-extraction', modelId);
  const output = await pipe('', { pooling: 'mean', normalize: true });
  return (output.data as Float32Array).length;
}

/**
 * 尝试创建嵌入提供者。返回 null 表示不可用（系统降级为纯关键词搜索）。
 *
 * 维度反查规则（spec §7.5）：
 *   1. 命中 KNOWN_DIMENSIONS → 直接用（无额外开销）
 *   2. 未命中 → 加载 pipeline 探测一次（毫秒级），同时 info log 提示「未知 model，
 *      探测到 dims=N」方便以后补表
 *
 * 后续扩展点：可在此处检测 OPENAI_API_KEY 等环境变量，创建对应的远程 provider。
 */
export async function createEmbeddingProvider(
  config?: { provider?: string; model?: string },
): Promise<EmbeddingProvider | null> {
  const providerType = config?.provider ?? 'local';
  if (providerType !== 'local') return null;

  const model = config?.model ?? DEFAULT_MODEL;

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
