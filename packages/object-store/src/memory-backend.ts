/**
 * In-process backend — identical semantics, no network, no credentials, no
 * bucket (docs/design/T-018.md §1.1).
 *
 * ADR-008's posture is *default to in-memory*, never *fall back to it*: this is
 * what the API composes when the object store is unconfigured, and what every
 * invariant suite runs against. AC-3 (no audio) and AC-4 (tenancy) are
 * properties of OUR rules, not of a remote service, so their tests must never
 * be environment-gated — only `test/s3-live.test.ts` is.
 *
 * Key order is lexicographic, exactly as `ListObjectsV2` returns it, so a test
 * written against this backend describes real S3 behaviour.
 */

import type { AdapterError, IsoTimestamp } from '@core';
import type {
  BackendHead,
  BackendListOptions,
  BackendListPage,
  BackendMetadata,
  BackendObject,
  BackendPutInput,
  ObjectBackend,
} from './backend.js';
import type { ObjectStoreResult } from './contract.js';

export type BackendOp = 'put' | 'get' | 'head' | 'list';

export interface MemoryBackendOptions {
  source?: string;
  /** Injectable clock — the deterministic seam every test needs. */
  clock?: () => IsoTimestamp;
  /**
   * Fault seam for tests: return an `AdapterError` to make the operation fail,
   * `undefined` to let it proceed. Production composition never passes one.
   */
  faults?: (op: BackendOp, key: string) => AdapterError | undefined;
}

interface StoredEntry {
  bytes: Uint8Array;
  content_type: string;
  metadata: BackendMetadata;
  stored_at: IsoTimestamp;
}

export interface MemoryBackend extends ObjectBackend {
  /** Number of stored objects — test/observability affordance only. */
  size(): number;
  /** Every stored key, lexicographically ordered. */
  keys(): readonly string[];
}

const defaultClock = (): IsoTimestamp => new Date().toISOString();

export function createMemoryBackend(options: MemoryBackendOptions = {}): MemoryBackend {
  const source = options.source ?? 'in-memory-object-store';
  const clock = options.clock ?? defaultClock;
  const faults = options.faults;
  const objects = new Map<string, StoredEntry>();

  const fault = (op: BackendOp, key: string): { ok: false; error: AdapterError } | undefined => {
    const error = faults?.(op, key);
    return error === undefined ? undefined : { ok: false, error };
  };

  const notFound = (op: string): { ok: false; error: AdapterError } => ({
    ok: false,
    error: { code: 'not_found', retryable: false, source, message: `${op} failed: no such key` },
  });

  const toHead = (entry: StoredEntry): BackendHead => ({
    byte_length: entry.bytes.byteLength,
    ...(entry.content_type !== '' ? { content_type: entry.content_type } : {}),
    metadata: entry.metadata,
    stored_at: entry.stored_at,
  });

  return {
    source,

    async put(input: BackendPutInput): Promise<ObjectStoreResult<void>> {
      const injected = fault('put', input.key);
      if (injected !== undefined) return injected;
      const existing = objects.get(input.key);
      if (existing === undefined) {
        // Copy the bytes: the caller's buffer must not alias stored state.
        objects.set(input.key, {
          bytes: input.bytes.slice(),
          content_type: input.content_type,
          metadata: { ...input.metadata },
          stored_at: clock(),
        });
      }
      // A key that already exists is left untouched. Keys are content-addressed
      // (D4), so the bytes are identical and a rewrite would only churn
      // `stored_at` — which is exactly the in-place mutation AC-7 forbids.
      return { ok: true, value: undefined };
    },

    async get(key: string): Promise<ObjectStoreResult<BackendObject>> {
      const injected = fault('get', key);
      if (injected !== undefined) return injected;
      const entry = objects.get(key);
      if (entry === undefined) return notFound('get');
      return { ok: true, value: { ...toHead(entry), bytes: entry.bytes.slice() } };
    },

    async head(key: string): Promise<ObjectStoreResult<BackendHead>> {
      const injected = fault('head', key);
      if (injected !== undefined) return injected;
      const entry = objects.get(key);
      if (entry === undefined) return notFound('head');
      return { ok: true, value: toHead(entry) };
    },

    async list(prefix: string, listOptions: BackendListOptions): Promise<ObjectStoreResult<BackendListPage>> {
      const injected = fault('list', prefix);
      if (injected !== undefined) return injected;
      const cursor = listOptions.cursor;
      const matching = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .filter(([key]) => cursor === undefined || key > cursor)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      const page = matching.slice(0, listOptions.limit);
      const truncated = matching.length > page.length;
      const last = page[page.length - 1];
      return {
        ok: true,
        value: {
          items: page.map(([key, entry]) => ({
            key,
            byte_length: entry.bytes.byteLength,
            stored_at: entry.stored_at,
          })),
          truncated,
          ...(truncated && last !== undefined ? { next_cursor: last[0] } : {}),
        },
      };
    },

    size(): number {
      return objects.size;
    },

    keys(): readonly string[] {
      return [...objects.keys()].sort();
    },
  };
}
