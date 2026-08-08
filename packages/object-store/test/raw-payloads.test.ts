/**
 * T-018 tester — the `RawPayloadStore` seam (design D5, §4.7; ADR-009 §1,
 * which states that T-018 must name `RawPayloadStore`).
 *
 * The port in `services/comms/src/ports.ts` (T-014's file) is SYNCHRONOUS,
 * while S3 is not, and specs/00 "Comms aggregation layer" independently
 * requires webhooks to ack immediately. The implementation is therefore
 * write-behind, and the properties that make that safe are what this file
 * tests:
 *
 *   - the ref is BIT-IDENTICAL to `InMemoryRawPayloadStore`'s, so the
 *     quarantine idempotency key `source + ':quarantine:' + ref` dedupes the
 *     same way before and after the store swap;
 *   - `stash` returns without awaiting anything;
 *   - a failed durable write is retried, then surfaced in `failedRefs()` with
 *     an error log — NEVER silently dropped;
 *   - the payload itself never rides the logs (ports.ts: "The payload NEVER
 *     rides the bus or the logs");
 *   - the key space is `ops/raw-payload/…`, owned by no account, so an
 *     account-scoped read cannot construct it (D3).
 */

import { describe, expect, it } from 'vitest';
import { InMemoryRawPayloadStore } from '@comms';
import { createRawPayloadStoreOverBackend } from '../src/raw-payloads.js';
import { createMemoryBackend } from '../src/memory-backend.js';
import { parseArtifactRef, rawPayloadKey, sha256HexOfUtf8, utf8Bytes } from '../src/keys.js';
import type { AdapterError } from '@core';
import type { BackendOp } from '../src/memory-backend.js';
import { backendError, bytesFrom, captureLog, expectErr, expectOk, fixedClock, stubBackend } from './helpers.js';

const noSleep = async (): Promise<void> => {};

const PAYLOADS: readonly unknown[] = [
  { provider: 'unknown', body: 'not parseable' },
  { b: 2, a: 1, nested: { z: true, y: [1, 2, 3] } },
  { nested: { y: [1, 2, 3], z: true }, a: 1, b: 2 },
  'a bare string payload',
  42,
  null,
  [],
  { with_undefined: undefined, kept: 'yes' },
];

describe('the ref is bit-identical to the in-memory implementation (ADR-001 — canonicalJson is imported, never copied)', () => {
  it.each(PAYLOADS.map((p, i) => [i, p] as const))('agrees on payload #%i', async (_i, payload) => {
    const reference = new InMemoryRawPayloadStore();
    const store = createRawPayloadStoreOverBackend(createMemoryBackend({ clock: fixedClock() }), { sleep: noSleep });
    expect(store.stash(payload)).toBe(reference.stash(payload));
    await store.flush();
  });

  it('produces the same ref for structurally equal payloads with different key order', async () => {
    const store = createRawPayloadStoreOverBackend(createMemoryBackend(), { sleep: noSleep });
    const a = store.stash({ b: 2, a: 1 });
    const b = store.stash({ a: 1, b: 2 });
    expect(a).toBe(b);
    await store.flush();
  });

  it('returns lowercase sha-256 hex, which is what an object key segment requires', () => {
    const store = createRawPayloadStoreOverBackend(createMemoryBackend(), { sleep: noSleep });
    expect(store.stash({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stash is non-blocking, and the durable write follows (§4.7)', () => {
  it('returns before the durable write has completed', async () => {
    // The in-process fake resolves its write in the same tick, so the ack-path
    // guarantee is only observable against a backend that cannot: the stub
    // holds its PUT open until released, exactly as a network round trip does.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let written = false;
    const backend = stubBackend({
      put: async () => {
        await gate;
        written = true;
        return { ok: true, value: undefined };
      },
    });
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep });

    const ref = store.stash({ raw: 'payload' });
    // specs/00 "Comms aggregation layer": webhooks ack immediately. The ack
    // path is never blocked on an S3 round trip.
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(written).toBe(false);
    expect(store.pendingCount()).toBe(1);

    release();
    await store.flush();
    expect(written).toBe(true);
    expect(store.pendingCount()).toBe(0);
    expect(backend.calls).toEqual([`put:${rawPayloadKey(ref)}`]);
  });

  it('lands the payload durably once flushed', async () => {
    const backend = createMemoryBackend({ clock: fixedClock() });
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep });
    const ref = store.stash({ raw: 'payload' });
    await store.flush();
    expect(store.pendingCount()).toBe(0);
    expect(backend.keys()).toEqual([rawPayloadKey(ref)]);
  });

  it('writes to the operator key space, which no account-scoped read can address (D3)', async () => {
    const backend = createMemoryBackend({ clock: fixedClock() });
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep });
    const ref = store.stash({ raw: 'payload' });
    await store.flush();
    const key = backend.keys()[0] ?? '';
    expect(key).toBe(`ops/raw-payload/${ref}`);
    expect(key.startsWith('acct/')).toBe(false);
    expect(parseArtifactRef(key)).toBeUndefined();
  });

  it('does not queue a second write for a redelivered identical payload', async () => {
    const backend = createMemoryBackend({ clock: fixedClock() });
    let writes = 0;
    const counting = {
      ...backend,
      put: async (input: Parameters<typeof backend.put>[0]) => {
        writes += 1;
        return backend.put(input);
      },
    };
    const store = createRawPayloadStoreOverBackend(counting, { sleep: noSleep });
    const first = store.stash({ raw: 'payload' });
    const second = store.stash({ raw: 'payload' });
    await store.flush();
    const third = store.stash({ raw: 'payload' });
    await store.flush();
    expect(first).toBe(second);
    expect(second).toBe(third);
    // At-least-once redelivery of the same unparseable payload produces one
    // object, not three.
    expect(writes).toBe(1);
  });

  it('reads back the durable payload through fetch()', async () => {
    const store = createRawPayloadStoreOverBackend(createMemoryBackend({ clock: fixedClock() }), { sleep: noSleep });
    const payload = { provider: 'unknown', headers: { a: 1 }, body: 'x' };
    const ref = store.stash(payload);
    await store.flush();
    expect(expectOk(await store.fetch(ref))).toEqual(payload);
  });

  it('serves get() from the pending set and then from the bounded recent cache', async () => {
    const store = createRawPayloadStoreOverBackend(createMemoryBackend({ clock: fixedClock() }), { sleep: noSleep });
    const payload = { raw: 'payload' };
    const ref = store.stash(payload);
    expect(store.get(ref)).toEqual(payload);
    await store.flush();
    expect(store.get(ref)).toEqual(payload);
    expect(store.get('f'.repeat(64))).toBeUndefined();
  });

  it('evicts the oldest entry once the recent cache is full — get() is cache-only by contract', async () => {
    const store = createRawPayloadStoreOverBackend(createMemoryBackend({ clock: fixedClock() }), {
      sleep: noSleep,
      cache_entries: 2,
    });
    const first = store.stash({ n: 1 });
    store.stash({ n: 2 });
    store.stash({ n: 3 });
    await store.flush();
    expect(store.get(first)).toBeUndefined();
    // …but the durable copy is still there: `fetch` is the real replay path.
    expect(expectOk(await store.fetch(first))).toEqual({ n: 1 });
  });
});

