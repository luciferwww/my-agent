import type { ExtensionLoadContext, LoadedRuntimeUnit, ProviderModelSnapshot, ProviderProjectionEntry } from 'my-agent/extension-api';
import { COPILOT_HEADERS, discoverCopilotModels, getCopilotAccess, LoginCancelledError, LoginError, LoginRequiredError } from './auth.js';
import { FileCredentials } from './credentials.js';
import { CopilotInferenceClient } from './inference.js';
import { LoginServer } from './login-server.js';
import { bindCopilotModels, COPILOT_PROTOCOL, COPILOT_PROVIDER_ID } from './model-metadata.js';
import type { CopilotModelBinding } from './model-metadata.js';
import { openLoginPage } from './platform.js';

const EMPTY_CATALOG = Object.freeze<ProviderModelSnapshot>({
  models: Object.freeze([]),
  resolveModel: () => ({
    ok: false, category: 'model_rejected',
    message: 'Copilot sign-in was dismissed; no models are available.',
  }),
});

export function createExtension(context: ExtensionLoadContext): LoadedRuntimeUnit {
  return {
    unitId: 'copilot-provider', source: 'external', orderKey: 'copilot-provider',
    required: false, initiallyEnabled: true, dependencies: [],
    create() {
      const credentials = new FileCredentials();
      const lifetime = new AbortController();
      let server: LoginServer | undefined;
      let serverStart: Promise<string> | undefined;
      let openingPage: Promise<void> | undefined;
      let signInCallers = 0;
      let signInDismissed = false;
      let pending: {
        readonly controller: AbortController;
        readonly promise: Promise<ProviderModelSnapshot>;
        waiters: number;
      } | undefined;

      async function signIn(signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        server ??= new LoginServer({
          credentials,
          reportError: (message) => context.logger.error(message),
        });
        serverStart ??= server.start().catch((error: unknown) => {
          serverStart = undefined;
          throw error;
        });
        const url = await serverStart;
        signal.throwIfAborted();
        const opening = new AbortController();
        const waiting = server.waitForSignIn(AbortSignal.any([signal, opening.signal]));
        signInCallers++;
        try {
          openingPage ??= openLoginPage(url);
          await Promise.all([waiting, openingPage]);
        } catch (error) {
          if (!signal.aborted && error instanceof LoginCancelledError && !signInDismissed) {
            signInDismissed = true;
            context.logger.info('Copilot sign-in was dismissed. Model discovery is paused until restart or provider re-enable.');
          }
          throw error;
        } finally {
          opening.abort(new LoginCancelledError('The Copilot sign-in request has ended.'));
          if (--signInCallers === 0) openingPage = undefined;
        }
      }

      async function withSignIn<T>(signal: AbortSignal, task: (token: string) => Promise<T>): Promise<T> {
        const execute = async () => {
          signal.throwIfAborted();
          const token = await credentials.load();
          signal.throwIfAborted();
          if (!token) throw new LoginRequiredError('Sign in with GitHub to use Copilot.');
          return task(token);
        };
        try { return await execute(); }
        catch (error) {
          if (!(error instanceof LoginRequiredError)) throw error;
          if (signInDismissed) {
            throw new LoginRequiredError('Copilot sign-in was dismissed. Restart my-agent or disable and re-enable the provider to sign in again.');
          }
          await signIn(signal);
          return execute();
        }
      }

      async function send(model: CopilotModelBinding, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
        return withSignIn(signal, async (token) => {
          const access = await getCopilotAccess(token, { signal });
          if (access.apiBase !== model.apiBase) throw new LoginError('The Copilot account endpoint changed. Refresh and reselect the model.');
          const response = await fetch(`${model.apiBase}/${model.wireProtocol === 'openai-responses' ? 'responses' : 'chat/completions'}`, {
            method: 'POST', redirect: 'error', signal,
            headers: { ...COPILOT_HEADERS, 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${access.token}` },
            body: JSON.stringify(body),
          });
          if (response.status === 401) {
            await response.body?.cancel();
            throw new LoginRequiredError('Copilot requires a new sign-in (HTTP 401).', 401);
          }
          return response;
        });
      }

      async function readCatalog(signal: AbortSignal): Promise<ProviderModelSnapshot> {
        signal.throwIfAborted();
        if (signInDismissed) return EMPTY_CATALOG;
        try {
          const discovered = await withSignIn(signal, (token) => discoverCopilotModels(token, { signal }));
          const bindings = bindCopilotModels(discovered, (message) => context.logger.warn(message));
          signal.throwIfAborted();
          const bound = new Map(bindings.map((model) => [model.modelId, {
            model, client: new CopilotInferenceClient(model, (body, signal) => send(model, body, signal), lifetime.signal),
          }]));
          return Object.freeze({
            models: Object.freeze(bindings.map((model) => Object.freeze({
              modelId: model.modelId, ...(model.displayName ? { displayName: model.displayName } : {}),
              capabilities: Object.freeze({
                ...(model.facts.toolUse === undefined ? {} : { toolUse: model.facts.toolUse }),
                ...(model.facts.mediaKinds === undefined ? {} : { mediaKinds: model.facts.mediaKinds }),
                ...(model.facts.reasoning === undefined ? {} : { reasoning: model.facts.reasoning }),
              }),
            }))),
            resolveModel: (modelId: string, connection: { readonly endpointId: string }) => {
              const entry = bound.get(modelId);
              if (!entry || connection.endpointId !== 'github-copilot') return {
                ok: false as const, category: 'model_rejected' as const,
                message: 'Copilot rejected a model or connection outside this captured catalog.',
              };
              return {
                ok: true as const,
                descriptor: Object.freeze({
                  invocationPort: entry.client,
                  identity: Object.freeze({ providerId: COPILOT_PROVIDER_ID, modelId }),
                  protocol: COPILOT_PROTOCOL, connection, facts: entry.model.facts,
                }),
              };
            },
          });
        } catch (error) {
          const failure: unknown = signal.aborted ? signal.reason : error;
          if (!signal.aborted && (failure instanceof LoginCancelledError
            || signInDismissed && failure instanceof LoginRequiredError)) return EMPTY_CATALOG;
          const reported = failure instanceof LoginError ? failure
            : new LoginError('Could not load Copilot models. Check your network and saved sign-in.');
          context.logger.error(reported.message);
          throw reported;
        }
      }

      const provider: ProviderProjectionEntry = {
        id: COPILOT_PROVIDER_ID,
        displayName: 'GitHub Copilot',
        protocol: COPILOT_PROTOCOL,
        resolveConnection: () => ({ ok: true, connection: Object.freeze({ endpointId: 'github-copilot' }) }),
        async getModelCatalog(querySignal?: AbortSignal) {
          const caller = querySignal ? AbortSignal.any([lifetime.signal, querySignal]) : lifetime.signal;
          caller.throwIfAborted();
          if (!pending || pending.controller.signal.aborted) {
            const controller = new AbortController();
            const promise = readCatalog(AbortSignal.any([lifetime.signal, controller.signal]));
            const operation = { controller, promise, waiters: 0 };
            pending = operation;
            const complete = () => { if (pending === operation) pending = undefined; };
            void promise.then(complete, complete);
          }
          const operation = pending;
          operation.waiters++;
          let cancel = () => {};
          const cancelled = new Promise<never>((_resolve, reject) => {
            cancel = () => reject(caller.reason);
            caller.addEventListener('abort', cancel, { once: true });
          });
          try {
            return await Promise.race([operation.promise, cancelled]);
          } finally {
            caller.removeEventListener('abort', cancel);
            if (--operation.waiters === 0 && pending === operation) {
              operation.controller.abort(new LoginCancelledError('The model catalog request was cancelled.'));
            }
          }
        },
      };
      return {
        registration: {
          id: 'copilot-provider', source: 'external',
          register(api) { api.registerProvider(provider); },
        },
        async start(signal) {
          signal.throwIfAborted();
        },
        async stop() {
          const task = pending?.promise;
          const starting = serverStart;
          lifetime.abort(new LoginCancelledError('The Copilot extension is stopping.'));
          if (starting) await Promise.allSettled([starting]);
          await server?.stop();
          if (task) await Promise.allSettled([task]);
        },
      };
    },
  };
}
