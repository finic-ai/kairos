export type ErrorKind =
  "invalid" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "bad_gateway" | "unavailable";

export const ERROR_STATUS = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  bad_gateway: 502,
  unavailable: 503,
} as const;

export class AppError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (message: string) => new AppError("not_found", "not_found", message);
export const forbidden = (message: string) => new AppError("forbidden", "forbidden", message);
export const invalid = (message: string) => new AppError("invalid", "invalid_request", message);
