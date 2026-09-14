import { describe, expect, it, vi } from 'vitest';

import type {
  ExtensionAcquisitionDiagnostic,
  ExtensionAcquisitionResult,
  ResolvedHostExtensionsConfig,
} from '../src/extension-acquisition/index.js';
import {
  formatAcquisitionWarning,
  formatRuntimeWarning,
  parseAgentHomeArgument,
  prepareWebSocketHostAcquisition,
} from './websocket-host-startup.js';

describe('supported WebSocket Host startup', () => {
  it('resolves Agent Home and runs only the generic acquisition boundary', async () => {
    const environment = Object.freeze({ MY_AGENT_HOME: 'C:\\configured-home' });
    const hostConfig: ResolvedHostExtensionsConfig = Object.freeze({
      enabled: true,
      entries: Object.freeze({}),
    });
    const result: ExtensionAcquisitionResult = Object.freeze({
      loadedUnits: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
    const resolveAgentHome = vi.fn(async () => 'C:\\canonical-home');
    const readHostExtensionsConfig = vi.fn(async () => hostConfig);
    const acquireExtensions = vi.fn(async () => result);

    await expect(prepareWebSocketHostAcquisition(
      'C:\\explicit-home',
      environment,
      { resolveAgentHome, readHostExtensionsConfig, acquireExtensions },
    )).resolves.toEqual({ agentHome: 'C:\\canonical-home', result });

    expect(resolveAgentHome).toHaveBeenCalledWith({
      explicitPath: 'C:\\explicit-home',
      environment,
    });
    expect(readHostExtensionsConfig).toHaveBeenCalledWith('C:\\canonical-home');
    expect(acquireExtensions).toHaveBeenCalledWith({
      agentHome: 'C:\\canonical-home',
      hostConfig,
      environment,
    });
  });

  it('accepts either Agent Home option syntax and rejects ambiguity', () => {
    expect(parseAgentHomeArgument(['--port=9000'])).toBeUndefined();
    expect(parseAgentHomeArgument(['--agent-home=C:\\agent-home'])).toBe('C:\\agent-home');
    expect(parseAgentHomeArgument(['--agent-home', 'C:\\agent-home']))
      .toBe('C:\\agent-home');
    expect(() => parseAgentHomeArgument(['--agent-home'])).toThrow('requires a path');
    expect(() => parseAgentHomeArgument([
      '--agent-home=C:\\one',
      '--agent-home',
      'C:\\two',
    ])).toThrow('only once');
  });

  it('keeps disabled diagnostics structured but omits them from operator warnings', () => {
    const disabled: ExtensionAcquisitionDiagnostic = Object.freeze({
      category: 'disabled',
      code: 'extension_disabled',
      extensionId: 'disabled-extension',
      locator: '"disabled-extension"',
    });

    expect(formatAcquisitionWarning(disabled)).toBeUndefined();
  });

  it('projects only bounded allowlisted acquisition and Runtime warning fields', () => {
    const secret = 'secret-that-must-not-appear';
    const acquisition = formatAcquisitionWarning(Object.freeze({
      category: 'secret_unavailable',
      code: 'environment_secret_unavailable',
      extensionId: 'relay',
      locator: '"relay-installation"',
      referencePath: '/apiKey',
      environmentVariable: 'RELAY_KEY',
    }));
    const runtime = formatRuntimeWarning({
      scope: 'startup',
      severity: 'warning',
      code: 'UNIT_INVALID',
      message: secret,
      unitId: 'relay',
      cause: new Error(secret),
    });

    expect(acquisition).toContain('environmentVariable="RELAY_KEY"');
    expect(runtime).toBe('Runtime warning: code=UNIT_INVALID unitId="relay"');
    expect(`${acquisition}${runtime}`).not.toContain(secret);

    const longId = 'x'.repeat(300);
    expect(formatRuntimeWarning({
      scope: 'startup',
      severity: 'warning',
      code: 'UNIT_CONFLICT',
      message: secret,
      unitId: longId,
    }).length).toBeLessThan(260);
  });

});
