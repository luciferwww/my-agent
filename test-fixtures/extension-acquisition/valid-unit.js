const contextMarker = Symbol.for('my-agent.test.extension-acquisition.factory-context');
const createMarker = Symbol.for('my-agent.test.extension-acquisition.unit-create');

globalThis[Symbol.for('my-agent.test.extension-acquisition.imported')] = true;

export function createExtension(context) {
  globalThis[contextMarker] = context;
  return {
    unitId: 'fixture-valid',
    source: 'external',
    orderKey: 'extension-controlled-order',
    required: false,
    initiallyEnabled: true,
    dependencies: [],
    create() {
      globalThis[createMarker] = true;
      throw new Error('Runtime owns Unit creation.');
    },
  };
}
