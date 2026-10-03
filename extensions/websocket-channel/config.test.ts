import { describe, expect, it } from 'vitest';

import { readWebSocketExtensionConfig } from './config.js';

describe('WebSocket Extension configuration', () => {
  it('accepts a complete Acquisition projection without adding fallbacks', () => {
    const value = Object.freeze({
      host: '127.0.0.1',
      port: 8787,
      webSocketPath: '/ws',
      clientPath: '/',
      approval: true,
      openBrowser: false,
    });

    const config = readWebSocketExtensionConfig(value);

    expect(config).toEqual(value);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    [{}, 'missing schema defaults'],
    [{
      host: '127.0.0.1',
      port: 8787,
      webSocketPath: '/',
      clientPath: '/',
      approval: true,
      openBrowser: false,
    }, 'overlapping paths'],
    [{
      host: '127.0.0.1',
      port: 8787,
      webSocketPath: '/ws?token=value',
      clientPath: '/',
      approval: true,
      openBrowser: false,
    }, 'query in WebSocket path'],
    [{
      host: '127.0.0.1',
      port: 8787,
      webSocketPath: '/ws',
      clientPath: '/chat#section',
      approval: true,
      openBrowser: false,
    }, 'fragment in client path'],
    [{
      host: '127.0.0.1',
      port: 8787,
      webSocketPath: '/</script>',
      clientPath: '/',
      approval: true,
      openBrowser: false,
    }, 'markup in WebSocket path'],
    [{
      host: '127.0.0.1',
      port: 8787,
      webSocketPath: '//example.com/ws',
      clientPath: '/',
      approval: true,
      openBrowser: false,
    }, 'scheme-relative WebSocket path'],
    [{
      host: '127.0.0.1',
      port: 8787,
      webSocketPath: '/ws%',
      clientPath: '/',
      approval: true,
      openBrowser: false,
    }, 'malformed percent encoding'],
  ])('rejects %s (%s)', (value, _reason) => {
    expect(() => readWebSocketExtensionConfig(value))
      .toThrow('WebSocket Extension configuration is invalid.');
  });
});
