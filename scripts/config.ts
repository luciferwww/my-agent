/**
 * Config Wizard 薄壳入口。
 *
 * 实现位于 src/platform/config/wizard/。
 * runWizard 绝不调 process.exit；本薄壳 catch 时按 WizardArgError.exitCode 分流。
 *
 * Usage: npx tsx scripts/config.ts [--path <file>] [--help|-h]
 */

import { runWizard, WizardArgError } from '../src/platform/config/wizard/index.js';

runWizard(process.argv.slice(2)).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err instanceof WizardArgError ? err.exitCode : 1;
  process.stderr.write(`\x1b[31mError: ${msg}\x1b[0m\n`);
  process.exit(code);
});
