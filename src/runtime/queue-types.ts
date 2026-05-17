import type { Channel } from '../adapters/channel/types.js';
import type { RunTurnParams } from './types.js';

export type TurnLaunchContext = Pick<
  RunTurnParams,
  'model' | 'maxTokens' | 'maxLlmCalls'
>;

export type MessageRouteContext = {
  originChannel?: Channel;
  originClientId?: string;
};

/**
 * 普通入站消息进入 session 队列后的最小保留形态。
 * 这里只保存后续真正启动 turn 时还原 RunTurnParams 与交互路由所需的信息。
 */
export type QueuedChannelTurn = {
  sessionKey: string;
  message: string;
  launchContext?: TurnLaunchContext;
  routeContext?: MessageRouteContext;
};

/** 当前活动 run-turn 可在执行中途消费的最小 steering 输入形态。 */
export type PendingSteeringInput = {
  message: string;
  routeContext?: MessageRouteContext;
};