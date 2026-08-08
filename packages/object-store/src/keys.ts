/**
 * Key construction and content addressing (docs/design/T-018.md §3.1, D3, D4).
 *
 * Two key spaces, and only two:
 *
 *   acct/{account_id}/{deal_id}/{kind}/{content_sha256}   account-scoped artifacts
 *   ops/raw-payload/{sha256_of_canonical_json}            operator-only, owned by no account
 *
 * The account prefix is the FIRST segment group, so `acct/{account_id}/` is a
 * valid list prefix and an account-scoped list cannot see another account's
 * keys — the isolation is enforced by the request, not by post-filtering
 * (specs/01 "Account model": "`Account` owns `Deals`"; specs/00 "Dealership
 * data tenancy").
 *
 * The final segment is the lowercase sha-256 hex of the bytes, and it is the
 * object's whole identity (D4). That makes AC-7 structural rather than a
 * promise: different bytes ⇒ different key, so an overwrite is
 * UNREPRESENTABLE, and `put` is naturally idempotent under at-least-once
 * delivery.
 *
 * `ops/raw-payload/…` belongs to no account on purpose: a `no_identity_match`
 * quarantine payload is one nobody owns (services/comms ports.ts,
 * `UnroutedReason`). Because it is a different prefix, the account-scoped
 * reader cannot even construct the key.
 */

import { createHash } from 'node:crypto';
import type { ArtifactKind, ArtifactLocation, ObjectRef, ObjectStoreResult } from './contract.js';
import { ARTIFACT_KINDS, OBJECT_STORE_SOURCE, storeError } from './contract.js';

/**
 * Path-traversal guard AND tenancy guard in one pattern. Without it an
 * `account_id` of `../other` would escape its own prefix and defeat the entire
 * tenancy design, so anything with a slash, a dot segment, a percent-escape,
 * whitespace, or an empty value is rejected BEFORE a key is built.
 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const ACCOUNT_PREFIX = 'acct';
export const RAW_PAYLOAD_PREFIX = 'ops/raw-payload';

const encoder = new TextEncoder();

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/** Lowercase sha-256 hex of the bytes — the object's identity. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * sha-256 hex of a UTF-8 string. Kept bit-identical to
 * `InMemoryRawPayloadStore`'s digest (`createHash('sha256').update(str)`) so a
 * quarantine ref does not change when the store is swapped.
 */
export function sha256HexOfUtf8(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Base64 of the same digest whose hex is in the key — for `ChecksumSHA256`. */
export function sha256Base64(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/** `acct/{account_id}/` — the only prefix an account-scoped list may use. */
export function accountPrefix(account_id: string): string {
  return `${ACCOUNT_PREFIX}/${account_id}/`;
}

/** Operator-only key space (D3). Never reachable from an account-scoped read. */
export function rawPayloadKey(ref: string): string {
  return `${RAW_PAYLOAD_PREFIX}/${ref}`;
}

export function buildArtifactRef(loc: ArtifactLocation): ObjectStoreResult<ObjectRef> {
  if (!isValidId(loc.account_id)) {
    return storeError('invalid_input', OBJECT_STORE_SOURCE, 'account_id is not a valid id');
  }
  if (!isValidId(loc.deal_id)) {
    return storeError('invalid_input', OBJECT_STORE_SOURCE, 'deal_id is not a valid id');
  }
  if (!isArtifactKind(loc.kind)) {
    return storeError('invalid_input', OBJECT_STORE_SOURCE, 'kind is not an artifact kind');
  }
  if (!SHA256_HEX_PATTERN.test(loc.content_sha256)) {
    return storeError('invalid_input', OBJECT_STORE_SOURCE, 'content_sha256 is not lowercase sha-256 hex');
  }
  return {
    ok: true,
    value: `${ACCOUNT_PREFIX}/${loc.account_id}/${loc.deal_id}/${loc.kind}/${loc.content_sha256}`,
  };
}

/** `undefined` for anything that is not a well-formed account-scoped ref. */
export function parseArtifactRef(ref: ObjectRef): ArtifactLocation | undefined {
  const parts = ref.split('/');
  if (parts.length !== 5) return undefined;
  const [prefix, account_id, deal_id, kind, content_sha256] = parts;
  if (prefix !== ACCOUNT_PREFIX) return undefined;
  if (account_id === undefined || !isValidId(account_id)) return undefined;
  if (deal_id === undefined || !isValidId(deal_id)) return undefined;
  if (kind === undefined || !isArtifactKind(kind)) return undefined;
  if (content_sha256 === undefined || !SHA256_HEX_PATTERN.test(content_sha256)) return undefined;
  return { account_id, deal_id, kind, content_sha256 };
}

/**
 * Pure, allocation-cheap, and evaluated BEFORE any network call, so a
 * cross-account probe gets neither an answer nor a timing signal (§4.4).
 */
export function isRefOwnedBy(account_id: string, ref: ObjectRef): boolean {
  const loc = parseArtifactRef(ref);
  return loc !== undefined && loc.account_id === account_id;
}

/**
 * First 12 hex chars of the content hash — enough to correlate in a log line,
 * not enough to address the object.
 */
export function refPrefix(ref: ObjectRef): string {
  const loc = parseArtifactRef(ref);
  const hash = loc?.content_sha256 ?? ref;
  return hash.slice(0, 12);
}
