/**
 * The internal object-store contract (docs/design/T-018.md §2) — the ONLY
 * shape a caller ever sees.
 *
 * specs/00 "Integrations — anti-corruption / adapter layer (shared)": "Every
 * external feed sits behind one internal interface. Core services never see a
 * provider's shape." Accordingly no `@aws-sdk/client-s3` type, command object,
 * stream, header, or credential appears in any declaration in this file, and
 * `s3-backend.ts` is the only module in the repo that imports the SDK at all.
 *
 * specs/00 "Core domain model" (**Store**): the object store holds "email
 * attachments, uploaded documents, and generated dossiers. **No audio is
 * stored.**" specs/01 "Consent & recording posture": "no audio is ever
 * captured or stored." Both statements are enforced structurally below —
 * `ArtifactKind` has three members and no audio member can be added without
 * editing this line, and `put({ kind: 'recording', … })` is a COMPILE error
 * rather than a runtime rejection.
 *
 * ADR-001: the spine is defined once and imported. Every result and error type
 * here is an `@core` import; `ObjectStoreResult` is an ALIAS, not a second
 * definition (design D1).
 */

import type { AdapterError, AdapterErrorCode, AdapterResult, IsoTimestamp } from '@core';

/** Readability alias over @core's uniform adapter result (D1). NOT a new type. */
export type ObjectStoreResult<T> = AdapterResult<T>;

/**
 * The three artifact classes specs/00 "Store" assigns to the object store:
 * "email attachments, uploaded documents, and generated dossiers".
 *
 * There is no 'recording' / 'audio' / 'call' member and there will not be one:
 * specs/00 "No audio is stored"; specs/01 "no audio is ever captured or
 * stored". This is the same construction `@core` used when it DELETED
 * `Message.recording_url` rather than leaving it nullable — the absence is the
 * enforcement.
 */
export type ArtifactKind = 'email_attachment' | 'document' | 'dossier';

/** The closed set, iterable for validation. Order is not meaningful. */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['email_attachment', 'document', 'dossier'];

/**
 * A stable, bucket-free storage key. Postgres columns hold this verbatim as
 * TEXT (AC-5) — the relational core holds references, the object store holds
 * bytes. Bucket-free ON PURPOSE: moving buckets must not invalidate every
 * stored row.
 *
 * Shape: `acct/{account_id}/{deal_id}/{kind}/{content_sha256}`
 */
export type ObjectRef = string;

export interface ArtifactLocation {
  /**
   * The owning account (specs/01 "Account model": "`Account` owns `Deals`").
   * Supplied by the authenticated caller — NEVER derived, defaulted, or
   * inferred here.
   */
  account_id: string;
  deal_id: string;
  kind: ArtifactKind;
  /** Lowercase sha-256 hex of the bytes. The object's whole identity (D4). */
  content_sha256: string;
}

export interface PutArtifactRequest {
  account_id: string;
  deal_id: string;
  kind: ArtifactKind;
  /**
   * Must be on this kind's allowlist (content-policy.ts). Never
   * sniffed-and-corrected — a wrong label is a rejection, not something we
   * quietly fix (D11: a rejected attachment is a surfaced, recorded refusal).
   */
  content_type: string;
  bytes: Uint8Array;
  /**
   * Display name. Sanitized, capped, header-safe. NEVER part of the key, never
   * interpreted, never used to open anything.
   */
  filename?: string;
  /**
   * Provenance the caller already holds; stored verbatim, never interpreted:
   *   email_attachment → the StoredMessage.message_ref it arrived on
   *   dossier          → the Deal's receipt_bundle_id
   *   document         → absent (a user upload has no upstream record)
   */
  origin_ref?: string;
}

export type PutOutcome = 'stored' | 'already_present';

export interface ObjectMetadata {
  ref: ObjectRef;
  account_id: string;
  deal_id: string;
  kind: ArtifactKind;
  content_type: string;
  byte_length: number;
  content_sha256: string;
  filename?: string;
  origin_ref?: string;
  stored_at: IsoTimestamp;
}

export interface PutResult {
  ref: ObjectRef;
  outcome: PutOutcome;
  metadata: ObjectMetadata;
}

export interface StoredArtifact {
  metadata: ObjectMetadata;
  bytes: Uint8Array;
}

export interface ListFilter {
  deal_id?: string;
  /** Requires `deal_id` — `kind` alone is `invalid_input`, never silently ignored. */
  kind?: ArtifactKind;
  /** Default 1000, capped at 1000. */
  limit?: number;
  cursor?: string;
}

/**
 * Only what a key and a list response actually carry. `content_type` and
 * `filename` are S3 user metadata and need a `head`, so they are ABSENT here
 * rather than fabricated — ADR-005's discipline (absent ⇒ unevaluable, never a
 * plausible-looking default) applied to storage.
 */
