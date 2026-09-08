import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RUNTIME_DEADLINE_POLICY,
  RuntimeDeadlineBudget,
  resolveRuntimeDeadlinePolicy,
  type RuntimeDeadlineDriver,
} from './runtime-deadline.js';

describe('runtime deadline policy', () => {
  it('resolves immutable defaults and partial overrides', () => {
    const policy = resolveRuntimeDeadlinePolicy({ shutdownOverallMs: 42 });
    expect(policy).toEqual({ ...DEFAULT_RUNTIME_DEADLINE_POLICY, shutdownOverallMs: 42 });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid deadline value %s',
    (value) => {
      expect(() => resolveRuntimeDeadlinePolicy({ shutdownOverallMs: value }))
        .toThrow('shutdownOverallMs must be a positive safe integer.');
    },
  );

  it('caps every phase by one absolute shutdown deadline', async () => {
    let now = 100;
    const race = vi.fn(async <T>(operation: Promise<T>) => ({
      outcome: 'completed' as const,
      value: await operation,
    }));
    const driver: RuntimeDeadlineDriver = {
      now: () => now,
      race: race as RuntimeDeadlineDriver['race'],
    };
    const budget = new RuntimeDeadlineBudget(
      driver,
      resolveRuntimeDeadlinePolicy({ shutdownOverallMs: 60 }),
    );

    await budget.race(Promise.resolve('first'), 30);
    expect(race).toHaveBeenLastCalledWith(expect.any(Promise), 130);

    now = 150;
    await budget.race(Promise.resolve('second'), 30);
    expect(race).toHaveBeenLastCalledWith(expect.any(Promise), 160);

    now = 160;
    await expect(budget.race(Promise.resolve('late'), 30)).resolves.toEqual({
      outcome: 'deadline-exhausted',
    });
    expect(race).toHaveBeenCalledTimes(2);
  });
});
