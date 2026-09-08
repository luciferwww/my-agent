import type { RuntimeHandle, RuntimeShutdownReport } from '../src/runtime/index.js';

export interface RuntimeHostOptions {
  readonly overallTimeoutMs?: number;
  readonly onForceExit?: (code: number) => never;
}

/** Owns process signals around an embedded RuntimeHandle; Runtime code never exits the process. */
export function createRuntimeHost(
  runtime: Pick<RuntimeHandle, 'close'>,
  options: RuntimeHostOptions = {},
) {
  const overallTimeoutMs = options.overallTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs < 1) {
    throw new Error('overallTimeoutMs must be a positive safe integer.');
  }
  const forceExit = options.onForceExit ?? ((code: number): never => process.exit(code));
  let closePromise: Promise<RuntimeShutdownReport> | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let signalCount = 0;

  const dispose = (): void => {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    if (forceTimer) clearTimeout(forceTimer);
    forceTimer = undefined;
  };

  const shutdown = (reason: string): Promise<RuntimeShutdownReport> => {
    closePromise ??= runtime.close(reason).then((report) => {
      dispose();
      if (report.outcome !== 'completed') process.exitCode = 1;
      return report;
    }, (error: unknown) => {
      dispose();
      process.exitCode = 1;
      throw error;
    });
    if (!forceTimer) {
      forceTimer = setTimeout(() => forceExit(1), overallTimeoutMs);
      forceTimer.unref?.();
    }
    return closePromise;
  };

  const handleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    signalCount += 1;
    if (signalCount > 1) {
      forceExit(signal === 'SIGINT' ? 130 : 143);
    }
    void shutdown(signal === 'SIGINT' ? 'process interrupted' : 'process terminated');
  };
  const onSigInt = (): void => handleSignal('SIGINT');
  const onSigTerm = (): void => handleSignal('SIGTERM');

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  return Object.freeze({ shutdown, dispose });
}
