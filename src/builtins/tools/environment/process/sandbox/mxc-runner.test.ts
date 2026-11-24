import { mkdtemp, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerRequest, PlatformSupport } from '@microsoft/mxc-sdk/v1';
import { createMxcCommandRunner } from './mxc-runner.js';
import { resolveSandboxConfig } from './config.js';

function fixture() {
  let resolveWait!: (result: { exitCode: number; timedOut: boolean }) => void;
  let rejectWait!: (error: Error) => void;
  const waiting = new Promise<{ exitCode: number; timedOut: boolean }>((yes, no) => {
    resolveWait = yes;
    rejectWait = no;
  });
  const native = {
    id: 321,
    standardInput: new PassThrough(),
    standardOutput: new PassThrough(),
    standardError: new PassThrough(),
    wait: vi.fn(() => waiting),
    kill: vi.fn(() => {
      native.standardOutput.end();
      native.standardError.end();
      resolveWait({ exitCode: -1, timedOut: false });
    }),
    dispose: vi.fn(),
  };
  let request: ContainerRequest | undefined;
  let envelope = '';
  native.standardInput.on('data', chunk => { envelope += chunk.toString(); });
  const sdk = {
    getPlatformSupport: vi.fn((): Pick<PlatformSupport, 'isSupported' | 'availableMethods' | 'bubblewrapNetwork'> => ({
      isSupported: true, availableMethods: ['bubblewrap'],
      bubblewrapNetwork: { proxyEnforcement: 'supported', warnings: [] },
    })),
    probe: vi.fn(() => ({
      tier: 'base-container',
      probes: { baseContainerSupportsDenyPaths: true, baseContainerSupportsEnumeratePaths: true },
    })),
    spawn: vi.fn(async (value: ContainerRequest) => { request = value; return native; }),
  };
  return {
    sdk, native, resolveWait, rejectWait,
    request: () => request,
    envelope: () => envelope,
    finish(code = 0) {
      native.standardOutput.end();
      native.standardError.end();
      resolveWait({ exitCode: code, timedOut: false });
    },
  };
}

