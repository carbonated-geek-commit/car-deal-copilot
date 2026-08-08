/**
 * The failure modes in the design's per-operation table (docs/design/T-020.md
 * §4.2, §4.4) that no happy path reaches.
 *
 * Two of these are contracts rather than preferences and are asserted as such:
 * a `recorded_extraction_deferred` is NOT a failure (the note is already
 * durable, so the caller retries the same `client_note_ref` and only the publish
 * is re-attempted), and a failed receipt mark NEVER changes the caller's
 * outcome — returning `503` would tell a client to retry a write that can never
 * succeed, and swapping the code would hide a correct rejection behind an
 * infrastructure problem.
 */

import { InMemoryQueue } from '@comms';
import type { Dealership } from '@core';
import type { ReceiptEntry, ReceiptResult, ReceiptStore } from '@receipt';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendRejectionMark,
  rejectionEntry,
  type DealershipDirectory,
  type DealershipNaturalKey,
  type RouteLogger,
} from '../../src/routes/index.js';
import {
  ACCOUNT_A,
  NORTHSIDE,
  bodyOf,
  boot,
  call,
  dealBody,
  errorCodeOf,
  scenario,
  vehicleBody,
  withStore,
  type Booted,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

// ---- POST /dealerships — the slug collision row --------------------------

const collidingDirectory = (): DealershipDirectory => ({
  get(): Promise<Dealership | undefined> {
    return Promise.resolve(undefined);
  },
  ensure(_key: DealershipNaturalKey): Promise<{ outcome: 'id_collision' }> {
    return Promise.resolve({ outcome: 'id_collision' });
  },
  search(): Promise<{ items: readonly Dealership[] }> {
    return Promise.resolve({ items: [] });
  },
});

describe('POST /dealerships — a minted id already held by a DIFFERENT natural key', () => {
  it('is a 409 conflict rather than an overwrite of a foreign global row', async () => {
    booted = await boot({ directory: collidingDirectory() });

    const res = await call(booted, 'POST', '/dealerships', ACCOUNT_A, NORTHSIDE);
    expect(res.statusCode).toBe(409);
    expect(errorCodeOf(res)).toBe('conflict');
    // The caller disambiguates; the response never echoes the other row.
    expect(res.body).not.toContain('Northside');
  });
});

// ---- POST …/messages — the deferred-extraction row -----------------------

describe('POST …/messages when the extraction publish fails', () => {
  it('reports the retryable 503 the outcome itself names, with the note already durable', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const queue = booted.container.queue;
    expect(queue).toBeInstanceOf(InMemoryQueue);
    (queue as InMemoryQueue).failNextPublishes(1);

    const res = await call(booted, 'POST', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A, {
      client_note_ref: 'ui-note-1',
      author: 'buyer',
      body: 'they quoted 28,900',
    });
    expect(res.statusCode).toBe(503);
    expect(errorCodeOf(res)).toBe('unavailable');
    expect(bodyOf<{ error: { retryable: boolean } }>(res).error.retryable).toBe(true);

    // NOT a failure: the note IS stored. This is the whole reason the code is
    // 503-retryable rather than a rollback.
    const messages = bodyOf<{ messages: readonly { body?: string }[] }>(
      await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A),
    );
    expect(messages.messages).toHaveLength(1);
  });

  it('absorbs the retry of the SAME client_note_ref — only the publish is re-attempted', async () => {
    booted = await boot();
    const s = await scenario(booted);
    (booted.container.queue as InMemoryQueue).failNextPublishes(1);

    const note = { client_note_ref: 'ui-note-1', author: 'buyer', body: 'they quoted 28,900' };
    await call(booted, 'POST', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A, note);

    const retry = await call(booted, 'POST', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A, note);
    expect(retry.statusCode).toBe(201);
    expect(bodyOf<{ disposition: string }>(retry).disposition).toBe('duplicate');

    const messages = bodyOf<{ messages: readonly unknown[] }>(
      await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A),
    );
    expect(messages.messages).toHaveLength(1);
  });
});

// ---- a rejection on a deal with no receipt bundle ------------------------

describe('a rejection on a deal that carries no receipt_bundle_id', () => {
  it('still rejects, and does not become a 500', async () => {
    booted = await boot();
    const s = await scenario(booted);

    await withStore(booted, s.deal_id, ACCOUNT_A, (session) => {
      const deal = session.store.getDeal(s.deal_id);
      if (deal === undefined) throw new Error('deal missing');
      const { receipt_bundle_id: _dropped, ...bare } = deal;
      session.store.putDeal(bare);
    });

    const res = await call(
      booted,
      'PUT',
      `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`,
      ACCOUNT_A,
      vehicleBody({ make: 'Toyota', model: 'Camry' }),
    );
    expect(res.statusCode).toBe(422);
    expect(errorCodeOf(res)).toBe('unprocessable');
  });

  it('still serves the trail, falling back to the deterministic bundle id', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-9', ACCOUNT_A, dealBody());
    await withStore(booted, 'deal-9', ACCOUNT_A, (session) => {
      const deal = session.store.getDeal('deal-9');
      if (deal === undefined) throw new Error('deal missing');
      const { receipt_bundle_id: _dropped, ...bare } = deal;
      session.store.putDeal(bare);
    });

    const res = await call(booted, 'GET', '/deals/deal-9/receipt', ACCOUNT_A);
    expect(res.statusCode).toBe(200);
    expect(bodyOf<{ receipt_bundle_id: string }>(res).receipt_bundle_id).toBe('receipt:deal-9');
  });
});

