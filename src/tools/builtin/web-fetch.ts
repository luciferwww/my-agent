import type { Tool } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 50_000;

function parseMaxChars(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_MAX_CHARS;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error('"maxChars" must be a positive integer');
  }
  return value;
}

function parseExtractMode(value: unknown): 'markdown' | 'text' {
  return value === 'text' ? 'text' : 'markdown';
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractReadableContent(raw: string, contentType: string, extractMode: 'markdown' | 'text'): string {
  const normalizedContentType = contentType.toLowerCase();
  if (!normalizedContentType.includes('html')) {
    return raw.trim();
  }

  let text = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');

  text = decodeHtmlEntities(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();

  if (extractMode === 'markdown') {
    return text;
  }
  return text;
}

function formatWebFetchResult(params: {
  url: string;
  finalUrl: string;
  extractMode: 'markdown' | 'text';
  content: string;
  truncated: boolean;
}): string {
  const header = [
    `url: ${params.url}`,
    ...(params.finalUrl !== params.url ? [`finalUrl: ${params.finalUrl}`] : []),
    `extractMode: ${params.extractMode}`,
    ...(params.truncated ? ['truncated: true'] : []),
  ];

  return `${header.join('\n')}\n\n${params.content}`.trimEnd();
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch a URL over HTTP(S) and extract readable text content without browser automation.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'HTTP or HTTPS URL to fetch.',
      },
      extractMode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: 'Readable extraction format.',
      },
      maxChars: {
        type: 'number',
        description: 'Maximum number of output characters.',
      },
    },
    required: ['url'],
  },
  execute: async (params) => {
    try {
      if (typeof params.url !== 'string' || !params.url.trim()) {
        return {
          content: 'Invalid input for tool "web_fetch": "url" must be a non-empty string',
          isError: true,
        };
      }

      const targetUrl = new URL(params.url);
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return {
          content: 'Invalid input for tool "web_fetch": only http and https URLs are supported',
          isError: true,
        };
      }

      const extractMode = parseExtractMode(params.extractMode);
      const maxChars = parseMaxChars(params.maxChars);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetch(targetUrl, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'user-agent': 'my-agent/0.1 web_fetch',
            'accept-language': 'en-US,en;q=0.9',
          },
        });

        if (!response.ok) {
          return {
            content: `Error executing tool "web_fetch": request failed with status ${response.status}`,
            isError: true,
          };
        }

        const raw = await response.text();
        const contentType = response.headers.get('content-type') ?? 'text/plain';
        const extracted = extractReadableContent(raw, contentType, extractMode);
        const truncated = extracted.length > maxChars;

        return {
          content: formatWebFetchResult({
            url: targetUrl.toString(),
            finalUrl: response.url || targetUrl.toString(),
            extractMode,
            content: truncated ? extracted.slice(0, maxChars) : extracted,
            truncated,
          }),
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            content: `Error executing tool "web_fetch": request timed out after ${DEFAULT_TIMEOUT_MS / 1000} seconds`,
            isError: true,
          };
        }

        return {
          content: `Error executing tool "web_fetch": ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return {
        content: `Error executing tool "web_fetch": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};