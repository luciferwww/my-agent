import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deviceLogin, LoginCancelledError, LoginError, LoginRequiredError, verifyCopilot } from './auth.js';
import type { Credentials } from './credentials.js';
import { pageHtml, pageScript } from './page.js';

interface LoginStatus {
  state: 'signed-out' | 'saved' | 'requesting-code' | 'waiting-authorization'
    | 'verifying' | 'saving' | 'verified' | 'signing-out' | 'cancelling' | 'cancelled' | 'failed';
  message: string;
  saved: boolean;
  needsLogin?: boolean;
}

interface Operation {
  readonly kind: 'login' | 'verify' | 'logout';
  readonly controller: AbortController;
  authorization?: { readonly url: string; readonly code: string };
  task?: Promise<void>;
}

export interface LoginServerOptions {
  readonly credentials: Credentials;
  readonly login?: typeof deviceLogin;
  readonly verify?: typeof verifyCopilot;
  readonly reportError: (message: string) => void;
}

export class LoginServer {
  private readonly server = createServer((request, response) => {
    void this.route(request, response).catch(() => {
      this.options.reportError('Copilot login page request failed.');
      if (!response.headersSent) this.json(response, 500, { error: 'The experiment request failed.' });
      else response.destroy();
    });
  });
  private readonly pageKey = randomBytes(32).toString('hex');
  private origin = '';
  private closing = false;
  private readonly pages = new Set<ServerResponse>();
  private readonly signInWaiters = new Set<(error?: unknown) => void>();
  private operation?: Operation;
  private status: LoginStatus = {
    state: 'signed-out', message: 'Your account is not connected on this device.', saved: false,
  };

  constructor(private readonly options: LoginServerOptions) {}