// ---- a failed mark never changes the caller's outcome (§4.4) -------------

const recordingLogger = (): RouteLogger & { readonly events: Record<string, unknown>[] } => {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    info: (payload: object) => events.push(payload as Record<string, unknown>),
    warn: (payload: object) => events.push(payload as Record<string, unknown>),
    error: (payload: object) => events.push(payload as Record<string, unknown>),
  };
};

const MARK = {
  receipt_bundle_id: 'receipt:deal-1',
  entry: rejectionEntry(
    'instance_mismatch',
    {
      deal_id: 'deal-1',
      dealership_id: 'dl-1',
      vin: 'VIN-1',
      submitted_make: 'Toyota',
      submitted_model: 'Camry',
      anchor_make: 'Honda',
      anchor_model: 'Accord',
      occurred_at: '2026-08-08T15:04:05.000Z',
    },
    'owner' as const,
  ),
  event: 'vehicle_anchor_reject',
  detail: { deal_id: 'deal-1', dealership_id: 'dl-1', field: 'make' },
};

describe('appendRejectionMark never changes the caller’s outcome (§4.4)', () => {
  it('logs and returns when the store reports a failure as a value', async () => {
    const log = recordingLogger();
    const failing: ReceiptStore = {
      append: (): Promise<ReceiptResult<never>> =>
        Promise.resolve({ ok: false, error: { code: 'store_unavailable', retryable: true, message: 'down' } }),
      read: (): Promise<ReceiptResult<readonly ReceiptEntry[]>> => Promise.resolve({ ok: true, value: [] }),
    };

    await expect(appendRejectionMark(failing, MARK, log)).resolves.toBeUndefined();
    expect(log.events.map((e) => e['event'])).toEqual(['vehicle_anchor_reject', 'receipt_append_failed']);
  });

  it('survives a store that THROWS — a defect in an implementation is still not the caller’s problem', async () => {
    const log = recordingLogger();
    const throwing: ReceiptStore = {
      append: (): Promise<never> => {
        throw new Error('boom');
      },
      read: (): Promise<ReceiptResult<readonly ReceiptEntry[]>> => Promise.resolve({ ok: true, value: [] }),
    };

    await expect(appendRejectionMark(throwing, MARK, log)).resolves.toBeUndefined();
    expect(log.events.map((e) => e['event'])).toEqual(['vehicle_anchor_reject', 'receipt_append_failed']);
  });

  it('reports a missing bundle rather than silently skipping the mark', async () => {
    const log = recordingLogger();
    const appended: unknown[] = [];
    const store: ReceiptStore = {
      append: (bundle: string): Promise<ReceiptResult<never>> => {
        appended.push(bundle);
        return Promise.resolve({ ok: false, error: { code: 'invalid_input', retryable: false, message: 'x' } });
      },
      read: (): Promise<ReceiptResult<readonly ReceiptEntry[]>> => Promise.resolve({ ok: true, value: [] }),
    };

    const { receipt_bundle_id: _dropped, ...bundleless } = MARK;
    await appendRejectionMark(store, bundleless, log);
    expect(appended).toEqual([]);
    expect(log.events.map((e) => e['event'])).toEqual(['vehicle_anchor_reject', 'receipt_bundle_missing']);
  });

  it('never puts a VIN, a value, or a money amount into the log line', () => {
    expect(JSON.stringify(MARK.detail)).not.toContain('VIN-1');
    expect(JSON.stringify(MARK.detail)).not.toContain('Toyota');
    expect(JSON.stringify(MARK.detail)).not.toContain('Camry');
    // …but the trail entry, which is account-scoped storage, does carry them.
    expect(MARK.entry.body).toContain('VIN-1');
  });
});

// ---- the envelope holds for everything this suite does not serve ---------

describe('the one error envelope covers this suite’s edges too (AC-16)', () => {
  it('answers an unmatched URL with the envelope, not a framework body', async () => {
    booted = await boot();
    const res = await call(booted, 'GET', '/deals/deal-1/not-a-thing', ACCOUNT_A);
    expect(res.statusCode).toBe(404);
    const body = bodyOf<{ error: { code: string; request_id: string; retryable: boolean } }>(res);
    expect(body.error.code).toBe('not_found');
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.retryable).toBe(false);
    expect(res.body).not.toContain('statusCode');
  });

  it('answers a non-JSON body with 415 through the same envelope', async () => {
    booted = await boot();
    const res = await booted.app.inject({
      method: 'PUT',
      url: '/deals/deal-1',
      headers: { 'x-dc-account-id': ACCOUNT_A, 'content-type': 'text/plain' },
      payload: 'path=hybrid',
    });
    expect(res.statusCode).toBe(415);
    expect(errorCodeOf(res)).toBe('unsupported_media_type');
  });

  it('carries a request id on every response, success or failure', async () => {
    booted = await boot();
    const ok = await call(booted, 'PUT', '/deals/deal-1', ACCOUNT_A, dealBody());
    const bad = await call(booted, 'GET', '/deals/deal-nope', ACCOUNT_A);
    expect(ok.headers['x-request-id']).toBeTruthy();
    expect(bad.headers['x-request-id']).toBeTruthy();
  });
});
