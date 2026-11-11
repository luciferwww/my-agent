<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { SettingsActionResult } from 'my-agent/extension-api';
import {
  agentPolicySettings, modelDraft, modelSettings, object, parseSection, settingsProviders, settingsTools,
  type ModelDraft, type SettingsSection, type SettingsProvider, type SettingsTool, type SettingsField,
} from '../client/settings';
import SettingsCredential, { type SecretDraft } from './SettingsCredential.vue';
import SettingsToolSelect from './SettingsToolSelect.vue';
import SettingsSelect from './SettingsSelect.vue';

const props = defineProps<{
  open: boolean;
  connected: boolean;
  execute: (action: string, input: unknown) => Promise<SettingsActionResult>;
}>();
const emit = defineEmits<{ close: []; catalog: [catalog: unknown] }>();
interface Draft {
  section: SettingsSection;
  baseline: string;
  baseURL: string;
  models: ModelDraft[];
  defaultModel?: { providerId: string; modelId: string };
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, SecretDraft>;
  stale: boolean;
  fileUnknown: boolean;
  allowMode: 'inherit' | 'explicit';
  allow: string;
  deny: string;
}
const dialog = ref<HTMLDialogElement>();
const drafts = ref<Draft[]>([]);
const selectedSection = ref('llm');
const selectedProviderId = ref('');
const visibleDrafts = computed(() => drafts.value.filter((draft) =>
  draft.section.id === (selectedSection.value === 'builtin' ? 'llm' : selectedSection.value)));
const extensions = computed(() => drafts.value.filter((draft) => draft.section.id.startsWith('extension:')));
const agents = computed(() => drafts.value.filter(draft => draft.section.agent));
const selectedCategory = computed(() => ['llm', 'builtin', 'provider'].includes(selectedSection.value) ? 'llm'
  : selectedSection.value === 'agents' || visibleDrafts.value[0]?.section.agent ? 'agents' : 'extensions');
const categories = computed(() => [
  { id: 'llm', name: 'LLM', description: 'Models & providers', drafts: drafts.value.filter((draft) => draft.section.id === 'llm') },
  { id: 'agents', name: 'Agents', description: 'Enablement & Tool policy', drafts: agents.value },
  { id: 'extensions', name: 'Extensions', description: 'Installed extensions', drafts: extensions.value },
]);
const categoryOptions = computed(() => categories.value.map(category => ({
  value: category.id,
  label: `${category.name}${category.drafts.some(isDirty) ? ' (unsaved)' : ''}${category.drafts.some(draft => draft.section.restartRequired) ? ' (restart required)' : ''}${category.drafts.some(draft => draft.stale || draft.fileUnknown) ? ' (unconfirmed)' : ''}`,
})));
const busy = ref(false);
type FeedbackKind = 'pending' | 'success' | 'error' | 'info';
const feedback = ref<{ kind: FeedbackKind; message: string }>();
let feedbackVersion = 0;
const editingModel = ref<ModelDraft>();
const diagnostics = ref<unknown[]>([]);
const agentDiagnostics = ref<unknown[]>([]);
const agentTab = ref<'configuration' | 'context'>('configuration');
const contextFile = ref('IDENTITY.md');
const contextNames = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'TOOLS.md'];
const providers = ref<SettingsProvider[]>([]);
const tools = ref<SettingsTool[]>([]);
const selectedProvider = computed(() => providers.value.find((provider) => provider.providerId === selectedProviderId.value));
const restartRequired = computed(() => drafts.value.some((draft) => draft.section.restartRequired));
const llm = computed(() => drafts.value.find((draft) => draft.section.id === 'llm'));
const saveDraft = computed(() => selectedSection.value === 'provider' ? llm.value
  : visibleDrafts.value[0]?.section.agent && agentTab.value === 'context' ? undefined : visibleDrafts.value[0]);
const modelChoices = computed(() => [
  ...(llm.value?.models ?? []).filter((model) => model.modelId).map((model) => ({
    providerId: 'builtin', modelId: model.modelId, label: `Built-in / ${model.displayName || model.modelId}`,
  })),
  ...providers.value.filter((provider) => provider.providerId !== 'builtin').flatMap((provider) =>
    provider.models.map((model) => ({ providerId: provider.providerId, modelId: model.modelId, label: `${provider.name} / ${model.name}` }))),
]);
function modelToken(reference: { providerId: string; modelId: string }) {
  return JSON.stringify([reference.providerId, reference.modelId]);
}
const defaultSelection = computed({
  get: () => llm.value?.defaultModel ? modelToken(llm.value.defaultModel) : '',
  set: (token: string) => {
    const model = modelChoices.value.find((model) => modelToken(model) === token);
    if (!llm.value) return;
    llm.value.defaultModel = model ? { providerId: model.providerId, modelId: model.modelId } : undefined;
    reportFeedback('info', 'Default changed in the LLM draft only. Save LLM to apply it.');
  },
});
const defaultAvailable = computed(() => modelChoices.value.some((model) => modelToken(model) === defaultSelection.value));
const defaultModelOptions = computed(() => [
  { value: '', label: 'None' },
  ...(llm.value?.defaultModel && !defaultAvailable.value ? [{
    value: defaultSelection.value,
    label: `${llm.value.defaultModel.providerId} / ${llm.value.defaultModel.modelId} (unavailable)`,
    disabled: true,
  }] : []),
  ...modelChoices.value.map(model => ({ value: modelToken(model), label: model.label })),
]);
function isDefault(providerId: string, modelId: string): boolean {
  return !!modelId && llm.value?.defaultModel?.providerId === providerId && llm.value.defaultModel.modelId === modelId;
}
function reportFeedback(kind: FeedbackKind, message: string): number {
  feedback.value = { kind, message };
  return ++feedbackVersion;
}
function finishFeedback(version: number, kind: FeedbackKind, message: string) {
  if (version === feedbackVersion) reportFeedback(kind, message);
}
function providerTarget(provider: SettingsProvider): string | undefined {
  return extensions.value.find((draft) => draft.section.id === provider.configurationSectionId)?.section.id;
}
function enumOptions(field: SettingsField) {
  const values = field.schema?.['enum'];
  if (!Array.isArray(values)) throw new Error('Malformed Extension enum.');
  return [
    { value: undefined, label: 'Omit / use declared default' },
    ...values.map((value: unknown) => ({ value, label: typeof value === 'string' ? value : JSON.stringify(value) })),
  ];
}

