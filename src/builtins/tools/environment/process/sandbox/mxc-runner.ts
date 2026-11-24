import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import { Logger } from '../../../../../platform/logger/index.js';
import type { CommandRunner, OutputChunk, RunCommandOptions } from '../exec-types.js';
import { BOOTSTRAP_FRAME_BYTES, BOOTSTRAP_REQUEST_BYTES, ROOT_VARIABLE, validateCommandEnvironment } from './bootstrap.js';
import type { SandboxConfig } from './config.js';

interface SandboxProcess {
  readonly id: number;
  readonly standardInput: Writable | null;
  readonly standardOutput: Readable | null;
  readonly standardError: Readable | null;
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): void;
  dispose(): void;
}

interface SandboxSdk {
  probe(request?: ContainerRequest): {
    tier?: string;
    error?: string;
    probes: { baseContainerSupportsDenyPaths: boolean; baseContainerSupportsEnumeratePaths: boolean };
  };
  spawn(request: ContainerRequest): Promise<SandboxProcess>;
}

const log = Logger.get('ExecSandbox');
const bootstrapPath = fileURLToPath(new URL(
  import.meta.url.endsWith('.ts') ? './bootstrap.ts' : './bootstrap.js', import.meta.url,
));

function contains(root: string, path: string): boolean {
  const target = relative(root, path);
  return !isAbsolute(target) && target !== '..' && !target.startsWith('..\\');
}

function requirePaths(config: SandboxConfig, paths: readonly string[]): void {
  for (const path of paths) {
    if (config.deniedPaths.some(denied => contains(denied, path))) {
      throw new Error(`Required sandbox path is denied: ${path}`);
    }
  }
}

function environment(root: string) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('Windows SystemRoot is unavailable');
  const comSpec = process.env.ComSpec ?? join(systemRoot, 'System32', 'cmd.exe');
  if (!isAbsolute(comSpec)) throw new Error('Windows ComSpec must be absolute');
  return {
    SystemRoot: systemRoot,
    SystemDrive: process.env.SystemDrive ?? 'C:',
    ComSpec: comSpec,
    PATH: `${dirname(process.execPath)};${process.env.PATH ?? join(systemRoot, 'System32')}`,
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    HOME: root, USERPROFILE: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
    [ROOT_VARIABLE]: root,
  };
}

