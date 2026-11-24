import { describe, expect, it } from 'vitest';
import type { AgentConfigDocument } from '../../platform/config/types.js';
import type { ExtensionAcquisitionDiagnostic, ExtensionDescriptorV1 } from '../../extension/acquisition/types.js';
import {
  buildExecutionSectionView,
  buildExtensionSectionView,
  buildLlmSectionView,
  buildSandboxSectionView,
  type SettingsApplicationState,
} from './section-views.js';
import { resolveAgentExecutionConfig } from '../../platform/config/index.js';
import { resolveSandboxConfig } from '../../builtins/tools/environment/index.js';

describe('sandbox section projection', () => {
  it('shows saved owner defaults and the actual startup policy without leaking other settings', () => {
    const startupConfig = resolveSandboxConfig({ enabled: true, network: 'outbound', write: [process.cwd()] });
    const view = buildSandboxSectionView({
      revision: 'sandbox-revision', startupConfig,
      document: { llm: { builtin: { apiKey: 'sandbox-secret-sentinel' } } },
    });
    expect(view).toMatchObject({
      id: 'agents:sandbox', kind: 'sandbox', settings: resolveSandboxConfig(),
      appliedSettings: startupConfig, restartRequired: true, applicationStatus: 'restart_required',
    });
    expect(JSON.stringify(view)).not.toContain('sandbox-secret-sentinel');
    expect(buildSandboxSectionView({ revision: 'same', startupConfig, document: { agents: { sandbox: startupConfig } } }))
      .toMatchObject({ restartRequired: false, applicationStatus: 'current' });
  });

  it('marks path-only changes and clears the marker for equivalent explicit defaults', () => {
    const startupConfig = resolveSandboxConfig();
    expect(buildSandboxSectionView({
      revision: 'paths', startupConfig, document: { agents: { sandbox: { read: [process.cwd()] } } },
    }).restartRequired).toBe(true);
    expect(buildSandboxSectionView({
      revision: 'defaults', startupConfig, document: { agents: { sandbox: startupConfig } },
    }).restartRequired).toBe(false);
  });
});

describe('execution section projection', () => {
  it('reuses owner defaults without materializing saved settings or leaking other configuration', () => {
    const running = resolveAgentExecutionConfig();
    const view = buildExecutionSectionView({
      revision: 'execution-revision', applied: running,
      document: { llm: { builtin: { apiKey: 'secret-sentinel' } } },
    });
    expect(view).toMatchObject({
      id: 'agents:execution', settings: {}, defaults: running,
      resolvedSettings: running,
      restartRequired: false, applicationStatus: 'current',
    });
    expect(view.defaults).toEqual({ steeringEnabled: true, maxSubagentDepth: 1 });
    expect(JSON.stringify(view)).not.toContain('secret-sentinel');
    expect(view.resolvedSettings).not.toHaveProperty('maxLlmCallsPerTurn');
  });

  it('reports publication consistency without a restart or running-policy duplicate', () => {
    const running = { steeringEnabled: true, maxSubagentDepth: 0, maxLlmCallsPerTurn: 9 };
    const pending = buildExecutionSectionView({ revision: 'one', applied: running, document: {} });
    expect(pending).toMatchObject({
      restartRequired: false, applicationStatus: 'not_applied',
    });
    expect(pending).not.toHaveProperty('runningSettings');
    const restored = buildExecutionSectionView({ revision: 'two', applied: running, document: { agents: running } });
    expect(restored).toMatchObject({ restartRequired: false, applicationStatus: 'current' });
    const explicitDefaults = buildExecutionSectionView({
      revision: 'three', applied: resolveAgentExecutionConfig(),
      document: { agents: { steeringEnabled: true, maxSubagentDepth: 1 } },
    });
    expect(explicitDefaults.restartRequired).toBe(false);
    expect(running).toEqual({ steeringEnabled: true, maxSubagentDepth: 0, maxLlmCallsPerTurn: 9 });
  });
});

