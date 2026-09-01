export {
  TurnInteractionManager,
  TurnInteractionManager as ApprovalManager,
} from './TurnInteractionManager.js';
export { CliChannel, type CliChannelConfig } from './CliChannel.js';
export { WebSocketChannel, type WebSocketChannelConfig } from './WebSocketChannel.js';
export type {
  ApprovalDecision,
  ApprovalDeliveryResult,
  ApprovalClosedResult,
  ApprovalInteractionRequest,
  ApprovalInteractionResponse,
  ApprovalRequest,
  ApprovalRequestOptions,
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
