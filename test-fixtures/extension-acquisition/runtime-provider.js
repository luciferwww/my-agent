export function createExtension() {
  return {
    unitId: 'fixture-runtime-provider',
    source: 'external',
    orderKey: 'fixture-runtime-provider',
    required: false,
    initiallyEnabled: true,
    dependencies: [],
    create() {
      return {
        registration: {
          id: 'fixture-runtime-provider',
          source: 'external',
          register(api) {
            api.registerProvider({
              id: 'fixture-provider',
              displayName: 'Fixture Provider',
              models: [{ modelId: 'fixture-model', displayName: 'Fixture Model' }],
              protocol: 'fixture',
              invocationPort: {},
              resolveConnection() {
                return { ok: false, category: 'connection_missing', message: 'unused' };
              },
              resolveModel() {
                return { ok: false, category: 'model_rejected', message: 'unused' };
              },
            });
          },
        },
        start() {},
        stop() {},
      };
    },
  };
}
