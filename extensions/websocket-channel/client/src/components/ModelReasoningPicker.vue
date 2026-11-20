<script>
import { nextTick } from 'vue';
import { Check, ChevronDown } from '@lucide/vue';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export default {
  name: 'ModelReasoningPicker',
  components: { Check, ChevronDown },
  expose: ['closeTransientUi'],
  props: [
    'modelCatalog',
    'availableModels',
    'availableModelProviders',
    'modelPickerLabel',
    'selectedModelDetails',
    'modelControlsDisabled',
    'showThinkingControl',
    'showEffortControl',
    'reasoningSelection',
    'reasoningConstraintNotice',
    'isConnected',
    'formatReasoningOption',
    'reasoningPickerOptions',
    'isReasoningPickerOptionDisabled',
    'modelOptionToken',
    'isSelectedModel',
    'isRuntimeDefaultModel',
  ],
  emits: ['pickerOpening', 'modelPickerOpening', 'selectModel', 'selectReasoningOption'],
  data() {
    return {
      modelPickerOpen: false,
      reasoningPickerOpen: null,
      modelSearch: '',
      activeModelOptionIndex: -1,
      pickerPosition: {},
    };
  },
  computed: {
    filteredModelProviders() {
      const query = this.modelSearch.trim().toLocaleLowerCase();
      if (!query) return this.availableModelProviders;
      return this.availableModelProviders.flatMap(provider => {
        const providerMatches = `${provider.displayName ?? provider.providerId} ${provider.providerId}`
          .toLocaleLowerCase()
          .includes(query);
        const models = providerMatches
          ? provider.models
          : provider.models.filter(model => `${model.displayName ?? model.modelId} ${model.modelId}`
              .toLocaleLowerCase()
              .includes(query));
        return models.length > 0 ? [{ ...provider, models }] : [];
      });
    },
    filteredModelOptions() {
      return this.filteredModelProviders.flatMap(provider => provider.models.map(model => ({
        providerId: provider.providerId,
        modelId: model.modelId,
      })));
    },
    activeModelOptionId() {
      return this.activeModelOptionIndex >= 0
        && this.activeModelOptionIndex < this.filteredModelOptions.length
        ? `model-picker-option-${this.activeModelOptionIndex}`
        : null;
    },
    reasoningControls() {
      return [
        ...(this.showThinkingControl ? [{ kind: 'thinking', label: 'Thinking' }] : []),
        ...(this.showEffortControl ? [{ kind: 'effort', label: 'Effort' }] : []),
      ];
    },
  },
  watch: {
    modelControlsDisabled(disabled) {
      if (disabled) this.closeTransientUi();
    },
    isConnected(connected) {
      if (!connected) this.closeTransientUi();
    },
  },
  mounted() {
    window.addEventListener('resize', this.positionPicker);
    window.addEventListener('scroll', this.onScroll, true);
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.positionPicker);
    window.removeEventListener('scroll', this.onScroll, true);
  },
  methods: {
    activeTrigger() {
      return this.modelPickerOpen
        ? this.$refs.modelPickerTrigger
        : this.$refs[`${this.reasoningPickerOpen}PickerTrigger`]?.[0];
    },
    positionPicker() {
      const trigger = this.activeTrigger();
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(this.modelPickerOpen ? Math.max(320, rect.width) : Math.max(160, rect.width), window.innerWidth - 16);
      const above = Math.max(0, rect.top - 14);
      const below = Math.max(0, window.innerHeight - rect.bottom - 14);
      const placeAbove = above >= Math.min(this.modelPickerOpen ? 360 : 240, below);
      this.pickerPosition = {
        left: `${clamp(rect.left, 8, window.innerWidth - width - 8)}px`,
        width: `${width}px`,
        maxHeight: `${Math.min(this.modelPickerOpen ? 380 : 280, placeAbove ? above : below)}px`,
        ...(placeAbove
          ? { top: 'auto', bottom: `${window.innerHeight - rect.top + 6}px` }
          : { top: `${rect.bottom + 6}px`, bottom: 'auto' }),
      };
    },
    onScroll(event) {
      if (this.$refs.pickerPanel?.contains(event.target)) return;
      this.positionPicker();
    },
    toggleModelPicker() {
      if (this.modelPickerOpen) {
        this.closeTransientUi();
        return;
      }
      if (this.modelControlsDisabled || !this.isConnected) return;
      this.$emit('pickerOpening');
      this.$emit('modelPickerOpening');
      this.closeTransientUi();
      this.modelPickerOpen = true;
      this.activeModelOptionIndex = this.modelOptionIndex(
        this.selectedModelDetails?.reference?.providerId,
        this.selectedModelDetails?.reference?.modelId,
      );
      this.positionPicker();
      nextTick(() => {
        this.scrollActiveModelOptionIntoView();
        this.$refs.modelSearchEl?.focus();
      });
    },
    closeTransientUi(restoreFocus = false) {
      const trigger = this.activeTrigger();
      this.modelPickerOpen = false;
      this.reasoningPickerOpen = null;
      this.modelSearch = '';
      this.activeModelOptionIndex = -1;
      if (restoreFocus) trigger?.focus();
    },
    onModelSearchInput(event) {
      this.modelSearch = event.target.value;
      nextTick(() => {
        this.activeModelOptionIndex = this.filteredModelOptions.length > 0 ? 0 : -1;
        this.scrollActiveModelOptionIntoView();
      });
    },
    onModelSearchKeydown(event) {
      const options = this.filteredModelOptions;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.activeModelOptionIndex = options.length === 0
          ? -1
          : clamp(this.activeModelOptionIndex + (event.key === 'ArrowDown' ? 1 : -1), 0, options.length - 1);
        this.scrollActiveModelOptionIntoView();
      } else if (event.key === 'Enter' && options.length > 0) {
        event.preventDefault();
        const option = options[clamp(this.activeModelOptionIndex, 0, options.length - 1)];
        this.selectModel(option.providerId, option.modelId);
      }
    },
    activateModelOption(providerId, modelId) {
      this.activeModelOptionIndex = this.modelOptionIndex(providerId, modelId);
    },
    modelOptionIndex(providerId, modelId) {
      return this.filteredModelOptions.findIndex(option =>
        option.providerId === providerId && option.modelId === modelId);
    },
    modelOptionId(providerId, modelId) {
      const index = this.modelOptionIndex(providerId, modelId);
      return index >= 0 ? `model-picker-option-${index}` : undefined;
    },
    scrollActiveModelOptionIntoView() {
      nextTick(() => {
        this.$refs.pickerPanel
          ?.querySelector('.model-picker-option.active')
          ?.scrollIntoView({ block: 'nearest' });
      });
    },
    selectModel(providerId, modelId) {
      this.closeTransientUi(true);
      this.$emit('selectModel', providerId, modelId);
    },
    toggleReasoningPicker(kind) {
      if (this.reasoningPickerOpen === kind) {
        this.closeTransientUi();
        return;
      }
      if (this.modelControlsDisabled || !this.isConnected) return;
      this.$emit('pickerOpening');
      this.closeTransientUi();
      this.reasoningPickerOpen = kind;
      this.positionPicker();
      nextTick(() => {
        (this.$refs.pickerPanel?.querySelector('[aria-selected="true"]:not(:disabled)')
          ?? this.$refs.pickerPanel?.querySelector('button:not(:disabled)'))?.focus();
      });
    },
    selectReasoningOption(kind, value) {
      if (this.isReasoningPickerOptionDisabled(kind, value)) return;
      this.closeTransientUi(true);
      this.$emit('selectReasoningOption', kind, value);
    },
    onPickerKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeTransientUi(true);
      } else if (event.key === 'Tab') {
        this.closeTransientUi(true);
      } else if (this.reasoningPickerOpen && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...this.$refs.pickerPanel.querySelectorAll('button:not(:disabled)')];
        const current = buttons.indexOf(document.activeElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }
    },
  },
};
</script>

