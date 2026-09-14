export function createExtension() {
  return {
    unitId: 'wrong-id',
    source: 'external',
    orderKey: 'wrong-id',
    required: false,
    initiallyEnabled: true,
    dependencies: [],
    create() {
      throw new Error('Runtime owns Unit creation.');
    },
  };
}
