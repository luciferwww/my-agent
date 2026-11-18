import type { ModelInvocationPort } from '../core/model-invocation/index.js';
import type { ProviderProjectionEntry } from '../core/model-resolution/index.js';

export const unusedInvocationPort: ModelInvocationPort = {
  async chat() { throw new Error('Unexpected Provider invocation in test.'); },
  chatStream() { throw new Error('Unexpected Provider stream in test.'); },
};

export function providerPort(provider: ProviderProjectionEntry): ModelInvocationPort {
  const resolve = async (model: string) => {
    const catalog = await provider.getModelCatalog();
    const connection = provider.resolveConnection();
    if (!connection.ok) throw new Error(connection.message);
    const result = catalog.resolveModel(model, connection.connection);
    if (!result.ok) throw new Error(result.message);
    return result.descriptor.invocationPort;
  };
  return {
    async chat(request) {
      return (await resolve(request.model)).chat(request);
    },
    async *chatStream(request) {
      yield* (await resolve(request.model)).chatStream(request);
    },
  };
}
