/**
 * `RawPayloadStore` over the object store — the write-behind seam
 * (docs/design/T-018.md D5, §4.7; ADR-009 §1, which states that T-018 must
 * name `RawPayloadStore`).
 *
 * THE PROBLEM, STATED PLAINLY. The port in `services/comms/src/ports.ts` is
 * SYNCHRONOUS — `stash(raw): string` must return before any network call could
 * complete, and `get(ref): unknown | undefined` cannot await. That file belongs
 * to T-014, so this package adapts rather than changes it. specs/00 "Comms
 * aggregation layer" independently requires webhooks to ack immediately, so
 * blocking the ack on an S3 round trip would be wrong EVEN IF the port allowed
 * it. Write-behind is the only shape both constraints admit.
 *
 * THE WINDOW, NAMED HONESTLY. Between `stash()` returning and the durable PUT
 * completing, a process crash loses that payload and the quarantine row's
 * `raw_payload_ref` would dangle. The blast radius is bounded — this path
 * carries only UNPARSEABLE provider payloads; the parsed-message path never
 * touches this store, so specs/00's "Provider timeouts must never drop a dealer
 * message" is not at risk. It is still a real gap, and it is the direct
 * consequence of a synchronous port over a network store. Recommendation on
 * record for the lead: a follow-up task owning `services/comms/src/ports.ts`
 * should make the port async so `stash` can be awaited before the quarantine
 * event is published.
 *
 * `stash()` returns `sha256(canonicalJson(payload))` — BIT-IDENTICAL to
 * `InMemoryRawPayloadStore`'s ref — so the quarantine idempotency key
 * (`source + ':quarantine:' + ref`) dedupes the same way before and after a
 * store swap. `canonicalJson` is IMPORTED from `@comms`, never copied: a second
 * copy would silently diverge and break that equality.
 *
 * This package deliberately ships NO in-memory `RawPayloadStore`. `@comms`
 * already exports `InMemoryRawPayloadStore`; a second one would be the
 * duplicate definition ADR-001 forbids.
 */

import { canonicalJson } from '@comms';
import type { RawPayloadStore } from '@comms';
import type { ObjectBackend } from './backend.js';
import { createS3Backend } from './s3-backend.js';
import type { ObjectStoreConfig, ObjectStoreLogEvent, ObjectStoreLogger, ObjectStoreResult } from './contract.js';
import { storeError } from './contract.js';
import { rawPayloadKey, sha256Base64, sha256HexOfUtf8, SHA256_HEX_PATTERN, utf8Bytes } from './keys.js';

const RAW_PAYLOAD_CONTENT_TYPE = 'application/json';
const DEFAULT_MAX_WRITE_ATTEMPTS = 5;
const DEFAULT_BACKLOG_WARN_AT = 256;
const DEFAULT_CACHE_ENTRIES = 256;
const BASE_BACKOFF_MS = 25;

export interface S3RawPayloadStore extends RawPayloadStore {
  /** Awaits every pending durable write. Call on graceful shutdown and in tests. */
  flush(): Promise<void>;
  /** The REAL operator replay path — `get()` cannot await (D5). */
  fetch(ref: string): Promise<ObjectStoreResult<unknown>>;
  /** Observability for the write-behind window. */
  pendingCount(): number;
  failedRefs(): readonly string[];
}

export interface RawPayloadStoreOptions {
  max_write_attempts?: number;
  backlog_warn_at?: number;
  log?: ObjectStoreLogger;
  /**
   * Backoff seam. Injectable so retry behaviour is testable without wall-clock
   * waits; production composition never passes one.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Bounded recent-write cache size — the only thing `get()` can serve from. */
  cache_entries?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });

/**
 * Builds the write-behind store over any backend. Not exported from the
 * barrel: production callers use `createS3RawPayloadStore`, while tests drive
 * it over the in-process backend (including its fault seam) so retry, flush,
 * and backlog behaviour are exercised with no network and no credentials.
 */
