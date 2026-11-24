import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformSupport, probe } from '@microsoft/mxc-sdk/v1';
import { TEST_TOOL_CONTEXT } from '../../../../../core/tools/test-utils.js';
import { createExecTool } from '../exec-tool.js';
import type { CommandRunner } from '../exec-types.js';
import { processTool } from '../process-tool.js';
import { processRegistry } from '../process-registry.js';
import { resolveSandboxConfig } from './config.js';
import { createMxcCommandRunner } from './mxc-runner.js';

const supported = process.platform === 'win32' ? probe().tier === 'base-container'
  : process.platform === 'linux' && getPlatformSupport().availableMethods.includes('bubblewrap');

describe.skipIf(!supported)('MXC execution boundary', () => {
  let root: string;
  let home: string;
  let work: string;
  let runner: CommandRunner;
  let calls = 0;
  const sessionId = `mxc-integration-${process.pid}`;
  function context(signal = new AbortController().signal) {
    return { ...TEST_TOOL_CONTEXT, sessionId, executionId: `${sessionId}-${++calls}`, signal };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mxc-integration-'));
    home = join(root, 'home');
    work = join(root, 'work');
    await mkdir(home);
    await mkdir(work);
    await mkdir(join(work, 'private'));
    await writeFile(join(work, 'allowed.txt'), 'SYNTHETIC_ALLOWED');
    await writeFile(join(work, 'wait.cjs'), 'console.log("READY");setInterval(()=>{},1000);');
    await writeFile(join(work, 'private', 'secret.txt'), 'SYNTHETIC_DENIED');
    await symlink(join(work, 'private'), join(work, 'private-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    runner = await createMxcCommandRunner(resolveSandboxConfig({
      enabled: true, write: [work], deny: [join(work, 'private')],
    }), home);
  });

  afterAll(async () => {
    await processRegistry.cleanupSession(sessionId);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('preserves original cwd and denies nested data while providing ready private TEMP', async () => {
    await writeFile(join(work, 'check.cjs'), [
      'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict");',
      'assert.equal(fs.readFileSync("allowed.txt","utf8"),"SYNTHETIC_ALLOWED");',
      `assert.throws(()=>fs.readFileSync("private/secret.txt"),{code:"${process.platform === 'win32' ? 'EPERM' : 'ENOENT'}"});`,
      `assert.throws(()=>fs.readFileSync("private-alias/secret.txt"),{code:"${process.platform === 'win32' ? 'EPERM' : 'ENOENT'}"});`,
      'fs.writeFileSync("generated.txt","SYNTHETIC_GENERATED");',
      'const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"node-data-"));',
      'console.log(JSON.stringify({cwd:process.cwd(),temporary}));',
    ].join('\n'));
    const result = await createExecTool(home, runner).execute({ command: 'node check.cjs', cwd: work }, context());
    expect(result.outcome).toBe('success');
    const output: unknown = JSON.parse(result.content.trim());
    if (typeof output !== 'object' || output === null || !('temporary' in output) || typeof output.temporary !== 'string') {
      throw new Error('Missing private TEMP result');
    }
    expect(output).toHaveProperty('cwd', work);
    await expect(stat(output.temporary)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(work, 'generated.txt'), 'utf8')).toBe('SYNTHETIC_GENERATED');
    expect(await readFile(join(work, 'private', 'secret.txt'), 'utf8')).toBe('SYNTHETIC_DENIED');
  }, 10_000);

  it.skipIf(process.platform !== 'linux')('does not hand off a bwrap launch that cannot reach the cwd', async () => {
    const result = await createExecTool(home, runner).execute({
      command: 'echo MUST_NOT_RUN', cwd: join(work, 'missing'), background: true,
    }, context());
    expect(result.outcome).toBe('failed');
    expect(result.content).not.toContain('runId:');
    expect(processRegistry.listVisible(sessionId)).toEqual([]);
  }, 10_000);

  it.skipIf(process.platform !== 'linux')('runs an ordinary offline npm task with ready private HOME/cache', async () => {
    await writeFile(join(work, 'package.json'), JSON.stringify({
      name: 'linux-mxc-fixture', private: true, scripts: { test: 'node home.cjs' },
    }));
    await writeFile(join(work, 'home.cjs'), [
      'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");',
      'fs.writeFileSync(path.join(os.homedir(),"marker.txt"),"SYNTHETIC_HOME");',
      'fs.writeFileSync(path.join(process.env.npm_config_cache,"cache-marker.txt"),"SYNTHETIC_CACHE");',
      'console.log("OFFLINE_NPM_PASSED");',
    ].join('\n'));
    const result = await createExecTool(home, runner).execute({
      command: 'npm run test --ignore-scripts --no-audit --no-fund', cwd: work,
    }, context());
    expect(result.outcome).toBe('success');
    expect(result.content).toContain('OFFLINE_NPM_PASSED');
  }, 10_000);

  it('applies caller Node hooks only to the command and leaves fake frames as user output', async () => {
    const hook = join(work, 'hook.cjs');
    await writeFile(hook, [
      'require("node:fs").writeFileSync("hook-observation.json",JSON.stringify({entry:process.argv[1]}));',
      'console.log(JSON.stringify({type:"started",pid:999999}));',
    ].join('\n'));
    const result = await createExecTool(home, runner).execute({
      command: 'node check.cjs', cwd: work,
      env: { NODE_OPTIONS: `--require=${JSON.stringify(hook)}` },
    }, context());
    expect(result.outcome).toBe('success');
    expect(result.content).toContain('"pid":999999');
    const observation: unknown = JSON.parse(await readFile(join(work, 'hook-observation.json'), 'utf8'));
    expect(observation).toEqual({ entry: join(work, 'check.cjs') });
  }, 10_000);

  it('hands off background ownership and kills the native tree through Process Tool', async () => {
    const parent = new AbortController();
    const ctx = context(parent.signal);
    const result = await createExecTool(home, runner).execute({
      command: 'node wait.cjs', cwd: work, background: true,
    }, ctx);
    expect(result.outcome).toBe('success');
    const id = /runId:\s*(\S+)/u.exec(result.content)?.[1];
    if (!id) throw new Error('No managed sandbox runId');
    parent.abort();
    await expect.poll(async () => (await processTool.execute({ action: 'log', runId: id }, ctx)).content).toContain('READY');
    const killed = await processTool.execute({ action: 'kill', runId: id }, ctx);
    expect(killed.outcome).toBe('success');
    expect(killed.content).toContain('status: aborted');
  }, 10_000);

  it('settles timeout without publishing a running foreground resource', async () => {
    const result = await createExecTool(home, runner).execute({
      command: 'node wait.cjs', cwd: work, timeout: 1,
    }, context());
    expect(result.outcome).toBe('failed');
    expect(result.content).toContain('timed out after 1 seconds');
  }, 10_000);

  it('yields an owned sandbox and converges Session cleanup after handoff', async () => {
    const parent = new AbortController();
    const ctx = context(parent.signal);
    const result = await createExecTool(home, runner).execute({
      command: 'node wait.cjs', cwd: work, yieldMs: 25,
    }, ctx);
    expect(result.outcome).toBe('success');
    const id = /runId:\s*(\S+)/u.exec(result.content)?.[1];
    if (!id) throw new Error('No yielded sandbox runId');
    const record = processRegistry.get(id, sessionId);
    if (!record?.pid) throw new Error('No owned Shell PID');
    if (process.platform === 'linux') {
      const command = await readFile(`/proc/${record.pid}/comm`, 'utf8');
      expect(command.trim()).toBe('bwrap');
    }
    parent.abort();
    await processRegistry.cleanupSession(sessionId);
    expect(processRegistry.get(id, sessionId)).toBeUndefined();
    expect(() => process.kill(record.pid!, 0)).toThrow();
  }, 10_000);

  it.each(['none', 'outbound', 'outbound-and-loopback'] as const)('enforces %s host-loopback access with a reachable outside-sandbox control', async network => {
    if (process.platform === 'linux' && (network === 'outbound-and-loopback'
      || (network === 'outbound' && getPlatformSupport().bubblewrapNetwork?.proxyEnforcement !== 'supported'))) {
      await expect(createMxcCommandRunner(resolveSandboxConfig({ enabled: true, network, write: [work] }), home))
        .rejects.toThrow(network === 'outbound-and-loopback' ? 'does not support' : 'networking is unavailable');
      return;
    }
    const networkRunner = await createMxcCommandRunner(resolveSandboxConfig({
      enabled: true, network, write: [work],
    }), home);
    let received = '';
    const server = createServer(socket => socket.on('data', bytes => { received += bytes.toString(); }));
    await new Promise<void>((yes, no) => {
      server.once('error', no);
      server.listen(0, '127.0.0.1', yes);
    });
    try {
      const address = server.address();
      if (typeof address !== 'object' || address === null) throw new Error('No test listener');
      await new Promise<void>((yes, no) => {
        const control = createConnection({ host: '127.0.0.1', port: address.port });
        control.once('error', no);
        control.once('connect', () => control.end('CONTROL', yes));
      });
      await expect.poll(() => received).toContain('CONTROL');
      await writeFile(join(work, 'network.cjs'), [
        `const socket=require("node:net").createConnection({host:"127.0.0.1",port:${address.port}});`,
        'const timer=setTimeout(()=>{socket.destroy();console.log("DENIED_TIMEOUT")},1000);',
        'socket.once("error",()=>{clearTimeout(timer);console.log("DENIED_ERROR")});',
        'socket.once("connect",()=>{clearTimeout(timer);socket.end("SANDBOX_CONNECTED");console.log("CONNECTED")});',
      ].join('\n'));
      const result = await createExecTool(home, networkRunner).execute({ command: 'node network.cjs', cwd: work }, context());
      expect(result.outcome).toBe('success');
      if (network === 'outbound-and-loopback') {
        expect(result.content).toContain('CONNECTED');
        await expect.poll(() => received).toContain('SANDBOX_CONNECTED');
      } else {
        expect(result.content).toContain('DENIED_');
        expect(received).not.toContain('SANDBOX_CONNECTED');
      }
    } finally {
      await new Promise<void>(yes => server.close(() => yes()));
    }
  }, 10_000);

  it.skipIf(process.env.MY_AGENT_TEST_MXC_NETWORK !== '1')(
    'allows public HTTPS and online npm without relaxing denied file access', async () => {
      const networkRunner = await createMxcCommandRunner(resolveSandboxConfig({
        enabled: true, network: 'outbound', write: [work], deny: [join(work, 'private')],
      }), home);
      await writeFile(join(work, 'outbound.cjs'), [
        'const assert=require("node:assert/strict"),fs=require("node:fs");',
        'assert.equal(process.env.npm_config_offline,"false");',
        `assert.throws(()=>fs.readFileSync("private/secret.txt"),{code:"${process.platform === 'win32' ? 'EPERM' : 'ENOENT'}"});`,
        'const request=require("node:https").get("https://example.com/",response=>{',
        'response.resume();response.once("end",()=>{assert.equal(response.statusCode,200);console.log("OUTBOUND_HTTPS_OK")});',
        '});',
        'request.setTimeout(8000,()=>request.destroy(new Error("HTTPS timeout")));',
        'request.once("error",error=>{console.error(error.message);process.exitCode=1});',
      ].join('\n'));
      const result = await createExecTool(home, networkRunner).execute({
        command: 'node outbound.cjs && npm config get offline', cwd: work, timeout: 15,
      }, context());
      expect(result.outcome).toBe('success');
      expect(result.content).toContain('OUTBOUND_HTTPS_OK');
      expect(result.content).toMatch(/\bfalse\b/u);
    }, 20_000,
  );
});