describe('a failed durable write is retried, then surfaced — never silently dropped', () => {
  function flakyBackend(failures: number, error: AdapterError) {
    let attempts = 0;
    const faults = (op: BackendOp): AdapterError | undefined => {
      if (op !== 'put') return undefined;
      attempts += 1;
      return attempts <= failures ? error : undefined;
    };
    return { backend: createMemoryBackend({ clock: fixedClock(), faults }), attempts: () => attempts };
  }

  it('retries a retryable failure and succeeds', async () => {
    const flaky = flakyBackend(2, backendError('provider_unavailable', 'origin down'));
    const store = createRawPayloadStoreOverBackend(flaky.backend, { sleep: noSleep, max_write_attempts: 5 });
    const ref = store.stash({ raw: 'payload' });
    await store.flush();
    expect(flaky.attempts()).toBe(3);
    expect(store.failedRefs()).toEqual([]);
    expect(store.pendingCount()).toBe(0);
    expect(expectOk(await store.fetch(ref))).toEqual({ raw: 'payload' });
  });

  it('gives up after max_write_attempts and records the ref as failed', async () => {
    const flaky = flakyBackend(99, backendError('provider_unavailable', 'origin down'));
    const capture = captureLog();
    const store = createRawPayloadStoreOverBackend(flaky.backend, {
      sleep: noSleep,
      max_write_attempts: 3,
      log: capture.log,
    });
    const ref = store.stash({ raw: 'payload' });
    await store.flush();
    expect(flaky.attempts()).toBe(3);
    expect(store.failedRefs()).toEqual([ref]);
    expect(store.pendingCount()).toBe(0);
    const error = capture.events.find((e) => e.level === 'error');
    expect(error?.op).toBe('stash');
    expect(error?.message).toContain('raw payload write failed');
    // Retained in the bounded cache so an operator still has a replay path.
    expect(store.get(ref)).toEqual({ raw: 'payload' });
  });

  it('does not retry a non-retryable failure', async () => {
    const flaky = flakyBackend(99, backendError('auth', 'denied'));
    const store = createRawPayloadStoreOverBackend(flaky.backend, { sleep: noSleep, max_write_attempts: 5 });
    const ref = store.stash({ raw: 'payload' });
    await store.flush();
    expect(flaky.attempts()).toBe(1);
    expect(store.failedRefs()).toEqual([ref]);
  });

  it('re-attempts a previously failed ref when the same payload is redelivered', async () => {
    let fail = true;
    const backend = createMemoryBackend({
      clock: fixedClock(),
      faults: (op) => (op === 'put' && fail ? backendError('auth', 'denied') : undefined),
    });
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep, max_write_attempts: 1 });
    const ref = store.stash({ raw: 'payload' });
    await store.flush();
    expect(store.failedRefs()).toEqual([ref]);

    fail = false;
    expect(store.stash({ raw: 'payload' })).toBe(ref);
    await store.flush();
    expect(store.failedRefs()).toEqual([]);
    expect(backend.keys()).toEqual([rawPayloadKey(ref)]);
  });

  it('alarms once when the write backlog crosses its threshold', async () => {
    const capture = captureLog();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const backend = stubBackend({
      put: async () => {
        await gate;
        return { ok: true, value: undefined };
      },
    });
    const store = createRawPayloadStoreOverBackend(backend, {
      sleep: noSleep,
      backlog_warn_at: 3,
      log: capture.log,
    });
    for (let i = 0; i < 6; i += 1) store.stash({ n: i });
    const alarms = capture.events.filter((e) => e.level === 'error' && e.op === 'stash');
    // A sustained backlog means the store is down and must alarm — but an
    // alarm that fires per item is an alarm nobody reads.
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.message).toContain('backlog');
    release();
    await store.flush();
  });
});

