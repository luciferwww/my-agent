import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelCompletion,
  ChannelInstance,
  ChannelRunRequest,
  ChannelRuntimeHost,
} from '../core/channel/index.js';
import type { RuntimeContributionUnit } from '../core/registry/index.js';
import type { AgentEvent } from '../core/runner/index.js';
import { activateRegistryChannels } from './channel-lifecycle.js';
import { stageRegistryCandidate } from './registry-builder.js';

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
    this.completion = new Promise((resolve) => {
      this.settleCompletion = resolve;
    });
  }

  send(event: AgentEvent): void {
    this.sentEvents.push(event);
  }

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

function createExternalTestModule(options: {
  readonly failStart?: boolean;
  readonly resource: ExternalSentinelResource;
  readonly capture: (channel: ExternalTestChannel) => void;
}): RuntimeContributionUnit {
  if (typeof options.resource.marker !== 'symbol') {
    throw new Error('external fixture resource marker must be a symbol');
  }
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

function createHost(): ChannelRuntimeHost {
  return {
    onMessage: vi.fn(async () => {}),
    onInteractionResponse: vi.fn(),
    onInteractionUnavailable: vi.fn(),
    abortHooks: {
      querySessionsNeedingAbort: () => [],
      abortTurn: () => ({ aborted: false, dropped: 0 }),
    },
  };
}

describe('External Test Channel module', () => {
  it('uses the common external staging path while retaining its private resource', async () => {
    const resource = { marker: Symbol('private-external-resource'), cleaned: false };
    let channel: ExternalTestChannel | undefined;
    const host = createHost();
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [createExternalTestModule({
        resource,
        capture: (created) => {
          channel = created;
        },
      })],
    });

    expect(channel).toBeUndefined();
    const activated = await activateRegistryChannels({ candidate, host });
    expect(channel).toBeDefined();
    expect(activated.snapshot.channels.resolve('external-test-channel')).toBeDefined();

    await channel!.dispatch({ sessionKey: 'main', message: 'external inbound' });
    expect(host.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'external-test-channel' }),
      { sessionKey: 'main', message: 'external inbound' },
    );

    activated.snapshot.channels.resolve('external-test-channel')?.send({
      type: 'run_start',
      sessionKey: 'main',
      turnId: 'turn-1',
    });
    expect(channel!.sentEvents).toHaveLength(1);

    await activated.lifecycle.runtimeConverged();
    expect(resource.cleaned).toBe(true);
  });

  it('cleans its private resource and remains absent when startup fails', async () => {
    const resource = { marker: Symbol('private-external-resource'), cleaned: false };
    const candidate = stageRegistryCandidate({
      providers: [],
      units: [createExternalTestModule({ resource, failStart: true, capture: () => {} })],
    });

    const activated = await activateRegistryChannels({ candidate, host: createHost() });

    expect(activated.snapshot.channels.bindings).toEqual([]);
    expect(activated.snapshot.diagnostics).toEqual([
      expect.objectContaining({
        unitId: 'external-test-channel-module',
        code: 'CHANNEL_START_FAILED',
      }),
    ]);
    expect(resource.cleaned).toBe(true);
  });
});
