/**
 * Vitest 全局 setup：跑测试前把 Logger 静音。
 *
 * - 立刻把全局 Logger 切到 'error' 级别（不带 adapter），覆盖默认的 ConsoleAdapter(info)
 * - mock 掉 Logger.configure，避免被 bootstrapRuntime 等代码路径再切回 ConsoleAdapter
 *
 * 想在某个测试里看 logger 输出？在该测试内 `vi.restoreAllMocks()` 后手动 `Logger.configure(...)`。
 */

import { beforeAll, vi } from 'vitest';
import { Logger } from './platform/logger/Logger.js';

beforeAll(async () => {
  await Logger.configure({ adapters: [], minLevel: 'error' });
  vi.spyOn(Logger, 'configure').mockResolvedValue(undefined);
});
