import { describe, expect, it, vi } from 'vitest';

import type {
  ExtensionAcquisitionDiagnostic,
  ExtensionAcquisitionResult,
  ResolvedHostExtensionsConfig,
} from '../../extension-acquisition/index.js';
import {
  formatAcquisitionWarning,
  formatRuntimeWarning,
  prepareStandaloneHostAcquisition,
} from './host-startup.js';

describe('standalone Host startup', () => {
  it('passes the installation-owned Extensions directory through the acquisition boundary', async () => {
    const environment = Object.freeze({ EXTENSION_SECRET: 'configured-value' });
    const hostConfig: ResolvedHostExtensionsConfig = Object.freeze({
      enabled: true,
      entries: Object.freeze({}),
    });
    const result: ExtensionAcquisitionResult = Object.freeze({
      loadedUnits: Object.freeze([]),
      diagnostics: Object.freeze([]),
    });
    const acquireExtensions = vi.fn(async () => result);

    await expect(prepareStandaloneHostAcquisition(
      'C:\\installation\\extensions',
      hostConfig,
      environment,
      { acquireExtensions },
    )).resolves.toEqual({ result });

    expect(acquireExtensions).toHaveBeenCalledWith({
      extensionsDir: 'C:\\installation\\extensions',
      extensionsConfig: hostConfig,
      environment,
    });
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