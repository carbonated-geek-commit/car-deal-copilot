/**
 * The artifact store — policy, tenancy, key construction, and integrity, in
 * exactly one place (docs/design/T-018.md §4).
 *
 * Everything that makes the guarantees hold lives here rather than in a
 * backend, so S3 and the in-process fake behave identically and a test written
 * against the fake describes the real thing:
 *
 *   AC-3  no audio path — `checkContentPolicy` runs before any network call.
 *   AC-4  tenancy — `account_id` is the first, mandatory read parameter, the
 *         list prefix is `acct/{account_id}/`, and a foreign ref returns
 *         `not_found` (never "forbidden"), decided LOCALLY so a probe learns
 *         nothing from the answer or from the timing.
 *   AC-7  append-only — keys are content-addressed, `put` HEADs first and
 *         skips the write when the object exists, and the interface has no
 *         delete/copy/move/caller-chosen key at all.
 *
 * Failures are values, never throws (`@core` `AdapterResult`).
 */

import type { AdapterError } from '@core';
import type { BackendHead, ObjectBackend } from './backend.js';
import {
  META_ACCOUNT_ID,
  META_DEAL_ID,
  META_FILENAME,
  META_KIND,
  META_ORIGIN_REF,
  META_SHA256,
} from './backend.js';
import { createS3Backend } from './s3-backend.js';
import type {
  ArtifactKind,
  ArtifactLocation,
  ObjectStoreConfig,
  ListFilter,
  ListPage,
  ObjectMetadata,
  ObjectRef,
  ObjectStore,
  ObjectStoreLogEvent,
  ObjectStoreLogger,
  ObjectStoreResult,
  ObjectSummary,
  PutArtifactRequest,
  PutResult,
  StoredArtifact,
} from './contract.js';
import { storeError } from './contract.js';
import type { IsoTimestamp } from '@core';
import { checkContentPolicy, DEFAULT_MAX_BYTES, normalizeContentType, sanitizeMetadataValue } from './content-policy.js';
import {
  accountPrefix,
  buildArtifactRef,
  isValidId,
  parseArtifactRef,
  refPrefix,
  sha256Base64,
  sha256Hex,
} from './keys.js';
import { createMemoryBackend } from './memory-backend.js';

export const MAX_LIST_LIMIT = 1000;

export interface ArtifactStoreOptions {
  source?: string;
  max_bytes?: number;
  clock?: () => IsoTimestamp;
  log?: ObjectStoreLogger;
}

const defaultClock = (): IsoTimestamp => new Date().toISOString();

