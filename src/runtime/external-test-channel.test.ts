import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelCompletion,
  ChannelInstance,
  ChannelRunRequest,
  ChannelRuntimeHost,
} from '../core/channel/index.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import type { AgentEvent } from '../core/runner/index.js';
import { CompositionCoordinator } from './composition-coordinator.js';
import { RuntimeCompositionManager } from './runtime-composition-manager.js';
import { RuntimeLifecycleLedger } from './runtime-lifecycle.js';
import { RuntimeUnitCatalog, createLoadedRuntimeUnit } from './runtime-unit.js';

interface ExternalSentinelResource {
  readonly marker: symbol;
  cleaned: boolean;
}

class ExternalTestChannel implements ChannelInstance {
  readonly id = 'external-test-channel';
  readonly completion: Promise<ChannelCompletion>;
  readonly sentEvents: AgentEvent[] = [];
  private messageHandler?: (request: ChannelRunRequest) => Promise<void>;
  private settleCompletion!: (completion: ChannelCompletion) => void;

  constructor(
    private readonly resource: ExternalSentinelResource,
    private readonly failStart: boolean,
  ) {
    this.completion = new Promise((resolve) => { this.settleCompletion = resolve; });
  }

  send(event: AgentEvent): void { this.sentEvents.push(event); }
  onMessage(handler: (request: ChannelRunRequest) => Promise<void>): void {
    this.messageHandler = handler;
  }
  async start(): Promise<void> {
    if (this.failStart) throw new Error('external fixture start failed');
  }
  async stop(): Promise<void> {
    this.resource.cleaned = true;
    this.settleCompletion({ outcome: 'closed', reason: 'stopped' });
  }
  async dispatch(request: ChannelRunRequest): Promise<void> {
    if (!this.messageHandler) throw new Error('external fixture is not bound');
    await this.messageHandler(request);
  }
}

function externalUnit(options: {
  readonly failStart?: boolean;
  readonly resource: ExternalSentinelResource;
  readonly capture: (channel: ExternalTestChannel) => void;
}): RuntimeContributionUnit {
  return {
    id: 'external-test-channel-module',
    source: 'external',
    register(api) {
      api.registerChannel({
        id: 'external-test-channel',
        create: () => {
          const channel = new ExternalTestChannel(options.resource, options.failStart ?? false);
          options.capture(channel);
          return channel;
        },
      });
    },
  };
}

function host(): ChannelRuntimeHost {
  return {
    onMessage: vi.fn(async () => {}),
    onInteractionResponse: vi.fn(),
    onInteractionUnavailable: vi.fn(),
    capabilities: {
      modelCatalog: {
        getSnapshot: () => ({
          generation: 1,
          defaultSelection: { state: 'unset' },
          providers: [],
        }),
      },
      abort: {
        querySessionsNeedingAbort: () => [],
        abortTurn: () => ({ aborted: false, dropped: 0 }),
      },
    },
  };
}

function managerFor(registration: RuntimeContributionUnit, runtimeHost: ChannelRuntimeHost) {
  const ledger = new RuntimeLifecycleLedger();
  return new RuntimeCompositionManager(
    new RuntimeUnitCatalog([createLoadedRuntimeUnit({
      registration,
      required: false,
    })]),
    new CompositionCoordinator(ledger),
    ledger,
    runtimeHost,
  );
}

describe('External Test Channel module', () => {
  it('uses common composition while retaining and cleaning its private resource', async () => {
    const resource = { marker: Symbol('private-external-resource'), cleaned: false };
    let channel: ExternalTestChannel | undefined;
    const runtimeHost = host();
    const manager = managerFor(externalUnit({
      resource,
      capture: (created) => { channel = created; },
    }), runtimeHost);

    expect(channel).toBeUndefined();
    const snapshot = await manager.start();
    expect(snapshot.channels.resolve('external-test-channel')).toBeDefined();

    await channel!.dispatch({ sessionKey: 'main', message: 'external inbound' });
    expect(runtimeHost.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'external-test-channel' }),
      { sessionKey: 'main', message: 'external inbound' },
    );
    snapshot.channels.resolve('external-test-channel')?.send({
      type: 'run_start',
      requestId: 'request-1',
      sessionKey: 'main',
      turnId: 'turn-1',
    });
    expect(channel!.sentEvents).toHaveLength(1);

    await manager.shutdown();
    expect(resource.cleaned).toBe(true);
  });

  it('cleans its private resource and excludes the Unit when startup fails', async () => {
    const resource = { marker: Symbol('private-external-resource'), cleaned: false };
    const manager = managerFor(externalUnit({
      resource,
      failStart: true,
      capture: () => {},
    }), host());

    const snapshot = await manager.start();

    expect(snapshot.channels.bindings).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        unitId: 'external-test-channel-module',
        code: 'CHANNEL_START_FAILED',
      }),
    ]);
    expect(resource.cleaned).toBe(true);
    await manager.shutdown();
  });
});