describe.skipIf(process.platform !== 'win32' && process.platform !== 'linux')('MXC command control', () => {
  it.skipIf(process.platform !== 'linux')('rejects an alias that exposes the host /tmp root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mxc-tmp-alias-'));
    const alias = join(directory, 'alias');
    await symlink('/tmp', alias, 'dir');
    try {
      const test = fixture();
      await expect(createMxcCommandRunner(resolveSandboxConfig({ enabled: true, read: [alias] }),
        process.cwd(), async () => test.sdk)).rejects.toThrow('conflicts with private /tmp');
      expect(test.sdk.spawn).not.toHaveBeenCalled();
    } finally {
      await rm(alias);
      await rm(directory, { recursive: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('requires bubblewrap rather than accepting another available backend', async () => {
    const test = fixture();
    test.sdk.getPlatformSupport.mockReturnValue({
      isSupported: true, availableMethods: ['lxc'],
      bubblewrapNetwork: { proxyEnforcement: 'supported', warnings: [] },
    });
    await expect(createMxcCommandRunner(resolveSandboxConfig({ enabled: true }), process.cwd(), async () => test.sdk))
      .rejects.toThrow('Linux bubblewrap is unavailable');
    expect(test.sdk.spawn).not.toHaveBeenCalled();
  });

  it.each(['none', 'outbound', 'outbound-and-loopback'] as const)(
    'maps %s to native policy and trusted npm behavior without expanding file grants', async network => {
      const test = fixture();
      const config = resolveSandboxConfig({ enabled: true, network, read: [process.cwd()] });
      if (process.platform === 'linux' && network === 'outbound-and-loopback') {
        await expect(createMxcCommandRunner(config, process.cwd(), async () => test.sdk))
          .rejects.toThrow('does not support agents.sandbox.network');
        expect(test.sdk.spawn).not.toHaveBeenCalled();
        return;
      }
      const runner = await createMxcCommandRunner(config, process.cwd(), async () => test.sdk);
      const running = runner({ command: 'x', cwd: process.cwd(), env: {} });
      await vi.waitFor(() => expect(test.native.wait).toHaveBeenCalled());
      expect(test.request()?.network).toEqual({
        egress: { default: network === 'none' ? 'deny' : 'allow' },
        ingress: { default: 'deny', hostLoopback: network === 'outbound-and-loopback' ? 'allow' : 'deny' },
      });
      expect(test.request()?.environment?.npm_config_offline).toBe(network === 'none' ? 'true' : 'false');
      expect(test.request()?.filesystem?.readonlyPaths).toContain(process.cwd());
      expect(test.request()?.filesystem?.readwritePaths).not.toContain(process.cwd());
      test.native.standardOutput.write('{"type":"started","pid":123}\n');
      await running.started;
      test.finish();
      expect((await running.completion).status).toBe('completed');
    },
  );

  it('rejects unavailable network capability before starting user code', async () => {
    const test = fixture();
    if (process.platform === 'linux') {
      test.sdk.getPlatformSupport.mockReturnValue({
        isSupported: true, availableMethods: ['bubblewrap'],
        bubblewrapNetwork: { proxyEnforcement: 'unsupported', warnings: ['missing slirp4netns'] },
      });
    } else {
      test.sdk.probe.mockReturnValue({
        tier: 'unsupported',
        probes: { baseContainerSupportsDenyPaths: true, baseContainerSupportsEnumeratePaths: true },
      });
    }
    await expect(createMxcCommandRunner(resolveSandboxConfig({ enabled: true, network: 'outbound' }),
      process.cwd(), async () => test.sdk)).rejects.toThrow('unavailable');
    expect(test.sdk.spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'linux')('rejects a namespace startup frame without a meaningful host ID', async () => {
    const test = fixture();
    test.native.id = 0;
    const runner = await createMxcCommandRunner(resolveSandboxConfig({ enabled: true }), process.cwd(), async () => test.sdk);
    const running = runner({ command: 'x', cwd: process.cwd(), env: {} });
    await vi.waitFor(() => expect(test.native.wait).toHaveBeenCalled());
    test.native.standardOutput.write('{"type":"started","pid":123}\n');
    await expect(running.started).rejects.toThrow('host process ID is unavailable');
    expect((await running.completion).status).toBe('failed');
    expect(running.control.released).toBe(true);
  });

  it.each(['start', 'terminal'])('settles a $0 callback failure without stranding its owner', async stage => {
    const test = fixture();
    const runner = await createMxcCommandRunner(resolveSandboxConfig({ enabled: true }), process.cwd(), async () => test.sdk);
    const fail = () => { throw new Error('observer failed'); };
    const running = runner({
      command: 'x', cwd: process.cwd(), env: {},
      ...(stage === 'start' ? { onSpawn: fail } : { onExit: fail }),
    });
    await vi.waitFor(() => expect(test.native.wait).toHaveBeenCalled());
    test.native.standardOutput.write('{"type":"started","pid":123}\n');
    if (stage === 'start') await expect(running.started).rejects.toThrow('observer failed');
    else {
      await expect(running.started).resolves.toBe(process.platform === 'linux' ? 321 : 123);
      test.finish();
    }
    expect((await running.completion).status).toBe('failed');
    expect(running.control.released).toBe(true);
  });

  it('keeps caller hooks out of bootstrap env and consumes only the first frame', async () => {
    const test = fixture();
    const runner = await createMxcCommandRunner(resolveSandboxConfig({ enabled: true }), process.cwd(), async () => test.sdk);
    const running = runner({ command: 'node test.cjs', cwd: process.cwd(), env: { NODE_OPTIONS: '--require ./hook.cjs' } });
    await vi.waitFor(() => expect(test.native.wait).toHaveBeenCalled());
    expect(test.request()?.environment?.NODE_OPTIONS).toBeUndefined();
    expect(test.envelope()).toContain('NODE_OPTIONS');
    test.native.standardOutput.write('{"type":"star');
    test.native.standardOutput.write('ted","pid":123}\n{"type":"started","pid":999}\n' + 'x'.repeat(10000));
    await expect(running.started).resolves.toBe(process.platform === 'linux' ? 321 : 123);
    if (process.platform === 'linux') {
      expect(test.sdk.probe).not.toHaveBeenCalled();
      expect(test.request()?.containment).toEqual({ type: 'bubblewrap' });
      expect(test.request()?.environment).not.toHaveProperty('ComSpec');
      expect(test.request()?.environment).not.toHaveProperty('LOCALAPPDATA');
    }
    const root: unknown = JSON.parse(test.envelope());
    expect(root).toHaveProperty('root');
    test.finish();
    const result = await running.completion;
    expect(result.status).toBe('completed');
    expect(result.output).toContain('{"type":"started","pid":999}');
    expect(result.output).not.toContain('"pid":123');
    expect(running.control.released).toBe(true);
  });

  it('terminates a late native spawn after Abort without sending user code or publishing readiness', async () => {
    const test = fixture();
    let resolveSpawn!: (native: typeof test.native) => void;
    test.sdk.spawn.mockImplementation(() => new Promise(resolve => { resolveSpawn = resolve; }));
    const controller = new AbortController();
    const runner = await createMxcCommandRunner(resolveSandboxConfig({ enabled: true }), process.cwd(), async () => test.sdk);
    const running = runner({ command: 'user-code', cwd: process.cwd(), env: {}, signal: controller.signal });
    await vi.waitFor(() => expect(test.sdk.spawn).toHaveBeenCalled());
    controller.abort();
    resolveSpawn(test.native);
    await expect(running.started).rejects.toThrow('canceled');
    expect((await running.completion).status).toBe('aborted');
    expect(test.envelope()).toBe('');
    expect(test.native.kill).toHaveBeenCalled();
    expect(running.control.released).toBe(true);
  });

  it('retains TEMP and the control after native cleanup cannot be confirmed', async () => {
    const test = fixture();
    const runner = await createMxcCommandRunner(resolveSandboxConfig({ enabled: true }), process.cwd(), async () => test.sdk);
    const running = runner({ command: 'x', cwd: process.cwd(), env: {} });
    await vi.waitFor(() => expect(test.native.wait).toHaveBeenCalled());
    const parsed: unknown = JSON.parse(test.envelope());
    if (typeof parsed !== 'object' || parsed === null || !('root' in parsed) || typeof parsed.root !== 'string') {
      throw new Error('Missing owned fixture root');
    }
    const root = parsed.root;
    test.native.kill.mockImplementation(() => {});
    test.native.standardOutput.end();
    test.native.standardError.end();
    test.rejectWait(new Error('native release failed'));
    try {
      expect((await running.completion).status).toBe('failed');
      expect(running.control.released).toBe(false);
      await expect(running.control.terminate('abort')).rejects.toThrow('unconfirmed');
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally {
      // This is a fake native driver, so no workload owns the retained fixture.
      await rm(root, { recursive: true, force: true });
    }
  });
});
