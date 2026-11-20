import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { LoginError } from './auth.js';

export async function openLoginPage(url: string): Promise<void> {
  const os = platform();
  const command = os === 'win32' ? 'rundll32.exe' : os === 'darwin' ? 'open' : os === 'linux' ? 'xdg-open' : undefined;
  const message = 'Could not open the sign-in page. Check your default browser, or run npm run start --workspace @my-agent/copilot-provider -- --device-code on this host and retry.';
  if (!command) throw new LoginError(message);
  const args = os === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
    child.once('error', () => reject(new LoginError(message)));
    child.once('close', (code) => code === 0 ? resolve() : reject(new LoginError(message)));
  });
}
