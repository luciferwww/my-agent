import type { ChannelRuntimeBinding } from '../core/channel/index.js';
import type { ChatContentBlock } from '../core/model-invocation/index.js';
import type { RunTurnParams } from './types.js';

export type TurnLaunchContext = Pick<
  RunTurnParams,
  'modelReference' | 'requestOverride' | 'maxLlmCalls'
>;

export type MessageRouteContext = {
  originChannel?: ChannelRuntimeBinding;
  originClientId?: string;
};

/**
 * 普通入站消息进入 session 队列后的最小保留形态。
 * 这里只保存后续真正启动 turn 时还原 RunTurnParams 与交互路由所需的信息。
 */
export type QueuedChannelTurn = {
  requestId: string;
  sessionKey: string;
  message: string | ChatContentBlock[];
  launchContext?: TurnLaunchContext;
  routeContext?: MessageRouteContext;
  /**
   * emit `user_message` 时生成的 UUID；启动 turn 时透传到 run_start.originMessageId，
   * 客户端据此把 turn 反向关联到触发它的用户消息。
   * 见 channel-multi-client-user-message-spec §5.1 D6。
   */
  originMessageId?: string;
};

/** 当前活动 run-turn 可在执行中途消费的最小 steering 输入形态。 */
export type PendingSteeringInput = {
  message: string;
  routeContext?: MessageRouteContext;
};