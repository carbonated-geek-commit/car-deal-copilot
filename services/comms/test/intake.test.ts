/**
 * T-014 tester — webhook intake: the ack-then-queue decision table
 * (design §1.2, §3.1 — BINDING; T-001 §5.2; AC-11).
 *
 * `intake.ts` is the one module T-014 did not touch, so this suite is the
 * regression evidence that the v0.5 re-basing left it behaving identically:
 *
 *   - 2xx ⇔ the inbound envelope is durably enqueued BEFORE any heavy work
 *     runs (no store read, no routing, no extraction pre-ack);
 *   - enqueue failure ⇒ 503, the ONE deliberate non-ack (the provider's retry
 *     is then the durability mechanism);
 *   - parse failure ⇒ quarantine event, STILL 2xx (no-drop rule);
 *   - an adapter that throws despite the sync-pure contract ⇒ treated as a
 *     parse failure ⇒ quarantine + 200 (§3.1 row 2).
 */

import { describe, expect, it } from 'vitest';
import {
  createCommsService,
  InMemoryCommsStore,
  InMemoryQueue,
  InMemoryRawPayloadStore,
} from '../src/index.js';
import {
  FixtureEmailAdapter,
  REMOVED_AUDIO_HANDLE_KEY,
  ThrowingTelephonyAdapter,
} from './fixtures/adapters.js';
import {
  emailPayload,
  IDENTITY_A,
  makeHarness,
  seedDeal,
  smsPayload,
} from './fixtures/harness.js';

