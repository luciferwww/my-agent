import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/runner/index.js';
import { toModelInvocationError } from '../core/model-invocation/index.js';
import type {
  ChatContentBlock,
  ChatMessage,
  ModelInvocationDiagnostics,
  ModelInvocationError,
} from '../core/model-invocation/index.js';
import type { SessionEntry } from '../core/session/index.js';
import type { ModelReference } from '../core/model-resolution/index.js';
import { ModelResolutionError, ModelResolver } from '../core/model-resolution/index.js';
import { TurnInteractionManager } from './turn-interaction/index.js';
import type {
  ApprovalInteractionRequest,
  ChannelRunRequest,
  ChannelCompletion,
  ChannelCompletionObserver,
  ChannelRuntimeBinding,
  TurnInteractionResponse,
} from '../core/channel/index.js';
import { Logger } from '../platform/logger/index.js';
import { loadContextFiles } from '../core/agent-context/index.js';
import type { ContextFile } from '../core/agent-context/types.js';
import {
  AttachmentValidationError,
  processInboundMessage,
} from '../core/media/attachment-pipeline.js';
import { classifyRuntimeError, createRuntimeError } from './errors.js';
import {
  buildRuntimeHandle,
  type RuntimeApplicationKernel,
  type RuntimeApplicationKernelInput,
} from './runtime-builder.js';
import type { ModelCatalogSnapshot, RuntimeHandle } from './runtime-composition.js';
import type {
  RuntimeGenerationPin,
  RuntimeSnapshotAccess,
} from './composition-coordinator.js';
import { buildSystemPromptParams } from './prompt-factory.js';
import { summarizeAssembled } from './summarize-assembled.js';
import {
  RequestCompletionGate,
  type RequestTerminal,
} from './request-completion-gate.js';
import {
  RuntimeDeadlineBudget,
  createSystemRuntimeDeadlineDriver,
  resolveRuntimeDeadlinePolicy,
} from './runtime-deadline.js';
import type { CurrentCallApprovalCapability } from '../core/approval/index.js';
import type {
  SessionPermissionMode,
  SessionPermissionState,
} from '../core/approval/index.js';
import { SessionCoordinator } from './session/SessionCoordinator.js';
import { SessionPermissionRegistry } from './session/SessionPermissionRegistry.js';
import { PendingSessionRegistry } from './session/PendingSessionRegistry.js';
import type { ActiveParentTurn } from './subagent-orchestration.js';
import {
  collectAvailableSubagents,
} from '../core/subagent/index.js';
import type {
  SubagentProfile,
} from '../core/subagent/types.js';
import type { AvailableSubagentEntry } from '../core/subagent/index.js';
import type {
  MessageRouteContext,
  PendingSteeringInput,
  QueuedChannelTurn,
  TurnLaunchContext,
} from './queue-types.js';
import type {
  RunTurnParams,
  RunTurnResult,
  RuntimeAppOptions,
  RuntimeErrorInfo,
  RuntimeErrorScope,
  RuntimeEvent,
  RuntimeLifecyclePhase,
  RuntimeLifecycleState,
  RuntimeResourceSet,
  RuntimeShutdownReport,
} from './types.js';

const log = Logger.get('RuntimeApp');
const interactionLog = Logger.get('TurnInteractionManager');

function findModelInvocationError(error: unknown): ModelInvocationError | undefined {
  const seen = new Set<Error>();
  let current = asSameRealmError(error);
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const canonical = toModelInvocationError(current);
    if (canonical) return canonical;
    if (seen.has(current)) return undefined;
    seen.add(current);
    current = readOwnErrorCause(current);
  }
  return undefined;
}

function asSameRealmError(value: unknown): Error | undefined {
  try {
    return value instanceof Error ? value : undefined;
  } catch {
    return undefined;
  }
}

function readOwnErrorCause(error: Error): Error | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    return descriptor && 'value' in descriptor
      ? asSameRealmError(descriptor.value)
      : undefined;
  } catch {
    return undefined;
  }
}

interface ModelInvocationOperatorDiagnostics {
  readonly providerId: string;
  readonly httpStatus?: number;
  readonly providerErrorType?: string;
  readonly providerErrorCode?: string;
  readonly providerMessage?: string;
  readonly requestId?: string;
  readonly request: Readonly<
    Omit<ModelInvocationDiagnostics['request'], 'model'>
    & { readonly model: string }
  >;
}

function projectModelInvocationDiagnostics(
  diagnostics: ModelInvocationDiagnostics | undefined,
): ModelInvocationOperatorDiagnostics | undefined {
  if (!diagnostics) return undefined;
  return Object.freeze({
    providerId: diagnostics.providerId,
    ...(diagnostics.httpStatus === undefined ? {} : { httpStatus: diagnostics.httpStatus }),
    ...(diagnostics.providerErrorType === undefined
      ? {}
      : { providerErrorType: diagnostics.providerErrorType }),
    ...(diagnostics.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: diagnostics.providerErrorCode }),
    ...(diagnostics.providerMessage === undefined
      ? {}
      : { providerMessage: diagnostics.providerMessage }),
    ...(diagnostics.requestId === undefined ? {} : { requestId: diagnostics.requestId }),
    request: Object.freeze({
      ...diagnostics.request,
      model: formatModelIdForOperator(diagnostics.request.model),
    }),
  });
}

function formatModelIdForOperator(modelId: string): string {
  const preview = modelId.length > 200 ? `${modelId.slice(0, 200)}…` : modelId;
  return JSON.stringify(preview);
}

function assertSessionPermissionMode(value: unknown): asserts value is SessionPermissionMode {
  if (value !== 'manual' && value !== 'allow_all') {
    throw new TypeError('Session permission mode must be "manual" or "allow_all".');
  }
}

interface ActiveRootTree {
  readonly requestId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly channels: readonly ChannelRuntimeBinding[];
  readonly pin: RuntimeGenerationPin;
  members: number;
  released: boolean;
}

export class RuntimeApp {
  private readonly onEvent?: RuntimeAppOptions['onEvent'];
  private readonly sessionCoordinator: SessionCoordinator;
  private readonly sessionPermissions = new SessionPermissionRegistry();
  private readonly inFlightRuns = new Set<Promise<unknown>>();
  /** Per-Session gate: one Turn per sessionId, with concurrency across Sessions. */
  private readonly inFlightSessions = new Set<string>();
  /** Normal message queue for each Session before a Turn starts. */
  private readonly messageQueueBySession = new Map<string, QueuedChannelTurn[]>();
  /** Steering inbox drained by the Runner at injection points in the active Turn. */
  private readonly steeringInboxBySession = new Map<string, PendingSteeringInput[]>();
  /**
   * Tracks only active run-Turns for steering. inFlightSessions represents busy
   * state, while this map identifies an active Turn that can accept steering.
   */
  private readonly activeTurnIdBySession = new Map<string, string>();

  /**
  * AbortController for each active Session Turn, used by abortTurn and shutdown.
  * runTurnInternal installs and removes its own controller; abortTurn, close,
  * and querySessionsNeedingAbort read it. See core-abort-spec.md section 8.1.
   */
  private readonly activeAborts = new Map<string, AbortController>();
  private readonly activeRootGenerations = new Map<string, ActiveRootTree>();
  private readonly requestGates = new Map<string, RequestCompletionGate<RunTurnResult>>();
  /** Active resolved Parent Turns eligible to delegate a tracked Child. */
  private readonly activeParentTurns: Map<string, ActiveParentTurn>;

