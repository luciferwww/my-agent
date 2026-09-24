# Channels

> Status: Current Authority
> Authority: Current implemented Channel behavior
> Verified: 2026-09-18
> Ownership: Channel contracts, Host-local CLI, Extension-delivered WebSocket protocol, interaction, attachment ingress, and client routing
> Ownership key: channel-transport-and-ingress

---

## 1. Boundary

`src/builtins/channels/cli/` owns the Standalone-local CLI adapter and its
Runtime Unit entry. `extensions/websocket-channel/` independently owns the
reusable WebSocket transport, HTTP client delivery, and external Runtime Unit
entry. Canonical Channel and interaction contracts live in
`src/core/channel/`; the Runtime-owned pending-interaction lifecycle lives in
`src/runtime/turn-interaction/`.

Channels own transport and wire validation. They pass accepted `ChannelRunRequest` values to the Runtime; they do not schedule Turns or call the Runner directly. Runtime owns per-session queueing, steering classification, Turn identity, generation capture, interaction routing, and event Fanout. [Media](media.md) owns attachment validation and canonical normalization after Channel ingress.

Runtime Composition observes each successfully published Channel completion once. A failed completion produces one bounded Runtime warning containing only Channel ID and phase; raw transport errors are not logged at this boundary. Concrete Hosts retain process-liveness and exit policy but do not duplicate Channel failure logs or observe secondary completions only for logging.

## 2. Source layout

```text
src/core/channel/
├── types.ts                  # canonical Channel, interaction, Catalog, and capability contracts
└── index.ts

src/builtins/channels/
└── cli/
    ├── CliChannel.ts         # readline transport
    ├── runtime-unit.ts
    └── index.ts

extensions/websocket-channel/
├── WebSocketChannel.ts       # HTTP and WebSocket transport
├── websocket-channel-unit.ts
├── entry.ts                  # Extension factory
└── client/chat.html

src/runtime/turn-interaction/
├── TurnInteractionManager.ts # Runtime-owned Promise bus
└── index.ts
```

## 3. Inbound, outbound, and capability flows

### 3.1 Client to Runtime

```text
CLI or WebSocket input
  │ ChannelRunRequest
  ▼
channel.onMessage(handler)
  ▼
RuntimeApp.handleInboundChannelMessage
  ├─ atomic Media normalization; reject the whole message on any failure
  ├─ emit user_message before routing divergence
  ├─ enabled active-session steering → steering inbox
  └─ ordinary input → per-session queue → scheduler
                                      ▼
                                 startQueuedTurn
                                 ├─ create turnId
                                 ├─ register origin Channel/client route
                                 └─ runTurn(...)
```

- A queued request receives a `requestId` and `originMessageId`, but its `turnId` is created only when that queue item starts. Queue waiting therefore does not allocate Turn-level routing state.
- `clientId` remains transport routing metadata in `MessageRouteContext`; it is not added to `RunTurnParams`.
- `user_message` is emitted after input assembly and before queued/steering classification. Queued execution carries its ID as `originMessageId` on subsequent lifecycle events. A steering message that misses the final Runner safe point is promoted after normal completion and later carries the same ID into its own Turn without another `user_message`.
- Any attachment failure rejects the complete inbound message before `user_message` emission or Runtime routing. WebSocket reports `ATTACHMENT_REJECTED`; no partial content is admitted.
- Steering currently accepts text only. A pure-attachment message is broadcast as `user_message` but is not added to the steering inbox.
- Direct library `runTurn()` bypasses Channel ingress and Channel queue creation, while still using the Runtime per-session gate and generation capture.

### 3.2 Runtime to clients

```text
AgentEvent
  ▼
Runtime Builder Fanout
  ├─ each selected ChannelRuntimeBinding.send(event)
  └─ RuntimeAppOptions.onAgentEvent(event)
```

Fanout selects captured-generation Channel bindings for events with a live `turnId`; events without Turn correlation use current bindings. Each synchronous throw or asynchronous rejection is contained and logged so one Channel or observer failure does not stop other deliveries or alter Turn execution. Terminal Fanout promises are tracked for bounded Shutdown convergence.

