import { describe, expect, it, vi } from 'vitest';
import { readProviderModelCatalog } from './provider-catalog.js';
import type { ProviderProjectionEntry } from './types.js';

describe('Provider-owned catalog reads', () => {
  it('reads each time and never retains a Core model catalog', async () => {
    let models = [{ modelId: 'first' }];
    const provider: ProviderProjectionEntry = {
      id: 'test',
      protocol: 'test',
      resolveConnection: () => ({ ok: false, category: 'connection_missing', message: 'unused' }),
      getModelCatalog: vi.fn(async () => ({
        models,
        resolveModel: () => ({ ok: false, category: 'model_rejected', message: 'unused' } as const),
      })),
    };
    const first = await readProviderModelCatalog(provider);
    models = [{ modelId: 'second' }];
    const second = await readProviderModelCatalog(provider);
    expect(first.models).toEqual([{ modelId: 'first' }]);
    expect(second.models).toEqual([{ modelId: 'second' }]);
    expect(provider.getModelCatalog).toHaveBeenCalledTimes(2);
  });
});
