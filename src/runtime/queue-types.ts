import type { ChannelRuntimeBinding } from '../core/channel/index.js';
import type { ChatContentBlock } from '../core/model-invocation/index.js';
import type { CanonicalModelIdentity } from '../core/model-resolution/index.js';

export type MessageRouteContext = {
  originChannel?: ChannelRuntimeBinding;
  originClientId?: string;
};

/**
 * Minimal accepted Channel message retained until claim or standalone launch.
 */
export type QueuedUserMessage = {
  requestId: string;
  sessionId: string;
  message: string | ChatContentBlock[];
  modelReference?: CanonicalModelIdentity;
  routeContext?: MessageRouteContext;
  /**
   * UUID emitted with `user_message`; later binding events correlate the
   * accepted message with its actual Turn.
   */
  originMessageId: string;
};