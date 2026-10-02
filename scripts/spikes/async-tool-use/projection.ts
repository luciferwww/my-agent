import type { ChatMessage } from '../../../src/core/model-invocation/types.js';

export interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Result {
  outcome: 'success' | 'failed' | 'cancelled' | 'not_executed';
  content: string;
}

type Event =
  | { kind: 'group'; calls: Call[] }
  | { kind: 'started'; callId: string }
  | { kind: 'result'; callId: string; result: Result }
  | { kind: 'cancel_requested'; callId: string; source: 'steering' | 'root' }
  | { kind: 'root_abort' }
  | { kind: 'activity'; callId: string }
  | { kind: 'steering'; messageId: string; text: string }
  | { kind: 'reply'; messageId: string; text: string; action: 'keep' | 'cancel'; observedThrough: number };

export type Fact = Event & { seq: number };
export interface Snapshot {
  version: 1;
  prefix: ChatMessage[];
  facts: Fact[];
}

export interface ControlDecision {
  reply: string;
  action: 'keep' | 'cancel';
}
export type ControlModel = (messages: ChatMessage[]) => Promise<ControlDecision>;
export type Executor = (call: Call, context: {
  signal: AbortSignal;
  reportActivity: () => void;
}) => Promise<Exclude<Result, { outcome: 'not_executed' }>>;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function group(snapshot: Snapshot): Call[] {
  const first = snapshot.facts[0];
  if (first?.kind !== 'group') throw new Error('Missing call group');
  return first.calls;
}

function resultFor(snapshot: Snapshot, callId: string): Result | undefined {
  for (const fact of snapshot.facts) {
    if (fact.kind === 'result' && fact.callId === callId) return fact.result;
  }
  return undefined;
}

function stateAt(snapshot: Snapshot, through: number): { callId: string; state: string }[] {
  const facts = snapshot.facts.filter((fact) => fact.seq <= through);
  return group(snapshot).map((call) => {
    const result = facts.find((fact) => fact.kind === 'result' && fact.callId === call.id);
    return {
      callId: call.id,
      state: result?.kind === 'result'
        ? result.result.outcome
        : facts.some((fact) => fact.kind === 'started' && fact.callId === call.id) ? 'running' : 'queued',
    };
  });
}

function steeringText(fact: Extract<Fact, { kind: 'steering' }>): string {
  return `[steering id=${fact.messageId}; received_at_fact=${fact.seq}]\n${fact.text}`;
}

function replyText(snapshot: Snapshot, fact: Extract<Fact, { kind: 'reply' }>): string {
  const pending = stateAt(snapshot, fact.observedThrough)
    .filter((entry) => entry.state === 'running' || entry.state === 'queued')
    .map((entry) => entry.callId);
  return `[control reply to=${fact.messageId}; observed_through_fact=${fact.observedThrough}; `
    + `results unavailable at that time for=${JSON.stringify(pending)}]\n${fact.text}`;
}

export function controlProjection(snapshot: Snapshot, through = snapshot.facts.length): ChatMessage[] {
  const messages = copy(snapshot.prefix);
  messages.push({
    role: 'user',
    content: '[HOST EXECUTION SNAPSHOT; status only, not a Tool Result]\n'
      + JSON.stringify({ observedThrough: through, calls: stateAt(snapshot, through) }),
  });
  for (const fact of snapshot.facts) {
    if (fact.seq > through) break;
    if (fact.kind === 'steering') messages.push({ role: 'user', content: steeringText(fact) });
    if (fact.kind === 'reply') messages.push({ role: 'assistant', content: replyText(snapshot, fact) });
  }
  return messages;
}

export function finalProjection(snapshot: Snapshot): ChatMessage[] {
  const calls = group(snapshot);
  if (calls.some((call) => !resultFor(snapshot, call.id))) {
    throw new Error('Pending/unknown execution: continuation blocked; no replay');
  }
  const steering = snapshot.facts.filter((fact) => fact.kind === 'steering');
  const replies = snapshot.facts.filter((fact) => fact.kind === 'reply');
  if (steering.length !== replies.length) throw new Error('Control reply pending');
  return [
    ...copy(snapshot.prefix),
    { role: 'assistant', content: calls.map((call) => ({ type: 'tool_use', ...copy(call) })) },
    {
      role: 'user',
      content: calls.map((call) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(resultFor(snapshot, call.id)),
      })),
    },
    ...snapshot.facts.flatMap((fact): ChatMessage[] => {
      if (fact.kind === 'steering') {
        return [{
          role: 'user',
          content: '[Chronological projection: this input arrived during the original execution; '
            + 'the results placed above were not necessarily available then.]\n' + steeringText(fact),
        }];
      }
      if (fact.kind === 'reply') return [{ role: 'assistant', content: replyText(snapshot, fact) }];
      return [];
    }),
  ];
}

