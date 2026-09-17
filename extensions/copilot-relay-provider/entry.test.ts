import { describe, expect, it, vi } from 'vitest';

import { createExtension } from './entry.js';

describe('Copilot Relay Extension entry', () => {
  it('maps scoped config to an uncreated External Unit', () => {
    const config = Object.freeze({
      baseURL: 'http://localhost:5000/',
      apiKey: 'relay-secret',
      discoveryTimeoutMs: 5000,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const unit = createExtension(Object.freeze({ config }));

    expect(unit).toMatchObject({
      unitId: 'copilot-relay-provider',
      source: 'external',
      orderKey: 'copilot-relay-provider',
      required: false,
      initiallyEnabled: true,
      dependencies: [],
    });
    expect(config).toEqual({
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
