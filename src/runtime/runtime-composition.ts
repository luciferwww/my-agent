import type {
  ChannelCompletion,
  ModelCatalogSnapshot,
} from '../core/channel/index.js';
import type { AvailableSubagentEntry } from '../core/subagent/index.js';
import type { ContextFile } from '../core/workspace/index.js';
import type {
  RunTurnParams,
  RunTurnResult,
  RuntimeLifecycleState,
  RuntimeShutdownReport,
} from './types.js';

export type {
  DefaultModelSelection,
  ModelCatalogEntry,
  ModelCatalogSnapshot,
  ProviderCatalogEntry,
} from '../core/channel/index.js';

export interface RuntimeApplication {
  runTurn(params: RunTurnParams): Promise<RunTurnResult>;
  getModelCatalog(): ModelCatalogSnapshot;
  abortTurn(sessionKey: string): { aborted: boolean; dropped: number };
  getState(): RuntimeLifecycleState;
  getToolNames(): string[];
  getContextFiles(): ContextFile[];
  getAvailableSubagents(): AvailableSubagentEntry[];
  reloadContextFiles(): Promise<ContextFile[]>;
  waitForChannelCompletion(id: string): Promise<ChannelCompletion>;
}

export type RuntimeReloadChange = Readonly<{
  operation: 'enable' | 'disable';
  unitId: string;
}>;

export type RuntimeReloadWarning = Readonly<{
  code: string;
  message: string;
  unitId?: string;
}>;

interface RuntimeReloadResultBase {
  readonly requestId: string;
  readonly change: RuntimeReloadChange;
  readonly warnings: readonly RuntimeReloadWarning[];
}

export type RuntimeReloadResult =
  | (RuntimeReloadResultBase & {
      readonly outcome: 'published';
      readonly previousGeneration: number;
      readonly generation: number;
      readonly retiredUnitIds: readonly string[];
    })
  | (RuntimeReloadResultBase & {
      readonly outcome: 'no-op';
      readonly generation: number;
    })
  | (RuntimeReloadResultBase & {
      readonly outcome: 'rejected';
      readonly generation: number;
      readonly category: string;
      readonly message: string;
    })
  | (RuntimeReloadResultBase & {
      readonly outcome: 'superseded';
      readonly generation: number;
      readonly supersededByRequestId: string;
    })
  | (RuntimeReloadResultBase & {
      readonly outcome: 'blocked';
      readonly generation: number;
      readonly blocker: RuntimeCompositionResidual;
    })
  | (RuntimeReloadResultBase & {
      readonly outcome: 'shutdown/cancelled';
      readonly generation: number;
    });

export interface RuntimeCompositionResidual {
  readonly phase: string;
  readonly message: string;
  readonly unitId?: string;
  readonly instanceId?: string;
  readonly generation?: number;
  readonly requestId?: string;
  readonly blockingTurnIds?: readonly string[];
}

export interface RuntimeCompositionControl {
  enableUnit(unitId: string): Promise<RuntimeReloadResult>;
  disableUnit(unitId: string): Promise<RuntimeReloadResult>;
}

export interface RuntimeHandle {
  readonly application: RuntimeApplication;
  readonly composition: RuntimeCompositionControl;
  close(reason?: string): Promise<RuntimeShutdownReport>;
}
