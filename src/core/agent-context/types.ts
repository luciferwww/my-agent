/** A file injected into the agent-context section. */
export interface ContextFile {
  /** File name, such as 'SOUL.md', used as the section heading. */
  path: string;
  /** File content. */
  content: string;
}