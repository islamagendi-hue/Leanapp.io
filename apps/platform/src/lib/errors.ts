/** Typed domain errors. Route handlers and actions map them to HTTP / form errors. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export class NotFoundError extends AppError {
  constructor(what = "Resource") {
    super("not_found", `${what} not found.`, 404);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that.") {
    super("forbidden", message, 403);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = "Sign in required.") {
    super("unauthorized", message, 401);
  }
}
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("validation_error", message, 422, details);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super("conflict", message, 409);
  }
}
export class RateLimitError extends AppError {
  constructor(public readonly retryAfterSeconds: number) {
    super("rate_limited", "Too many requests.", 429);
  }
}