  async start(): Promise<string> {
    try {
      if (await this.options.credentials.load()) {
        this.status = { state: 'saved', saved: true, message: 'Checking your saved sign-in...', };
      }
    } catch {
      this.status = { state: 'failed', saved: false, message: 'Could not read your saved sign-in. Check credential file permissions or sign in again.' };
      this.options.reportError(this.status.message);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('The local login page has no TCP address.');
    this.origin = `http://127.0.0.1:${address.port}`;
    return `${this.origin}/#${this.pageKey}`;
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.settleSignIn(new LoginCancelledError('The account service is stopping.'));
    const operation = this.operation;
    operation?.controller.abort(new LoginCancelledError('The experiment is stopping.'));
    await operation?.task;
    if (!this.server.listening) return;
    const closed = new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
    this.server.closeAllConnections();
    await closed;
  }

  async waitForSignIn(signal: AbortSignal): Promise<void> {
    if (this.operation?.controller.signal.aborted) await this.operation.task;
    signal.throwIfAborted();
    if (this.closing) throw new LoginCancelledError('The account service is stopping.');
    const waitingSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        this.signInWaiters.delete(finish);
        waitingSignal.removeEventListener('abort', cancel);
        if (error === undefined) resolve();
        else reject(error);
      };
      const cancel = () => {
        finish(signal.aborted ? signal.reason : new LoginError('Sign-in timed out. Try your Copilot request again.'));
        if (this.signInWaiters.size === 0) {
          this.operation?.controller.abort(new LoginCancelledError('The Copilot request was cancelled.'));
        }
      };
      this.signInWaiters.add(finish);
      waitingSignal.addEventListener('abort', cancel, { once: true });
      if (!this.operation) {
        this.status = {
          state: 'signed-out', saved: this.status.saved, needsLogin: true,
          message: 'Sign in with GitHub to continue using Copilot.',
        };
        this.publish();
      }
    });
  }

  private settleSignIn(error?: unknown): void {
    for (const finish of this.signInWaiters) finish(error);
  }

  private snapshot() {
    return {
      ...this.status,
      busy: this.operation !== undefined,
      ...(this.status.state === 'waiting-authorization' && !this.operation?.controller.signal.aborted
        ? { authorization: this.operation?.authorization } : {}),
    };
  }

  private publish(): void {
    const event = `data: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const page of this.pages) page.write(event);
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== new URL(this.origin).host
      || (request.headers.origin !== undefined && request.headers.origin !== this.origin)) {
      this.json(response, 403, { error: 'Only this local experiment page may access this service.' });
      return;
    }
    if (this.closing) { this.json(response, 503, { error: 'The experiment is stopping.' }); return; }
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml);
      return;
    }
    if (request.method === 'GET' && request.url === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(pageScript);
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.pageKey}`) {
      this.json(response, 401, { error: 'Reopen the original experiment launch URL.' });
      return;
    }
    if (request.url === '/api/events' && request.method === 'GET') {
      const firstPage = this.pages.size === 0;
      this.pages.add(response);
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.once('close', () => {
        this.pages.delete(response);
        if (this.pages.size === 0 && !this.closing) {
          const reason = new LoginCancelledError('The login page was closed or disconnected. Login cancelled.');
          this.operation?.controller.abort(reason);
          if (!this.operation && this.signInWaiters.size > 0) {
            this.status.state = 'cancelled';
            this.status.message = reason.message;
          }
          this.settleSignIn(reason);
        }
      });
      if (firstPage && this.status.saved && !this.status.needsLogin && !this.operation) {
        const operation = this.begin('verify');
        operation.task = this.run(operation);
      } else {
        response.write(`data: ${JSON.stringify(this.snapshot())}\n\n`);
      }
      return;
    }
    if (request.url === '/api/status' && request.method === 'GET') {
      this.json(response, 200, this.snapshot());
      return;
    }
    if (request.method !== 'POST' || !['/api/login', '/api/cancel', '/api/logout'].includes(request.url ?? '')) {
      this.json(response, 404, { error: 'Unknown experiment action.' });
      return;
    }
    if (request.url === '/api/cancel') {
      if (this.status.state === 'saving' || this.status.state === 'signing-out') {
        this.json(response, 409, { error: 'The account update is completing. Please wait.' });
        return;
      }
      if (this.operation) {
        this.status.state = 'cancelling';
        this.status.message = 'Cancelling...';
        this.operation.controller.abort(new LoginCancelledError(
          this.operation.kind === 'verify' ? 'Connection check cancelled.' : 'Sign-in cancelled.',
        ));
        this.publish();
      }
      this.json(response, 200, this.snapshot());
      return;
    }
    if (this.operation) { this.json(response, 409, { error: 'An account operation is already running.' }); return; }
    if (this.pages.size === 0) {
      this.json(response, 409, { error: 'Keep the local login page connected before starting authentication.' });
      return;
    }
    // Reserve the operation synchronously, before starting authentication.
    const operation = this.begin(request.url === '/api/login' ? 'login' : 'logout');
    operation.task = this.run(operation);
    this.json(response, 202, this.snapshot());
  }

  private begin(kind: Operation['kind']): Operation {
    const operation: Operation = {
      kind, controller: new AbortController(),
    };
    this.operation = operation;
    this.status.state = kind === 'login' ? 'requesting-code' : kind === 'logout' ? 'signing-out' : 'verifying';
    this.status.message = kind === 'login' ? 'Requesting a GitHub device code...'
      : kind === 'logout' ? 'Removing your saved sign-in from this device...' : 'Checking your saved sign-in...';
    this.publish();
    return operation;
  }

  private async run(operation: Operation): Promise<void> {
    const signal = operation.controller.signal;
    const timeout = setTimeout(() => {
      operation.controller.abort(new LoginError('Login timed out. Start again.'));
    }, 15 * 60_000);
    try {
      if (operation.kind === 'logout') {
        await this.options.credentials.clear();
        this.status = { state: 'signed-out', saved: false, message: 'Signed out on this device.' };
        return;
      }
      let accessToken: string | undefined;
      if (operation.kind === 'login') {
        accessToken = await (this.options.login ?? deviceLogin)({
          signal,
          display: (url, code) => {
            signal.throwIfAborted();
            operation.authorization = { url, code };
            this.status.state = 'waiting-authorization';
            this.status.message = 'Copy the device code, then open the GitHub link and enter it there to authorize.';
            this.publish();
          },
        });
      } else {
        accessToken = await this.options.credentials.load();
      }
      signal.throwIfAborted();
      if (!accessToken) {
        this.status.saved = false;
        throw new LoginError('No saved sign-in was found. Sign in again.');
      }
      this.status.state = 'verifying';
      this.status.message = 'Checking Copilot access...';
      this.publish();
      await (this.options.verify ?? verifyCopilot)(accessToken, { signal });
      signal.throwIfAborted();
      if (operation.kind === 'login') {
        this.status.state = 'saving';
        this.status.message = 'Saving your sign-in on this device...';
        this.publish();
        await this.options.credentials.save(accessToken, signal);
      }
      this.status = { state: 'verified', saved: true, message: 'Your GitHub Copilot account is connected on this device.' };
    } catch (error) {
      const reason: unknown = signal.aborted ? signal.reason : error;
      const cancelled = reason instanceof LoginCancelledError;
      if (reason instanceof LoginRequiredError) this.status.needsLogin = true;
      this.status.state = cancelled && operation.kind !== 'logout' ? 'cancelled' : 'failed';
      this.status.message = operation.kind === 'logout'
        ? 'Could not sign out. Your saved sign-in may still be on this device. Please try again.'
        : reason instanceof LoginError ? reason.message
          : 'Could not complete the request. Check your network and credential file permissions, then try again.';
      this.options.reportError(this.status.message);
    } finally {
      clearTimeout(timeout);
      this.operation = undefined;
      this.publish();
      this.settleSignIn(this.status.state === 'verified' ? undefined
        : this.status.state === 'cancelled' || operation.kind === 'logout'
          ? new LoginCancelledError(this.status.message) : new LoginError(this.status.message));
    }
  }

  private json(response: ServerResponse, code: number, value: unknown): void {
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
  }
}