export function createObjectStoreOverBackend(
  backend: ObjectBackend,
  options: ArtifactStoreOptions = {},
): ObjectStore {
  const source = options.source ?? backend.source;
  const max_bytes = options.max_bytes ?? DEFAULT_MAX_BYTES;
  const clock = options.clock ?? defaultClock;
  const log: ObjectStoreLogger = options.log ?? (() => {});

  const emit = (event: ObjectStoreLogEvent): void => {
    log(event);
  };

  const fail = (
    op: ObjectStoreLogEvent['op'],
    error: AdapterError,
    context: Partial<ObjectStoreLogEvent> = {},
  ): { ok: false; error: AdapterError } => {
    emit({ op, level: 'warn', source, outcome: error.code, message: error.message, ...context });
    return { ok: false, error };
  };

  async function put(req: PutArtifactRequest): Promise<ObjectStoreResult<PutResult>> {
    const started = Date.now();

    // Step 1 — ids. The path-traversal and tenancy guard, before anything else.
    if (!isValidId(req.account_id)) {
      return fail('put', invalid(source, 'account_id is not a valid id'));
    }
    if (!isValidId(req.deal_id)) {
      return fail('put', invalid(source, 'deal_id is not a valid id'), { account_id: req.account_id });
    }

    // Steps 2–6 — content policy. ALL LOCAL: a hostile or mislabeled request
    // never reaches the network. A rejection names the offending type so the
    // caller can record that an attachment arrived and was refused (D11) —
    // the receipt trail shows the gap rather than pretending nothing arrived.
    const policyError = checkContentPolicy({
      kind: req.kind,
      content_type: req.content_type,
      bytes: req.bytes,
      max_bytes,
      source,
    });
    if (policyError !== undefined) {
      return fail('put', policyError, {
        account_id: req.account_id,
        deal_id: req.deal_id,
        kind: req.kind,
        byte_length: req.bytes.byteLength,
      });
    }

    const content_sha256 = sha256Hex(req.bytes);
    const content_type = normalizeContentType(req.content_type);
    const location: ArtifactLocation = {
      account_id: req.account_id,
      deal_id: req.deal_id,
      kind: req.kind,
      content_sha256,
    };
    const built = buildArtifactRef(location);
    if (!built.ok) return fail('put', built.error, { account_id: req.account_id });
    const ref = built.value;

    const filename = req.filename === undefined ? undefined : sanitizeMetadataValue(req.filename);
    const origin_ref = req.origin_ref === undefined ? undefined : sanitizeMetadataValue(req.origin_ref);

    // Step 7 — HEAD first. This is what makes AC-7 structural: the code path
    // that would overwrite an existing object literally does not run. One
    // extra round trip is the price, and it is a decision, not an oversight.
    const existing = await backend.head(ref);
    if (existing.ok) {
      if (existing.value.byte_length !== req.bytes.byteLength) {
        // Identical hash, different length — an integrity alarm, not a hit.
        return fail(
          'put',
          error('malformed_response', source, 'stored object length disagrees with its content hash'),
          { account_id: req.account_id, deal_id: req.deal_id, kind: req.kind, ref_prefix: refPrefix(ref) },
        );
      }
      const metadata = metadataFromHead(ref, location, existing.value, content_type);
      emit({
        op: 'put',
        level: 'info',
        source,
        outcome: 'ok',
        account_id: req.account_id,
        deal_id: req.deal_id,
        kind: req.kind,
        ref_prefix: refPrefix(ref),
        byte_length: req.bytes.byteLength,
        duration_ms: Date.now() - started,
        message: 'already_present',
      });
      return { ok: true, value: { ref, outcome: 'already_present', metadata } };
    }
    if (existing.error.code !== 'not_found') {
      return fail('put', existing.error, {
        account_id: req.account_id,
        deal_id: req.deal_id,
        kind: req.kind,
        ref_prefix: refPrefix(ref),
      });
    }

    // Step 8 — write. Idempotent by construction: the key IS the content hash,
    // so a retried PUT of the same bytes lands the same object at the same key
    // and an at-least-once consumer produces one object, not two.
    const written = await backend.put({
      key: ref,
      bytes: req.bytes,
      content_type,
      content_sha256,
      content_sha256_base64: sha256Base64(req.bytes),
      metadata: {
        [META_KIND]: req.kind,
        [META_ACCOUNT_ID]: req.account_id,
        [META_DEAL_ID]: req.deal_id,
        [META_SHA256]: content_sha256,
        ...(filename !== undefined ? { [META_FILENAME]: filename } : {}),
        ...(origin_ref !== undefined ? { [META_ORIGIN_REF]: origin_ref } : {}),
      },
    });
    if (!written.ok) {
      return fail('put', written.error, {
        account_id: req.account_id,
        deal_id: req.deal_id,
        kind: req.kind,
        ref_prefix: refPrefix(ref),
      });
    }

    const metadata: ObjectMetadata = {
      ref,
      account_id: req.account_id,
      deal_id: req.deal_id,
      kind: req.kind,
      content_type,
      byte_length: req.bytes.byteLength,
      content_sha256,
      ...(filename !== undefined ? { filename } : {}),
      ...(origin_ref !== undefined ? { origin_ref } : {}),
      stored_at: clock(),
    };
    emit({
      op: 'put',
      level: 'info',
      source,
      outcome: 'ok',
      account_id: req.account_id,
      deal_id: req.deal_id,
      kind: req.kind,
      ref_prefix: refPrefix(ref),
      byte_length: req.bytes.byteLength,
      duration_ms: Date.now() - started,
      message: 'stored',
    });
    return { ok: true, value: { ref, outcome: 'stored', metadata } };
  }

  /**
   * The tenancy gate, shared by `get` and `head`. A foreign or unparseable ref
   * is decided here — locally, before any network call — and a foreign ref
   * yields `not_found` rather than a distinct "forbidden", so a cross-account
   * probe cannot confirm that an object exists. The attempt is still logged at
   * `warn`: it is a security signal even though the caller learns nothing.
   */
  function scope(
    op: 'get' | 'head',
    account_id: string,
    ref: ObjectRef,
  ): { ok: true; value: ArtifactLocation } | { ok: false; error: AdapterError } {
    if (!isValidId(account_id)) {
      return fail(op, invalid(source, 'account_id is not a valid id'));
    }
    const location = parseArtifactRef(ref);
    if (location === undefined) {
      return fail(op, invalid(source, 'ref is not a well-formed artifact reference'), {
        account_id,
      });
    }
    if (location.account_id !== account_id) {
      emit({
        op,
        level: 'warn',
        source,
        outcome: 'tenancy_reject',
        account_id,
        ref_prefix: refPrefix(ref),
        message: `ref belongs to another account (${location.account_id})`,
      });
      return {
        ok: false,
        error: error('not_found', source, `${op} failed: no such object`),
      };
    }
    return { ok: true, value: location };
  }

  async function get(account_id: string, ref: ObjectRef): Promise<ObjectStoreResult<StoredArtifact>> {
    const started = Date.now();
    const scoped = scope('get', account_id, ref);
    if (!scoped.ok) return scoped;
    const location = scoped.value;

    const fetched = await backend.get(ref);
    if (!fetched.ok) {
      return fail('get', fetched.error, {
        account_id,
        deal_id: location.deal_id,
        kind: location.kind,
        ref_prefix: refPrefix(ref),
      });
    }

    // The content-addressing claim is VERIFIED on every read, not asserted.
    const actual = sha256Hex(fetched.value.bytes);
    if (actual !== location.content_sha256) {
      return fail(
        'get',
        error('malformed_response', source, 'retrieved bytes do not match the content hash in the key'),
        { account_id, deal_id: location.deal_id, kind: location.kind, ref_prefix: refPrefix(ref) },
      );
    }
    const crossCheck = crossCheckMetadata(location, fetched.value, source);
    if (crossCheck !== undefined) {
      return fail('get', crossCheck, {
        account_id,
        deal_id: location.deal_id,
        kind: location.kind,
        ref_prefix: refPrefix(ref),
      });
    }
    if (fetched.value.content_type === undefined) {
      return fail('get', error('malformed_response', source, 'stored object has no content type'), {
        account_id,
        deal_id: location.deal_id,
        kind: location.kind,
        ref_prefix: refPrefix(ref),
      });
    }

    emit({
      op: 'get',
      level: 'debug',
      source,
      outcome: 'ok',
      account_id,
      deal_id: location.deal_id,
      kind: location.kind,
      ref_prefix: refPrefix(ref),
      byte_length: fetched.value.byte_length,
      duration_ms: Date.now() - started,
    });
    return {
      ok: true,
      value: {
        metadata: metadataFromHead(ref, location, fetched.value, fetched.value.content_type),
        bytes: fetched.value.bytes,
      },
    };
  }

  async function head(account_id: string, ref: ObjectRef): Promise<ObjectStoreResult<ObjectMetadata>> {
    const started = Date.now();
    const scoped = scope('head', account_id, ref);
    if (!scoped.ok) return scoped;
    const location = scoped.value;

    const fetched = await backend.head(ref);
    if (!fetched.ok) {
      return fail('head', fetched.error, {
        account_id,
        deal_id: location.deal_id,
        kind: location.kind,
        ref_prefix: refPrefix(ref),
      });
    }
    const crossCheck = crossCheckMetadata(location, fetched.value, source);
    if (crossCheck !== undefined) {
      return fail('head', crossCheck, {
        account_id,
        deal_id: location.deal_id,
        kind: location.kind,
        ref_prefix: refPrefix(ref),
      });
    }
    if (fetched.value.content_type === undefined) {
      return fail('head', error('malformed_response', source, 'stored object has no content type'), {
        account_id,
        deal_id: location.deal_id,
        kind: location.kind,
        ref_prefix: refPrefix(ref),
      });
    }

    emit({
      op: 'head',
      level: 'debug',
      source,
      outcome: 'ok',
      account_id,
      deal_id: location.deal_id,
      kind: location.kind,
      ref_prefix: refPrefix(ref),
      byte_length: fetched.value.byte_length,
      duration_ms: Date.now() - started,
    });
    return { ok: true, value: metadataFromHead(ref, location, fetched.value, fetched.value.content_type) };
  }

  async function list(account_id: string, filter: ListFilter = {}): Promise<ObjectStoreResult<ListPage>> {
    const started = Date.now();
    if (!isValidId(account_id)) {
      return fail('list', invalid(source, 'account_id is not a valid id'));
    }
    if (filter.deal_id !== undefined && !isValidId(filter.deal_id)) {
      return fail('list', invalid(source, 'deal_id is not a valid id'), { account_id });
    }
    if (filter.kind !== undefined && filter.deal_id === undefined) {
      // Never a silently ignored filter: a caller that asked for one kind and
      // got every kind would read the page as complete for that kind.
      return fail('list', invalid(source, 'kind requires deal_id'), { account_id });
    }

    // The prefix is built from the authenticated account, so "list everything"
    // is not a thing this interface can express.
    let prefix = accountPrefix(account_id);
    if (filter.deal_id !== undefined) prefix += `${filter.deal_id}/`;
    if (filter.kind !== undefined) prefix += `${filter.kind}/`;

    const requested = filter.limit ?? MAX_LIST_LIMIT;
    const limit = Math.max(1, Math.min(requested, MAX_LIST_LIMIT));
    if (requested > MAX_LIST_LIMIT) {
      emit({
        op: 'list',
        level: 'debug',
        source,
        outcome: 'ok',
        account_id,
        message: `limit clamped to ${MAX_LIST_LIMIT}`,
      });
    }

    const page = await backend.list(prefix, {
      limit,
      ...(filter.cursor !== undefined ? { cursor: filter.cursor } : {}),
    });
    if (!page.ok) return fail('list', page.error, { account_id });

    const items: ObjectSummary[] = [];
    for (const entry of page.value.items) {
      const location = parseArtifactRef(entry.key);
      if (location === undefined || location.account_id !== account_id) {
        // A key under our own prefix that does not parse, or that resolves to
        // another account, is an integrity alarm — never quietly skipped.
        return fail('list', error('malformed_response', source, 'stored key is not a valid artifact ref'), {
          account_id,
        });
      }
      items.push({
        ref: entry.key,
        account_id: location.account_id,
        deal_id: location.deal_id,
        kind: location.kind,
        content_sha256: location.content_sha256,
        byte_length: entry.byte_length,
        stored_at: entry.stored_at,
      });
    }

    emit({
      op: 'list',
      level: 'debug',
      source,
      outcome: 'ok',
      account_id,
      ...(filter.deal_id !== undefined ? { deal_id: filter.deal_id } : {}),
      ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
      duration_ms: Date.now() - started,
    });
    return {
      ok: true,
      value: {
        items,
        truncated: page.value.truncated,
        ...(page.value.next_cursor !== undefined ? { next_cursor: page.value.next_cursor } : {}),
      },
    };
  }

  return { source, put, get, head, list };
}