const descriptor: ExtensionDescriptorV1 = {
  manifestVersion: 1, id: 'relay', version: '1.0.0', entry: 'entry.js',
  configSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      label: { type: 'string', default: 'initial' },
      token: { type: 'string', writeOnly: true },
      locked: { type: 'string', readOnly: true },
      hidden: { type: 'object', properties: { secret: { type: 'string', writeOnly: true } } },
      count: { type: 'number' },
      enabledFeature: { type: 'boolean' },
    },
  },
};

function llmView(
  llm: AgentConfigDocument['llm'] = undefined,
  applicationStatus: SettingsApplicationState = 'current',
) {
  return buildLlmSectionView({ id: 'llm', revision: 'revision-llm', llm, applicationStatus });
}

function extensionView(entry: unknown = undefined, baseline: unknown = undefined) {
  return buildExtensionSectionView({
    id: 'extension:relay', revision: 'revision-relay',
    descriptor, entry, baseline, diagnostics: [],
  });
}

describe('LLM section projection', () => {
  it('preserves empty section shape without materializing Built-in or default Model', () => {
    expect(llmView()).toEqual({
      id: 'llm', revision: 'revision-llm', restartRequired: false,
      applicationStatus: 'current', settings: {},
      form: { credentials: { '/builtin/apiKey': { configured: false } } },
    });
  });

  it.each<SettingsApplicationState>(['current', 'not_applied', 'unknown'])(
    'preserves supplied %s status and the configured Model without a Built-in section',
    (status) => {
      const defaultModel = { providerId: 'external', modelId: 'model' };
      const view = llmView({ defaultModel }, status);
      expect(view.applicationStatus).toBe(status);
      expect(view.restartRequired).toBe(false);
      expect(view.settings).toEqual({ defaultModel });
    },
  );

  it.each([
    { key: undefined, metadata: { configured: false } },
    { key: '', metadata: { configured: false } },
    { key: '   ', metadata: { configured: false } },
    { key: 'literal-key-sentinel', metadata: { configured: true, source: 'literal' } },
    { key: '${VIEW_KEY_SENTINEL}', metadata: { configured: true, source: 'environment' } },
  ])('redacts Built-in credential while preserving its metadata: $metadata', ({ key, metadata }) => {
    const builtin = {
      baseURL: 'https://example.test/v1',
      models: [{ modelId: 'model', protocol: 'openai-responses' as const }],
      ...(key === undefined ? {} : { apiKey: key }),
    };
    const before = structuredClone(builtin);
    const view = llmView({ builtin });
    expect(view.settings).toEqual({
      builtin: { baseURL: builtin.baseURL, models: builtin.models },
    });
    expect(view.form.credentials['/builtin/apiKey']).toEqual(metadata);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('literal-key-sentinel');
    expect(serialized).not.toContain('VIEW_KEY_SENTINEL');
    expect(builtin).toEqual(before);
    expect(llmView({ builtin })).toEqual(view);
  });

  it('propagates invalid LLM validation rather than returning an empty safe-looking section', () => {
    expect(() => llmView({ builtin: {
      baseURL: 'https://example.test/v1',
      models: [{ modelId: 'model', protocol: 'openai-responses' }],
      apiKey: '${invalid-reference-sentinel}',
    } })).toThrow(/llm\.builtin\.apiKey/);
  });
});