export async function createMxcCommandRunner(
  config: SandboxConfig,
  agentHome: string,
  loadSdk: () => Promise<SandboxSdk> = async () => import('@microsoft/mxc-sdk/v1'),
): Promise<CommandRunner> {
  if (process.platform !== 'win32') throw new Error('Exec sandbox requires supported Windows BaseContainer');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor === undefined || minor < 21) {
    throw new Error('Exec sandbox requires Node 24.21 or later within Node 24 LTS');
  }
  const sdk = await loadSdk();
  const support = sdk.probe();
  if (support.tier !== 'base-container' || !support.probes.baseContainerSupportsEnumeratePaths
    || (config.deniedPaths.length > 0 && !support.probes.baseContainerSupportsDenyPaths)) {
    throw new Error(`Exec sandbox is unavailable: ${support.error ?? 'required native capabilities are missing'}`);
  }
  const systemRoot = environment(tmpdir()).SystemRoot;
  const reads = [bootstrapPath, dirname(process.execPath), join(systemRoot, 'System32')];
  // Node determines the entry's module type from its nearest package manifest.
  let directory = dirname(bootstrapPath);
  while (true) {
    const manifest = join(directory, 'package.json');
    try {
      if ((await stat(manifest)).isFile()) {
        reads.push(manifest);
        break;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  requirePaths(config, reads);
  const temporaryBase = await realpath(tmpdir());
  if (contains(resolve(agentHome), temporaryBase)) throw new Error('Sandbox temporary base must be outside Agent Home');
  return options => runSandboxCommand(sdk, config, reads, temporaryBase, options);
}

function runSandboxCommand(
  sdk: SandboxSdk,
  config: SandboxConfig,
  reads: string[],
  temporaryBase: string,
  options: RunCommandOptions,
) {
  let native: SandboxProcess | undefined;
  let nativeWait: ReturnType<SandboxProcess['wait']> | undefined;
  let outputWaits: Promise<void>[] = [];
  const streams: Readable[] = [];
  let root: string | undefined;
  let released = false;
  let stopReason: 'manual' | 'timeout' | 'abort' | undefined;
  let failure: Error | undefined;
  const canceled = new Error('Sandbox startup was canceled');
  let startedSettled = false;
  let resolveStarted!: (pid: number) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<number>((yes, no) => { resolveStarted = yes; rejectStarted = no; });
  // Foreground callers observe completion rather than started; the same failure is reported there.
  void started.catch(() => undefined);
  const output: string[] = [];
  let resolveCompletion!: (value: {
    mode: 'foreground'; status: 'completed' | 'failed' | 'timed_out' | 'aborted';
    output: string; exitCode?: number; errorMessage?: string;
  }) => void;
  const completion = new Promise<{
    mode: 'foreground'; status: 'completed' | 'failed' | 'timed_out' | 'aborted';
    output: string; exitCode?: number; errorMessage?: string;
  }>(yes => { resolveCompletion = yes; });

  function stop(reason: 'manual' | 'timeout' | 'abort'): void {
    stopReason ??= reason;
    native?.kill();
  }
  function stopSafely(reason: 'timeout' | 'abort') {
    try {
      stop(reason);
    } catch {
      failure = new Error('Sandbox process termination failed');
      log.error('Sandbox process termination failed');
    }
  }
  const onAbort = () => stopSafely('abort');
  const timeout = options.timeoutMs ? setTimeout(() => stopSafely('timeout'), options.timeoutMs) : undefined;
  if (options.signal?.aborted) stopReason = 'abort';
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  function rejectStart(error: Error) {
    if (startedSettled) return;
    startedSettled = true;
    rejectStarted(error);
  }
  function push(stream: 'stdout' | 'stderr', text: string) {
    if (!text) return;
    output.push(text);
    const chunk: OutputChunk = { stream, text, timestamp: Date.now() };
    (stream === 'stdout' ? options.onStdout : options.onStderr)?.(chunk);
  }
  function watch(stream: Readable | null, kind: 'stdout' | 'stderr'): Promise<void> {
    if (!stream) return Promise.reject(new Error(`Sandbox ${kind} is unavailable`));
    streams.push(stream);
    const decoder = new StringDecoder('utf8');
    let header = Buffer.alloc(0);
    let parsed = kind === 'stderr';
    return new Promise<void>((yes, no) => {
      let finished = false;
      const failed = (error: Error) => {
        if (finished) return;
        finished = true;
        failure = error;
        rejectStart(error);
        try { native?.kill(); } catch { log.error('Sandbox stream failure cleanup remains unconfirmed'); }
        no(error);
      };
      stream.on('data', (chunk: unknown) => {
        if (finished) return;
        try {
          if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') throw new Error('Invalid sandbox output chunk');
          let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (!parsed) {
            header = Buffer.concat([header, bytes]);
            const newline = header.indexOf(10);
            if (newline < 0) {
              if (header.length > BOOTSTRAP_FRAME_BYTES) throw new Error('Sandbox startup frame exceeds 4 KiB');
              return;
            }
            if (newline > BOOTSTRAP_FRAME_BYTES) throw new Error('Sandbox startup frame exceeds 4 KiB');
            let frame: unknown;
            try { frame = JSON.parse(header.subarray(0, newline).toString('utf8')); }
            catch { throw new Error('Invalid sandbox startup frame'); }
            if (typeof frame !== 'object' || frame === null || !('type' in frame)) throw new Error('Invalid sandbox startup frame');
            if (frame.type === 'failed') {
              if (stopReason) {
                parsed = true;
                rejectStart(canceled);
                return;
              }
              throw new Error('message' in frame && typeof frame.message === 'string'
                ? frame.message : 'Sandbox command could not start');
            }
            if (frame.type !== 'started' || !('pid' in frame) || typeof frame.pid !== 'number'
              || !Number.isSafeInteger(frame.pid) || frame.pid <= 0) throw new Error('Invalid sandbox startup PID');
            parsed = true;
            // A native chunk can contain both the frame and large user output; cap only the frame.
            bytes = header.subarray(newline + 1);
            header = Buffer.alloc(0);
            if (stopReason) rejectStart(canceled);
            else {
              options.onSpawn?.(frame.pid);
              startedSettled = true;
              resolveStarted(frame.pid);
            }
          }
          push(kind, decoder.write(bytes));
        } catch (error) {
          failed(error instanceof Error ? error : new Error('Sandbox output failed'));
        }
      });
      stream.once('error', error => {
        failed(error);
      });
      stream.once('end', () => {
        if (finished) return;
        if (!parsed && stopReason) {
          rejectStart(canceled);
          finished = true;
          yes();
        } else if (!parsed) {
          const error = new Error('Sandbox ended without command readiness');
          rejectStart(error);
          finished = true;
          no(error);
        } else {
          try {
            push(kind, decoder.end());
            finished = true;
            yes();
          } catch (error) {
            failed(error instanceof Error ? error : new Error('Sandbox output failed'));
          }
        }
      });
      stream.once('close', () => {
        if (finished) return;
        if (stopReason || failure) {
          finished = true;
          yes();
        } else failed(new Error(`Sandbox ${kind} closed before output completion`));
      });
    });
  }

  // The Tool installs the control in its lifecycle owner before native work begins.
  queueMicrotask(() => {
    void (async () => {
      let exitCode: number | undefined;
      let nativeReleased = false;
      try {
        if (stopReason) {
          released = true;
          throw canceled;
        }
        if (!/^[a-z]:\\/iu.test(options.cwd) || options.cwd.includes('\0')) {
          throw new Error('Sandbox cwd must be an absolute local Windows path');
        }
        const userEnvironment = validateCommandEnvironment(options.env);
        root = await mkdtemp(join(temporaryBase, 'my-agent-exec-'));
        requirePaths(config, [root]);
        const envelope = JSON.stringify({ command: options.command, root, environment: userEnvironment });
        if (Buffer.byteLength(envelope) > BOOTSTRAP_REQUEST_BYTES) throw new Error('Sandbox request exceeds 64 KiB');
        const request: ContainerRequest = {
          command: `"${process.execPath}" "${bootstrapPath}"`,
          workingDirectory: options.cwd,
          environment: environment(root),
          inheritDefaultEnvironment: false,
          filesystem: { readonlyPaths: [...reads, ...config.readonlyPaths], readwritePaths: [root, ...config.readwritePaths], deniedPaths: [...config.deniedPaths] },
          network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } },
          ui: { disable: false, clipboard: 'none', allowInputInjection: false },
          containment: { type: 'processcontainer', config: {
            filesystem: { enumeratePaths: [...new Set([
              process.execPath, bootstrapPath, options.cwd, root,
              ...config.readonlyPaths, ...config.readwritePaths,
            ].map(path => resolve(path).slice(0, 3)))] },
            ui: { isolation: 'container', desktopSystemControl: false, systemSettings: 'none', ime: false },
          } },
        };
        const probe = sdk.probe(request);
        if (probe.tier !== 'base-container') throw new Error(`Sandbox request is unsupported: ${probe.error ?? 'native policy unavailable'}`);
        if (stopReason) throw canceled;
        native = await sdk.spawn(request);
        const input = native.standardInput;
        if (!input) throw new Error('Sandbox stdin is unavailable');
        const stdout = watch(native.standardOutput, 'stdout');
        const stderr = watch(native.standardError, 'stderr');
        outputWaits = [stdout, stderr];
        nativeWait = native.wait();
        input.once('error', error => {
          if (!released && !stopReason) {
            failure = error;
            rejectStart(error);
            try { native?.kill(); } catch { log.error('Sandbox stdin failure cleanup remains unconfirmed'); }
          }
        });
        if (stopReason) {
          rejectStart(canceled);
          native.kill();
          input.end();
        } else input.end(envelope);
        const [result] = await Promise.all([nativeWait, stdout, stderr]);
        exitCode = result.exitCode;
        nativeReleased = true;
      } catch (error) {
        if (error !== canceled) failure ??= error instanceof Error ? error : new Error('Sandbox execution failed');
        rejectStart(failure ?? canceled);
        if (native) {
          try {
            native.kill();
            nativeWait ??= native.wait();
            const result = await nativeWait;
            exitCode = result.exitCode;
            nativeReleased = true;
          } catch {
            log.error('Sandbox native cleanup remains unconfirmed');
          }
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        if (failure) {
          for (const stream of streams) stream.destroy();
          await Promise.allSettled(outputWaits);
        }
        // A failed wait/free is not evidence of release; keep TEMP and the owner for shutdown.
        if (!native || nativeReleased) {
          try {
            native?.dispose();
            if (root) await rm(root, { recursive: true, force: true });
            released = true;
          } catch {
            failure = new Error('Sandbox temporary cleanup failed');
            log.error('Sandbox temporary cleanup remains unconfirmed');
          }
        }
        let status: 'failed' | 'timed_out' | 'aborted' | 'completed' = failure ? 'failed'
          : stopReason === 'timeout' ? 'timed_out'
          : stopReason ? 'aborted'
          : failure || exitCode !== 0 ? 'failed' : 'completed';
        let errorMessage = status === 'timed_out' && options.timeoutMs
          ? `Process timed out after ${options.timeoutMs / 1000} seconds`
          : failure?.message;
        rejectStart(new Error(errorMessage ?? 'Sandbox ended before command readiness'));
        try {
          options.onExit?.({ status, exitCode, errorMessage });
        } catch {
          status = 'failed';
          errorMessage = 'Sandbox terminal observer failed';
          log.error(errorMessage);
        }
        resolveCompletion({ mode: 'foreground', status, output: output.join(''), exitCode, errorMessage });
      }
    })();
  });
  return {
    started, completion,
    control: {
      sandboxed: true,
      get released() { return released; },
      async terminate(reason: 'manual' | 'timeout' | 'abort') {
        stop(reason);
        await completion;
        if (!released) throw new Error('Sandbox cleanup remains unconfirmed');
      },
    },
  };
}
