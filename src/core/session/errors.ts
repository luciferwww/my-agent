export type SessionErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ARCHIVED'
  | 'SESSION_BUSY'
  | 'SESSION_HAS_DESCENDANTS'
  | 'SESSION_TITLE_INVALID'
  | 'SESSION_CAPACITY_EXCEEDED'
  | 'SESSION_DATA_INVALID'
  | 'SESSION_PERSISTENCE_FAILED';

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SessionError';
  }
}