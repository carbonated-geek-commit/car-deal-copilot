/**
 * T-009 tester — end-to-end pipeline: extraction attachment + current_offer
 * rollup (AC-1/2/4; design §4.2 C1–C5, §6; ADR-005).
 *
 *   - sms/email: webhook → thread → extract → extracted_offer on the Message
 *     → rolled into the thread's current_offer;
 *   - call: consent hook → stubbed transcription → transcript fill-once →
 *     extraction on the transcript; no body, no recording_url, ever;
 *   - ADR-005: a partial Offer WITHOUT sale_price flows through attachment
 *     and rollup unchanged — absent fields stay absent, never zero;
 *   - rollup is per-field newest-message-wins by Message.timestamp, NOT
 *     processing order (commutative under unordered at-least-once delivery);
 *   - error paths: no-offer text, transcript unavailable → bounded retries →
 *     DLQ with envelope intact (call message still threaded).
 */

import { describe, expect, it } from 'vitest';
import type { SpineEvent } from '@core';
import {
  callPayload,
  emailPayload,
  IDENTITY_A,
  makeDeal,
  makeHarness,
  smsPayload,
  T1,
  T2,
} from './fixtures/harness.js';

const PRICE_TEXT = 'The price is $23,500 for this one.';
const MONTHLY_TEXT = '$450/mo';

describe('SMS / email end-to-end (AC-2, AC-4, AC-6)', () => {
  it('SMS: threads the verbatim @core Message, attaches extracted_offer, rolls up current_offer', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: PRICE_TEXT, at: T1 }));
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.messages).toHaveLength(1);
    const msg = thread.messages[0]!;
    expect(msg.channel).toBe('sms');
    expect(msg.direction).toBe('in');
    expect(msg.body).toBe(PRICE_TEXT);
    expect(msg.timestamp).toBe(T1); // = InboundComms.received_at
    expect(msg.extracted_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    expect(thread.current_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    expect(h.queue.deadLetters).toHaveLength(0);
  });

  it('email with an itemized fee: fee lands in extracted_offer and current_offer', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    await h.service.intake.ingest(
      'email',
      emailPayload({ ref: 'em-1', body: 'The price is $23,500 for this one. Plus a doc fee of $499.', at: T1 }),
    );
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    const offer = thread.messages[0]!.extracted_offer!;
    expect(offer.sale_price).toBe(23_500_00);
    expect(offer.fees).toStrictEqual([{ name: 'doc fee', amount: 499_00 }]);
    expect(offer.flags).toStrictEqual([]);
    expect(thread.current_offer!.fees).toStrictEqual([{ name: 'doc fee', amount: 499_00 }]);
  });

  it('text with no offer: message still threads; no extracted_offer, no current_offer', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: 'Thanks, talk soon.' }));
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.extracted_offer).toBeUndefined();
    expect(thread.current_offer).toBeUndefined();
    expect(h.queue.deadLetters).toHaveLength(0); // "no offer" is a valid terminal outcome, not an error
  });
});

