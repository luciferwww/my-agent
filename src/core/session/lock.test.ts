import { describe, it, expect } from 'vitest';
import { withFileLock } from './lock.js';

describe('withFileLock', () => {
  it('executes a single operation normally', async () => {
    const result = await withFileLock('/fake/path', async () => 42);
    expect(result).toBe(42);
  });

  it('queues concurrent operations on the same file', async () => {
    const order: number[] = [];

    const op = (n: number, delayMs: number) =>
      withFileLock('/same/file', async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(n);
        return n;
      });

    // 同时发起 3 个操作
    const [r1, r2, r3] = await Promise.all([
      op(1, 30),
      op(2, 10),
      op(3, 10),
    ]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(r3).toBe(3);
    // 应该按发起顺序执行，不是按耗时排序
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not block operations on different files', async () => {
    const order: string[] = [];

    const slow = withFileLock('/file-a', async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push('a');
    });

    const fast = withFileLock('/file-b', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('b');
    });

    await Promise.all([slow, fast]);
    // /file-b 应该先完成，因为不同文件互不阻塞
    expect(order).toEqual(['b', 'a']);
  });

  it('releases lock when operation throws', async () => {
    // 第一个操作抛出异常
    await expect(
      withFileLock('/error/file', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 第二个操作应该正常执行（锁已释放）
    const result = await withFileLock('/error/file', async () => 'ok');
    expect(result).toBe('ok');
  });
});
