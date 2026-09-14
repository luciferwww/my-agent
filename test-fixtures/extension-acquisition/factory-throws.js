export function createExtension({ config }) {
  throw new Error(`Extension rejected secret: ${String(config.secret)}`);
}
