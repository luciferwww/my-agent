/**
 * Per-file Promise 队列锁。
 * 确保同一个文件的写操作排队执行，不同文件互不阻塞。
 *
 * 参考 OpenClaw 的 withSessionStoreLock()（src/config/sessions/store.ts）。
 */

const locks = new Map<string, Promise<void>>();

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = locks.get(filePath) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  locks.set(filePath, next);

  try {
    await current;
    return await fn();
  } finally {
    resolve();
    if (locks.get(filePath) === next) {
      locks.delete(filePath);
    }
  }
}
