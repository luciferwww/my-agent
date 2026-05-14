export {
  TurnInteractionManager,
  type TurnInteractionManagerConfig,
  TurnInteractionManager as ApprovalManager,
  type TurnInteractionManagerConfig as ApprovalManagerConfig,
} from './TurnInteractionManager.js';
export { CliChannel, type CliChannelConfig } from './CliChannel.js';
export { WebSocketChannel, type WebSocketChannelConfig } from './WebSocketChannel.js';
export type {
  ApprovalDecision,
  ApprovalInteractionRequest,
  ApprovalInteractionResponse,
  ApprovalRequest,
  ApprovalResult,
  Channel,
  ChannelApprovalAdapter,
  ChannelInteractionAdapter,
  ChannelRunRequest,
  SelectInteractionRequest,
  SelectInteractionResponse,
  TurnInteractionKind,
  TurnInteractionOption,
  TurnInteractionOutcome,
  TurnInteractionRequest,
  TurnInteractionResponse,
} from './types.js';