describe('Extension section projection', () => {
  it('projects only own editable nonsensitive finite scalar values', () => {
    const config = {
      token: 'credential-sentinel',
      locked: 'read-only-sentinel',
      hidden: { secret: 'nested-sentinel' },
      count: Number.POSITIVE_INFINITY,
      enabledFeature: false,
      unsupported: 'unknown-sentinel',
    };
    const view = extensionView({ config });
    expect(view.settings).toEqual({ enabled: true, config: { enabledFeature: false } });
    expect(view.form.credentials).toEqual({ '/token': { configured: true, source: 'literal' } });
    expect(view.form.fields.find(field => field.name === 'locked')).toMatchObject({ editable: false });
    const serialized = JSON.stringify(view);
    for (const sentinel of [
      'inherited-sentinel', 'credential-sentinel', 'read-only-sentinel', 'nested-sentinel', 'unknown-sentinel',
    ]) expect(serialized).not.toContain(sentinel);
    expect(extensionView({ config: { label: 'label', count: 0, enabledFeature: true } }).settings.config)
      .toEqual({ label: 'label', count: 0, enabledFeature: true });
    const inherited: unknown = Object.create({ label: 'inherited-sentinel' });
    expect(extensionView({ config: inherited }).settings.config).toEqual({});
  });

  it.each([
    { token: undefined, metadata: { configured: false } },
    { token: '', metadata: { configured: false } },
    { token: '  ', metadata: { configured: false } },
    { token: 'literal-secret-sentinel', metadata: { configured: true, source: 'literal' } },
    { token: '${EXTENSION_KEY_SENTINEL}', metadata: { configured: true, source: 'environment' } },
    { token: '${invalid-reference-sentinel}', metadata: { configured: true, error: 'invalid_credential' } },
    { token: 42, metadata: { configured: true, error: 'invalid_credential' } },
  ])('preserves credential metadata without exposing raw input: $metadata', ({ token, metadata }) => {
    const view = extensionView({ config: { token } });
    expect(view.form.credentials['/token']).toEqual(metadata);
    expect(view.settings.config).not.toHaveProperty('token');
    const serialized = JSON.stringify(view);
    for (const sentinel of ['literal-secret-sentinel', 'EXTENSION_KEY_SENTINEL', 'invalid-reference-sentinel']) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('preserves descriptor naming and selects diagnostics in their original order', () => {
    const diagnostics: ExtensionAcquisitionDiagnostic[] = [
      { category: 'disabled', code: 'extension_disabled', extensionId: 'relay' },
      { category: 'disabled', code: 'extension_disabled', extensionId: 'other' },
      { category: 'config_invalid', code: 'entry_config_invalid', extensionId: 'relay' },
    ];
    const input = {
      id: 'extension:relay', revision: 'revision-relay', entry: undefined,
      baseline: undefined, descriptor, diagnostics,
    };
    const before = structuredClone(input);
    const view = buildExtensionSectionView(input);
    expect(view).toMatchObject({ id: input.id, revision: input.revision, name: 'relay' });
    expect(view.diagnostics).toEqual([diagnostics[0], diagnostics[2]]);
    expect(buildExtensionSectionView({ ...input, descriptor: { ...descriptor, name: 'Relay display' } }).name)
      .toBe('Relay display');
    expect(input).toEqual(before);
  });

  it.each([
    { entry: undefined, baseline: undefined, restart: false, enabled: true },
    { entry: { enabled: true, config: { label: 'initial' } }, baseline: undefined, restart: false, enabled: true },
    { entry: { enabled: false }, baseline: undefined, restart: true, enabled: false },
    { entry: { config: { label: 'changed' } }, baseline: undefined, restart: true, enabled: true },
    { entry: { config: { token: 'one' } }, baseline: { config: { token: 'two' } }, restart: true, enabled: true },
    { entry: null, baseline: null, restart: false, enabled: true },
    { entry: null, baseline: undefined, restart: true, enabled: true },
    { entry: { config: 'invalid' }, baseline: { config: 'invalid' }, restart: false, enabled: true },
    { entry: { config: 'invalid' }, baseline: undefined, restart: true, enabled: true },
  ])('compares effective baseline and invalid entries without changing enablement', ({ entry, baseline, restart, enabled }) => {
    const view = extensionView(entry, baseline);
    expect(view.restartRequired).toBe(restart);
    expect(view.applicationStatus).toBe(restart ? 'restart_required' : 'current');
    expect(view.settings.enabled).toBe(enabled);
  });

  it('clears only a reverted difference without mutating values, descriptors or diagnostics', () => {
    const baseline = { config: { label: 'initial', token: '${IMMUTABLE_KEY_SENTINEL}' } };
    const changed = { config: { ...baseline.config, label: 'changed' } };
    const original = structuredClone({ baseline, changed, descriptor });
    expect(extensionView(changed, baseline).restartRequired).toBe(true);
    const reverted = extensionView(baseline, baseline);
    expect(reverted.restartRequired).toBe(false);
    expect(extensionView(baseline, baseline)).toEqual(reverted);
    expect({ baseline, changed, descriptor }).toEqual(original);
    expect(JSON.stringify(reverted)).not.toContain('IMMUTABLE_KEY_SENTINEL');
  });
});
