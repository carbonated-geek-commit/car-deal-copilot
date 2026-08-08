/**
 * `ObjectBackend` — the internal, key-level seam (docs/design/T-018.md §1.1).
 *
 * This is NOT the public interface (that is `ObjectStore` in contract.ts). It
 * exists so that policy, key construction, tenancy scoping, and integrity
 * verification live in exactly one place (`artifact-store.ts`) and are
 * therefore identical whether the bytes land in S3 or in the in-process fake.
 * A backend moves bytes at a key and knows nothing about accounts, deals,
 * kinds, or content policy.
 *
 * Nothing declared here is a provider type: `s3-backend.ts` is the only module
 * that imports `@aws-sdk/client-s3`, and no command object, stream, or SDK
 * exception shape crosses this boundary (AC-1, specs/00 "Integrations —
 * anti-corruption / adapter layer").
 */

import type { AdapterError, AdapterErrorCode, IsoTimestamp } from '@core';
import type { ObjectStoreResult } from './contract.js';
import { isRetryable } from './contract.js';

/** User metadata as plain key/value pairs — never raw headers. */
export type BackendMetadata = Readonly<Record<string, string>>;

export interface BackendPutInput {
  key: string;
  bytes: Uint8Array;
  content_type: string;
  /** Lowercase hex — the same digest that terminates the key. */
  content_sha256: string;
  /**
   * Base64 of that same digest. Supplied by the caller (which already computed
   * it) so no backend has to convert encodings, and forwarded as
   * `ChecksumSHA256` so the SERVER verifies integrity too.
   */
  content_sha256_base64: string;
  metadata: BackendMetadata;
}

/**
 * What a backend RETRIEVED — never more. Every field a provider may omit is
 * optional, so a backend cannot substitute a plausible-looking default for
 * something it did not receive (docs/design/T-018.md §5.6; ADR-005: a missing
 * required input is unevaluable, never zero). The artifact store turns an
 * absent field into `malformed_response`, which is the only honest answer.
 */
export interface BackendHead {
  byte_length?: number;
  content_type?: string;
  metadata: BackendMetadata;
  stored_at?: IsoTimestamp;
}

export interface BackendObject extends BackendHead {
  bytes: Uint8Array;
}

export interface BackendListItem {
  key: string;
  byte_length?: number;
  stored_at?: IsoTimestamp;
}

export interface BackendListPage {
  items: readonly BackendListItem[];
  truncated: boolean;
  next_cursor?: string;
}

export interface BackendListOptions {
  limit: number;
  cursor?: string;
}

export interface ObjectBackend {
  readonly source: string;
  put(input: BackendPutInput): Promise<ObjectStoreResult<void>>;
  get(key: string): Promise<ObjectStoreResult<BackendObject>>;
  head(key: string): Promise<ObjectStoreResult<BackendHead>>;
  list(prefix: string, options: BackendListOptions): Promise<ObjectStoreResult<BackendListPage>>;
}

/** Metadata keys written on every artifact PUT (§3.3). Lowercase, ASCII. */
export const META_KIND = 'kind';
export const META_ACCOUNT_ID = 'account-id';
export const META_DEAL_ID = 'deal-id';
export const META_SHA256 = 'sha256';
export const META_FILENAME = 'filename';
export const META_ORIGIN_REF = 'origin-ref';

/**
 * Provider-signal → `AdapterErrorCode` (§4.1, binding).
 *
 * D2: a missing bucket or an incoherent configuration maps to `'auth'`.
 * `AdapterErrorCode` is a FROZEN union in `packages/core` (T-010, not this
 * task's file); `'auth'` is documented as "credential problem — not retryable,
 * alert operator", which is the identical handling class. Adding a `'config'`
 * code would be an edit to a file this task does not own, so the mapping is
 * recorded here as deliberate rather than sloppy.
 *
 * The unrecognized case is `provider_unavailable`/retryable ON PURPOSE:
 * assuming transient is more conservative than declaring a permanent failure
 * we cannot substantiate.
 */
export function classifyProviderError(err: unknown): AdapterErrorCode {
  const name = errorName(err);
  const status = httpStatus(err);

  switch (name) {
    case 'NoSuchKey':
    case 'NotFound':
    case 'NoSuchUpload':
      return 'not_found';
    case 'AccessDenied':
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
    case 'ExpiredToken':
    case 'ExpiredTokenException':
    case 'CredentialsProviderError':
    case 'NoSuchBucket':
      return 'auth';
    case 'SlowDown':
    case 'TooManyRequests':
    case 'ThrottlingException':
      return 'rate_limited';
    case 'InternalError':
    case 'ServiceUnavailable':
    case 'RequestTimeout':
    case 'RequestTimeTooSkewed':
    case 'TimeoutError':
    case 'AbortError':
    case 'NetworkingError':
      return 'provider_unavailable';
    default:
      break;
  }

  const code = errorCode(err);
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
    return 'provider_unavailable';
  }
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status !== undefined && status >= 500) return 'provider_unavailable';
  return 'provider_unavailable';
}

/**
 * Log-safe `AdapterError` from a provider throw. The provider's message body
 * is NEVER copied through — it can echo request content — so only the error
 * name and the operation appear.
 */
export function toAdapterError(err: unknown, source: string, op: string): AdapterError {
  const code = classifyProviderError(err);
  return {
    code,
    retryable: isRetryable(code),
    source,
    message: `${op} failed: ${errorName(err) ?? 'unknown provider error'}`,
  };
}

function errorName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const record = err as { name?: unknown };
  return typeof record.name === 'string' ? record.name : undefined;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const record = err as { code?: unknown };
  return typeof record.code === 'string' ? record.code : undefined;
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const record = err as { $metadata?: { httpStatusCode?: unknown }; statusCode?: unknown };
  const fromMetadata = record.$metadata?.httpStatusCode;
  if (typeof fromMetadata === 'number') return fromMetadata;
  return typeof record.statusCode === 'number' ? record.statusCode : undefined;
}
