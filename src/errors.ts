/**
 * 统一错误码与可解释错误类型。
 * 所有参数校验失败都抛出带 code 的 ValidationError，不静默丢消息。
 */
export const ErrorCode = {
  INVALID_SLOT: 'INVALID_SLOT',
  INVALID_PROBABILITY: 'INVALID_PROBABILITY',
  INVALID_SEED: 'INVALID_SEED',
  INVALID_LIMIT: 'INVALID_LIMIT',
  DUPLICATE_STATION: 'DUPLICATE_STATION',
  DUPLICATE_MESSAGE: 'DUPLICATE_MESSAGE',
  EMPTY_STATIONS: 'EMPTY_STATIONS',
  UNKNOWN_STATION: 'UNKNOWN_STATION',
  QUEUE_OVERFLOW: 'QUEUE_OVERFLOW',
  RUN_LOCKED: 'RUN_LOCKED',
  RUN_FINISHED: 'RUN_FINISHED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCodeType;
  readonly details?: unknown;
  constructor(code: ErrorCodeType, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code: ErrorCodeType, message: string, details?: unknown): never {
  throw new AppError(code, message, details);
}
