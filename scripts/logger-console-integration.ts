/**
 * Logger → ConsoleAdapter 集成演示
 *
 * 运行：npx tsx scripts/logger-console-integration.ts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleAdapter } from '../src/logger/ConsoleAdapter.js';
import { FileAdapter } from '../src/logger/FileAdapter.js';
import { Logger } from '../src/logger/Logger.js';

const LOG_DIR = join(tmpdir(), 'demo-logs');

async function main() {
  // ── 1. configure 前：默认 ConsoleAdapter(info) ───────────
  console.log('\n=== configure 前（默认 ConsoleAdapter, minLevel: info）===');
  Logger.get('Boot').debug('this should be filtered');
  Logger.get('Boot').info('application initializing');
  Logger.get('Boot').warn('config file not found, using defaults');
  Logger.get('Boot').error('this is an error → goes to stderr');

  // ── 2. configure：切换到 debug 级别 ─────────────────────
  console.log('\n=== configure 后（minLevel: debug）===');
  await Logger.configure({
    adapters: [new ConsoleAdapter({ colors: true })],
    minLevel: 'debug',
  });

  const agentLogger = Logger.get('AgentRunner');
  const sessionLogger = Logger.get('SessionManager');

  agentLogger.debug('loading history', { sessionKey: 'main', messages: 12 });
  agentLogger.info('turn started', { sessionKey: 'main' });
  sessionLogger.info('session resolved', { sessionKey: 'main', sessionId: 'abc-123' });
  agentLogger.warn('context nearing limit', { usedTokens: 180_000, maxTokens: 200_000 });
  agentLogger.error('LLM call failed', { error: 'timeout', round: 3 });

  // ── 3. setLevel 实时调整 ─────────────────────────────────
  console.log('\n=== setLevel(warn) 后 ===');
  Logger.setLevel('warn');
  agentLogger.debug('filtered');
  agentLogger.info('filtered');
  agentLogger.warn('only warn and above visible');
  agentLogger.error('error still visible → stderr');

  // ── 4. 多 adapter：Console + File ───────────────────────
  console.log(`\n=== Console + File adapter（查看 ${LOG_DIR}）===`);
  const fileAdapter = new FileAdapter({ dir: LOG_DIR, prefix: 'demo' });
  await Logger.configure({
    adapters: [
      new ConsoleAdapter({ colors: true }),
      fileAdapter,
    ],
    minLevel: 'info',
  });

  Logger.get('RuntimeApp').info('runtime ready', { tools: ['read_file', 'exec', 'web_fetch'] });
  Logger.get('AgentRunner').warn('tool result pruned', { toolName: 'read_file', originalChars: 50_000 });

  await Logger.close();
  console.log(`\n✓ Logger closed. File output written to: ${LOG_DIR}`);
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
