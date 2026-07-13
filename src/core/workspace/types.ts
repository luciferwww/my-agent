/** 注入到 project-context Section 的文件 */
export interface ContextFile {
  /** 文件名，如 'SOUL.md'，用作 Section 标题 */
  path: string;
  /** 文件内容 */
  content: string;
}
