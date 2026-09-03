export interface FixtureLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}
