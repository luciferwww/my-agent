import katex from 'katex';
import { Marked, type MarkedExtension, type Tokens } from 'marked';

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
markdown.use(canonicalLatexExtension());

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

function canonicalLatexExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'inlineCanonicalKatex',
        level: 'inline',
        start: source => source.indexOf('\\('),
        tokenizer(source) {
          const match = /^\\\((.+?)\\\)/u.exec(source);
          return match
            ? { type: 'inlineCanonicalKatex', raw: match[0], text: match[1] }
            : undefined;
        },
        renderer: token => renderCanonicalLatex(token, false),
      },
      {
        name: 'blockCanonicalKatex',
        level: 'block',
        tokenizer(source) {
          const match = /^\\\[\s*\n?([\s\S]+?)\n?\s*\\\](?:\n|$)/u.exec(source);
          return match
            ? { type: 'blockCanonicalKatex', raw: match[0], text: match[1].trim() }
            : undefined;
        },
        renderer: token => `${renderCanonicalLatex(token, true)}\n`,
      },
    ],
  };
}

function renderCanonicalLatex(token: Tokens.Generic, displayMode: boolean): string {
  return katex.renderToString(String(token['text'] ?? ''), {
    displayMode,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
  });
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
