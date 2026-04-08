import { createServer } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { webFetchTool } from './web-fetch.js';

let server: ReturnType<typeof createServer>;
let baseUrl = '';

beforeEach(async () => {
  server = createServer((req, res) => {
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Hello</h1><p>World</p></body></html>');
      return;
    }

    if (req.url === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('plain text body');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server address');
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('webFetchTool', () => {
  it('extracts readable content from html', async () => {
    const result = await webFetchTool.execute({ url: `${baseUrl}/html`, extractMode: 'text' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
  });

  it('returns text responses as-is', async () => {
    const result = await webFetchTool.execute({ url: `${baseUrl}/text` });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('plain text body');
  });

  it('rejects unsupported protocols', async () => {
    const result = await webFetchTool.execute({ url: 'file:///tmp/example.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('only http and https');
  });
});