export interface ObjectSummary {
  ref: ObjectRef;
  account_id: string;
  deal_id: string;
  kind: ArtifactKind;
  content_sha256: string;
  byte_length: number;
  stored_at: IsoTimestamp;
}

export interface ListPage {
  items: readonly ObjectSummary[];
  /** `true` with a `next_cursor` — never a short page that looks complete. */
  truncated: boolean;
  next_cursor?: string;
}

/**
 * The one internal interface (AC-1).
 *
 * Four methods. No `delete`, no `copy`, no `move`, no caller-chosen key, no
 * presigned URL, no audio-anything (D8, D9). The forbidden operations are
 * ABSENT rather than guarded, which is the difference between a rule and a
 * hope: specs/00 "Receipt layer" is append-only, and specs/01 archives a
 * closed thread rather than deleting it.
 *
 * `account_id` is the first, mandatory parameter of all three reads, so an
 * unscoped read is INEXPRESSIBLE — the same construction T-014 used to make an
 * unscoped dealership-contact lookup impossible.
 */
export interface ObjectStore {
  /** Adapter id for logs and `AdapterError.source`, e.g. "s3-object-store". */
  readonly source: string;

  put(req: PutArtifactRequest): Promise<ObjectStoreResult<PutResult>>;

  get(account_id: string, ref: ObjectRef): Promise<ObjectStoreResult<StoredArtifact>>;
  head(account_id: string, ref: ObjectRef): Promise<ObjectStoreResult<ObjectMetadata>>;
  list(account_id: string, filter?: ListFilter): Promise<ObjectStoreResult<ListPage>>;
}

/**
 * Structured, log-safe sink shape (§4.8).
 *
 * NEVER logged, under any level: object bytes or any encoding of them; any
 * content preview; the full filename; the raw quarantine payload (only its ref
 * travels — services/comms ports.ts: "The payload NEVER rides the bus or the
 * logs"); credentials or any part of one; a request signature; a raw SDK error
 * body, which can echo request content.
 */
export interface ObjectStoreLogEvent {
  op: 'put' | 'get' | 'head' | 'list' | 'stash' | 'flush' | 'config';
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  outcome: 'ok' | AdapterErrorCode | 'tenancy_reject';
  account_id?: string;
  deal_id?: string;
  kind?: ArtifactKind;
  /**
   * First 12 hex chars of the content hash. Enough to correlate, not enough to
   * address — a full ref in a log line is a capability in a log line.
   */
  ref_prefix?: string;
  byte_length?: number;
  duration_ms?: number;
  message?: string;
}

export type ObjectStoreLogger = (event: ObjectStoreLogEvent) => void;

export interface ObjectStoreConfig {
  bucket: string;
  region: string;
  /**
   * S3-compatible endpoint (MinIO or equivalent). Present ⇒ path-style
   * addressing (D12). Absent ⇒ AWS default endpoint resolution.
   */
  endpoint?: string;
  /**
   * Sent only when set. Default unset — bucket-default encryption is a
   * deployment concern, and a hard-coded SSE header breaks some S3-compatible
   * backends.
   */
  server_side_encryption?: 'AES256' | 'aws:kms';
  /** Send ChecksumSHA256 on PUT so the server verifies integrity too. Default true. */
  checksums?: boolean;
  /** SDK retry attempts. Default 3. We add NO second retry layer (§4.2). */
  max_attempts?: number;
  /** Per-object byte cap. Default 25 MiB. */
  max_bytes?: number;
  clock?: () => IsoTimestamp;
  /** Structured, log-safe sink. Default: no-op. No logger dependency. */
  log?: ObjectStoreLogger;
}

/*
 * There is deliberately NO credential field on ObjectStoreConfig. Credentials
 * come from the AWS SDK's standard provider chain (environment, profile, or
 * instance role). A key or secret is never a parameter, never logged, and
 * never written to this repo — credential absence is the structural
 * enforcement the constitution relies on.
 */

/** `retryable` derived from `code`, stated explicitly so no caller guesses. */
export function isRetryable(code: AdapterErrorCode): boolean {
  return code === 'rate_limited' || code === 'provider_unavailable';
}

/** Builds the uniform failure value. Adapters never throw across the boundary. */
export function storeError(
  code: AdapterErrorCode,
  source: string,
  message: string,
): { ok: false; error: AdapterError } {
  return { ok: false, error: { code, retryable: isRetryable(code), source, message } };
}

/** Default adapter id used by the pure key/policy helpers. */
export const OBJECT_STORE_SOURCE = 'object-store';
