const marker = Symbol.for('my-agent.test.extension-acquisition.executions');
globalThis[marker] = (globalThis[marker] ?? 0) + 1;

export function createExtension() {
  throw new Error('The A1 fixture entry must not execute.');
}