export function createRawPayloadStoreOverBackend(
  backend: ObjectBackend,
  options: RawPayloadStoreOptions = {},
): S3RawPayloadStore {
  const source = backend.source;
  const maxAttempts = Math.max(1, options.max_write_attempts ?? DEFAULT_MAX_WRITE_ATTEMPTS);
  const backlogWarnAt = options.backlog_warn_at ?? DEFAULT_BACKLOG_WARN_AT;
  const cacheEntries = Math.max(1, options.cache_entries ?? DEFAULT_CACHE_ENTRIES);
  const sleep = options.sleep ?? defaultSleep;
  const log: ObjectStoreLogger = options.log ?? (() => {});

  /** Refs whose durable write has not yet succeeded. */
  const pending = new Map<string, unknown>();
  /** Bounded recent-write cache — insertion-ordered, oldest evicted first. */
  const recent = new Map<string, unknown>();
  const inflight = new Map<string, Promise<void>>();
  const failed = new Set<string>();
  let backlogWarned = false;

  const emit = (event: ObjectStoreLogEvent): void => {
    log(event);
  };

  const remember = (ref: string, payload: unknown): void => {
    recent.set(ref, payload);
    while (recent.size > cacheEntries) {
      const oldest = recent.keys().next();
      if (oldest.done === true) break;
      recent.delete(oldest.value);
    }
  };

  const checkBacklog = (): void => {
    if (pending.size >= backlogWarnAt && !backlogWarned) {
      backlogWarned = true;
      // A sustained backlog means the store is down. One log per crossing:
      // an alarm that fires per-item is an alarm nobody reads.
      emit({
        op: 'stash',
        level: 'error',
        source,
        outcome: 'provider_unavailable',
        message: `raw payload write backlog reached ${pending.size}`,
      });
    } else if (pending.size === 0) {
      backlogWarned = false;
    }
  };

  async function writeDurably(ref: string, json: string, payload: unknown): Promise<void> {
    const bytes = utf8Bytes(json);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const written = await backend.put({
        key: rawPayloadKey(ref),
        bytes,
        content_type: RAW_PAYLOAD_CONTENT_TYPE,
        content_sha256: ref,
        content_sha256_base64: sha256Base64(bytes),
        metadata: {},
      });
      if (written.ok) {
        pending.delete(ref);
        failed.delete(ref);
        remember(ref, payload);
        checkBacklog();
        emit({ op: 'stash', level: 'debug', source, outcome: 'ok', ref_prefix: ref.slice(0, 12) });
        return;
      }
      if (!written.error.retryable || attempt === maxAttempts) {
        pending.delete(ref);
        failed.add(ref);
        // Retained in the bounded cache so an operator still has an in-process
        // replay path; NEVER silently dropped, and never reported as durable.
        remember(ref, payload);
        checkBacklog();
        emit({
          op: 'stash',
          level: 'error',
          source,
          outcome: written.error.code,
          ref_prefix: ref.slice(0, 12),
          message: `raw payload write failed after ${attempt} attempt(s): ${written.error.message}`,
        });
        return;
      }
      await sleep(BASE_BACKOFF_MS * attempt);
    }
  }

  return {
    stash(raw_payload: unknown): string {
      const json = canonicalJson(raw_payload);
      const ref = sha256HexOfUtf8(json);
      // Already durable, or a write is already in flight: at-least-once
      // redelivery of the same unparseable payload must not queue twice.
      if (inflight.has(ref) || (recent.has(ref) && !failed.has(ref) && !pending.has(ref))) {
        return ref;
      }
      pending.set(ref, raw_payload);
      checkBacklog();
      const work = writeDurably(ref, json, raw_payload).finally(() => {
        inflight.delete(ref);
      });
      inflight.set(ref, work);
      // `writeDurably` never rejects — every failure is a value — so there is
      // no unhandled rejection to guard against, and the ack path never waits.
      return ref;
    },

    get(ref: string): unknown | undefined {
      // Pending-or-cache only. The port's synchronous signature admits nothing
      // better; `fetch()` is the durable read.
      if (pending.has(ref)) return pending.get(ref);
      return recent.get(ref);
    },

    async flush(): Promise<void> {
      while (inflight.size > 0) {
        await Promise.all([...inflight.values()]);
      }
      emit({ op: 'flush', level: 'debug', source, outcome: 'ok' });
    },

    async fetch(ref: string): Promise<ObjectStoreResult<unknown>> {
      if (!SHA256_HEX_PATTERN.test(ref)) {
        return storeError('invalid_input', source, 'ref is not lowercase sha-256 hex');
      }
      const fetched = await backend.get(rawPayloadKey(ref));
      if (!fetched.ok) return { ok: false, error: fetched.error };
      const text = new TextDecoder('utf-8').decode(fetched.value.bytes);
      if (sha256HexOfUtf8(text) !== ref) {
        return storeError('malformed_response', source, 'retrieved payload does not match its ref');
      }
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return storeError('malformed_response', source, 'retrieved payload is not valid JSON');
      }
    },

    pendingCount(): number {
      return pending.size;
    },

    failedRefs(): readonly string[] {
      return [...failed];
    },
  };
}

/** Production composition: write-behind over the S3-compatible backend. */
export function createS3RawPayloadStore(
  config: ObjectStoreConfig,
  options: RawPayloadStoreOptions = {},
): S3RawPayloadStore {
  return createRawPayloadStoreOverBackend(createS3Backend(config), {
    ...options,
    ...(options.log === undefined && config.log !== undefined ? { log: config.log } : {}),
  });
}
