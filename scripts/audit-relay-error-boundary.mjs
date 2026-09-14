import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const relayRoot = join(repositoryRoot, 'dist', 'extensions', 'copilot-relay-provider');
const runtimeCoreImport = /(?:\bfrom\s*|\bimport\s*['"]|\bimport\s*\(|\brequire\s*\()\s*['"]?[^'"]*[/\\]core[/\\]model-invocation(?:[/\\]|['"])/u;

for (const example of [
  'import value from "../../core/model-invocation/index.js";',
  'import "../../core/model-invocation/index.js";',
  'await import("../../core/model-invocation/index.js");',
  'require("../../core/model-invocation/index.js");',
]) {
  if (!runtimeCoreImport.test(example)) {
    throw new Error(`Relay error-boundary audit matcher rejected a runtime-import fixture: ${example}`);
  }
}
if (runtimeCoreImport.test('import "./local-module.js";')) {
  throw new Error('Relay error-boundary audit matcher rejected its local-import fixture.');
}

const productionFiles = (await collectJavaScript(relayRoot))
  .filter((path) => !path.endsWith('.test.js'));
const responsesClient = join(relayRoot, 'responses-client.js');
if (!productionFiles.includes(responsesClient)) {
  throw new Error('Relay error-boundary audit could not find emitted responses-client.js.');
}

const violations = [];
for (const path of productionFiles) {
  const content = await readFile(path, 'utf8');
  if (runtimeCoreImport.test(content)) {
    violations.push(relative(repositoryRoot, path).replaceAll('\\', '/'));
  }
}

if (violations.length > 0) {
  throw new Error(
    `Relay production JavaScript retains Host Core model-invocation imports: ${violations.join(', ')}`,
  );
}

console.log(`Relay error-boundary audit passed (${productionFiles.length} production JavaScript files).`);

async function collectJavaScript(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScript(path));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}
