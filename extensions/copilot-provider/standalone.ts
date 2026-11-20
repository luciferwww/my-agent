import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deviceLogin, LoginCancelledError, LoginError, verifyCopilot } from './auth.js';
import { FileCredentials } from './credentials.js';
import { LoginServer } from './login-server.js';
import { openLoginPage } from './platform.js';

const server = new LoginServer({
  credentials: new FileCredentials(),
  reportError: (message) => console.error(message),
});

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  let deviceCode: boolean;
  try {
    const { values } = parseArgs({ args: [...args], options: { 'device-code': { type: 'boolean' } } });
    deviceCode = values['device-code'] === true;
  } catch {
    throw new LoginError('Usage: npm run start --workspace @my-agent/copilot-provider -- [--device-code]');
  }
  if (deviceCode) {
    const controller = new AbortController();
    const cancel = () => controller.abort(new LoginCancelledError('Copilot sign-in was cancelled.'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
      const token = await deviceLogin({
        signal,
        display: (url, code) => console.log(`Open ${url} in a browser on any device and enter code ${code}.`),
      });
      signal.throwIfAborted();
      await verifyCopilot(token, { signal });
      signal.throwIfAborted();
      await new FileCredentials().save(token, signal);
      console.log('Copilot sign-in saved on this host. You can now retry your Copilot request.');
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
    return;
  }
  const pageUrl = await server.start();
  // This local capability URL is printed only to the interactive launcher, never host logs.
  console.log(`Copilot login experiment: ${pageUrl}\nPress Ctrl+C to stop.`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.stop().catch(() => {
      console.error('Could not stop the login experiment cleanly.');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await openLoginPage(pageUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(async (error: unknown) => {
    console.error(error instanceof LoginError ? error.message
      : 'Could not start Copilot sign-in. Check file permissions and your default browser, or use --device-code.');
    await server.stop();
    process.exitCode = 1;
  });
}