Most events route by `sessionId`. Subagent events carry a child `sessionId` plus `callerSessionId`, and WebSocket routes them to the caller Session audience. A queued `request_end` has no Session ID, so WebSocket resolves its audience from the earlier `user_message` through `originMessageId`; an uncorrelated event is not sent. `user_message.attachmentSummaries` may expose type, MIME, byte count, and dimensions, but never raw base64.

### 3.3 Runtime capabilities

Before `start()`, candidate activation may call:

```text
bindRuntimeCapabilities({ modelCatalog, abort })
```

`modelCatalog.getSnapshot()` is a live query over the current published generation. `abort.querySessionsNeedingAbort()` and `abort.abortTurn(sessionId)` form the abort capability; aborting a session can terminate its active Turn and drop ordinary queued requests. Channel model selection consumes the Catalog for presentation and early checks, but Model Resolution remains the final authority.

## 4. Canonical contracts

`src/core/channel/types.ts` owns `ChannelRunRequest`, `ChannelInstance`,
completion, interaction, Runtime-capability, and `ChannelOperationError`
types. Runtime normalizes owner-internal Session and Media failures into that
bounded Channel-facing error instead of exposing their concrete classes
through the Extension API. The adapter-facing send boundary is
`send(event: AgentEvent): void | Promise<void>`. A Unit stages
`ChannelContribution` factories; Runtime publishes only immutable narrow
`ChannelRuntimeBinding` projections. [Channel Specification](../specifications/channel.md)
owns the stable contract.

## 5. Approval and interaction lifecycle

`TurnInteractionManager` is the Runtime-owned in-memory Promise bus. It routes a Tool interaction to the Turn's captured Channel/client origin and reports responses or terminal unavailability back to Runner. Elevating a Session to `allow_all` closes its already-pending requests as mode-authorized so clients can remove stale approval UI. Channel implementations provide approval interactions and user-facing Session permission controls; [Approval Lifecycle](../specifications/approval-lifecycle.md) owns settlement and failure semantics.

## 6. CLI Channel

`CliChannel` is a single-session readline transport.

```text
CliChannelConfig {
  input?: NodeJS.ReadableStream   # default process.stdin
  output?: NodeJS.WritableStream  # default process.stdout
  prompt?: string                 # default "> "
  approval?: boolean              # default false
}
```

### 6.1 Presentation

CLI streams text, presents bounded Tool/Compaction/Subagent status, suppresses local input echo, and lets the input loop print failures once. It renders `max_llm_calls` as a generic configured-limit notice based on the existing `run_end` result. The HTML client uses the same existing stop reason for a system notice. Tool Result preview limits affect presentation only, never the result passed to the Model.

### 6.2 Model commands and lifecycle

`/models` and `/model` query and select exact current-Catalog references; display escaping never changes opaque Model identity. `/permission` shows the current Session mode, while `/permission manual` and `/permission allow_all` change it. Allow All requires typing an explicit confirmation after a warning about Shell, external filesystem, integrity, and disconnect behavior. A new CLI conversation initially has no Session ID. The first ordinary message calls the Runtime Session capability and immediately submits the message with the returned server-issued UUID; later messages reuse that ID. Merely entering a new-conversation state does not create a Pending Session. CLI approval uses its readline interaction, Ctrl+C delegates active/queued Abort through Runtime capabilities before closing the Channel, and process exit policy remains Host-owned.

## 7. WebSocket Channel

```text
WebSocketChannelConfig {
  host: string
  port: number
  webSocketPath: string
  clientPath: string
  maxClients?: number
  approval: boolean
  openBrowser: boolean
}
```

The Extension Descriptor supplies defaults after explicit enablement:
`127.0.0.1:8787`, WebSocket path `/ws`, client path `/`, approval enabled,
and browser launch disabled. The Extension owns its 15 MiB maximum frame size.
A socket must complete `hello` before business messages.

The bundled HTML is a minimal reference/debugging client. A production website
may run elsewhere and connect to the endpoint directly. Authentication, TLS,
Origin/Host policy, and public-network hardening are deliberately outside this
Channel and belong to the operational proxy/gateway boundary.

### 7.1 Protocol and routing

