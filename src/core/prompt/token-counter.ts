/**
 * 简单的 token 数量估算。
 * 使用 "字符数 / 3.5" 的经验公式，适用于英文和中文混合文本。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}
