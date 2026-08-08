/**
 * Foreign error vocabularies → the one envelope (docs/design/T-019.md §2.7,
 * §4.3).
 *
 * One direction only. Nothing here re-exports a foreign type, and no other
 * module in this service is permitted to translate `DbError`, `AdapterError`,
 * `ReceiptError`, or a zod issue — otherwise two call sites would eventually
 * disagree about whether a unique violation is a 409 or a 500, and the answer
 * would depend on which handler you happened to hit.
 *
 * The second rule this module keeps: a foreign `message` is NEVER copied onto
 * the wire. `DbError.message` is log-safe by `@db`'s contract but it still names
 * tables and constraints; `AdapterError.message` names a provider. Both go into
 * `cause` (log-only, structurally unable to reach `toEnvelope`) while the
 * response carries static text chosen here.
 */

import type { AdapterError } from '@core';
import type { DbError } from '@db';
import type { ReceiptError } from '@receipt';
import type { ZodIssue } from 'zod';

import { apiError, type ApiError, type ApiErrorCode, type ApiFieldIssue } from './envelope.js';

/** Where a validated value came from — the root segment of every issue path. */
export type ValidationRoot = 'body' | 'params' | 'query' | 'headers';

/** Belt on the one place caller-controlled text may appear in a response. */
const MAX_ISSUE_TEXT = 120;
const UNSAFE_ISSUE_CHARS = /[^\w .,:;/@[\]{}()<>=+*?|'"-]/gu;

const safeText = (value: string): string => value.replace(UNSAFE_ISSUE_CHARS, '_').slice(0, MAX_ISSUE_TEXT);

const dottedPath = (root: ValidationRoot, path: readonly PropertyKey[]): string =>
  [root, ...path.map((segment) => (typeof segment === 'number' ? `[${String(segment)}]` : safeText(String(segment))))]
    .join('.')
    .replace(/\.\[/gu, '[');

/**
 * Describes WHY the value was rejected, never WHAT was sent.
 *
 * zod's own `issue.message` is not forwarded: several of its default messages
 * are safe, but the set is not closed and a future schema (a `.refine`, a
 * regex, a custom error map) could put caller input into it. Deriving the text
 * from the issue's structured fields makes the safety a property of this
 * function rather than a property of every schema anyone ever writes.
 *
 * The one deliberate exception is `unrecognized_keys`, where the key NAME is
 * the whole point of the report (§4.3: "the key path") — a client that typoed
 * `walkaway_number` learns which key was refused, not what it contained.
 */
function describeIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${safeText(String(issue.expected))}`;
    case 'invalid_value': {
      const options = issue.values.map((value) => safeText(String(value)));
      return options.length === 1
        ? `expected ${String(options[0])}`
        : `expected one of: ${options.join(', ')}`;
    }
    case 'unrecognized_keys':
      return `unrecognized key(s): ${issue.keys.map(safeText).join(', ')}`;
    case 'too_small':
      return `${safeText(String(issue.origin))} is below the minimum ${String(issue.minimum)}`;
    case 'too_big':
      return `${safeText(String(issue.origin))} is above the maximum ${String(issue.maximum)}`;
    case 'not_multiple_of':
      return `must be a multiple of ${String(issue.divisor)}`;
    case 'invalid_format':
      return `expected format ${safeText(String(issue.format))}`;
    case 'invalid_key':
      return 'invalid key';
    case 'invalid_element':
      return 'invalid element';
    case 'invalid_union':
      return 'did not match any accepted shape';
    default:
      return 'invalid value';
  }
}

export function toFieldIssues(issues: readonly ZodIssue[], root: ValidationRoot): readonly ApiFieldIssue[] {
  return issues.map((issue) => ({ path: dottedPath(root, issue.path), message: describeIssue(issue) }));
}

export function fromZodError(issues: readonly ZodIssue[], root: ValidationRoot): ApiError {
  return apiError('invalid_request', `request ${root} failed validation`, {
    details: toFieldIssues(issues, root),
  });
}

/**
 * `@db` → envelope.
 *
 * `tenancy_violation` maps to 404 rather than 403 for the same reason the gate
 * does (D3), and it is the one row here that is ALSO a defect signal: the
 * account scope should have made the row unreachable long before Postgres had
 * to refuse it. `http/request-log.ts` logs it at `error`.
 */
export function fromDbError(error: DbError): ApiError {
  const map: Readonly<Record<DbError['code'], ApiErrorCode>> = {
    not_configured: 'internal',
    connection_failed: 'unavailable',
    server_too_old: 'internal',
    permission_denied: 'internal',
    unique_violation: 'conflict',
    foreign_key_violation: 'not_found',
    not_null_violation: 'unprocessable',
    check_violation: 'unprocessable',
    append_only_violation: 'conflict',
    write_once_violation: 'conflict',
    tenancy_violation: 'not_found',
    serialization_failure: 'unavailable',
    statement_timeout: 'unavailable',
    migration_conflict: 'internal',
    unavailable: 'unavailable',
    unknown: 'internal',
  };
  const code = map[error.code];
  return apiError(code, MESSAGE_BY_CODE[code], {
    // The source's own judgement is authoritative for retry — `@db` states it
    // explicitly so no caller has to guess, and re-deriving it here would be a
    // second opinion about the same fact.
    retryable: code === 'unavailable' ? error.retryable : false,
    cause: error,
  });
}

/** `@core` adapter failures — object store, telephony, email, valuation. */
export function fromAdapterError(error: AdapterError): ApiError {
  const map: Readonly<Record<AdapterError['code'], ApiErrorCode>> = {
    invalid_input: 'unprocessable',
    not_found: 'not_found',
    // Not client-fixable and never retryable by the caller: a credential
    // problem is an operator alert wearing a 503.
    auth: 'unavailable',
    rate_limited: 'unavailable',
    provider_unavailable: 'unavailable',
    malformed_response: 'unavailable',
  };
  const code = map[error.code];
  return apiError(code, MESSAGE_BY_CODE[code], {
    retryable: code === 'unavailable' ? error.retryable : false,
    cause: error,
  });
}

export function fromReceiptError(error: ReceiptError): ApiError {
  const map: Readonly<Record<ReceiptError['code'], ApiErrorCode>> = {
    invalid_input: 'unprocessable',
    store_unavailable: 'unavailable',
    not_implemented: 'internal',
  };
  const code = map[error.code];
  return apiError(code, MESSAGE_BY_CODE[code], { retryable: error.retryable && code === 'unavailable', cause: error });
}

/**
 * Fastify's own failures (D4): body limit, unsupported content type,
 * unparseable JSON, and the 404 for a URL no plugin claimed. These never reach
 * a handler, which is exactly why they would otherwise escape as
 * `{statusCode, error, message}` — a second error contract.
 */
export function fromFrameworkError(cause: unknown): ApiError {
  const status = readNumber(cause, 'statusCode');
  const framework_code = readString(cause, 'code');

  if (framework_code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
    return apiError('payload_too_large', MESSAGE_BY_CODE.payload_too_large, { cause });
  }
  if (framework_code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || status === 415) {
    return apiError('unsupported_media_type', MESSAGE_BY_CODE.unsupported_media_type, { cause });
  }
  if (status === 404) return apiError('not_found', MESSAGE_BY_CODE.not_found, { cause });
  if (status !== undefined && status >= 400 && status < 500) {
    // Everything else in the 4xx band that the framework raised before a
    // handler ran is a malformed request: empty body, invalid JSON, bad
    // parameters. Reported as one code so a client sees one contract.
    return apiError('invalid_request', MESSAGE_BY_CODE.invalid_request, { cause });
  }
  return apiError('internal', MESSAGE_BY_CODE.internal, { cause });
}

/**
 * The last resort. An unexpected throw is a DEFECT, so the caller learns the
 * code and nothing else — no stack, no message, no class name. The whole
 * original value rides `cause` into the log.
 */
export function fromUnknown(cause: unknown): ApiError {
  return apiError('internal', MESSAGE_BY_CODE.internal, { cause });
}

/**
 * The caller-facing text for every code. Static and stable: a client may match
 * on `code`, and these strings exist so a human reading a response is not left
 * guessing. Nothing interpolated, so nothing can leak through them.
 */
export const MESSAGE_BY_CODE: Readonly<Record<ApiErrorCode, string>> = {
  invalid_request: 'request failed validation',
  unauthenticated: 'no account context',
  forbidden: 'not permitted',
  not_found: 'not found',
  conflict: 'conflicts with existing state',
  payload_too_large: 'request body too large',
  unsupported_media_type: 'unsupported content type',
  unprocessable: 'request could not be processed',
  internal: 'internal error',
  unavailable: 'temporarily unavailable',
};

function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}