/**
 * Production composition over the S3-compatible backend. The config carries no
 * credential field: the SDK's standard provider chain supplies them, so no key
 * or secret is ever a parameter here or a value in this repo.
 */
export function createS3ObjectStore(config: ObjectStoreConfig): ObjectStore {
  return createObjectStoreOverBackend(createS3Backend(config), {
    ...(config.max_bytes !== undefined ? { max_bytes: config.max_bytes } : {}),
    ...(config.clock !== undefined ? { clock: config.clock } : {}),
    ...(config.log !== undefined ? { log: config.log } : {}),
  });
}

/**
 * In-process object store — same keys, same policy, same errors; no network,
 * no credentials, no bucket. ADR-008: the API DEFAULTS to this, and never
 * falls back to it.
 */
export function createInMemoryObjectStore(
  options: { max_bytes?: number; clock?: () => IsoTimestamp; log?: ObjectStoreLogger } = {},
): ObjectStore & { readonly size: () => number } {
  const backend = createMemoryBackend({
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  const store = createObjectStoreOverBackend(backend, {
    source: 'in-memory-object-store',
    ...(options.max_bytes !== undefined ? { max_bytes: options.max_bytes } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  return { ...store, size: () => backend.size() };
}

function metadataFromHead(
  ref: ObjectRef,
  location: ArtifactLocation,
  head: BackendHead,
  content_type: string,
): ObjectMetadata {
  const filename = head.metadata[META_FILENAME];
  const origin_ref = head.metadata[META_ORIGIN_REF];
  return {
    ref,
    account_id: location.account_id,
    deal_id: location.deal_id,
    kind: location.kind,
    content_type,
    byte_length: head.byte_length,
    content_sha256: location.content_sha256,
    ...(filename !== undefined ? { filename } : {}),
    ...(origin_ref !== undefined ? { origin_ref } : {}),
    stored_at: head.stored_at,
  };
}

/**
 * Belt-and-braces against a key-parse or migration fault: the object's own
 * metadata must agree with its key. Deliberately redundant — a key-parse bug
 * must not be able to silently reclassify an object or hand it to the wrong
 * account.
 */
function crossCheckMetadata(
  location: ArtifactLocation,
  head: BackendHead,
  source: string,
): AdapterError | undefined {
  const metaAccount = head.metadata[META_ACCOUNT_ID];
  if (metaAccount !== undefined && metaAccount !== location.account_id) {
    return error('malformed_response', source, 'stored account metadata disagrees with the key');
  }
  const metaDeal = head.metadata[META_DEAL_ID];
  if (metaDeal !== undefined && metaDeal !== location.deal_id) {
    return error('malformed_response', source, 'stored deal metadata disagrees with the key');
  }
  const metaKind = head.metadata[META_KIND];
  if (metaKind !== undefined && metaKind !== (location.kind as ArtifactKind)) {
    return error('malformed_response', source, 'stored kind metadata disagrees with the key');
  }
  const metaSha = head.metadata[META_SHA256];
  if (metaSha !== undefined && metaSha !== location.content_sha256) {
    return error('malformed_response', source, 'stored hash metadata disagrees with the key');
  }
  return undefined;
}

function invalid(source: string, message: string): AdapterError {
  return storeError('invalid_input', source, message).error;
}

function error(
  code: AdapterError['code'],
  source: string,
  message: string,
): AdapterError {
  return storeError(code, source, message).error;
}