/** One call group, one serial execution slot, and one serial control-model slot. */
export class ProjectionTurn {
  private readonly state: Snapshot;
  private controller: AbortController | undefined;
  private activeId: string | undefined;
  private stopLaunching = false;
  private started = false;
  private controlTail: Promise<void> = Promise.resolve();
  private readonly claimedIds = new Set<string>();
  private readonly abortListener: () => void;

  constructor(
    prefix: ChatMessage[],
    calls: Call[],
    private readonly execute: Executor,
    private readonly model: ControlModel,
    readonly rootSignal: AbortSignal,
  ) {
    if (!calls.length || new Set(calls.map((call) => call.id)).size !== calls.length) {
      throw new Error('Call group must contain unique IDs');
    }
    this.state = { version: 1, prefix: copy(prefix), facts: [] };
    this.append({ kind: 'group', calls: copy(calls) });
    this.abortListener = () => {
      this.append({ kind: 'root_abort' });
      this.cancel('root');
    };
    rootSignal.addEventListener('abort', this.abortListener, { once: true });
    if (rootSignal.aborted) this.abortListener();
  }

  snapshot(): Snapshot {
    return copy(this.state);
  }

  private append(event: Event): void {
    this.state.facts.push({ ...event, seq: this.state.facts.length + 1 });
  }

  /** Idempotent late delivery; conflicting terminal facts are never overwritten. */
  acceptResult(callId: string, result: Result): boolean {
    const prior = resultFor(this.state, callId);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(result)) throw new Error('Conflicting terminal');
      return false;
    }
    if (!group(this.state).some((call) => call.id === callId)) throw new Error('Unknown call');
    const hasStarted = this.state.facts.some((fact) => fact.kind === 'started' && fact.callId === callId);
    if ((result.outcome === 'not_executed') === hasStarted) throw new Error('Invalid start/result relation');
    this.append({ kind: 'result', callId, result: copy(result) });
    return true;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Execution cannot be replayed');
    this.started = true;
    try {
      for (const call of group(this.state)) {
        if (this.stopLaunching) {
          this.acceptResult(call.id, { outcome: 'not_executed', content: 'Stopped before launch' });
          continue;
        }
        this.controller = new AbortController();
        this.activeId = call.id;
        this.append({ kind: 'started', callId: call.id });
        try {
          const result = await this.execute(copy(call), {
            signal: this.controller.signal,
            reportActivity: () => {
              if (!resultFor(this.state, call.id)) this.append({ kind: 'activity', callId: call.id });
            },
          });
          this.acceptResult(call.id, result);
        } catch (error) {
          this.acceptResult(call.id, {
            outcome: 'failed',
            content: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.activeId = undefined;
          this.controller = undefined;
        }
      }
    } finally {
      this.rootSignal.removeEventListener('abort', this.abortListener);
    }
  }

  cancel(source: 'steering' | 'root'): void {
    this.stopLaunching = true;
    if (!this.activeId || resultFor(this.state, this.activeId) || this.controller?.signal.aborted) return;
    this.append({ kind: 'cancel_requested', callId: this.activeId, source });
    this.controller?.abort();
  }

  steer(messageId: string, text: string): Promise<void> {
    if (this.claimedIds.has(messageId)) return Promise.reject(new Error('Duplicate steering identity'));
    this.claimedIds.add(messageId);
    this.append({ kind: 'steering', messageId, text });
    const next = this.controlTail.then(async () => {
      const through = this.state.facts.length;
      const decision = await this.model(controlProjection(this.state, through));
      if (decision.action !== 'keep' && decision.action !== 'cancel') throw new Error('Invalid control action');
      this.append({
        kind: 'reply',
        messageId,
        text: decision.reply,
        action: decision.action,
        observedThrough: through,
      });
      if (decision.action === 'cancel') this.cancel('steering');
    });
    this.controlTail = next.catch(() => undefined);
    return next;
  }
}
