import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigEditError,
  editAgentConfigSection,
  restoreAgentConfigSection,
  saveAgentConfigSection,
} from './agent-config-editor.js';
import type { AgentConfigDocument } from './types.js';
import { replaceAgentConfigFile } from './file-publication.js';

const model = { modelId: 'one', protocol: 'openai-responses' };
const settings = { builtin: { baseURL: 'https://new.example/v1', models: [model] } };
const schema = {
  type: 'object',
  properties: {
    label: { type: 'string', minLength: 2 },
    token: { type: 'string', writeOnly: true, pattern: '^key-[a-z]+$', minLength: 8 },
    fixed: { type: 'string', readOnly: true },
    nested: {
      type: 'object',
      properties: { secret: { type: 'string', writeOnly: true } },
      additionalProperties: false,
    },
  },
  required: ['label', 'token'],
  additionalProperties: false,
};

describe('Agent Home section editing', () => {
  let agentHome: string;
  beforeEach(async () => {
    agentHome = await mkdtemp(join(tmpdir(), 'agent-config-editor-'));
  });
  afterEach(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  async function write(document: AgentConfigDocument) {
    await writeFile(join(agentHome, 'config.json'), JSON.stringify(document), 'utf8');
  }
  async function read(): Promise<AgentConfigDocument> {
    return JSON.parse(await readFile(join(agentHome, 'config.json'), 'utf8'));
  }

  it('reads the current file, preserves other sections and keeps an unresolved raw credential', async () => {
    const document: AgentConfigDocument = {
      llm: { builtin: { baseURL: 'https://old.example', apiKey: '${SETTINGS_UNAVAILABLE_KEY}', models: [model] } },
      agents: { steeringEnabled: false },
      extensions: { entries: { other: { enabled: false, config: { secret: 'untouched' } } } },
    };
    await write(document);
    const committed = await saveAgentConfigSection(agentHome, { kind: 'llm', settings });
    expect(committed.previous).toEqual({ kind: 'llm', value: document.llm });
    expect(await read()).toEqual({
      ...document,
      llm: { builtin: { ...settings.builtin, apiKey: '${SETTINGS_UNAVAILABLE_KEY}' } },
    });
    expect(committed.document).toEqual(await read());
    expect(await readdir(agentHome)).toEqual(['config.json']);
  });

  it('preserves unopened fields only on retained model identities and never resurrects deleted rows', () => {
    const current: AgentConfigDocument = {
      llm: { builtin: { baseURL: 'https://old.example', models: [
        { ...model, endpoint: 'old', outputTokenLimit: 256, reasoning: { efforts: ['high'] } },
        { modelId: 'deleted', protocol: 'openai-responses', outputTokenLimit: 128 },
      ] } },
    };
    const edited = editAgentConfigSection(current, { kind: 'llm', settings });
    expect(edited.document.llm?.builtin).toEqual({
      ...settings.builtin,
      models: [{ ...model, outputTokenLimit: 256, reasoning: { efforts: ['high'] } }],
    });
    expect(current.llm?.builtin).toMatchObject({ models: [{ endpoint: 'old' }, { modelId: 'deleted' }] });
  });

  it.each(['keep', 'clear', 'replace'] as const)('handles the explicit %s credential intent', (operation) => {
    const result = editAgentConfigSection({
      llm: { builtin: { ...settings.builtin, apiKey: '${OLD_KEY}' } },
    }, {
      kind: 'llm', settings,
      credentials: { '/builtin/apiKey': operation === 'replace' ? { operation, value: '${NEW_KEY}' } : { operation } },
    });
    expect(result.document.llm?.builtin).toEqual({
      ...settings.builtin,
      ...(operation === 'clear' ? {} : { apiKey: operation === 'keep' ? '${OLD_KEY}' : '${NEW_KEY}' }),
    });
  });

  it.each([
    { settings: { builtin: { ...settings.builtin, apiKey: 'not-an-intent' } } },
    { settings, credentials: { '/unknown': { operation: 'clear' } } },
    { settings, credentials: { '/builtin/apiKey': { operation: 'replace', value: '' } } },
    { settings, credentials: { '/builtin/apiKey': { operation: 'replace', value: '${invalid-name}' } } },
    { settings, credentials: { '/builtin/apiKey': { operation: 'keep', value: 'extra' } } },
    { settings: { builtin: { models: [model] } } },
    { settings: { builtin: { ...settings.builtin, models: [model, model] } } },
  ])('does not write an invalid or unauthorized edit %#', async (edit) => {
    await write({});
    await expect(saveAgentConfigSection(agentHome, { kind: 'llm', ...edit })).rejects.toThrow();
    expect(await read()).toEqual({});
    expect(await readdir(agentHome)).toEqual(['config.json']);
  });

  it.each([undefined, { builtin: { ...settings.builtin, apiKey: '${ORIGINAL_KEY}' } }])(
    'restores exact target values or absence without overwriting later unrelated sections',
    async (llm) => {
      await write(llm === undefined ? {} : { llm });
      const saved = await saveAgentConfigSection(agentHome, { kind: 'llm', settings });
      const unrelated = { entries: { other: { enabled: true, config: { raw: '${OTHER_KEY}' } } } };
      await write({ ...saved.document, extensions: unrelated });
      const restored = await restoreAgentConfigSection(agentHome, saved.previous);
      expect(restored).toEqual({ ...(llm === undefined ? {} : { llm }), extensions: unrelated });
      expect(await read()).toEqual(restored);
    },
  );

  it('cleans up an unpublished temporary file while preserving the original error and file', async () => {
    await write({ agents: { steeringEnabled: true } });
    const failure = new Error('pre-replacement check failed');
    await expect(replaceAgentConfigFile(agentHome, '{}', async () => { throw failure; })).rejects.toBe(failure);
    expect(await read()).toEqual({ agents: { steeringEnabled: true } });
    expect(await readdir(agentHome)).toEqual(['config.json']);
  });

  it.each([
    { kind: 'llm', settings },
    { kind: 'extension', extensionId: 'relay', schema: { type: 'object' }, settings: { enabled: false, config: {} } },
  ] as const)('rejects the legacy global switch during a $kind save without changing the file', async (edit) => {
    const extensions = { enabled: false, entries: {} };
    await write({ extensions });
    await expect(saveAgentConfigSection(agentHome, edit)).rejects.toMatchObject({
      code: 'NAMESPACE_INVALID',
      fieldPath: 'extensions.enabled',
    });
    expect(await read()).toEqual({ extensions });
    expect(await readdir(agentHome)).toEqual(['config.json']);
  });

  it('preserves hidden/read-only Extension values and raw kept secrets even when disabled', () => {
    const current: AgentConfigDocument = {
      extensions: { entries: {
        relay: { enabled: true, config: {
          label: 'old', token: '${UNAVAILABLE_TOKEN}', fixed: 'server-owned', nested: { secret: 'hidden' },
        } },
        other: { enabled: false },
      } },
    };
    const result = editAgentConfigSection(current, {
      kind: 'extension', extensionId: 'relay', schema,
      settings: { enabled: false, config: { label: 'new' } },
    });
    expect(result.document.extensions?.entries).toEqual({
      relay: { enabled: false, config: {
        label: 'new', token: '${UNAVAILABLE_TOKEN}', fixed: 'server-owned', nested: { secret: 'hidden' },
      } },
      other: { enabled: false },
    });
  });

  it.each([
    { settings: { enabled: false, config: { label: 'x' } } },
    { settings: { enabled: false, config: { label: 'ok', fixed: 'client-owned' } } },
    { settings: { enabled: false, config: { label: 'ok', nested: {} } } },
    { settings: { enabled: false, config: { label: 'ok', token: 'key-direct' } } },
    { settings: { enabled: false, config: { label: 'ok' } }, credentials: { '/token': { operation: 'replace', value: 'invalid' } } },
    { settings: { enabled: false, config: { label: 'ok' } }, credentials: { '/token': { operation: 'clear' } } },
  ])('rejects invalid disabled Extension edits and server-owned fields %#', (edit) => {
    expect(() => editAgentConfigSection({
      extensions: { entries: { relay: { config: { token: 'key-original' } } } },
    }, { kind: 'extension', extensionId: 'relay', schema, ...edit })).toThrow(ConfigEditError);
  });

  it('accepts a legal raw environment reference without applying literal constraints or resolving it', () => {
    const result = editAgentConfigSection({}, {
      kind: 'extension', extensionId: 'relay', schema,
      settings: { enabled: true, config: { label: 'ok' } },
      credentials: { '/token': { operation: 'replace', value: '${UNAVAILABLE_TOKEN}' } },
    });
    expect(result.document.extensions?.entries?.['relay']).toEqual({
      enabled: true, config: { label: 'ok', token: '${UNAVAILABLE_TOKEN}' },
    });
  });

  it('escapes credential property paths without introducing arbitrary path mutation', () => {
    const result = editAgentConfigSection({}, {
      kind: 'extension', extensionId: 'relay',
      schema: { type: 'object', properties: { 'a/b~c': { type: 'string', writeOnly: true } }, additionalProperties: false },
      settings: { enabled: true, config: {} },
      credentials: { '/a~1b~0c': { operation: 'replace', value: 'secret' } },
    });
    expect(result.document.extensions?.entries?.['relay']).toEqual({ enabled: true, config: { 'a/b~c': 'secret' } });
  });
});