describe('ack-then-queue: 2xx = enqueued before heavy work', () => {
  it('parsed SMS acks 200/parsed with NO heavy work done yet; drain does the threading', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    const outcome = await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-1', body: 'The price is $23,500 for this one.' }),
    );

    expect(outcome).toStrictEqual({ kind: 'enqueued', http_status: 200, disposition: 'parsed' });
    // Ack happened; heavy work has NOT: nothing threaded until the bus drains.
    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
    expect(h.extractionRequests).toHaveLength(0);

    await h.queue.drain();

    const deal = h.service.read.getDeal('deal-a')!;
    expect(deal.dealer_threads).toHaveLength(1);
    expect(deal.dealer_threads[0]!.messages).toHaveLength(1);
  });

  it('enqueue failure is a 503 — the one deliberate non-ack — and nothing is stored', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    h.queue.failNextPublishes(1);
    const failed = await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1' }));
    expect(failed).toStrictEqual({ kind: 'enqueue_failed', http_status: 503 });

    await h.queue.drain();
    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
    expect(h.service.read.listQuarantined()).toHaveLength(0);
    expect(h.service.read.listUnrouted()).toHaveLength(0);
  });

  it('provider retry after our 503 lands exactly one message (redelivery dedupes downstream)', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    const payload = smsPayload({ ref: 'sms-1', body: 'The price is $23,500 for this one.' });

    h.queue.failNextPublishes(1);
    const first = await h.service.intake.ingest('telephony', payload);
    expect(first.http_status).toBe(503);

    const retry = await h.service.intake.ingest('telephony', payload);
    expect(retry).toStrictEqual({ kind: 'enqueued', http_status: 200, disposition: 'parsed' });

    await h.queue.drain();
    const threads = h.service.read.getDeal('deal-a')!.dealer_threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages).toHaveLength(1);
  });

  it('parse failure still acks 200/quarantined; the raw payload is stashed and operator-visible', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    const garbage = { totally: 'not-a-normalized-payload', n: 42 };

    const outcome = await h.service.intake.ingest('telephony', garbage);
    expect(outcome).toStrictEqual({
      kind: 'enqueued',
      http_status: 200,
      disposition: 'quarantined',
    });

    await h.queue.drain();

    const quarantined = h.service.read.listQuarantined();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.source).toBe('fixture-telephony');
    expect(quarantined[0]!.parse_error.code).toBe('malformed_response');
    // The stashed raw payload is retrievable by ref (replay path) …
    expect(h.raw.get(quarantined[0]!.raw_payload_ref)).toStrictEqual(garbage);
    // … and nothing was threaded or guessed onto a deal.
    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
    expect(h.service.read.listUnrouted()).toHaveLength(0);
  });

  it('redelivered garbage dedupes on the deterministic quarantine key: one record', async () => {
    const h = makeHarness();
    const garbage = { b: 2, a: 1 };
    // Structurally equal payload with different key order — canonical JSON
    // makes the ref (and so the idempotency key) identical.
    const garbageReordered = { a: 1, b: 2 };

    expect((await h.service.intake.ingest('telephony', garbage)).http_status).toBe(200);
    expect((await h.service.intake.ingest('telephony', garbageReordered)).http_status).toBe(200);
    await h.queue.drain();

    expect(h.service.read.listQuarantined()).toHaveLength(1);
  });

  it('channel/adapter mismatch (email-shaped payload on the telephony channel) quarantines with 200', async () => {
    const h = makeHarness();
    const outcome = await h.service.intake.ingest('telephony', emailPayload({ ref: 'em-1' }));
    expect(outcome).toStrictEqual({
      kind: 'enqueued',
      http_status: 200,
      disposition: 'quarantined',
    });
    await h.queue.drain();
    expect(h.service.read.listQuarantined()).toHaveLength(1);
  });

  it('an adapter that THROWS despite the sync-pure contract is treated as parse failure: 200 + quarantine', async () => {
    // Assemble a service around the defective adapter with fresh infrastructure.
    // Note what is NOT in this dependency list any more: there is no
    // speech-capture port to inject — the seam was deleted, not stubbed (D1).
    const queue = new InMemoryQueue();
    const store = new InMemoryCommsStore();
    const raw = new InMemoryRawPayloadStore();
    let eid = 0;
    const service = createCommsService({
      telephony: new ThrowingTelephonyAdapter(),
      email: new FixtureEmailAdapter(),
      queue,
      store,
      raw_payloads: raw,
      now: () => '2026-08-07T12:00:00.000Z',
      new_event_id: () => `t-evt-${++eid}`,
    });

    const payload = smsPayload({ ref: 'sms-1' });
    const outcome = await service.intake.ingest('telephony', payload);
    expect(outcome).toStrictEqual({
      kind: 'enqueued',
      http_status: 200,
      disposition: 'quarantined',
    });

    await queue.drain();
    const quarantined = service.read.listQuarantined();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.source).toBe('fixture-throwing');
    // The dealer message is preserved for replay — never dropped.
    expect(raw.get(quarantined[0]!.raw_payload_ref)).toStrictEqual(payload);
  });

  it('quarantine and enqueue-failure compose: 503 on garbage, then provider retry quarantines once', async () => {
    const h = makeHarness();
    const garbage = 'not even an object';

    h.queue.failNextPublishes(1);
    expect((await h.service.intake.ingest('email', garbage)).http_status).toBe(503);
    expect((await h.service.intake.ingest('email', garbage)).http_status).toBe(200);
    await h.queue.drain();

    expect(h.service.read.listQuarantined()).toHaveLength(1);
    expect(h.service.read.listQuarantined()[0]!.source).toBe('fixture-email');
  });

  it('a call payload still carrying the removed v0.4 audio handle is provider drift: quarantined, never threaded', async () => {
    // The spine has no field for it, so the only honest disposition is "this
    // provider shape is not an inbound message" — 200 + quarantine, held for
    // an operator, and NOT silently accepted with the field dropped.
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    const legacy: Record<string, unknown> = {
      channel: 'call',
      to_identity: { phone_number: IDENTITY_A.phone_number },
      from: { phone: '+15550200001' },
      provider_message_ref: 'call-legacy',
      received_at: '2026-08-07T10:05:00.000Z',
    };
    legacy[REMOVED_AUDIO_HANDLE_KEY] = 'audio-handle-1';

    const outcome = await h.service.intake.ingest('telephony', legacy);
    expect(outcome).toStrictEqual({
      kind: 'enqueued',
      http_status: 200,
      disposition: 'quarantined',
    });
    await h.queue.drain();

    expect(h.service.read.listQuarantined()).toHaveLength(1);
    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
  });
});
