export type RequestTerminal<T> =
  | { readonly outcome: 'completed'; readonly value: T }
  | { readonly outcome: 'aborted'; readonly value: T }
  | { readonly outcome: 'failed' | 'shutdown_nonconverged'; readonly error: Error }
  | { readonly outcome: 'cancelled'; readonly reason: 'abort_queue_drop' | 'shutdown' };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** RuntimeApp-owned compare-and-set gate for one accepted Root request. */
export class RequestCompletionGate<T> {
  readonly terminal: Promise<RequestTerminal<T>>;
  private readonly deferred: Deferred<RequestTerminal<T>>;
  private state: 'accepted' | 'started' | 'terminal' = 'accepted';
  private _turnId?: string;
  private _terminalOutcome?: RequestTerminal<T>['outcome'];

  constructor(
    readonly requestId: string,
    readonly originMessageId?: string,
  ) {
    this.deferred = createDeferred<RequestTerminal<T>>();
    this.terminal = this.deferred.promise;
  }

  get turnId(): string | undefined {
    return this._turnId;
  }

  get isTerminal(): boolean {
    return this.state === 'terminal';
  }

  get terminalOutcome(): RequestTerminal<T>['outcome'] | undefined {
    return this._terminalOutcome;
  }

  start(turnId: string): boolean {
    if (this.state !== 'accepted') return false;
    this.state = 'started';
    this._turnId = turnId;
    return true;
  }

  seal(terminal: RequestTerminal<T>): boolean {
    if (this.state === 'terminal') return false;
    this.state = 'terminal';
    this._terminalOutcome = terminal.outcome;
    this.deferred.resolve(Object.freeze(terminal));
    return true;
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