After `hello`, WebSocket accepts Session creation, permission query/change, Turn submission, approval resolution, Abort, and Catalog queries. All JSON property names use camelCase; snake_case is reserved for `type` discriminator values such as `create_session` and `run_turn`. `create_session` carries a `requestId` and optional `permissionMode`; `session_created` returns the same `requestId`, server-issued `sessionId`, and authoritative permission state. Strict `get_session_permission_mode` and `set_session_permission_mode` messages use `sessionId`; the setter additionally requires `mode: 'manual' | 'allow_all'`. Successful queries and changes produce `session_permission_mode_changed`, and changes are broadcast to the connected audience observing that Session. `run_turn` continues to require `sessionId`, so the Channel never treats an omitted ID as an implicit create. It also emits acknowledgements, Catalog responses, correlated `AgentEvent` values, approval lifecycle messages, and requesting-socket errors. Wire validation owns JSON and transport shape; Media owns decoded attachment validation.

Clients should treat “new Session” as local state only. When the user submits the first message, the client issues `create_session` with the selected initial permission mode, waits for `session_created`, and immediately issues `run_turn` with the returned ID. This makes initial elevation atomic and avoids abandoned UI create actions producing even a Pending registration. For an existing Session, the HTML client queries Runtime truth on selection/reconnect, stores no grant locally, requires confirmation before Allow All, shows a persistent warning while elevated, and can revoke to Manual for future calls.

A successful `run_turn` registers the client in that session's audience. The
relationship is many-to-many: one logical `clientId` may work in multiple
Sessions concurrently, and one Session may have multiple connected clients.
The Channel maintains forward and reverse audience maps so disconnect cleanup
is proportional to that client's sessions. The bundled reference client keeps
independent in-memory draft, attachment, Turn, Approval, permission, and
waiting state for each Session, so switching the visible Session does not
cancel or hide another Session's active work. This state is page-local and is
not replayed after a refresh or reconnect.

A newer socket using the same `clientId` supersedes and closes the old socket;
the old socket's late close cannot remove the replacement. A pending approval
route carries `clientId`, `sessionId`, and `turnId`. Both `approval_requested`
and `approval_closed` expose the Session and Turn correlation on the wire.
Only that logical client may resolve the pending approval; foreign and unknown
approval IDs fail without consuming the pending route. A disconnect of the
current socket reports `origin_disconnected`. For the queued terminal event
whose canonical `AgentEvent` has no Session ID, the Channel resolves the
Session from `originMessageId` and adds that Session correlation to the
WebSocket payload.

Runtime Model Resolution errors retain their category. The HTML client refreshes the Catalog after an unavailable exact selection and requires explicit reselection; it does not substitute a model or resubmit the failed Turn. WebSocket Abort completion remains visible through correlated Turn events.

## 8. Runtime composition

Runtime creates and starts candidate Channel instances before publication, binds the Runtime host and capabilities before readiness, and keeps ingress closed until publication. Candidate create/start failure rolls back all sibling Channels in that Unit. Root Turn trees retain their captured generation's Channel bindings; reload does not reroute in-flight events to newer instances. `waitForChannelCompletion(id)` exposes terminal Channel completion.

Standalone supplies no Host-local Channel by default and supplies only the CLI
Unit when `--cli` is present. WebSocket is loaded only through generic
Extension Acquisition after an explicit `extensions.entries.websocket-channel`
entry. The Host does not import or identify that Extension. The global Agent
configuration has no general Channel-selection namespace.

## 9. Evidence

| Kind | Evidence |
|---|---|
| Source | [Core Channel types](../../src/core/channel/types.ts), [Runtime intake](../../src/runtime/RuntimeApp.ts), [WebSocket Extension](../../extensions/websocket-channel/WebSocketChannel.ts) |
| Tests | [Runtime intake tests](../../src/runtime/RuntimeApp.intake.test.ts), [WebSocket Extension tests](../../extensions/websocket-channel/WebSocketChannel.test.ts) |
| Controlling authority | [Channel Specification](../specifications/channel.md), [Approval Lifecycle Specification](../specifications/approval-lifecycle.md), [Multi-client User Messages Specification](../specifications/multi-client-user-messages.md) |