<template>
  <div class="composer-model-controls" :class="{ open: modelPickerOpen || reasoningPickerOpen }" :inert="modelControlsDisabled">
    <div class="composer-model-picker model-picker" :class="{ open: modelPickerOpen }">
      <span class="field-label-text">Model</span>
      <button
        ref="modelPickerTrigger"
        class="model-picker-trigger"
        type="button"
        :disabled="!isConnected || modelControlsDisabled"
        :aria-label="`Model: ${modelPickerLabel}`"
        :aria-expanded="String(modelPickerOpen)"
        aria-haspopup="dialog"
        @click="toggleModelPicker"
      >
        <span class="model-picker-trigger-copy">
          <span class="model-picker-trigger-name">{{ modelPickerLabel }}</span>
          <span v-if="selectedModelDetails" class="model-picker-trigger-provider">
            {{ selectedModelDetails.provider.displayName ?? selectedModelDetails.provider.providerId }}
          </span>
        </span>
        <ChevronDown class="model-picker-chevron" aria-hidden="true" />
      </button>
    </div>
    <div
      v-for="control in reasoningControls"
      :key="control.kind"
      class="reasoning-control model-picker"
      :class="{ open: reasoningPickerOpen === control.kind }"
    >
      <span class="field-label-text">{{ control.label }}</span>
      <button
        :ref="`${control.kind}PickerTrigger`"
        class="model-picker-trigger reasoning-picker-trigger"
        type="button"
        :aria-label="`${control.kind === 'effort' ? 'Reasoning effort' : control.label}: ${formatReasoningOption(reasoningSelection[control.kind])}`"
        :disabled="!isConnected || modelControlsDisabled"
        :aria-expanded="String(reasoningPickerOpen === control.kind)"
        aria-haspopup="listbox"
        @click="toggleReasoningPicker(control.kind)"
      >
        <span class="model-picker-trigger-copy">
          <span class="model-picker-trigger-name">{{ formatReasoningOption(reasoningSelection[control.kind]) }}</span>
        </span>
        <ChevronDown class="model-picker-chevron" aria-hidden="true" />
      </button>
    </div>
    <div v-if="reasoningConstraintNotice" class="composer-reasoning-notices">
      <div class="reasoning-notice">{{ reasoningConstraintNotice }}</div>
    </div>
    <Teleport to="body">
      <template v-if="modelPickerOpen || reasoningPickerOpen">
        <div class="model-picker-scrim" @click="closeTransientUi()"></div>
        <div
          ref="pickerPanel"
          class="model-picker-panel composer-picker-panel"
          :class="{ 'reasoning-picker-panel': reasoningPickerOpen }"
          :style="pickerPosition"
          :role="modelPickerOpen ? 'dialog' : 'listbox'"
          :aria-label="modelPickerOpen ? 'Select model' : reasoningPickerOpen === 'thinking' ? 'Thinking options' : 'Reasoning effort options'"
          @keydown="onPickerKeydown"
        >
          <template v-if="modelPickerOpen">
            <input
              ref="modelSearchEl"
              :value="modelSearch"
              class="model-picker-search"
              type="search"
              role="combobox"
              aria-label="Search models or providers"
              aria-autocomplete="list"
              aria-controls="model-picker-options"
              aria-expanded="true"
              :aria-activedescendant="activeModelOptionId"
              placeholder="Search models or providers"
              @input="onModelSearchInput"
              @keydown="onModelSearchKeydown"
            />
            <div id="model-picker-options" class="model-picker-list" role="listbox">
              <div v-if="filteredModelProviders.length === 0" class="model-picker-empty">
                {{ availableModels.length === 0 ? 'No models available' : 'No matching models' }}
              </div>
              <section v-for="provider in filteredModelProviders" :key="provider.providerId" class="model-provider-group">
                <div class="model-provider-heading"><span>{{ provider.displayName ?? provider.providerId }}</span></div>
                <button
                  v-for="model in provider.models"
                  :key="modelOptionToken(provider.providerId, model.modelId)"
                  class="model-picker-option"
                  :class="{
                    selected: isSelectedModel(provider.providerId, model.modelId),
                    active: activeModelOptionIndex === modelOptionIndex(provider.providerId, model.modelId),
                  }"
                  type="button"
                  role="option"
                  :id="modelOptionId(provider.providerId, model.modelId)"
                  :aria-selected="String(isSelectedModel(provider.providerId, model.modelId))"
                  @mouseenter="activateModelOption(provider.providerId, model.modelId)"
                  @click="selectModel(provider.providerId, model.modelId)"
                >
                  <span class="model-picker-check" aria-hidden="true"><Check v-if="isSelectedModel(provider.providerId, model.modelId)" /></span>
                  <span class="model-picker-option-copy">
                    <span class="model-picker-option-name">{{ model.displayName ?? model.modelId }}</span>
                  </span>
                  <span v-if="isRuntimeDefaultModel(provider.providerId, model.modelId)" class="model-picker-default-badge">Default</span>
                </button>
              </section>
            </div>
          </template>
          <div v-else class="composer-reasoning-options">
            <button
              v-for="value in reasoningPickerOptions(reasoningPickerOpen)"
              :key="value"
              class="model-picker-option reasoning-picker-option"
              :class="{ selected: reasoningSelection[reasoningPickerOpen] === value }"
              type="button"
              role="option"
              :aria-selected="String(reasoningSelection[reasoningPickerOpen] === value)"
              :disabled="isReasoningPickerOptionDisabled(reasoningPickerOpen, value)"
              @click="selectReasoningOption(reasoningPickerOpen, value)"
            >
              <span class="model-picker-check" aria-hidden="true"><Check v-if="reasoningSelection[reasoningPickerOpen] === value" /></span>
              <span class="model-picker-option-copy"><span class="model-picker-option-name">{{ formatReasoningOption(value) }}</span></span>
            </button>
          </div>
        </div>
      </template>
    </Teleport>
  </div>
</template>