describe('call end-to-end (AC-2; D7/D8/D9; specs/01 transcribe-only)', () => {
  it('call: threads immediately, fills the transcript once, extracts from the transcript', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    h.transcripts.set('call-audio-1', 'The price is $23,500 for this one at 4.9% APR for 72 months.');

    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', callRef: 'call-audio-1', at: T1 }));
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.messages).toHaveLength(1);
    const msg = thread.messages[0]!;
    expect(msg.channel).toBe('call');
    expect(msg.direction).toBe('in');
    expect(msg.transcript).toBe('The price is $23,500 for this one at 4.9% APR for 72 months.');
    // Transcribe-only posture: no body, no recording_url — the fields are
    // absent, not null-set (no code path in this service writes them).
    expect('body' in msg).toBe(false);
    expect('recording_url' in msg).toBe(false);
    // Extraction ran on the transcript.
    expect(msg.extracted_offer).toStrictEqual({
      fees: [],
      flags: [],
      sale_price: 23_500_00,
      apr: 4.9,
      term_months: 72,
    });
    expect(thread.current_offer!.sale_price).toBe(23_500_00);
  });

  it('consent hook { transcribe: false }: call message still threads; no transcript, no extraction', async () => {
    const observed: string[] = [];
    const h = makeHarness({
      consent: {
        onInboundCall: (deal_id) => {
          observed.push(deal_id);
          return { transcribe: false };
        },
      },
    });
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    h.transcripts.set('call-audio-1', 'The price is $23,500.');

    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', callRef: 'call-audio-1' }));
    await h.queue.drain();

    expect(observed).toStrictEqual(['deal-a']); // hook consulted, with the resolved deal
    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.messages).toHaveLength(1); // never dropped (D7)
    expect(thread.messages[0]!.transcript).toBeUndefined();
    expect(thread.messages[0]!.extracted_offer).toBeUndefined();
    expect(thread.current_offer).toBeUndefined();
  });

  it('transcript unavailable: bounded retries → dead letter with envelope intact; call still threaded', async () => {
    const h = makeHarness({ maxAttempts: 2 });
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    // 'call-audio-missing' is never registered with the stub.

    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', callRef: 'call-audio-missing' }));
    await h.queue.drain();

    // The dealer contact was never lost (D7)…
    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.transcript).toBeUndefined();

    // …and the failure is operator-visible, envelope intact (T-001 §5.3).
    const dead = h.queue.deadLetters;
    expect(dead).toHaveLength(1);
    expect(dead[0]!.consumer).toBe('transcription-stub-worker');
    expect(dead[0]!.attempts).toBe(2);
    expect(dead[0]!.last_reason).toBe('transcript_unavailable');
    const env = dead[0]!.event;
    expect(env.type).toBe('comms.transcription.requested.v1');
    if (env.type !== 'comms.transcription.requested.v1') throw new Error('unreachable');
    expect(env.payload.call_ref).toBe('call-audio-missing');
    expect(env.payload.provider_message_ref).toBe('call-1');
    expect(env.deal_id).toBe('deal-a');
  });
});

