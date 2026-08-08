/**
 * The ONE error envelope (docs/design/T-019.md §2.7, D4; AC-6).
 *
 * ADR-001: "defined once … and imported everywhere — no parallel type
 * definitions." Every non-2xx body this service emits is `ApiErrorBody` and
 * nothing else — including the bodies Fastify would otherwise generate for a
 * route that was never reached (413/415/404/500). Those are overwritten in
 * `http/server.ts`, because a framework-shaped error body is a second error
 * contract that also leaks the framework.
 *
 * `ApiError` is the in-process carrier; `ApiErrorBody` is the wire shape. The
 * split exists so `cause` (a driver error, a stack, a SQLSTATE detail) has
 * somewhere to live for the log and NO path to the response — `toEnvelope`
 * simply cannot copy it.
 */

/**
 * The closed code set. A status is derived from the code, never chosen at a
 * call site, so two endpoints cannot disagree about what "not found" is worth.
 */
export type ApiErrorCode =
  | 'invalid_request' // 400 — malformed body/params/query, or out-of-enum
  | 'unauthenticated' // 401 — no account context resolved at the edge
  | 'forbidden' // 403 — role/grant denial INSIDE an owned account (E3)
  | 'not_found' // 404 — absent, OR not owned (D3 — indistinguishable ON PURPOSE)
  | 'conflict' // 409 — write-once / uniqueness violated
  | 'payload_too_large' // 413
  | 'unsupported_media_type' // 415
  | 'unprocessable' // 422 — well-formed but violates a domain invariant
  | 'internal' // 500 — a defect; details never leave the process
  | 'unavailable'; // 503 — transient; the ONLY default-retryable code

export const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  unprocessable: 422,
  internal: 500,
  unavailable: 503,
};

/**
 * Retryability is derived from the code and stated explicitly on the wire so a
 * client never guesses. Only `unavailable` is retryable by default: a `409`
 * needs a new natural key, a `500` needs a fix, and a `400` needs a new
 * request. `apiError` lets a caller widen this ONLY by passing `retryable`
 * deliberately, which is visible at the call site and in review.
 */
export function defaultRetryable(code: ApiErrorCode): boolean {
  return code === 'unavailable';
}

export interface ApiFieldIssue {
  /** Dotted path, e.g. `body.working_with.role`. */
  readonly path: string;
  /**
   * WHY, never WHAT. "expected one of: sales_agent, …" is safe to echo; the
   * rejected VALUE is not — it is caller input that would land in a log and in
   * a shared error body.
   */
  readonly message: string;
}

/** The wire shape. Every non-2xx response in this service is exactly this. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    /** Log-safe, caller-safe, stable. Never a stack, SQL, URL, or echoed input. */
    readonly message: string;
    readonly request_id: string;
    readonly retryable: boolean;
    /** Present only for `invalid_request`. */
    readonly details?: readonly ApiFieldIssue[];
  };
}

/** The in-process carrier. `cause` is for the log only and is NEVER serialized. */
export interface ApiError {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: readonly ApiFieldIssue[];
  readonly cause?: unknown;
}

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

export const ok = <T>(value: T): ApiResult<T> => ({ ok: true, value });
export const fail = <T = never>(error: ApiError): ApiResult<T> => ({ ok: false, error });

/**
 * Builds the carrier without ever assigning `undefined` to an optional field
 * (`exactOptionalPropertyTypes` is on repo-wide).
 */
export function apiError(
  code: ApiErrorCode,
  message: string,
  extra: { readonly retryable?: boolean; readonly details?: readonly ApiFieldIssue[]; readonly cause?: unknown } = {},
): ApiError {
  return {
    code,
    message,
    retryable: extra.retryable ?? defaultRetryable(code),
    ...(extra.details !== undefined && { details: extra.details }),
    ...(extra.cause !== undefined && { cause: extra.cause }),
  };
}

export const statusFor = (error: ApiError): number => STATUS_BY_CODE[error.code];

/**
 * Carrier → wire. `cause` is structurally unable to cross: it is not read here,
 * so no future edit to a call site can leak one by accident.
 *
 * `details` is emitted only for `invalid_request` (§2.7): a 404 that carried
 * field paths would describe a resource the caller may not be allowed to know
 * exists, and a 500 that carried them would describe our internals.
 */
export function toEnvelope(error: ApiError, request_id: string): ApiErrorBody {
  const details = error.code === 'invalid_request' ? error.details : undefined;
  return {
    error: {
      code: error.code,
      message: error.message,
      request_id,
      retryable: error.retryable,
      ...(details !== undefined && details.length > 0 && { details }),
    },
  };
}

/**
 * Shape assertion used by the `onSend` guard (D4): the LAST thing that can tell
 * us a non-2xx body escaped the envelope. Deliberately structural rather than a
 * class check — a body that arrived from a plugin is still a body.
 */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  if (typeof candidate !== 'object' || candidate === null) return false;
  const body = candidate as Record<string, unknown>;
  return (
    typeof body['code'] === 'string' &&
    (STATUS_BY_CODE as Record<string, number>)[body['code']] !== undefined &&
    typeof body['message'] === 'string' &&
    typeof body['request_id'] === 'string' &&
    typeof body['retryable'] === 'boolean'
  );
}

/**
 * An `ApiError` that has been thrown rather than returned.
 *
 * Failures are values everywhere in this service; this exists only for the two
 * places Fastify's own control flow requires an exception — a hook that must
 * abort the request, and the readers in §2.4/§2.5 whose precondition the route
 * audit already guarantees. `http/server.ts` unwraps it back into the envelope.
 */
export class ApiErrorException extends Error {
  readonly api_error: ApiError;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiErrorException';
    this.api_error = error;
  }
}

export const throwApi = (code: ApiErrorCode, message: string): never => {
  throw new ApiErrorException(apiError(code, message));
};