  // ── Channel layer ───────────────────────────────────────────────
  private readonly turnInteractionManager: TurnInteractionManager;
  /** Turn-to-interaction route using the Channel reference and originClientId. */
  private readonly routeContextByTurn: Map<string, MessageRouteContext>;
  private approvalRoutingWired = false;

  private closePromise?: Promise<RuntimeShutdownReport>;
  private shutdownReport?: RuntimeShutdownReport;

  /**
    * Fanout entry for AgentEvent broadcasts. Injected by the Runtime Builder
    * when it constructs the application kernel; instance methods (notably
   * `handleInboundChannelMessage`) call this to emit `user_message` events
   * without needing to import the fanout closure.
  * See channel-multi-client-user-message-spec section 5.3.
   */
  private fanoutAgentEvent!: (event: AgentEvent) => void | Promise<void>;

  /**
    * Profile registry including the built-in `general-purpose` entry. Built
    * by the Runtime Builder before kernel construction; not part of
   * RuntimeResourceSet because it is consumed only by RuntimeApp itself
  * (the public surface is the available-profile projection).
   */
  private subagentProfiles!: ReadonlyMap<string, SubagentProfile>;

  private constructor(
    private readonly resources: RuntimeResourceSet,
    private state: RuntimeLifecycleState,
    private readonly channelCompletionObserver: ChannelCompletionObserver,
    private readonly snapshotAccess: RuntimeSnapshotAccess,
    subagentProfiles: ReadonlyMap<string, SubagentProfile>,
    activeParentTurns: Map<string, ActiveParentTurn>,
    routeContextByTurn: Map<string, MessageRouteContext>,
    onEvent?: RuntimeAppOptions['onEvent'],
  ) {
    this.subagentProfiles = subagentProfiles;
    this.activeParentTurns = activeParentTurns;
    this.routeContextByTurn = routeContextByTurn;
    this.onEvent = onEvent;
    this.turnInteractionManager = new TurnInteractionManager(interactionLog);
    this.sessionCoordinator = new SessionCoordinator({
      sessionManager: resources.sessionManager,
      pendingSessions: new PendingSessionRegistry({
        onExpire: (sessionId) => this.sessionPermissions.delete(sessionId),
      }),
      isBusy: (sessionId) => this.inFlightSessions.has(sessionId)
        || (this.messageQueueBySession.get(sessionId)?.length ?? 0) > 0,
    });
  }

  static async create(options: RuntimeAppOptions): Promise<RuntimeHandle> {
    return buildRuntimeHandle(options, RuntimeApp.createKernel);
  }

  private static createKernel(input: RuntimeApplicationKernelInput): RuntimeApplicationKernel {
    const app = new RuntimeApp(
      input.resources,
      input.state,
      input.channelCompletionObserver,
      input.snapshotAccess,
      input.subagentProfiles,
      input.activeParentTurns,
      input.routeContextByTurn,
      input.onEvent,
    );
    app.fanoutAgentEvent = input.fanoutAgentEvent;
    app.wireApprovalRouting();

    return {
      application: app,
      onChannelMessage: (binding, request) =>
        app.handleInboundChannelMessage(binding, request),
      onInteractionResponse: (response) => app.handleInteractionResponse(response),
      onInteractionUnavailable: (id, reason) => {
        app.turnInteractionManager.settle(id, { outcome: 'unavailable', reason });
      },
      querySessionsNeedingAbort: () => {
        const sessions = new Set<string>(app.activeAborts.keys());
        for (const [sessionKey, queue] of app.messageQueueBySession) {
          if (queue.length > 0) sessions.add(sessionKey);
        }
        return [...sessions];
      },
      abortTurn: (sessionId) => app.abortTurn(sessionId),
      blockingTurnIds: (generation) => app.blockingTurnIds(generation),
      abortGeneration: (generation) => app.abortGeneration(generation),
      channelBindingsForTurn: (turnId) => app.channelBindingsForTurn(turnId),
      shouldDeliverAgentEvent: (event) => app.shouldDeliverAgentEvent(event),
      close: (reason, budget) => app.close(reason, budget),
    };
  }

  // ── State queries ────────────────────────────────────────────────

  async createSession(input?: {
    permissionMode?: SessionPermissionMode;
    originClientId?: string;
  }): Promise<{ sessionId: string; permission: SessionPermissionState }> {
    if (input?.permissionMode !== undefined) {
      assertSessionPermissionMode(input.permissionMode);
    }
    const { sessionId } = await this.sessionCoordinator.createSession();
    const permission = this.sessionPermissions.initialize(
      sessionId,
      input?.permissionMode ?? 'manual',
      input?.originClientId,
    );
    return { sessionId, permission };
  }

  listSessions(input?: { archived?: boolean }): Promise<SessionEntry[]> {
    return this.sessionCoordinator.listSessions(input);
  }

  getSession(sessionId: string): Promise<SessionEntry> {
    return this.sessionCoordinator.getSession(sessionId);
  }

  renameSession(sessionId: string, title: string | null): Promise<SessionEntry> {
    return this.sessionCoordinator.renameSession(sessionId, title);
  }

  async archiveSession(sessionId: string): Promise<SessionEntry> {
    const entry = await this.sessionCoordinator.archiveSession(sessionId);
    this.resetSessionPermissionMode(sessionId);
    return entry;
  }

  async unarchiveSession(sessionId: string): Promise<SessionEntry> {
    const entry = await this.sessionCoordinator.unarchiveSession(sessionId);
    this.sessionPermissions.initialize(sessionId);
    return entry;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionCoordinator.deleteSession(sessionId);
    this.resetSessionPermissionMode(sessionId);
  }

  async forkSession(sessionId: string, entryId?: string): Promise<SessionEntry> {
    const entry = await this.sessionCoordinator.forkSession(sessionId, entryId);
    this.sessionPermissions.initialize(entry.sessionId);
    return entry;
  }

  getSessionPermissionMode(sessionId: string): SessionPermissionState {
    this.sessionCoordinator.assertLiveSession(sessionId);
    return this.sessionPermissions.get(sessionId);
  }

  setSessionPermissionMode(input: {
    sessionId: string;
    mode: SessionPermissionMode;
    originClientId?: string;
  }): SessionPermissionState {
    this.sessionCoordinator.assertLiveSession(input.sessionId);
    assertSessionPermissionMode(input.mode);
    const previous = this.sessionPermissions.get(input.sessionId);
    const state = this.sessionPermissions.set(
      input.sessionId,
      input.mode,
      input.originClientId,
    );
    if (previous.mode !== 'allow_all' && state.mode === 'allow_all') {
      this.turnInteractionManager.authorizeSession(input.sessionId);
    }
    return state;
  }

  onSessionPermissionModeChanged(
    handler: (state: SessionPermissionState) => void,
  ): () => void {
    return this.sessionPermissions.onChange(handler);
  }

  private resetSessionPermissionMode(sessionId: string): void {
    const existing = this.sessionPermissions.peek(sessionId);
    if (existing?.mode === 'allow_all') {
      this.sessionPermissions.set(sessionId, 'manual');
    }
    this.sessionPermissions.delete(sessionId);
  }