describe('current_offer rollup (AC-4; design §6; ADR-005)', () => {
  it('ADR-005: a partial Offer without sale_price attaches and rolls up verbatim — never zero-filled', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: MONTHLY_TEXT, at: T1 }));
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    // toStrictEqual proves the ABSENCE of sale_price/apr/term_months — the
    // payment-packing-shaped monthly-only offer is first-class, not an error.
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({ fees: [], flags: [], monthly: 450_00 });
    expect(thread.current_offer).toStrictEqual({ fees: [], flags: [], monthly: 450_00 });
    expect(thread.current_offer!.sale_price).toBeUndefined(); // absent — NEVER 0
  });

  it('partial offers accumulate per-field: monthly-only then price-only compose; each Message keeps its verbatim partial', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: MONTHLY_TEXT, at: T1 }));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-2', body: PRICE_TEXT, at: T2 }));
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.current_offer).toStrictEqual({
      fees: [],
      flags: [],
      monthly: 450_00,
      sale_price: 23_500_00,
    });
    // The per-message record stays the extractor's verbatim output (§6.5).
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({ fees: [], flags: [], monthly: 450_00 });
    expect(thread.messages[1]!.extracted_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
  });

  it('rollup order source is Message.timestamp, not processing order: an older price processed later never wins', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    // Newer message (T2) fully processed first…
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-new', body: PRICE_TEXT, at: T2 }));
    await h.queue.drain();
    // …then an older message (T1) arrives late (out-of-order delivery).
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-old', body: 'The price is $12,000 for this one.', at: T1 }),
    );
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.messages).toHaveLength(2); // both messages kept (append-only)
    expect(thread.current_offer!.sale_price).toBe(23_500_00); // newest by timestamp wins
  });

  it('rollup is order-independent: opposite ingest orders yield the identical current_offer', async () => {
    const run = async (refsInOrder: ReadonlyArray<{ ref: string; body: string; at: string }>) => {
      const h = makeHarness();
      h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
      for (const m of refsInOrder) {
        await h.service.intake.ingest('telephony', smsPayload(m));
        await h.queue.drain(); // force processing in this exact order
      }
      return h.service.read.getDeal('deal-a')!.dealer_threads[0]!.current_offer;
    };

    const monthlyFirst = await run([
      { ref: 'sms-1', body: MONTHLY_TEXT, at: T1 },
      { ref: 'sms-2', body: PRICE_TEXT, at: T2 },
    ]);
    const priceFirst = await run([
      { ref: 'sms-2', body: PRICE_TEXT, at: T2 },
      { ref: 'sms-1', body: MONTHLY_TEXT, at: T1 },
    ]);

    expect(monthlyFirst).toStrictEqual(priceFirst);
    expect(monthlyFirst).toStrictEqual({ fees: [], flags: [], monthly: 450_00, sale_price: 23_500_00 });
  });

  it('an empty fees[] on a later offer never erases known fees (§6.2)', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    // Same dealer, same email thread: first a fee line, later a price-only
    // message whose extracted offer carries fees: [] ("no fee lines found",
    // not "fees are zero").
    await h.service.intake.ingest(
      'email',
      emailPayload({ ref: 'em-1', body: 'Plus a doc fee of $499.', at: T1 }),
    );
    await h.service.intake.ingest('email', emailPayload({ ref: 'em-2', body: PRICE_TEXT, at: T2 }));
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1]!.extracted_offer!.fees).toStrictEqual([]); // verbatim per-message
    expect(thread.current_offer).toStrictEqual({
      fees: [{ name: 'doc fee', amount: 499_00 }], // survived the later empty fees[]
      flags: [],
      sale_price: 23_500_00,
    });
  });

  it('flags on current_offer are always [] — flag evaluation belongs downstream (§6.3, ADR-002)', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: PRICE_TEXT }));
    await h.queue.drain();
    expect(h.service.read.getDeal('deal-a')!.dealer_threads[0]!.current_offer!.flags).toStrictEqual([]);
  });
});

describe('consumer error paths (§5.3)', () => {
  it('extraction-completed for an unknown message row: bounded retries → DLQ, envelope intact', async () => {
    const h = makeHarness({ maxAttempts: 2 });
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    const orphan: SpineEvent = {
      event_id: 'evt-orphan',
      type: 'offer.extraction.completed.v1',
      occurred_at: T1,
      deal_id: 'deal-a',
      idempotency_key: 'deal-a:ghost-ref:extraction-complete',
      payload: {
        deal_id: 'deal-a',
        dealer_id: 'dealer:sms:+15550200001',
        provider_message_ref: 'ghost-ref',
        offer: { fees: [], flags: [], sale_price: 100_00 },
      },
    };
    expect(await h.queue.publish(orphan)).toStrictEqual({ ok: true });
    await h.queue.drain();

    const dead = h.queue.deadLetters;
    expect(dead).toHaveLength(1);
    expect(dead[0]!.consumer).toBe('extraction-apply');
    expect(dead[0]!.last_reason).toBe('message_row_not_found');
    expect(dead[0]!.event.idempotency_key).toBe('deal-a:ghost-ref:extraction-complete');
    // And no thread was invented for the orphan.
    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
  });

  it('a consumer-side publish failure retries WITHOUT double-appending (keyed writes no-op on re-run)', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: PRICE_TEXT }));
    // Fail the router's first follow-up publish (the extraction request).
    h.queue.failNextPublishes(1);
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.messages).toHaveLength(1); // appended exactly once across attempts
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    expect(thread.current_offer!.sale_price).toBe(23_500_00);
    expect(h.queue.deadLetters).toHaveLength(0); // the retry succeeded
  });
});
