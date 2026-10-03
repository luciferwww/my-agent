export interface MissingLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface UncoveredPort {
  send(message: string): Promise<void>;
}

export interface PayloadConfig {
  enabled: boolean;
}
