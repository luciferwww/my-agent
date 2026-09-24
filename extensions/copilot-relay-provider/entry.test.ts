import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionLoadContext } from 'my-agent/extension-api';

import { createExtension } from './entry.js';

const capturedOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('./copilot-relay-provider-unit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./copilot-relay-provider-unit.js')>();
  return {
    ...actual,
    createCopilotRelayProviderUnit: (options: unknown) => {
      capturedOptions.push(options);
      return actual.createCopilotRelayProviderUnit(options as never);
    },
  };
});

describe('Copilot Relay Extension entry', () => {
  beforeEach(() => {
    capturedOptions.length = 0;
  });

  it('maps scoped config to an uncreated External Unit', () => {
    const config = Object.freeze({
      baseURL: 'http://localhost:5000/',
      apiKey: 'relay-secret',
      discoveryTimeoutMs: 5000,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const unit = createExtension(extensionContext(config));

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
    expect(capturedOptions[0]).toEqual(expect.objectContaining({ apiKey: 'relay-secret' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects invalid direct factory input without starting Unit I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(() => createExtension(extensionContext(
      Object.freeze({ baseURL: 'https://relay.example.com' }),
    ))).toThrow('loopback');
    expect(() => createExtension(extensionContext(
      Object.freeze({ discoveryTimeoutMs: 0 }),
    ))).toThrow('positive safe integer');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

});

function extensionContext(
  config: Readonly<Record<string, unknown>>,
): ExtensionLoadContext {
  return Object.freeze({
    config,
    logger: Object.freeze({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  });
}
