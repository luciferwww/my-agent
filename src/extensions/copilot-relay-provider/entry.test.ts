import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { prepareExtensionConfig } from '../acquisition/configuration.js';
import { createExtension } from './entry.js';

const DESCRIPTOR_PATH = fileURLToPath(new URL('./extension.json', import.meta.url));

describe('Copilot Relay Extension entry', () => {
  it('maps validated scoped config to an uncreated External Unit', async () => {
    const descriptor = JSON.parse(await readFile(DESCRIPTOR_PATH, 'utf8')) as {
      readonly configSchema: Readonly<Record<string, unknown>>;
    };
    const prepared = prepareExtensionConfig({
      baseURL: 'http://localhost:5000/',
      apiKey: 'relay-secret',
    }, descriptor.configSchema, {});
    if (!prepared.ok) throw new Error('Expected valid Relay Extension config.');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const unit = createExtension(Object.freeze({ config: prepared.config }));

    expect(unit).toMatchObject({
      unitId: 'copilot-relay-provider',
      source: 'external',
      orderKey: 'copilot-relay-provider',
      required: false,
      initiallyEnabled: true,
      dependencies: [],
    });
    expect(prepared.config).toEqual({
      baseURL: 'http://localhost:5000/',
      apiKey: 'relay-secret',
      discoveryTimeoutMs: 5000,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects invalid direct factory input without starting Unit I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(() => createExtension(Object.freeze({
      config: Object.freeze({ baseURL: 'https://relay.example.com' }),
    }))).toThrow('loopback');
    expect(() => createExtension(Object.freeze({
      config: Object.freeze({ discoveryTimeoutMs: 0 }),
    }))).toThrow('positive safe integer');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
