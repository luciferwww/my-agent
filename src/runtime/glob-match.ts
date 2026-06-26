/**
 * glob 匹配：`*` 匹配任意字符序列，`?` 匹配单字符。大小写敏感。
 *
 * 给工具策略字段 `tools.allow / deny` 使用（精确名 + glob 两用），
 * 同时用于 `applyDenyFilter` 注册时过滤。详见 spec §5.2 / §6.3。
 */
export function globMatch(name: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`).test(name);
}

/** 任一 pattern 命中即返回 true；patterns 空数组返回 false。 */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globMatch(name, p));
}
