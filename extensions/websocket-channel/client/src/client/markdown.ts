import { Marked } from 'marked';

const renderer = {
  html({ text }: { text: string }): string {
    return escapeHtml(text);
  },
  image({ text }: { text: string }): string {
    return escapeHtml(text);
  },
  link(
    this: { parser: { parseInline(tokens: unknown[]): string } },
    token: {
      href: string;
      title?: string | null;
      tokens: unknown[];
    },
  ): string {
    const text = this.parser.parseInline(token.tokens);
    if (!isSafeLink(token.href)) return text;
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    return `<a href="${escapeHtml(token.href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
};

const markdown = new Marked({ renderer });

export function renderAssistantMarkdown(value: unknown): string {
  const normalized = String(value || '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return '';
  return markdown.parse(normalized, { async: false });
}

function isSafeLink(href: string): boolean {
  try {
    const url = new URL(href, 'https://client.invalid');
    return url.protocol === 'http:'
      || url.protocol === 'https:'
      || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]!,
  );
}