describe('fetch — the durable read and its failure modes', () => {
  it('refuses a ref that is not lowercase sha-256 hex, without a backend call', async () => {
    const backend = stubBackend();
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep });
    for (const bad of ['', 'not-a-ref', 'F'.repeat(64), 'a'.repeat(63), `../${'a'.repeat(64)}`]) {
      expectErr(await store.fetch(bad), 'invalid_input');
    }
    expect(backend.calls).toEqual([]);
  });

  it('returns not_found for a ref that was never stored', async () => {
    const store = createRawPayloadStoreOverBackend(createMemoryBackend(), { sleep: noSleep });
    expectErr(await store.fetch('a'.repeat(64)), 'not_found');
  });

  it('raises malformed_response when the stored bytes do not match the ref', async () => {
    const backend = stubBackend({
      get: async () => ({
        ok: true,
        value: {
          bytes: utf8Bytes('{"tampered":true}'),
          byte_length: 17,
          content_type: 'application/json',
          metadata: {},
          stored_at: '2026-08-07T12:00:00.000Z',
        },
      }),
    });
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep });
    const error = expectErr(await store.fetch(sha256HexOfUtf8('{"other":1}')), 'malformed_response');
    expect(error.retryable).toBe(false);
  });

  it('raises malformed_response when the stored bytes are not JSON', async () => {
    const notJson = 'this is not json';
    const backend = stubBackend({
      get: async () => ({
        ok: true,
        value: {
          bytes: utf8Bytes(notJson),
          byte_length: notJson.length,
          content_type: 'application/json',
          metadata: {},
          stored_at: '2026-08-07T12:00:00.000Z',
        },
      }),
    });
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep });
    const error = expectErr(await store.fetch(sha256HexOfUtf8(notJson)), 'malformed_response');
    expect(error.message).toContain('not valid JSON');
  });

  it('propagates a transient provider failure as retryable', async () => {
    const backend = stubBackend({ get: async () => ({ ok: false, error: backendError('rate_limited') }) });
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep });
    expect(expectErr(await store.fetch('a'.repeat(64)), 'rate_limited').retryable).toBe(true);
  });
});

describe('the payload never rides the logs', () => {
  it('logs only a 12-character ref prefix, never the payload', async () => {
    const capture = captureLog();
    const store = createRawPayloadStoreOverBackend(createMemoryBackend({ clock: fixedClock() }), {
      sleep: noSleep,
      log: capture.log,
    });
    const ref = store.stash({ secret_body: 'the buyer will pay 31000', authorization: 'Bearer abc123' });
    await store.flush();
    const serialized = JSON.stringify(capture.events);
    expect(serialized).not.toContain('31000');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('secret_body');
    expect(serialized).not.toContain(ref);
    expect(serialized).toContain(ref.slice(0, 12));
  });

  it('stores the payload bytes verbatim so an operator replay is faithful', async () => {
    const backend = createMemoryBackend({ clock: fixedClock() });
    const store = createRawPayloadStoreOverBackend(backend, { sleep: noSleep });
    const payload = { b: 2, a: 1 };
    const ref = store.stash(payload);
    await store.flush();
    const stored = expectOk(await backend.get(rawPayloadKey(ref)));
    expect([...stored.bytes]).toEqual([...bytesFrom('{"a":1,"b":2}')]);
  });
});