function draftSignature(draft: Draft): string {
  return JSON.stringify([
    draft.baseURL, draft.models, draft.defaultModel,
    draft.enabled, draft.config, draft.secrets,
    draft.allowMode, draft.allow, draft.deny,
  ]);
}
function isDirty(draft: Draft): boolean {
  return draftSignature(draft) !== draft.baseline;
}
function makeDraft(section: SettingsSection): Draft {
  const builtin = section.settings['builtin'] === undefined ? undefined : object(section.settings['builtin']);
  const reference = section.settings['defaultModel'] === undefined ? undefined : object(section.settings['defaultModel']);
  const savedConfig = section.settings['config'] === undefined ? {} : object(section.settings['config']);
  const tools = section.agent && section.settings['tools'] !== undefined ? object(section.settings['tools']) : {};
  if (builtin && (!Array.isArray(builtin['models']) || typeof builtin['baseURL'] !== 'string')) {
    throw new Error('Malformed Built-in settings.');
  }
  if (reference && (typeof reference['providerId'] !== 'string' || typeof reference['modelId'] !== 'string')) {
    throw new Error('Malformed default model.');
  }
  const draft: Draft = {
    section, baseline: '', baseURL: String(builtin?.['baseURL'] ?? ''),
    models: Array.isArray(builtin?.['models']) ? builtin['models'].map(modelDraft) : [],
    defaultModel: reference ? { providerId: String(reference['providerId']), modelId: String(reference['modelId']) } : undefined,
    enabled: section.agent ? section.agent.enabled : section.settings['enabled'] === true,
    allowMode: tools['allow'] === undefined ? 'inherit' : 'explicit',
    allow: Array.isArray(tools['allow']) ? tools['allow'].join('\n') : '',
    deny: Array.isArray(tools['deny']) ? tools['deny'].join('\n') : '',
    config: Object.fromEntries(section.fields.filter((field) => field.editable && !field.sensitive)
      .map((field) => [field.name, Object.hasOwn(savedConfig, field.name) ? savedConfig[field.name] : undefined])),
    secrets: Object.fromEntries(Object.keys(section.credentials).map((path) => [path, { operation: 'keep', value: '' }])),
    stale: false, fileUnknown: false,
  };
  draft.baseline = draftSignature(draft);
  return draft;
}
function clearSecretValues(target?: Draft) {
  for (const draft of target ? [target] : drafts.value) for (const secret of Object.values(draft.secrets)) secret.value = '';
}
function applyCatalog(value: unknown) {
  providers.value = settingsProviders(value);
  emit('catalog', value);
}
async function load() {
  if (busy.value || !props.connected) return;
  busy.value = true;
  const version = reportFeedback('pending', 'Loading Settings...');
  try {
    const result = await props.execute('load', {});
    if (!result.ok) throw new Error(result.error.message);
    const output = object(result.output);
    if (!Array.isArray(output['sections'])) throw new Error('Malformed Settings view.');
    tools.value = settingsTools(output['toolCatalog']);
    const loaded = output['sections'].map((section: unknown) => makeDraft(parseSection(section)));
    applyCatalog(output['modelCatalog']);
    clearSecretValues();
    drafts.value = loaded;
    editingModel.value = undefined;
    if (!['llm', 'builtin', 'provider', 'extensions', 'agents'].includes(selectedSection.value)
      && !loaded.some((draft) => draft.section.id === selectedSection.value)) {
      selectedSection.value = 'extensions';
    }
    diagnostics.value = Array.isArray(output['diagnostics']) ? output['diagnostics'] : [];
    agentDiagnostics.value = Array.isArray(output['agentDiagnostics']) ? output['agentDiagnostics'] : [];
    finishFeedback(version, 'success', 'Settings loaded.');
  } catch (failure) {
    finishFeedback(version, 'error', failure instanceof Error ? `Settings load failed: ${failure.message}` : 'Settings could not be loaded.');
  } finally { busy.value = false; }
}
function credentials(draft: Draft) {
  return Object.fromEntries(Object.entries(draft.secrets).map(([path, secret]) => {
    if (secret.operation === 'replace') {
      if (!secret.value.trim()) throw new Error('Re-enter replacement credentials before submitting.');
      return [path, { operation: 'replace', value: secret.value }];
    }
    return [path, { operation: secret.operation }];
  }));
}
function builtin(draft: Draft) {
  return { baseURL: draft.baseURL, models: draft.models.map(modelSettings) };
}
function settings(draft: Draft) {
  if (draft.section.agent) return agentPolicySettings(draft.section, draft);
  if (draft.section.id === 'llm') return {
    ...(draft.section.settings['builtin'] !== undefined || draft.baseURL !== '' || draft.models.length > 0
      || draft.secrets['/builtin/apiKey']?.operation === 'replace' ? { builtin: builtin(draft) } : {}),
    ...(draft.defaultModel ? { defaultModel: { ...draft.defaultModel } } : {}),
  };
  const config = { ...draft.config };
  for (const field of draft.section.fields) {
    if ((field.schema?.['type'] === 'number' || field.schema?.['type'] === 'integer') && config[field.name] === '') {
      delete config[field.name];
    }
  }
  return { enabled: draft.enabled, config };
}
async function save(draft: Draft) {
  if (busy.value || !props.connected || draft.stale) return;
  busy.value = true;
  const version = reportFeedback('pending', `Saving ${draft.section.name}...`);
  try {
    const input = {
      sectionId: draft.section.id, expectedRevision: draft.section.revision,
      settings: settings(draft),
      ...(draft.section.agent ? {} : { credentials: credentials(draft) }),
    };
    const response = props.execute('update', input);
    clearSecretValues(draft);
    const result = await response;
    const output = result.output === undefined ? undefined : object(result.output);
    if (output?.['section'] !== undefined) {
      const confirmed = makeDraft(parseSection(output['section']));
      const index = drafts.value.indexOf(draft);
      if (index >= 0) drafts.value[index] = confirmed;
      editingModel.value = undefined;
    }
    if (output?.['modelCatalog'] !== undefined) applyCatalog(output['modelCatalog']);
    if (Array.isArray(output?.['agentSections'])) {
      for (const raw of output['agentSections']) {
        const view = parseSection(raw);
        const existing = drafts.value.find(item => item.section.id === view.id);
        if (existing) {
          existing.section.agent = view.agent;
          existing.section.applicationStatus = view.applicationStatus;
        }
      }
    }
    if (Array.isArray(output?.['agentDiagnostics'])) agentDiagnostics.value = output['agentDiagnostics'];
    if (!result.ok) {
      if (result.error.code === 'rollback_failed' && typeof output?.['revision'] === 'string') {
        draft.section.revision = output['revision'];
        draft.fileUnknown = true;
      } else if (['revision_conflict', 'request_timeout', 'connection_lost', 'invalid_response', 'settings_failed', 'file_state_unknown'].includes(result.error.code)) {
        draft.stale = true;
      }
      throw new Error(`${result.error.message}${result.error.fieldPath ? ` (${result.error.fieldPath})` : ''}`);
    }
    if (!output?.['section']) {
      draft.stale = true;
      throw new Error('Save returned no confirmed section. Reload before saving again.');
    }
    const warnings = output['warnings'];
    finishFeedback(version, 'success', `${draft.section.name}: saved.${draft.section.agent ? ' Applied to subsequent Turns.' : ''}${Array.isArray(warnings) && warnings.length ? ' Runtime reported retirement warnings; check service logs.' : ''}`);
  } catch (failure) {
    finishFeedback(version, 'error', `${draft.section.name}: ${failure instanceof Error ? failure.message : 'Save outcome could not be confirmed.'}`);
  } finally { busy.value = false; }
}
async function testModel(providerId: string, modelId: string) {
  if (busy.value || !props.connected) return;
  busy.value = true;
  const version = reportFeedback('pending', `${providerId}/${modelId}: Testing...`);
  try {
    const draft = llm.value;
    if (draft?.stale) throw new Error('Reload saved settings before testing this draft.');
    const input = {
      reference: { providerId, modelId },
      ...(providerId === 'builtin' && draft ? {
        builtin: { settings: builtin(draft), credentials: credentials(draft), expectedRevision: draft.section.revision },
      } : {}),
    };
    const response = props.execute('test_llm_model', input);
    if (providerId === 'builtin' && draft) clearSecretValues(draft);
    const result = await response;
    if (!result.ok) {
      if (draft && result.error.code === 'revision_conflict') draft.stale = true;
      throw new Error(result.error.message);
    }
    if (object(result.output)['outcome'] !== 'completed') throw new Error('Model Test returned no confirmed call outcome.');
    finishFeedback(version, 'success', `${providerId}/${modelId}: Test completed. Nothing was saved or made default.`);
  } catch (failure) {
    finishFeedback(version, 'error', `${providerId}/${modelId}: ${failure instanceof Error ? failure.message : 'Model Test failed.'}`);
  } finally { busy.value = false; }
}
function setDefault(providerId: string, modelId: string) {
  if (!llm.value) return;
  llm.value.defaultModel = { providerId, modelId };
  reportFeedback('info', `${providerId}/${modelId}: default changed in the LLM draft only. Save LLM to apply it.`);
}
function addModel(draft: Draft) {
  const model: ModelDraft = { modelId: '', protocol: 'openai-responses', displayName: '', endpoint: '', advanced: '{}' };
  draft.models.push(model);
  editingModel.value = model;
  reportFeedback('info', 'Model added to the LLM draft. Save LLM to apply it.');
}
function removeModel(draft: Draft, index: number) {
  const removed = draft.models.splice(index, 1)[0];
  if (editingModel.value === removed) editingModel.value = undefined;
  let message = `${removed?.modelId || 'Model'} removed from the LLM draft. Save LLM to apply it.`;
  if (draft.defaultModel?.providerId === 'builtin' && draft.defaultModel.modelId === removed?.modelId) {
    draft.defaultModel = undefined;
    message = 'The deleted model was the draft default; that draft selection was cleared. Save LLM to apply it.';
  }
  reportFeedback('info', message);
}
watch(() => props.open, async (open) => {
  await nextTick();
  if (open) {
    dialog.value?.showModal();
    if (!drafts.value.length) await load();
  } else {
    dialog.value?.close();
    clearSecretValues();
  }
});
watch(() => props.connected, (connected) => {
  if (connected) return;
  clearSecretValues();
  for (const draft of drafts.value) draft.stale = true;
  reportFeedback('error', 'Disconnected. Reload saved settings after reconnecting; unsaved drafts have not been retried.');
});
watch(selectedSection, () => { agentTab.value = 'configuration'; contextFile.value = 'IDENTITY.md'; });
</script>