  getState(): RuntimeLifecycleState {
    return {
      ...this.state,
      lastError: this.state.lastError ? { ...this.state.lastError } : undefined,
    };
  }

  getContextFiles(): ContextFile[] {
    return [...this.resources.contextFiles];
  }

  getToolNames(): string[] {
    return this.snapshotAccess.currentSnapshot().tools.definitions.map((tool) => tool.name);
  }

  getModelCatalog(): ModelCatalogSnapshot {
    const snapshot = this.snapshotAccess.currentSnapshot();
    const providers = Object.freeze(snapshot.providers.map((provider) => Object.freeze({
      providerId: provider.id,
      displayName: provider.displayName ?? provider.id,
      models: Object.freeze(provider.models.map((model) => Object.freeze({
        modelId: model.modelId,
        displayName: model.displayName ?? model.modelId,
        ...(model.capabilities
          ? {
              capabilities: Object.freeze({
                ...(model.capabilities.toolUse !== undefined
                  ? { toolUse: model.capabilities.toolUse }
                  : {}),
                ...(model.capabilities.mediaKinds !== undefined
                  ? { mediaKinds: Object.freeze([...model.capabilities.mediaKinds]) }
                  : {}),
              }),
            }
          : {}),
      }))),
    })));
    const configured = this.resources.appConfig.llm.defaultModel;
    let defaultSelection: ModelCatalogSnapshot['defaultSelection'];
    if (!configured) {
      defaultSelection = Object.freeze({ state: 'unset' });
    } else {
      const reference = Object.freeze({
        providerId: configured.providerId,
        modelId: configured.modelId,
      });
      const provider = snapshot.providers.find((entry) => entry.id === reference.providerId);
      defaultSelection = provider?.models.some((model) => model.modelId === reference.modelId)
        ? Object.freeze({ state: 'available', reference })
        : Object.freeze({
            state: 'unavailable',
            reference,
            reason: provider ? 'model_rejected' : 'provider_unregistered',
          });
    }
    return Object.freeze({
      generation: snapshot.generation,
      defaultSelection,
      providers,
    });
  }

  waitForChannelCompletion(id: string): Promise<ChannelCompletion> {
    return this.channelCompletionObserver.waitForChannelCompletion(id);
  }

  private blockingTurnIds(generation: number): readonly string[] {
    return Object.freeze([...this.activeRootGenerations]
      .filter(([, root]) => root.generation === generation)
      .map(([turnId]) => turnId)
      .sort());
  }

  private abortGeneration(generation: number): readonly string[] {
    const aborted: string[] = [];
    for (const [turnId, root] of this.activeRootGenerations) {
      if (root.generation !== generation) continue;
      this.activeAborts.get(root.sessionId)?.abort('generation-retirement');
      aborted.push(turnId);
    }
    return Object.freeze(aborted.sort());
  }

  private channelBindingsForTurn(
    turnId: string,
  ): readonly ChannelRuntimeBinding[] | undefined {
    return this.activeRootGenerations.get(turnId)?.channels;
  }

  private shouldDeliverAgentEvent(event: AgentEvent): boolean {
    if (event.type !== 'run_end' && event.type !== 'error') return true;
    const outcome = this.requestGates.get(event.requestId)?.terminalOutcome;
    return outcome !== 'shutdown_nonconverged';
  }

