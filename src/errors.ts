export type ErrorCode =
  | "E_VALIDATION"
  | "E_DUP_STATION"
  | "E_DUP_MESSAGE"
  | "E_UNKNOWN_STATION"
  | "E_NEGATIVE_TIME"
  | "E_NON_INTEGER_SLOT"
  | "E_BAD_PROBABILITY"
  | "E_BAD_SEED"
  | "E_QUEUE_OVERFLOW"
  | "E_MODEL_FROZEN"
  | "E_NOT_FOUND"
  | "E_RUN_FINISHED"
  | "E_BUDGET_EXHAUSTED"
  | "E_BAD_REQUEST";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode | "E_INTERNAL",
    message: string,
    public httpStatus = 400
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorBody(err: unknown): { error: { code: string; message: string } } {
  if (err instanceof ApiError) {
    return { error: { code: err.code, message: err.message } };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { error: { code: "E_INTERNAL", message: msg } };
}

export function httpStatusOf(err: unknown): number {
  if (err instanceof ApiError) return err.httpStatus;
  return 500;
}
