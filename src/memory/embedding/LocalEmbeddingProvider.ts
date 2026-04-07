import type { EmbeddingProvider } from '../types.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;

/**
 * 本地嵌入提供者，使用 @xenova/transformers 在 Node.js 中运行轻量级模型。
 *
 * 默认模型: Xenova/all-MiniLM-L6-v2（384 维，~90MB）
 * - 首次调用 embed() 时懒加载 pipeline（避免启动延迟）
 * - 模型自动缓存到 ~/.cache/huggingface/
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  // 用 any 避免 @xenova/transformers 的复杂泛型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipelinePromise: Promise<any> | null = null;

  constructor(modelId: string = DEFAULT_MODEL, dimensions: number = DEFAULT_DIMENSIONS) {
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

      // output.data 是 Float32Array，转为普通数组并截取到目标维度
      const embedding = Array.from(output.data as Float32Array).slice(0, this.dimensions);
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
    // 动态 import，避免未安装 @xenova/transformers 时模块加载失败
    const { pipeline } = await import('@xenova/transformers');
    return pipeline('feature-extraction', this.modelId);
  }
}

/**
 * 尝试创建嵌入提供者。返回 null 表示不可用（系统降级为纯关键词搜索）。
 *
 * 后续扩展点：可在此处检测 OPENAI_API_KEY 等环境变量，创建对应的远程 provider。
 */
export async function createEmbeddingProvider(
  config?: { provider?: string; model?: string },
): Promise<EmbeddingProvider | null> {
  const providerType = config?.provider ?? 'local';

  if (providerType === 'local') {
    try {
      const model = config?.model ?? DEFAULT_MODEL;
      return new LocalEmbeddingProvider(model);
    } catch {
      return null;
    }
  }

  // 后续实现其他 provider
  return null;
}