  private registerChild(turnId: string, tree: ActiveRootTree): () => void {
    if (tree.released || this.activeRootGenerations.get(turnId) !== tree) {
      throw new Error(`Root tree "${turnId}" no longer accepts Child members.`);
    }
    tree.members += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseTreeMember(turnId, tree);
    };
  }

  private releaseTreeMember(turnId: string, tree: ActiveRootTree): void {
    if (tree.released) return;
    tree.members -= 1;
    if (tree.members > 0) return;
    if (tree.members < 0) {
      throw new Error(`Root tree "${turnId}" member accounting underflow.`);
    }
    tree.released = true;
    tree.pin.release();
    if (this.activeRootGenerations.get(turnId) === tree) {
      this.activeRootGenerations.delete(turnId);
    }
  }

  /**
  * Abort the active turn on `sessionId` AND drop any queued (followup)
   * messages for that session. See core-abort-spec.md §0.3 D3 — single-step
   * "stop everything for this session" semantics.
   *
   * Returns independent `{ aborted, dropped }` values: whether an active Turn
   * was aborted and how many queued messages were removed.
   *
   * When both are empty, no event is emitted.
   *
   * Never throws; safeEmit reduces subscriber failures to warnings.
   *
   * AbortSignal propagation also aborts active Child Agents.
   *
   * The messages_dropped event mirrors the returned dropped count for library
   * and telemetry consumers. Channels use the return value to avoid subscription ordering.
   *
   * Pending steering drained inside runAttempt is discarded and logged on abort,
   * but is not included in dropped or messages_dropped. See section 7.2.3.
   */
  abortTurn(sessionId: string): { aborted: boolean; dropped: number } {
    const controller = this.activeAborts.get(sessionId);
    const queue = this.messageQueueBySession.get(sessionId);
    const dropped = queue?.length ?? 0;
    const aborted = !!controller;

    if (!aborted && dropped === 0) return { aborted: false, dropped: 0 };

    if (controller) controller.abort();
    if (dropped > 0) {
      this.messageQueueBySession.delete(sessionId);
      for (const item of queue ?? []) {
        void this.settleQueuedRequest(item, 'abort_queue_drop');
      }
      this.safeEmit({
        type: 'messages_dropped',
        sessionId,
        reason: 'abort',
        dropped, // Excludes pending steering; see section 7.2.3.
      });
    }
    log.info('turn aborted by user', { sessionId, aborted, dropped });
    return { aborted, dropped };
  }

  /**
  * Convert subscriber exceptions to warnings to preserve the never-throws contract.
   */
  private safeEmit(event: RuntimeEvent): void {
    try {
      this.emit(event);
    } catch (err) {
      log.warn('RuntimeEvent subscriber threw; swallowed', {
        eventType: event.type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Approval routing (channel-design.md section 4.3) ─────────────

  /** Configure interaction transport once; Tool authorization stays in Runner policy flow. */
  private wireApprovalRouting(): void {
    if (this.approvalRoutingWired) return;
    this.approvalRoutingWired = true;

    // TurnInteractionManager → origin channel
    this.turnInteractionManager.onRequest((request) => {
      const originChannel = this.routeContextByTurn.get(request.turnId)?.originChannel;
      if (!originChannel) {
        log.warn('interaction request has no origin channel', {
          interactionId: request.id,
          toolName: request.toolName,
          turnId: request.turnId,
          sessionId: request.sessionId,
          originClientId: request.originClientId,
        });
        return { status: 'unavailable', reason: 'origin_missing' };
      }

      log.info('routing interaction request to origin channel', {
        interactionId: request.id,
        toolName: request.toolName,
        turnId: request.turnId,
        sessionId: request.sessionId,
        originClientId: request.originClientId,
        channelId: originChannel.id,
        route: 'interaction',
      });
      if (!originChannel.interaction) {
        return { status: 'unavailable', reason: 'origin_missing' };
      }
      const interactionRequest: ApprovalInteractionRequest = {
        ...request,
        kind: 'approval',
      };
      return originChannel.interaction.sendInteractionRequest(interactionRequest);
    });

    this.turnInteractionManager.onClose((request, result) => {
      const originChannel = this.routeContextByTurn.get(request.turnId)?.originChannel;
      if (!originChannel) {
        log.warn('interaction closure has no origin channel', {
          interactionId: request.id,
          toolName: request.toolName,
          turnId: request.turnId,
          sessionId: request.sessionId,
          originClientId: request.originClientId,
        });
        return;
      }

      log.info('routing interaction closure to origin channel', {
        interactionId: request.id,
        toolName: request.toolName,
        turnId: request.turnId,
        sessionId: request.sessionId,
        originClientId: request.originClientId,
        channelId: originChannel.id,
        route: 'interaction',
      });

      if (originChannel.interaction) {
        const interactionRequest: ApprovalInteractionRequest = {
          ...request,
          kind: 'approval',
        };
        originChannel.interaction.sendInteractionClosed(interactionRequest, result);
      }
    });
  }

  private getApprovalCapability(turnId: string): CurrentCallApprovalCapability | undefined {
    const route = this.routeContextByTurn.get(turnId);
    const originChannel = route?.originChannel;
    if (!originChannel?.interaction) return undefined;

    const capability: CurrentCallApprovalCapability = {
      request: async (request, signal) => this.turnInteractionManager.request({
        request: {
          toolName: request.toolName,
          input: { ...request.input },
          sessionId: request.sessionId,
          turnId: request.turnId,
          originClientId: this.routeContextByTurn.get(request.turnId)?.originClientId,
        },
        signal,
      }),
    };
    return Object.freeze(capability);
  }

  private handleInteractionResponse(response: TurnInteractionResponse): void {
    log.info('interaction response received from channel', {
      interactionId: response.id,
      kind: response.kind,
      outcome: response.outcome,
      decision: 'decision' in response ? response.decision : undefined,
    });

    if (response.kind !== 'approval') {
      log.warn('unsupported interaction response', {
        interactionId: response.id,
        kind: response.kind,
        outcome: response.outcome,
      });
      return;
    }

    if (response.outcome === 'submitted') {
      this.turnInteractionManager.resolve(response.id, response.decision);
      return;
    }

    if (response.outcome === 'cancelled') {
      this.turnInteractionManager.settle(response.id, {
        outcome: 'denied',
        reason: 'user_cancelled',
      });
      return;
    }

    this.turnInteractionManager.settle(response.id, {
      outcome: 'aborted',
      reason: 'turn',
    });
  }

  /**
  * All inbound Channel messages pass through Runtime intake: media processing,
  * atomic media validation, user_message broadcast, steering routing, then queueing.
  * user_message is emitted after assembly and before queued/steering routing.
   */
  private async handleInboundChannelMessage(
    channel: ChannelRuntimeBinding,
    req: ChannelRunRequest,
  ): Promise<void> {
    log.info('channel message received', {
      channelId: channel.id,
      clientId: req.clientId,
      sessionKey: req.sessionId,
      hasModelOverride: req.modelReference !== undefined,
      hasMaxLlmCalls: req.maxLlmCalls !== undefined,
      messageChars: typeof req.message === 'string' ? req.message.length : undefined,
      attachmentCount: Array.isArray(req.message) ? req.message.length : 0,
    });
    const { normalized, dropped } = await processInboundMessage(req.message);
    if (dropped.length > 0) {
      throw new AttachmentValidationError(dropped);
    }

    const assembled = this.assembleInboundMessage(normalized);
    if (assembled === undefined) return;

    const assembledMessageChars =
      typeof assembled === 'string' ? assembled.length : undefined;
    const assembledAttachmentCount = Array.isArray(assembled) ? assembled.length : 0;

    // Broadcast user_message before selecting queued or steering delivery.
    const routeToSteering = this.shouldRouteMessageToSteering(req.sessionId);
    const deliveryMode: 'queued' | 'steering' = routeToSteering ? 'steering' : 'queued';
    const { text: broadcastText, attachmentSummaries } = summarizeAssembled(assembled);
    const messageId = randomUUID();

    this.fanoutAgentEvent({
      type: 'user_message',
      sessionId: req.sessionId,
      messageId,
      content: broadcastText,
      attachmentSummaries: attachmentSummaries.length ? attachmentSummaries : undefined,
      originClientId: req.clientId ?? null,
      deliveryMode,
      timestamp: Date.now(),
    });

    // Steering accepts text only; attachment-only steering is not queued.
    if (routeToSteering) {
      if (broadcastText.trim() === '') {
        log.info('steering message has no text after summarize; skipping enqueue', {
          channelId: channel.id,
          clientId: req.clientId,
          sessionKey: req.sessionId,
          attachmentCount: attachmentSummaries.length,
        });
        return;
      }
      this.enqueueSteeringInput(
        req.sessionId,
        {
          message: broadcastText,
          launchContext: this.buildTurnLaunchContext(req),
          routeContext: this.buildMessageRouteContext(channel, req),
          originMessageId: messageId,
        },
      );
      log.info('channel message routed to steering', {
        channelId: channel.id,
        clientId: req.clientId,
        sessionKey: req.sessionId,
        messageChars: broadcastText.length,
        droppedAttachments: dropped.length,
      });
      return;
    }

    // Normal queued delivery.
    const queuedTurn: QueuedChannelTurn = {
      requestId: randomUUID(),
      sessionId: req.sessionId,
      message: assembled,
      launchContext: this.buildTurnLaunchContext(req),
      routeContext: this.buildMessageRouteContext(channel, req),
      originMessageId: messageId,
    };
    this.requestGates.set(
      queuedTurn.requestId,
      new RequestCompletionGate(queuedTurn.requestId, queuedTurn.originMessageId),
    );

    this.enqueueQueuedTurn(queuedTurn);
    log.info('channel message enqueued', {
      channelId: channel.id,
      clientId: req.clientId,
      sessionKey: req.sessionId,
      queueLength: this.messageQueueBySession.get(req.sessionId)?.length ?? 0,
      messageChars: assembledMessageChars,
      attachmentCount: assembledAttachmentCount,
      droppedAttachments: dropped.length,
    });

    const started = this.scheduleNextQueuedTurn(req.sessionId);
    if (started) {
      await started;
    }
  }

  /**
   * Reject degenerate normalized input before it reaches the Session queue.
   *
   * undefined means there is no text, successful attachment, or placeholder to queue.
   */
  private assembleInboundMessage(
    normalized: string | ChatContentBlock[],
  ): string | ChatContentBlock[] | undefined {
    if (typeof normalized === 'string') {
      return normalized.trim() === '' ? undefined : normalized;
    }

    // Meaningful arrays contain a non-text block or non-empty trimmed text.
    const hasContent = normalized.some(
      (b) => b.type !== 'text' || (b as { type: 'text'; text: string }).text.trim() !== '',
    );
    if (!hasContent) {
      return undefined;
    }
    return normalized;
  }

  /**
  * Steering requires both the Runtime switch and an active Session Turn.
  * Messages with no active Turn use normal queueing.
   */
  private shouldRouteMessageToSteering(sessionKey: string): boolean {
    return this.resources.runtimeConfig.steeringEnabled
      && this.activeTurnIdBySession.has(sessionKey);
  }

  private buildTurnLaunchContext(req: ChannelRunRequest): TurnLaunchContext | undefined {
    if (
      req.modelReference === undefined
      && req.maxLlmCalls === undefined
    ) {
      return undefined;
    }

    return {
      modelReference: req.modelReference,
      maxLlmCalls: req.maxLlmCalls,
    };
  }

  private buildMessageRouteContext(
    channel: ChannelRuntimeBinding,
    req: ChannelRunRequest,
  ): MessageRouteContext {
    return {
      originChannel: channel,
      originClientId: req.clientId,
    };
  }

  /** Queueing mutates only local state; scheduleNextQueuedTurn decides when to start. */
  private enqueueQueuedTurn(item: QueuedChannelTurn): void {
    const queue = this.messageQueueBySession.get(item.sessionId) ?? [];
    queue.push(item);
    this.messageQueueBySession.set(item.sessionId, queue);
  }

  private settleQueuedRequest(
    item: QueuedChannelTurn,
    reason: 'abort_queue_drop' | 'shutdown',
  ): Promise<void> | undefined {
    const gate = this.requestGates.get(item.requestId);
    if (!gate?.seal({ outcome: 'cancelled', reason })) return undefined;
    const event = Object.freeze({
      type: 'request_end' as const,
      requestId: item.requestId,
      ...(item.originMessageId ? { originMessageId: item.originMessageId } : {}),
      outcome: 'cancelled' as const,
      reason,
    });
    this.safeEmit(event);
    const fanout = Promise.resolve(this.fanoutAgentEvent(event)).catch((error) => {
      log.warn('request_end Fanout failed', {
        requestId: item.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.requestGates.delete(item.requestId);
    return fanout;
  }

  /**
  * Append to the active Turn's steering inbox. Runner currently consumes only
  * text, while routeContext remains available for audit and future routing.
   */
  private enqueueSteeringInput(
    sessionKey: string,
    item: PendingSteeringInput,
  ): void {
    const inbox = this.steeringInboxBySession.get(sessionKey) ?? [];
    inbox.push(item);
    this.steeringInboxBySession.set(sessionKey, inbox);
  }

  /**
   * Move steering that missed Runner's final safe point into the existing
   * queued-Turn path. The original user_message remains the sole intake event.
   */
  private promoteUnreadSteering(sessionKey: string): void {
    const inbox = this.steeringInboxBySession.get(sessionKey);
    if (!inbox || inbox.length === 0) return;

    this.steeringInboxBySession.delete(sessionKey);
    for (const item of inbox) {
      const queuedTurn: QueuedChannelTurn = {
        requestId: randomUUID(),
        sessionId: sessionKey,
        message: item.message,
        launchContext: item.launchContext,
        routeContext: item.routeContext,
        originMessageId: item.originMessageId,
      };
      this.requestGates.set(
        queuedTurn.requestId,
        new RequestCompletionGate(queuedTurn.requestId, queuedTurn.originMessageId),
      );
      this.enqueueQueuedTurn(queuedTurn);
    }
  }

  /**
  * Start at most one queued message for a Session. A busy Session remains
  * queued until the current Turn releases it.
   */
  private scheduleNextQueuedTurn(sessionKey: string): Promise<RunTurnResult> | undefined {
    if (this.inFlightSessions.has(sessionKey)) {
      return undefined;
    }

    const queue = this.messageQueueBySession.get(sessionKey);
    if (!queue || queue.length === 0) {
      return undefined;
    }

    const next = queue.shift();
    if (!next) {
      return undefined;
    }

    if (queue.length === 0) {
      this.messageQueueBySession.delete(sessionKey);
    }

    return this.startQueuedTurn(next);
  }

  /**
  * Allocate turnId and origin routing only when a queued item starts, avoiding
  * Turn resources while queued while preserving approval and interaction routing.
   */
  private async startQueuedTurn(item: QueuedChannelTurn): Promise<RunTurnResult> {
    const turnId = randomUUID();
    if (item.routeContext) {
      this.routeContextByTurn.set(turnId, item.routeContext);
    }

    try {
      return await this.runTurn({
        requestId: item.requestId,
        sessionId: item.sessionId,
        message: item.message,
        promptMode: 'full',
        modelReference: item.launchContext?.modelReference,
        maxLlmCalls: item.launchContext?.maxLlmCalls,
        turnId,
        originMessageId: item.originMessageId,
      });
    } finally {
      this.routeContextByTurn.delete(turnId);
      log.debug('queued turn routing cleared', {
        sessionKey: item.sessionId,
        turnId,
      });
    }
  }

  // ── runTurn ───────────────────────────────────────────────────────

  runTurn(params: RunTurnParams): Promise<RunTurnResult> {
    try {
      this.assertCanRunForSession(params.sessionId);
    } catch (error) {
      return Promise.reject(error);
    }

    const requestId = params.requestId ?? randomUUID();
    const existingGate = this.requestGates.get(requestId);
    const gate = existingGate ?? new RequestCompletionGate<RunTurnResult>(
      requestId,
      params.originMessageId,
    );
    if (!existingGate) this.requestGates.set(requestId, gate);

    const turnId = params.turnId ?? randomUUID();
    if (!gate.start(turnId)) {
      return Promise.reject(new Error(`Runtime request "${requestId}" is already started or terminal.`));
    }

    const worker = this.executeRootRequest(
      { ...params, requestId, turnId },
      gate,
    );
    this.inFlightRuns.add(worker);
    void worker.then(
      () => this.inFlightRuns.delete(worker),
      (error: unknown) => {
        this.inFlightRuns.delete(worker);
        const runtimeError = error instanceof Error ? error : new Error(String(error));
        gate.seal({ outcome: 'failed', error: runtimeError });
        this.requestGates.delete(requestId);
      },
    );

    return gate.terminal.then((terminal) => this.callerResult(terminal));
  }

  private async executeRootRequest(
    params: RunTurnParams & { requestId: string; turnId: string },
    gate: RequestCompletionGate<RunTurnResult>,
  ): Promise<void> {
    const generationPin = this.snapshotAccess.captureRootGeneration();
    const tree: ActiveRootTree = {
      requestId: params.requestId,
      generation: generationPin.generation,
      sessionId: params.sessionId,
      channels: generationPin.snapshot.channels.bindings,
      pin: generationPin,
      members: 1,
      released: false,
    };
    this.activeRootGenerations.set(params.turnId, tree);
    this.inFlightSessions.add(params.sessionId);
    this.state.activeRunCount += 1;
    this.state.lastRunStartedAt = Date.now();
    this.safeEmit({
      type: 'turn_start',
      requestId: params.requestId,
      ...(params.originMessageId ? { originMessageId: params.originMessageId } : {}),
      turnId: params.turnId,
      sessionId: params.sessionId,
      contextVersion: this.state.contextVersion,
    });

    const turnStartedAt = Date.now();
    let promoteUnreadSteering = false;
    this.activeTurnIdBySession.set(params.sessionId, params.turnId);
    log.debug('turn start', {
      requestId: params.requestId,
      sessionKey: params.sessionId,
      turnId: params.turnId,
      generation: generationPin.generation,
      messageChars: typeof params.message === 'string' ? params.message.length : undefined,
      attachmentCount: Array.isArray(params.message) ? params.message.length : 0,
      activeRuns: this.state.activeRunCount,
    });

    try {
      const result = await this.runTurnInternal(params, generationPin, tree);
      const outcome = result.stopReason === 'aborted' ? 'aborted' : 'completed';
      promoteUnreadSteering = result.stopReason !== 'aborted'
        && result.stopReason !== 'max_llm_calls';
      if (gate.seal({ outcome, value: result })) {
        this.safeEmit({
          type: 'turn_end',
          requestId: params.requestId,
          ...(params.originMessageId ? { originMessageId: params.originMessageId } : {}),
          turnId: params.turnId,
          sessionId: params.sessionId,
          outcome,
          result,
        });
      } else {
        log.info('late Root completion ignored by public gate', {
          requestId: params.requestId,
          turnId: params.turnId,
          outcome,
        });
      }
      log.info('turn end', {
        requestId: params.requestId,
        sessionKey: params.sessionId,
        turnId: params.turnId,
        durationMs: Date.now() - turnStartedAt,
        toolRounds: result.toolRounds,
        stopReason: result.stopReason,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    } catch (error) {
      const classifiedInfo = classifyRuntimeError('run', error);
      const modelInvocationError = findModelInvocationError(classifiedInfo.cause);
      const info = modelInvocationError
        ? {
            ...classifiedInfo,
            message: modelInvocationError.message,
            cause: modelInvocationError,
          }
        : classifiedInfo;
      const runtimeError = createRuntimeError(info);
      if (gate.seal({ outcome: 'failed', error: runtimeError })) {
        this.safeEmit({
          type: 'turn_end',
          requestId: params.requestId,
          ...(params.originMessageId ? { originMessageId: params.originMessageId } : {}),
          turnId: params.turnId,
          sessionId: params.sessionId,
          outcome: 'failed',
          failure: Object.freeze({ code: info.code, message: info.message }),
        });
      } else {
        log.info('late Root failure ignored by public gate', {
          requestId: params.requestId,
          turnId: params.turnId,
          code: info.code,
        });
      }
      if (params.originMessageId && error instanceof ModelResolutionError) {
        void Promise.resolve(this.fanoutAgentEvent({
          type: 'error',
          requestId: params.requestId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          error,
          category: error.category,
          originMessageId: params.originMessageId,
        })).catch(() => undefined);
      }
      log.error('turn failed', {
        requestId: params.requestId,
        sessionKey: params.sessionId,
        turnId: params.turnId,
        durationMs: Date.now() - turnStartedAt,
        code: info.code,
        message: info.message,
        ...(modelInvocationError
          ? {
              modelInvocation: Object.freeze({
                category: modelInvocationError.category,
                diagnostics: projectModelInvocationDiagnostics(modelInvocationError.diagnostics),
              }),
            }
          : {}),
      });
      this.recordError('run', info);
    } finally {
      if (this.activeTurnIdBySession.get(params.sessionId) === params.turnId) {
        this.activeTurnIdBySession.delete(params.sessionId);
      }
      if (
        promoteUnreadSteering
        && this.state.phase !== 'closing'
        && this.state.phase !== 'closed'
        && this.state.phase !== 'failed'
      ) {
        this.promoteUnreadSteering(params.sessionId);
      } else {
        this.steeringInboxBySession.delete(params.sessionId);
      }
      this.inFlightSessions.delete(params.sessionId);
      this.state.activeRunCount = Math.max(0, this.state.activeRunCount - 1);
      this.state.lastRunEndedAt = Date.now();
      this.releaseTreeMember(params.turnId, tree);
      this.requestGates.delete(params.requestId);

      const next = this.scheduleNextQueuedTurn(params.sessionId);
      if (next) {
        void next.catch((error) => {
          log.warn('queued turn failed after scheduling', {
            sessionKey: params.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }

  private callerResult(terminal: RequestTerminal<RunTurnResult>): RunTurnResult {
    if (terminal.outcome === 'completed' || terminal.outcome === 'aborted') return terminal.value;
    if (terminal.outcome === 'cancelled') {
      throw new Error(`Runtime request cancelled: ${terminal.reason}`);
    }
    throw terminal.error;
  }

  /**
   * Snapshot the projection of `subagentProfiles` used for the
   * `<available-subagents>` system prompt section. Caller (typically
   * the prompt-factory layer) decides whether to inject it based on
   * `subagents.enabled` and the prompt mode.
   */
  getAvailableSubagents(): AvailableSubagentEntry[] {
    return collectAvailableSubagents(this.subagentProfiles);
  }

  async reloadContextFiles(): Promise<ContextFile[]> {
    this.assertCanReload();

    try {
      const nextFiles = await loadContextFiles(this.resources.agentHome, {
        mode: 'full',
        maxFileChars: this.resources.resolvedConfig.context.maxFileChars,
        maxTotalChars: this.resources.resolvedConfig.context.maxTotalChars,
      });

      this.resources.contextFiles = nextFiles;
      this.state.contextVersion += 1;
      this.emit({
        type: 'context_reload',
        contextVersion: this.state.contextVersion,
        fileCount: nextFiles.length,
      });
      return nextFiles;
    } catch (error) {
      const info = classifyRuntimeError('reload', error);
      this.recordError('reload', info, 'warning');
      return this.resources.contextFiles;
    }
  }

  async close(
    reason?: string,
    sharedBudget?: RuntimeDeadlineBudget,
  ): Promise<RuntimeShutdownReport> {
    if (this.shutdownReport) {
      return this.shutdownReport;
    }

    if (this.closePromise) {
      return this.closePromise;
    }

    log.info('shutdown start', {
      reason,
      inFlightTurns: this.inFlightRuns.size,
      channels: this.snapshotAccess.currentSnapshot().channels.bindings.length,
    });
    this.emit({ type: 'shutdown_start', reason });
    this.setPhase('closing');

    this.closePromise = (async () => {
      const startedAt = Date.now();
      const budget = sharedBudget ?? new RuntimeDeadlineBudget(
        createSystemRuntimeDeadlineDriver(),
        resolveRuntimeDeadlinePolicy(undefined),
      );
      const completed: string[] = [];
      const failed: Array<{ resource: string; message: string }> = [];
      const residuals: import('./types.js').RuntimeShutdownResidual[] = [];
      const queuedCancelledRequestIds: string[] = [];
      const terminalFanout: Promise<void>[] = [];
      const activeAtAdmission = [...this.activeRootGenerations.entries()]
        .sort(([left], [right]) => left.localeCompare(right));
      const terminals = new Map(activeAtAdmission.map(([, tree]) => [
        tree.requestId,
        this.requestGates.get(tree.requestId)?.terminal,
      ]));

      try {
        for (const [sessionKey, queue] of [...this.messageQueueBySession]
          .sort(([left], [right]) => left.localeCompare(right))) {
          this.messageQueueBySession.delete(sessionKey);
          for (const item of queue) {
            queuedCancelledRequestIds.push(item.requestId);
            const delivery = this.settleQueuedRequest(item, 'shutdown');
            if (delivery) terminalFanout.push(delivery);
          }
        }
        this.turnInteractionManager.close();
        completed.push('turnInteractionManager');

        const convergence = () => Promise.allSettled([...this.inFlightRuns]);
        const graceful = await budget.race(
          convergence(),
          budget.policy.shutdownGracefulDrainMs,
        );
        if (graceful.outcome === 'failed') {
          failed.push({ resource: 'turns', message: graceful.message });
        }

        if (graceful.outcome === 'deadline-exhausted') {
          for (const [turnId, tree] of activeAtAdmission) {
            if (this.activeRootGenerations.get(turnId) !== tree) continue;
            this.activeAborts.get(tree.sessionId)?.abort('shutdown');
          }
        }

        const abortConvergence = graceful.outcome === 'deadline-exhausted'
          ? await budget.race(convergence(), budget.policy.shutdownAbortConvergenceMs)
          : graceful;
        if (abortConvergence.outcome === 'failed') {
          failed.push({ resource: 'turns', message: abortConvergence.message });
        }

        const nonconvergedRequestIds: string[] = [];
        if (abortConvergence.outcome === 'deadline-exhausted') {
          for (const [turnId, tree] of [...this.activeRootGenerations.entries()]
            .sort(([left], [right]) => left.localeCompare(right))) {
            const gate = this.requestGates.get(tree.requestId);
            const error = new Error(`Runtime request "${tree.requestId}" did not converge during shutdown.`);
            if (gate?.seal({ outcome: 'shutdown_nonconverged', error })) {
              nonconvergedRequestIds.push(tree.requestId);
              this.safeEmit({
                type: 'turn_end',
                requestId: tree.requestId,
                ...(gate.originMessageId ? { originMessageId: gate.originMessageId } : {}),
                turnId,
                sessionId: tree.sessionId,
                outcome: 'shutdown_nonconverged',
                failure: Object.freeze({
                  code: 'SHUTDOWN_NONCONVERGED',
                  message: error.message,
                }),
              });
            }
            residuals.push({
              owner: 'runtime',
              phase: 'shutdown-abort-convergence',
              generation: tree.generation,
              requestId: tree.requestId,
              turnId,
              blockingTurnIds: Object.freeze([turnId]),
              message: error.message,
            });
          }
        }

        if (terminalFanout.length > 0) {
          const fanout = await budget.raceRemaining(Promise.allSettled(terminalFanout));
          if (fanout.outcome === 'deadline-exhausted') {
            residuals.push({
              owner: 'fanout',
              phase: 'terminal-fanout',
              message: 'Terminal Fanout did not converge before the shutdown deadline.',
            });
          } else if (fanout.outcome === 'failed') {
            failed.push({ resource: 'terminalFanout', message: fanout.message });
          }
        }

        const terminalOutcomes = await Promise.all([...terminals.entries()].map(async ([requestId, terminal]) => [
          requestId,
          terminal ? await terminal : undefined,
        ] as const));
        const completedRequestIds = terminalOutcomes
          .filter(([, terminal]) => terminal?.outcome === 'completed')
          .map(([requestId]) => requestId)
          .sort();
        const actualAbortedRequestIds = terminalOutcomes
          .filter(([, terminal]) => terminal?.outcome === 'aborted')
          .map(([requestId]) => requestId);
        actualAbortedRequestIds.sort();
        nonconvergedRequestIds.sort();
        queuedCancelledRequestIds.sort();
        const protectedGenerations = [...new Set(
          [...this.activeRootGenerations.values()].map((tree) => tree.generation),
        )].sort((left, right) => left - right);

        this.resources.contextFiles = [];
        this.state.closedAt = Date.now();
        this.setPhase('closed');

        const report = freezeShutdownReport({
          outcome: residuals.length > 0 || budget.remaining() <= 0
            ? 'deadline-exhausted'
            : 'completed',
          reason,
          startedAt,
          finishedAt: Date.now(),
          completed,
          failed,
          turns: {
            completedRequestIds,
            abortedRequestIds: actualAbortedRequestIds,
            nonconvergedRequestIds,
            queuedCancelledRequestIds,
            protectedGenerations,
          },
          instanceStops: {
            completedInstanceIds: [],
            failedInstanceIds: [],
            pendingInstanceIds: [],
            skippedProtectedInstanceIds: [],
          },
          residuals,
        });

        this.shutdownReport = report;
        log.info('shutdown complete', {
          durationMs: report.finishedAt - report.startedAt,
          completed: completed.length,
          failed: failed.length,
        });
        this.emit({ type: 'shutdown_end', report });
        return report;
      } catch (error) {
        const info = classifyRuntimeError('shutdown', error);
        log.error('shutdown failed', { code: info.code, message: info.message });
        this.recordError('shutdown', info);
        this.setPhase('failed');
        throw createRuntimeError(info);
      } finally {
        this.sessionPermissions.clear();
      }
    })();

    return this.closePromise;
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
  * Admit the message, optionally reload context, build prompts, and delegate
  * the Turn to AgentRunner.
   */
  private async runTurnInternal(
    params: RunTurnParams & { requestId: string; turnId: string },
    generationPin: RuntimeGenerationPin,
    tree: ActiveRootTree,
  ): Promise<RunTurnResult> {
    // Defensive stale cleanup for unexpected paths that bypassed normal finally cleanup.
    const stale = this.activeAborts.get(params.sessionId);
    if (stale) {
      log.warn('stale abort controller cleared (defensive)', { sessionKey: params.sessionId });
      this.activeAborts.delete(params.sessionId);
    }

    // Register this Turn's controller for abortTurn and shutdown.
    const controller = new AbortController();
    this.activeAborts.set(params.sessionId, controller);
    let parentRecord: ActiveParentTurn | undefined;

    try {
      const admission = await this.sessionCoordinator.admitMessage(
        params.sessionId,
        params.message,
      );

      if (params.reloadContextFiles) {
        await this.reloadContextFiles();
      }

      const snapshot = generationPin.snapshot;
      const visibleToolDefinitions = snapshot.tools.visibleDefinitions(
        this.resources.toolPolicy,
      );

      const resolvedModel = new ModelResolver(snapshot.providers).resolve({
        reference: params.modelReference ?? this.resources.appConfig.llm.defaultModel,
        referenceSource: params.modelReference === undefined ? 'config-default' : 'turn-explicit',
        request: {
          tools: visibleToolDefinitions.length > 0,
          mediaKinds: Array.isArray(params.message)
            && params.message.some((block) => block.type === 'image')
            ? ['image']
            : [],
        },
        policy: {},
      });

      const systemPrompt = this.resources.systemPromptBuilder.build(
        buildSystemPromptParams({
          config: this.resources.resolvedConfig,
          contextFiles: this.resources.contextFiles,
          toolNames: visibleToolDefinitions.map(({ name }) => name),
          overrides: params,
          agentHome: this.resources.agentHome,
          // Only inject the <available-subagents> section when the feature is
          // on. SystemPromptBuilder additionally suppresses it in minimal mode
          // (which is what subagents themselves get).
          availableSubagents:
            this.resources.resolvedConfig.subagents?.enabled !== false
              ? this.getAvailableSubagents()
              : undefined,
        }),
      );

      // Context-hook prepend modifies only text and preserves multimodal ordering.
      let runnerMessage: string | ChatContentBlock[];
      if (typeof params.message === 'string') {
        runnerMessage = (await this.resources.userPromptBuilder.build({
          text: params.message,
        })).text;
      } else {
        // Use the first text block as the prepend host; preserve all other blocks.
        const hostIndex = params.message.findIndex((b) => b.type === 'text');
        const hostText = hostIndex >= 0
          ? (params.message[hostIndex] as { type: 'text'; text: string }).text
          : '';
        const prepended = (await this.resources.userPromptBuilder.build({
          text: hostText,
        })).text;

        runnerMessage = hostIndex >= 0
          ? params.message.map((b, i) =>
              i === hostIndex ? { type: 'text', text: prepended } : b,
            )
          : [{ type: 'text', text: prepended }, ...params.message];
      }

      const effectiveReference: ModelReference = Object.freeze({
        providerId: resolvedModel.identity.providerId,
        modelId: resolvedModel.identity.modelId,
      });
      const effectiveMaxLlmCalls =
        params.maxLlmCalls ?? this.resources.runnerConfig.maxLlmCalls;
      parentRecord = Object.freeze({
        requestId: params.requestId,
        sessionId: params.sessionId,
        depth: 0,
        turnId: params.turnId,
        signal: controller.signal,
        effectiveReference,
        effectiveMaxLlmCalls,
        contextFiles: Object.freeze([...this.resources.contextFiles]),
        registrySnapshot: snapshot,
        getSessionPermissionMode: () =>
          this.sessionPermissions.get(params.sessionId).mode,
        registerChild: () => this.registerChild(params.turnId, tree),
      });
      this.activeParentTurns.set(params.turnId, parentRecord);

      const result = await this.resources.agentRunner.run({
        requestId: params.requestId,
        sessionId: params.sessionId,
        message: runnerMessage,
        resolvedModel,
        systemPrompt,
        turnId: params.turnId,
        toolProjection: snapshot.tools,
        hookProjection: snapshot.hooks,
        toolPolicy: this.resources.toolPolicy,
        getSessionPermissionMode: () =>
          this.sessionPermissions.get(params.sessionId).mode,
        approvalCapability: this.getApprovalCapability(params.turnId),
        maxLlmCalls: effectiveMaxLlmCalls,
        // Runtime drains the inbox; Runner controls when steering is consumed.
        getSteeringMessages: async () => this.drainSteeringMessages(params.sessionId),
        compaction: this.resources.resolvedConfig.compaction,
        originMessageId: params.originMessageId,
        signal: controller.signal, // core-abort-spec.md §8.2
      });

      return {
        sessionId: params.sessionId,
        text: result.text,
        content: result.content,
        stopReason: result.stopReason,
        usage: result.usage,
        toolRounds: result.toolRounds,
      };
    } finally {
      if (parentRecord && this.activeParentTurns.get(params.turnId) === parentRecord) {
        this.activeParentTurns.delete(params.turnId);
      }
      // Remove only the controller registered by this Turn.
      if (this.activeAborts.get(params.sessionId) === controller) {
        this.activeAborts.delete(params.sessionId);
      }
    }
  }

  /**
  * Remove steering input as Runner reads it to prevent duplicate injection.
   */
  private async drainSteeringMessages(sessionKey: string): Promise<ChatMessage[]> {
    const inbox = this.steeringInboxBySession.get(sessionKey);
    if (!inbox || inbox.length === 0) {
      return [];
    }

    this.steeringInboxBySession.delete(sessionKey);

    const messages = await Promise.all(inbox.map(async (item) => {
      // Runner currently consumes text only; routeContext remains for future routing.
      const builtUserPrompt = await this.resources.userPromptBuilder.build({ text: item.message });
      return {
        role: 'user' as const,
        content: builtUserPrompt.text,
      } satisfies ChatMessage;
    }));

    return messages;
  }

  /**
  * Serialize Turns within a Session while allowing cross-Session concurrency.
  * Reject all Turns after Runtime shutdown begins.
   */
  private assertCanRunForSession(sessionKey: string): void {
    if (
      this.state.phase === 'closing' ||
      this.state.phase === 'closed' ||
      this.state.phase === 'failed'
    ) {
      throw createRuntimeError({
        scope: 'run',
        severity: 'recoverable',
        code: 'RUN_REJECTED',
        message: `Cannot run when runtime phase is ${this.state.phase}.`,
      });
    }
    if (this.inFlightSessions.has(sessionKey)) {
      throw createRuntimeError({
        scope: 'run',
        severity: 'recoverable',
        code: 'RUN_REJECTED',
        message: `Session ${sessionKey} already has a turn in flight.`,
      });
    }
  }

  private assertCanReload(): void {
    if (this.state.phase === 'closing' || this.state.phase === 'closed' || this.state.phase === 'failed') {
      throw createRuntimeError({
        scope: 'reload',
        severity: 'recoverable',
        code: 'CONTEXT_LOAD_FAILED',
        message: `Cannot reload context files when runtime phase is ${this.state.phase}.`,
      });
    }
  }

  private assertNotClosed(): void {
    if (this.state.phase === 'closing' || this.state.phase === 'closed' || this.state.phase === 'failed') {
      throw createRuntimeError({
        scope: 'startup',
        severity: 'recoverable',
        code: 'RUN_REJECTED',
        message: `Cannot register channel when runtime phase is ${this.state.phase}.`,
      });
    }
  }

  private setPhase(next: RuntimeLifecyclePhase): void {
    this.state.phase = next;
    if (next === 'ready' && !this.state.readyAt) {
      this.state.readyAt = Date.now();
    }
  }

  private recordError(
    scope: RuntimeErrorScope,
    info: RuntimeErrorInfo,
    eventType?: 'warning' | 'error',
  ): void {
    this.state.lastError = {
      message: info.message,
      at: Date.now(),
      scope,
    };

    const type = eventType ?? (info.severity === 'warning' ? 'warning' : 'error');
    this.emit({ type, info });
  }

  private emit(event: RuntimeEvent): void {
    this.onEvent?.(event);
  }
}

function freezeShutdownReport(report: RuntimeShutdownReport): RuntimeShutdownReport {
  const turns = Object.freeze({
    completedRequestIds: Object.freeze([...report.turns.completedRequestIds]),
    abortedRequestIds: Object.freeze([...report.turns.abortedRequestIds]),
    nonconvergedRequestIds: Object.freeze([...report.turns.nonconvergedRequestIds]),
    queuedCancelledRequestIds: Object.freeze([...report.turns.queuedCancelledRequestIds]),
    protectedGenerations: Object.freeze([...report.turns.protectedGenerations]),
  });
  const instanceStops = Object.freeze({
    completedInstanceIds: Object.freeze([...report.instanceStops.completedInstanceIds]),
    failedInstanceIds: Object.freeze([...report.instanceStops.failedInstanceIds]),
    pendingInstanceIds: Object.freeze([...report.instanceStops.pendingInstanceIds]),
    skippedProtectedInstanceIds: Object.freeze([
      ...report.instanceStops.skippedProtectedInstanceIds,
    ]),
  });
  return Object.freeze({
    ...report,
    completed: Object.freeze([...report.completed]),
    failed: Object.freeze(report.failed.map((entry) => Object.freeze({ ...entry }))),
    turns,
    instanceStops,
    residuals: Object.freeze(report.residuals.map((entry) => Object.freeze({
      ...entry,
      ...(entry.blockingTurnIds
        ? { blockingTurnIds: Object.freeze([...entry.blockingTurnIds]) }
        : {}),
    }))),
  });
}
