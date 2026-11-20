import type { ProviderModelFacts } from 'my-agent/extension-api';
import type { CopilotModel } from './auth.js';
import { LoginError } from './auth.js';
import { parseCopilotModelCatalog } from './catalog-metadata.js';
import type { CopilotWireProtocol } from './client-types.js';
import { asRecord } from './responses-client.js';

export { COPILOT_PROVIDER_ID } from './responses-client.js';
export type { CopilotWireProtocol } from './client-types.js';
export const COPILOT_PROTOCOL = 'github-copilot-model-router';

export interface CopilotModelBinding {
  readonly modelId: string;
  readonly displayName?: string;
  readonly apiBase: string;
  readonly wireProtocol: CopilotWireProtocol;
  readonly facts: ProviderModelFacts;
}

export function bindCopilotModels(
  models: readonly CopilotModel[],
  warn: (message: string) => void,
): readonly CopilotModelBinding[] {
  for (const model of models) {
    const endpoints = model.metadata.supported_endpoints;
    if (endpoints !== undefined && (!Array.isArray(endpoints) || endpoints.some((value) => typeof value !== 'string'))) {
      throw new LoginError('Copilot returned invalid model endpoint metadata.');
    }
    const supports = asRecord(asRecord(model.metadata.capabilities)?.supports);
    for (const name of ['tool_calls', 'vision', 'streaming']) {
      if (supports?.[name] !== undefined && typeof supports[name] !== 'boolean') {
        throw new LoginError('Copilot returned invalid model capability metadata.');
      }
    }
  }
  const parsed = parseCopilotModelCatalog({ data: models
    .filter((model) => asRecord(asRecord(model.metadata.capabilities)?.supports)?.streaming !== false)
    .map((model) => model.metadata),
  }, (diagnostic) => warn(`Copilot ignored ${diagnostic.ignoredValueCount} unrecognized reasoning effort values.`));
  const bindings: CopilotModelBinding[] = [];
  for (const model of models) {
    const binding = parsed.get(model.modelId);
    if (binding) bindings.push(Object.freeze({
      modelId: model.modelId, ...(model.displayName ? { displayName: model.displayName } : {}),
      apiBase: model.apiBase, wireProtocol: binding.protocol, facts: binding.facts,
    }));
  }
  if (bindings.length !== models.length) warn(`Copilot excluded ${models.length - bindings.length} models without a supported streaming protocol and complete token limits.`);
  return Object.freeze(bindings);
}