<template>
  <dialog ref="dialog" class="settings-dialog" aria-labelledby="settings-heading"
    @cancel.prevent="emit('close')" @keydown.escape.stop.prevent="emit('close')">
    <header class="settings-header">
      <div>
        <h2 id="settings-heading">Settings</h2>
        <p>Configure models, Agents and installed Extensions. Save each section independently.</p>
      </div>
      <div class="settings-header-actions">
        <div class="settings-reload">
          <button type="button" class="secondary" :disabled="busy || !connected" @click="load">Reload saved settings</button>
          <small>Discards all unsaved drafts</small>
        </div>
        <button type="button" class="secondary" @click="emit('close')">Close</button>
      </div>
    </header>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        <p class="settings-nav-heading">Sections</p>
        <div class="settings-nav-list">
          <button v-for="category in categories" :key="category.id" type="button" class="session-item"
            :class="{ selected: selectedCategory === category.id }"
            :aria-current="selectedCategory === category.id ? 'page' : undefined"
            @click="selectedSection = category.id">
            <span class="settings-nav-name">{{ category.name }}</span>
            <span class="settings-nav-description">{{ category.description }}</span>
            <span v-if="category.drafts.some(isDirty)" class="settings-badge">Unsaved</span>
            <span v-if="category.drafts.some(draft => draft.section.restartRequired)" class="settings-badge">Restart required</span>
            <span v-if="category.drafts.some(draft => draft.stale || draft.fileUnknown)" class="settings-badge">Unconfirmed</span>
          </button>
        </div>
        <SettingsSelect class="settings-mobile-select" label="Section" :model-value="selectedCategory"
          :options="categoryOptions" @update:model-value="selectedSection = $event" />
      </nav>
      <div class="settings-content" :key="selectedSection">
    <p v-if="restartRequired" class="settings-warning" role="status">Saved Extension changes require a manual service restart. Reverting to startup values clears the corresponding requirement.</p>
    <details v-if="diagnostics.length"><summary>Startup diagnostics</summary><pre>{{ JSON.stringify(diagnostics, null, 2) }}</pre></details>
    <section v-if="selectedSection === 'provider'" class="settings-section">
      <button type="button" class="secondary settings-back" @click="selectedSection = 'llm'">Back to Providers</button>
      <template v-if="selectedProvider">
        <h3>{{ selectedProvider.name }}</h3>
        <button v-if="providerTarget(selectedProvider)" type="button" class="secondary settings-back"
          @click="selectedSection = providerTarget(selectedProvider) ?? 'llm'">Configure Extension</button>
        <p v-else class="settings-description">No editable Extension configuration is available for this Provider.</p>
        <fieldset :disabled="busy || !connected">
          <p class="settings-help">Test uses the currently loaded instance, not saved or draft Extension settings, and may incur charges. It never saves. Deadline: 30 seconds including preparation.</p>
          <p v-if="!selectedProvider.models.length" class="settings-description">No loaded models. Configure the owning Extension and restart before testing.</p>
          <div v-for="model in selectedProvider.models" :key="model.modelId" class="settings-model-row">
            <div class="settings-model-copy">
              <strong>{{ model.name }} <span v-if="isDefault(selectedProvider.providerId, model.modelId)" class="settings-badge">Default</span></strong>
              <span v-if="model.name !== model.modelId" class="settings-description">{{ model.modelId }}</span>
            </div>
            <div class="settings-actions">
              <button type="button" class="secondary" :disabled="llm?.stale"
                @click="testModel(selectedProvider.providerId, model.modelId)">Test</button>
              <button type="button" class="secondary" :disabled="!llm || llm.stale || isDefault(selectedProvider.providerId, model.modelId)"
                @click="setDefault(selectedProvider.providerId, model.modelId)">Set default</button>
            </div>
          </div>
          <p class="settings-description">Set default only updates the LLM draft. Save LLM to apply it.</p>
        </fieldset>
      </template>
      <p v-else class="settings-warning">This Provider is no longer in the loaded catalog. Return to Providers to select an available one.</p>
    </section>
    <section v-if="selectedSection === 'agents'" class="settings-section">
      <h3>Agents</h3>
      <p class="settings-description">Enablement and Tool policy apply to subsequent Turns. MD changes require restart.</p>
      <details v-if="agentDiagnostics.length"><summary>Agent definition diagnostics</summary><pre>{{ JSON.stringify(agentDiagnostics, null, 2) }}</pre></details>
      <div class="settings-list">
        <div v-for="draft in agents" :key="draft.section.id" class="settings-list-row">
          <div class="settings-list-copy">
            <strong>{{ draft.section.name }}</strong>
            <span>{{ draft.section.agent?.description || 'No valid startup definition.' }}</span>
            <span>{{ draft.section.agent?.builtIn ? 'Built-in - Shared Tool defaults' : draft.section.agent?.enabled ? 'Enabled' : 'Disabled' }}</span>
            <div class="settings-markers">
              <span v-if="!draft.section.agent?.definitionAvailable" class="settings-badge">Definition unavailable</span>
              <span v-if="isDirty(draft)" class="settings-badge">Unsaved</span>
              <span v-if="draft.stale" class="settings-badge">Unconfirmed</span>
            </div>
          </div>
          <button type="button" class="secondary" :aria-label="`Configure ${draft.section.name}`" @click="selectedSection = draft.section.id">Configure</button>
        </div>
      </div>
    </section>
    <section v-if="selectedSection === 'extensions'" class="settings-section">
      <h3>Extensions</h3>
      <p class="settings-description">Configure installed extensions individually. Saved changes require a manual restart.</p>
      <p v-if="!extensions.length" class="settings-description">No discovered extensions.</p>
      <div class="settings-list">
        <div v-for="draft in extensions" :key="draft.section.id" class="settings-list-row">
          <div class="settings-list-copy">
            <strong>{{ draft.section.name }}</strong>
            <span>{{ draft.enabled ? 'Enabled after restart' : 'Disabled after restart' }}</span>
            <div class="settings-markers">
              <span v-if="isDirty(draft)" class="settings-badge">Unsaved</span>
              <span v-if="draft.section.restartRequired" class="settings-badge">Restart required</span>
              <span v-if="draft.stale || draft.fileUnknown" class="settings-badge">Unconfirmed</span>
            </div>
          </div>
          <button type="button" class="secondary" :aria-label="`Configure ${draft.section.name}`" @click="selectedSection = draft.section.id">Configure</button>
        </div>
      </div>
    </section>
    <section v-for="draft in visibleDrafts" :key="draft.section.id" class="settings-section">
      <button v-if="selectedSection !== 'llm'" type="button" class="secondary settings-back"
        @click="selectedSection = draft.section.id === 'llm' ? 'llm' : draft.section.agent ? 'agents' : 'extensions'">
        {{ draft.section.id === 'llm' ? 'Back to Providers' : draft.section.agent ? 'Back to Agents' : 'Back to Extensions' }}
      </button>
      <h3>{{ selectedSection === 'builtin' ? 'Built-in Provider' : draft.section.id === 'llm' ? 'LLM' : draft.section.name }}</h3>
      <p v-if="draft.section.restartRequired" class="settings-warning">Saved, not applied: restart required.</p>
      <p v-if="draft.section.applicationStatus && draft.section.applicationStatus !== 'current' && !draft.section.restartRequired" class="settings-warning">
        Saved configuration application status: {{ draft.section.applicationStatus }}. Successful file saving alone does not confirm Runtime application.
      </p>
      <p v-if="draft.stale" class="settings-warning">Reload before saving. This editor's revision or connection is no longer confirmed.</p>
      <p v-if="draft.fileUnknown" class="settings-warning">File state is unknown after failed rollback. These are retained drafts, not confirmed saved values. A new explicit save is still allowed.</p>
      <details v-if="draft.section.diagnostics.length"><summary>Extension diagnostics</summary><pre>{{ JSON.stringify(draft.section.diagnostics, null, 2) }}</pre></details>
      <fieldset :disabled="busy || !connected || draft.stale">
        <template v-if="draft.section.id === 'llm'">
          <template v-if="selectedSection === 'llm'">
            <div class="settings-default">
              <SettingsSelect v-model="defaultSelection" label="Default model" :options="defaultModelOptions" />
              <button type="button" class="secondary" :disabled="!defaultAvailable || !draft.defaultModel"
                @click="draft.defaultModel && testModel(draft.defaultModel.providerId, draft.defaultModel.modelId)">Test selected model</button>
            </div>
            <p class="settings-description">Default selection and Built-in configuration share one LLM draft. Save LLM to apply both.</p>
          </template>
          <p class="settings-help">Test makes a real model request and may incur charges. Built-in tests use this draft; other Providers use currently loaded instances. Test never saves. Deadline: 30 seconds including preparation.</p>
          <template v-if="selectedSection === 'llm'">
            <h4 class="settings-list-heading">Providers</h4>
            <div class="settings-list">
              <div class="settings-list-row">
                <div class="settings-list-copy">
                  <strong>Built-in</strong>
                  <span>{{ draft.models.length }} draft model{{ draft.models.length === 1 ? '' : 's' }}</span>
                </div>
                <button type="button" class="secondary" aria-label="Built-in details" @click="selectedSection = 'builtin'">Details</button>
              </div>
              <div v-for="provider in providers.filter(provider => provider.providerId !== 'builtin')" :key="provider.providerId" class="settings-list-row">
                <div class="settings-list-copy">
                  <strong>{{ provider.name }} <span v-if="providerTarget(provider)" class="settings-badge">Extension</span></strong>
                  <span>{{ provider.models.length }} loaded {{ provider.models.length === 1 ? 'model' : 'models' }}</span>
                  <span v-if="!providerTarget(provider)">No editable Extension configuration is available.</span>
                </div>
                <button type="button" class="secondary" :aria-label="`${provider.name} details`"
                  @click="selectedProviderId = provider.providerId; selectedSection = 'provider'">Details</button>
              </div>
            </div>
          </template>
          <template v-else>
          <div class="settings-group">
            <label>Base URL<input v-model="draft.baseURL" type="url" autocomplete="off"></label>
            <SettingsCredential v-for="(secret, path) in draft.secrets" :key="path" v-model="draft.secrets[path]"
              :metadata="draft.section.credentials[path]" label="Built-in API key" />
            <article v-for="(model, index) in draft.models" :key="index" class="settings-model-item">
              <div class="settings-model-row">
                <div class="settings-model-copy">
                  <div class="settings-model-title">
                    <button type="button" class="settings-model-toggle" :aria-expanded="editingModel === model"
                      :aria-label="`${editingModel === model ? 'Collapse' : 'Edit'} ${model.modelId || 'new model'}`"
                      @click="editingModel = editingModel === model ? undefined : model">
                      <strong>{{ model.displayName || model.modelId || 'New model' }}</strong>
                      <span class="settings-description">{{ editingModel === model ? 'Done' : 'Edit' }}</span>
                    </button>
                    <span v-if="isDefault('builtin', model.modelId)" class="settings-badge">Default</span>
                  </div>
                  <span class="settings-description">{{ model.displayName && model.modelId ? `${model.modelId} / ` : '' }}{{ model.protocol }}</span>
                </div>
                <div class="settings-actions">
                  <button type="button" class="secondary" :disabled="!model.modelId.trim()" @click="testModel('builtin', model.modelId)">Test</button>
                  <button type="button" class="secondary" :disabled="!model.modelId.trim() || isDefault('builtin', model.modelId)"
                    @click="setDefault('builtin', model.modelId)">Set default</button>
                  <button type="button" class="secondary" @click="removeModel(draft, index)">Delete</button>
                </div>
              </div>
              <div v-if="editingModel === model" class="settings-model">
              <label>Model ID<input v-model="model.modelId"></label>
              <label>Display name (optional)<input v-model="model.displayName"></label>
              <SettingsSelect v-model="model.protocol" label="Protocol"
                :options="['openai-responses', 'openai-chat-completions', 'anthropic-messages'].map(value => ({ value, label: value }))" />
              <label>Relative endpoint (optional)<input v-model="model.endpoint" placeholder="/v1/responses"></label>
              <details><summary>Advanced model limits and reasoning</summary>
                <p>JSON fields: maximumContextTokens, maximumPromptTokens, maximumOutputTokens, outputTokenLimit, reasoning (thinking / efforts). Existing values are preserved.</p>
                <label>Advanced fields<textarea v-model="model.advanced" rows="5" spellcheck="false"></textarea></label>
              </details>
              </div>
            </article>
            <button type="button" class="secondary settings-add" @click="addModel(draft)">Add model</button>
          </div>
          <p class="settings-description">Save LLM also saves the default model selected on the Providers page.</p>
          </template>
        </template>
        <template v-else-if="draft.section.agent">
          <div v-if="!draft.section.agent.builtIn" class="settings-actions settings-tabs" role="tablist" aria-label="Agent settings">
            <button type="button" role="tab" :aria-selected="agentTab === 'configuration'" @click="agentTab = 'configuration'">Configuration</button>
            <button type="button" role="tab" :aria-selected="agentTab === 'context'" @click="agentTab = 'context'">Context</button>
          </div>
          <template v-if="agentTab === 'configuration' || draft.section.agent.builtIn">
            <p class="settings-description">{{ draft.section.agent.description }}</p>
            <p v-if="draft.section.agent.builtIn" class="settings-help">Shared Tool defaults for subsequent Root and Child Turns, not an independent general-purpose profile. This built-in type cannot be disabled.</p>
            <template v-else>
              <label class="settings-checkbox"><input v-model="draft.enabled" type="checkbox"><span>Enabled</span></label>
              <p v-if="!draft.section.agent.definitionAvailable" class="settings-warning">No valid startup definition. This override cannot register an Agent. A requested specialist falls back to general-purpose unless explicitly disabled.</p>
              <p class="settings-description">Model: {{ draft.section.agent.model === 'inherit' || !draft.section.agent.model ? 'Inherit Parent model' : `${draft.section.agent.model.providerId} / ${draft.section.agent.model.modelId}` }} (read-only)</p>
              <p v-if="draft.section.agent.modelAvailable === false" class="settings-warning">The configured or recommended model is not in the loaded catalog. Task-time resolution will report unavailable models; no silent model fallback.</p>
            </template>
            <p class="settings-help">Tools selected for approval bypass skip ordinary approval, not access restrictions. Prohibited Tools cannot be used and take precedence. Manual Exec and external-path approval rules still apply.</p>
            <label class="settings-checkbox">
              <input type="checkbox" :checked="draft.allowMode === 'inherit'"
                @change="draft.allowMode = draft.allowMode === 'inherit' ? 'explicit' : 'inherit'">
              <span>{{ draft.section.agent.builtIn ? 'Use default approval rules (no bypass)' : 'Inherit shared approval bypass' }}</span>
            </label>
            <SettingsToolSelect label="Approval bypass tools" :tools="tools"
              :model-value="draft.allowMode === 'inherit' ? draft.section.agent.sharedAllow.join('\n') : draft.allow"
              :disabled="draft.allowMode === 'inherit'" @update:model-value="draft.allow = $event" />
            <p v-if="draft.allowMode === 'inherit'" class="settings-description">
              {{ draft.section.agent.builtIn ? 'Default approval bypass' : 'Shared approval bypass (read-only)' }}:
              {{ draft.section.agent.sharedAllow.join(', ') || '(none)' }}
            </p>
            <p v-else-if="!draft.allow" class="settings-description">No Tools bypass approval through this list. This does not disable Tools.</p>
            <p v-if="!draft.section.agent.builtIn" class="settings-help">Shared deny (read-only): {{ draft.section.agent.sharedDeny.join(', ') || '(none)' }}. Local settings cannot remove these entries.</p>
            <SettingsToolSelect v-model="draft.deny" :label="draft.section.agent.builtIn ? 'Shared prohibited tools' : 'Additional prohibited tools'"
              :tools="tools" :locked-tools="draft.section.agent.sharedDeniedTools" />
          </template>
          <template v-else>
            <p class="settings-help">Read-only startup snapshot. Manual MD edits, additions and deletions require restart. Reload saved settings does not reread MD.</p>
            <div class="settings-actions settings-tabs" role="tablist" aria-label="Context files">
              <button v-for="name in contextNames" :key="name" type="button" role="tab" :aria-selected="contextFile === name" @click="contextFile = name">{{ name }}</button>
            </div>
            <p v-if="draft.section.agent.missingFiles.includes(contextFile)" class="settings-warning">Missing {{ contextFile }} at startup. Child Context inherits the corresponding Parent file.</p>
            <template v-else-if="contextFile === 'IDENTITY.md'">
              <h4>Frontmatter metadata (not child instructions)</h4>
              <pre class="settings-context">{{ JSON.stringify(draft.section.agent.metadata, null, 2) }}</pre>
              <h4>Body (running Context)</h4>
              <pre class="settings-context">{{ draft.section.agent.instructionFiles.find(file => file.path === contextFile)?.content || '(empty or omitted by Context budget)' }}</pre>
              <details><summary>Raw startup snapshot</summary><pre class="settings-context">{{ draft.section.agent.contextFiles.find(file => file.path === contextFile)?.content }}</pre></details>
            </template>
            <pre v-else class="settings-context">{{ draft.section.agent.contextFiles.find(file => file.path === contextFile)?.content || '(empty or omitted by Context budget)' }}</pre>
          </template>
        </template>
        <template v-else>
          <p>Extension parameters and enablement take effect only after a manual restart.</p>
          <label class="settings-checkbox">
            <input v-model="draft.enabled" type="checkbox">
            <span>Enabled <small class="settings-description">(requires service restart after saving)</small></span>
          </label>
          <template v-for="field in draft.section.fields" :key="field.path">
            <p v-if="!field.editable">{{ field.name }}: {{ field.supported ? 'read-only' : 'unsupported Schema form' }}; retained by the server, value not exposed.</p>
            <SettingsSelect v-else-if="!field.sensitive && Array.isArray(field.schema?.['enum'])"
              v-model="draft.config[field.name]" :label="String(field.schema?.['title'] || field.name)"
              :description="String(field.schema?.['description'] ?? '')" :options="enumOptions(field)" />
            <label v-else-if="!field.sensitive && field.schema?.['type'] === 'boolean'" class="settings-checkbox">
              <input v-model="draft.config[field.name]" type="checkbox">
              <span class="settings-checkbox-copy">
                <span>{{ field.schema?.['title'] || field.name }}</span>
                <small v-if="field.schema?.['description']">{{ field.schema['description'] }}</small>
              </span>
            </label>
            <label v-else-if="!field.sensitive">
              {{ field.schema?.['title'] || field.name }}
              <span v-if="field.schema?.['description']">{{ field.schema['description'] }}</span>
              <input v-if="field.schema?.['type'] === 'number' || field.schema?.['type'] === 'integer'"
                v-model.number="draft.config[field.name]" type="number" :step="field.schema['type'] === 'integer' ? 1 : 'any'">
              <input v-else v-model="draft.config[field.name]" :placeholder="String(field.schema?.['default'] ?? '')">
            </label>
          </template>
          <SettingsCredential v-for="(secret, path) in draft.secrets" :key="path" v-model="draft.secrets[path]"
            :metadata="draft.section.credentials[path]" :label="String(path)" />
        </template>
      </fieldset>
    </section>
      </div>
    </div>
      <footer class="settings-footer">
        <p v-if="feedback" class="settings-feedback" :class="`settings-feedback-${feedback.kind}`"
          :role="feedback.kind === 'error' ? 'alert' : 'status'" aria-atomic="true">{{ feedback.message }}</p>
        <div v-if="saveDraft" class="settings-savebar">
          <span>{{ saveDraft.fileUnknown ? 'File state unconfirmed' : isDirty(saveDraft) ? 'Unsaved changes' : 'No unsaved changes' }}</span>
          <button type="button" class="primary" :disabled="busy || !connected || saveDraft.stale" @click="save(saveDraft)">
            Save {{ saveDraft.section.id === 'llm' ? 'LLM' : saveDraft.section.name }}
          </button>
        </div>
      </footer>
  </dialog>
</template>

<style scoped>
.settings-dialog { --settings-nav-width: 210px; width: min(1060px, calc(100vw - 32px)); height: min(800px, calc(100dvh - 40px)); max-height: calc(100dvh - 40px); padding: 0; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); }
.settings-dialog[open] { display: flex; flex-direction: column; }
.settings-dialog::backdrop { background: rgb(0 0 0 / 40%); }
.settings-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 22px 26px; border-bottom: 1px solid var(--border); flex: none; }
.settings-header h2 { margin: 0 0 6px; font-size: 20px; letter-spacing: -.03em; }
.settings-header p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.settings-header-actions { display: flex; align-items: flex-start; gap: 10px; flex: none; }
.settings-reload { display: grid; gap: 5px; text-align: center; }
.settings-reload small { color: var(--muted); font-size: 10px; }
.settings-layout { display: grid; grid-template-columns: var(--settings-nav-width) minmax(0, 1fr); min-height: 0; flex: 1; }
.settings-nav { padding: 20px 12px; border-right: 1px solid var(--border); background: var(--surface); overflow: auto; }
.settings-nav-heading { margin: 0 12px 12px; color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
.settings-nav-list { display: grid; gap: 6px; }
.settings-nav-list button { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; padding: 12px; text-align: left; color: var(--text); }
.settings-nav-name { width: 100%; overflow-wrap: anywhere; font-weight: 600; }
.settings-nav-description { width: 100%; color: var(--muted); font-size: 11px; }
.settings-badge { padding: 2px 6px; border: 1px solid var(--border-strong); border-radius: 4px; color: var(--accent); background: var(--surface-soft); font-size: 10px; }
.settings-mobile-select { display: none; }
.settings-content { padding: 24px 28px; min-width: 0; overflow: auto; }
.settings-section h3 { margin: 0 0 20px; font-size: 18px; overflow-wrap: anywhere; }
.settings-section p { line-height: 1.6; }
.settings-back { margin-bottom: 18px; }
.settings-description { margin: 0; color: var(--muted); font-size: 12px; }
.settings-list-heading { margin: 8px 0 0; font-size: 13px; font-weight: 600; }
.settings-list { display: grid; }
.settings-list-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--border); }
.settings-list-copy { display: grid; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.settings-list-copy strong { font-size: 13px; font-weight: 600; }
.settings-list-copy > span { color: var(--muted); font-size: 11px; }
.settings-list-copy .settings-badge { margin-left: 6px; font-weight: normal; }
.settings-markers { display: flex; gap: 6px; flex-wrap: wrap; }
.settings-markers:empty { display: none; }
.settings-list-row > button { flex: none; }
.settings-actions, .settings-savebar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.settings-actions { justify-content: flex-end; }
.settings-savebar { justify-content: space-between; }
.settings-default { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 12px; }
.settings-group { display: grid; gap: 16px; }
.settings-help { margin: 0; padding: 12px 14px; color: var(--muted); background: var(--surface-soft); border-radius: 6px; font-size: 12px; }
.settings-tabs { justify-content: flex-start; }
.settings-tabs [aria-selected="true"] { color: var(--accent); outline: 1px solid var(--border-strong); }
.settings-context { max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; background: var(--surface-soft); font-size: 12px; }
fieldset { display: grid; gap: 14px; padding: 0; border: 0; min-width: 0; }
.settings-model-item { border-bottom: 1px solid var(--border); }
.settings-model { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 14px 0; }
.settings-model details { grid-column: 1 / -1; }
.settings-model-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.settings-model-item > .settings-model-row { border-bottom: 0; }
.settings-model-copy { display: grid; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
.settings-model-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.settings-model-toggle { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; min-width: 0; padding: 0; color: var(--text); background: transparent; text-align: left; font-size: 13px; overflow-wrap: anywhere; }
.settings-add { justify-self: start; }
.settings-actions span { overflow-wrap: anywhere; min-width: 0; }
.settings-footer { flex: none; padding: 12px 28px 12px calc(var(--settings-nav-width) + 28px); border-top: 1px solid var(--border); background: var(--panel); }
.settings-feedback { margin: 0; max-height: min(140px, 20dvh); overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; color: var(--muted); font-size: 12px; line-height: 1.5; }
.settings-feedback-success { color: var(--success); }
.settings-feedback-error { color: var(--danger); }
.settings-feedback-pending { color: var(--accent); }
.settings-feedback + .settings-savebar { margin-top: 10px; }
.settings-savebar > span { color: var(--muted); font-size: 12px; }
.settings-savebar > button { margin-left: auto; flex: none; }
.secondary { padding: 8px 11px; font-size: 12px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
fieldset:disabled { opacity: .6; }
.settings-content :deep(label) { min-width: 0; line-height: 1.5; }
input[type='checkbox'] { width: auto; align-self: start; }
.settings-checkbox { display: flex; flex-direction: row; align-items: flex-start; gap: 8px; cursor: pointer; }
.settings-checkbox > span { min-width: 0; overflow-wrap: anywhere; }
.settings-checkbox-copy { display: grid; gap: 4px; }
.settings-checkbox-copy small { color: var(--muted); font-size: 11px; }
.settings-checkbox input { width: auto; flex: none; align-self: start; margin: 3px 0 0; }
.settings-warning { border-left: 3px solid var(--accent); padding-left: 10px; }
pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
textarea { width: 100%; font-family: var(--mono); }
summary { color: var(--muted); cursor: pointer; font-size: 12px; }
@media (max-width: 700px) {
  .settings-dialog { width: calc(100vw - 16px); height: calc(100dvh - 16px); max-height: calc(100dvh - 16px); }
  .settings-header { align-items: flex-start; flex-direction: column; gap: 14px; padding: 18px; }
  .settings-header-actions { width: 100%; justify-content: space-between; }
  .settings-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .settings-nav { padding: 12px 18px; border-right: 0; border-bottom: 1px solid var(--border); }
  .settings-nav-heading, .settings-nav-list { display: none; }
  .settings-mobile-select { display: block; }
  .settings-content { padding: 20px 18px; }
  .settings-footer { padding: 12px 18px; }
  .settings-default, .settings-model { grid-template-columns: minmax(0, 1fr); }
  .settings-default button { justify-self: start; }
  .settings-model-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
}
</style>
