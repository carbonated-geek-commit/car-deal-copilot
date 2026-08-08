/**
 * T-014 tester — end-to-end pipeline: extraction attachment + current_offer
 * rollup (AC-5, AC-10; design §2.1, §1.6; ADR-005, ADR-006).
 *
 *   - sms/email keep the v0.5 flow `webhook → thread onto DealerThread →
 *     extract offer` (AC-5), with the extracted offer attached to the Message
 *     and rolled into the thread's current_offer;
 *   - ADR-005: a partial Offer WITHOUT sale_price flows through attachment and
 *     rollup unchanged — absent fields stay absent, NEVER zero and never
 *     "not triggered";
 *   - rollup is per-field newest-message-wins by `Message.timestamp`, NOT
 *     processing order (commutative under unordered at-least-once delivery);
 *   - error paths: no-offer text is a valid terminal outcome; an orphan
 *     artifact retries then dead-letters with the envelope intact; a
 *     consumer-side publish failure retries without double-appending.
 *
 * The three speech-capture cases that used to live here were deleted with the
 * stage itself (design D1); the v0.5 call flow is `call-flow.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SpineEvent, VehicleInstance, VehicleTarget } from '@core';
import {
  createCommsService,
  InMemoryCommsStore,
  InMemoryRawPayloadStore,
} from '../src/index.js';
import { CapturingQueue } from './fixtures/doubles.js';
import { FixtureEmailAdapter, FixtureTelephonyAdapter } from './fixtures/adapters.js';
import {
  DEALERSHIP_A,
  emailPayload,
  IDENTITY_A,
  makeHarness,
  onlyThread,
  seedDeal,
  smsPayload,
  T1,
  T2,
} from './fixtures/harness.js';

const PRICE_TEXT = 'The price is $23,500 for this one.';
const MONTHLY_TEXT = '$450/mo';

describe('SMS / email end-to-end (AC-5)', () => {
  it('SMS: threads the verbatim @core Message, attaches extracted_offer, rolls up current_offer', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: PRICE_TEXT, at: T1 }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1);
    const msg = thread.messages[0]!;
    expect(msg.channel).toBe('sms');
    expect(msg.direction).toBe('in');
    // AC-7: author is read off the TRANSPORT (an inbound provider message is
    // from the dealership), never inferred from body content.
    expect(msg.author).toBe('dealer');
    expect(msg.body).toBe(PRICE_TEXT);
    expect(msg.timestamp).toBe(T1); // = InboundComms.received_at
    expect(msg.extracted_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    expect(thread.current_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    expect(h.queue.deadLetters).toHaveLength(0);
  });

  it('email with an itemized fee: fee lands in extracted_offer and current_offer', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest(
      'email',
      emailPayload({
        ref: 'em-1',
        body: 'The price is $23,500 for this one. Plus a doc fee of $499.',
        at: T1,
      }),
    );
    await h.queue.drain();

    const thread = onlyThread(h);
    const offer = thread.messages[0]!.extracted_offer!;
    expect(offer.sale_price).toBe(23_500_00);
    expect(offer.fees).toStrictEqual([{ name: 'doc fee', amount: 499_00 }]);
    expect(offer.flags).toStrictEqual([]);
    expect(thread.current_offer!.fees).toStrictEqual([{ name: 'doc fee', amount: 499_00 }]);
  });

  it('text with no offer: message still threads; no extracted_offer, no current_offer', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: 'Thanks, talk soon.' }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.extracted_offer).toBeUndefined();
    expect(thread.current_offer).toBeUndefined();
    expect(h.queue.deadLetters).toHaveLength(0); // "no offer" is a valid terminal outcome, not an error
  });

  it('inbound text is never capped or truncated, even below the in-app note bound (D13 asymmetry)', async () => {
    // T-012 §4.1 assigned message-size bounding to this boundary and forbade
    // the extractor from truncating. A note is bounded because the buyer can
    // be asked to shorten it; a dealer's own words are EVIDENCE and are stored
    // whole — a truncated dealer message is silently altered evidence.
    const h = makeHarness({ max_note_chars: 40 });
    seedDeal(h, 'deal-a', IDENTITY_A);
    const long = 'The price is $23,500 for this one. ' + 'x'.repeat(500);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-long', body: long, at: T1 }));
    await h.queue.drain();

    const msg = onlyThread(h).messages[0]!;
    expect(msg.body).toBe(long); // stored verbatim, whole
    expect(msg.body!.length).toBe(long.length);
  });
});

describe('current_offer rollup (AC-10; ADR-005, ADR-006)', () => {
  it('ADR-005: a partial Offer without sale_price attaches and rolls up verbatim — never zero-filled', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: MONTHLY_TEXT, at: T1 }));
    await h.queue.drain();

    const thread = onlyThread(h);
    // toStrictEqual proves the ABSENCE of sale_price/apr/term_months — the
    // payment-packing-shaped monthly-only offer is first-class, not an error.
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({
      fees: [],
      flags: [],
      monthly: 450_00,
    });
    expect(thread.current_offer).toStrictEqual({ fees: [], flags: [], monthly: 450_00 });
    expect(thread.current_offer!.sale_price).toBeUndefined(); // absent — NEVER 0
    expect('sale_price' in thread.current_offer!).toBe(false);
  });

  it('partial offers accumulate per-field: monthly-only then price-only compose; each Message keeps its verbatim partial', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: MONTHLY_TEXT, at: T1 }));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-2', body: PRICE_TEXT, at: T2 }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.current_offer).toStrictEqual({
      fees: [],
      flags: [],
      monthly: 450_00,
      sale_price: 23_500_00,
    });
    // The per-message record stays the extractor's verbatim output.
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({
      fees: [],
      flags: [],
      monthly: 450_00,
    });
    expect(thread.messages[1]!.extracted_offer).toStrictEqual({
      fees: [],
      flags: [],
      sale_price: 23_500_00,
    });
  });

  it('rollup order source is Message.timestamp, not processing order: an older price processed later never wins', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    // Newer message (T2) fully processed first…
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-new', body: PRICE_TEXT, at: T2 }));
    await h.queue.drain();
    // …then an older message (T1) arrives late (out-of-order delivery).
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-old', body: 'The price is $12,000 for this one.', at: T1 }),
    );
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(2); // both messages kept (append-only)
    expect(thread.current_offer!.sale_price).toBe(23_500_00); // newest by timestamp wins
  });

  it('rollup is order-independent: opposite ingest orders yield the identical current_offer', async () => {
    const run = async (refsInOrder: ReadonlyArray<{ ref: string; body: string; at: string }>) => {
      const h = makeHarness();
      seedDeal(h, 'deal-a', IDENTITY_A);
      for (const m of refsInOrder) {
        await h.service.intake.ingest('telephony', smsPayload(m));
        await h.queue.drain(); // force processing in this exact order
      }
      return onlyThread(h).current_offer;
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
    expect(monthlyFirst).toStrictEqual({
      fees: [],
      flags: [],
      monthly: 450_00,
      sale_price: 23_500_00,
    });
  });

  it('an empty fees[] on a later offer never erases known fees', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    // Same dealership, same thread: first a fee line, later a price-only
    // message whose extracted offer carries fees: [] ("no fee lines found",
    // not "fees are zero").
    await h.service.intake.ingest(
      'email',
      emailPayload({ ref: 'em-1', body: 'Plus a doc fee of $499.', at: T1 }),
    );
    await h.service.intake.ingest('email', emailPayload({ ref: 'em-2', body: PRICE_TEXT, at: T2 }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1]!.extracted_offer!.fees).toStrictEqual([]); // verbatim per-message
    expect(thread.current_offer).toStrictEqual({
      fees: [{ name: 'doc fee', amount: 499_00 }], // survived the later empty fees[]
      flags: [],
      sale_price: 23_500_00,
    });
  });

  it('flags on current_offer are always [] — flag evaluation belongs downstream (ADR-002/ADR-007)', async () => {
    // ADR-007's `above_market` compares an offer against THAT VehicleInstance's
    // own ValuationSnapshot retail band. This service holds no valuation input
    // and no vehicle instance write path, so the comparison is not expressible
    // here: emitting a flag would be a fabricated verdict, and an unevaluable
    // input must never become "not triggered" (ADR-005).
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: PRICE_TEXT }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.current_offer!.flags).toStrictEqual([]);
    expect(thread.messages[0]!.extracted_offer!.flags).toStrictEqual([]);
    // No valuation was fetched and no instance was bound — nothing to compare against.
    expect(thread.vehicle_instance).toBeUndefined();
  });
});

describe('consumer error paths (design §3.5)', () => {
  it('extraction-completed for an unknown message row: bounded retries → DLQ, envelope intact', async () => {
    const h = makeHarness({ maxAttempts: 2 });
    seedDeal(h, 'deal-a', IDENTITY_A);

    const orphan: SpineEvent = {
      event_id: 'evt-orphan',
      type: 'offer.extraction.completed.v1',
      occurred_at: T1,
      deal_id: 'deal-a',
      idempotency_key: 'deal-a:ghost-ref:extraction-complete',
      payload: {
        deal_id: 'deal-a',
        dealership_id: DEALERSHIP_A,
        message_ref: 'ghost-ref',
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
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: PRICE_TEXT }));
    // Fail the router's first follow-up publish (the extraction request).
    h.queue.failNextPublishes(1);
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1); // appended exactly once across attempts
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({
      fees: [],
      flags: [],
      sale_price: 23_500_00,
    });
    expect(thread.current_offer!.sale_price).toBe(23_500_00);
    expect(h.queue.deadLetters).toHaveLength(0); // the retry succeeded
  });

  it('a message arriving never advances the negotiation, never binds a vehicle, never edits the anchor', async () => {
    // specs/00 "Cardinality invariants" + Q12: process_step, working_with,
    // vehicle_instance and target_vehicle are the buyer's to set through the
    // API. No port method on CommsStore can change them, so a dealer message
    // cannot move the deal along by arriving.
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    const anchorBefore = h.service.read.getDeal('deal-a')!.target_vehicle;

    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-1', body: 'The price is $23,500 on the 2019 Cart with 40,000 miles.' }),
    );
    await h.queue.drain();

    const deal = h.service.read.getDeal('deal-a')!;
    expect(deal.target_vehicle).toStrictEqual(anchorBefore); // write-once anchor untouched
    expect(deal.dealer_threads[0]!.process_step).toBe('information_gather');
    expect(deal.dealer_threads[0]!.vehicle_instance).toBeUndefined();
    expect(deal.dealer_threads[0]!.working_with).toBeUndefined();

    // @ts-expect-error — specs/00 "Cardinality invariants": make/model are
    // write-once and readonly on the spine type, so no code here (or anywhere
    // downstream of `getDeal`) can retarget a deal by assignment.
    deal.target_vehicle.make = 'Other Marque';
    expect(h.service.read.getDeal('deal-a')!.target_vehicle).toStrictEqual(anchorBefore);
  });

  it('a make/model mismatch is unrepresentable on a thread: a VehicleInstance has no make or model', () => {
    // specs/00: one deal, one make/model. The per-thread `VehicleInstance`
    // deliberately carries neither, so a thread that contradicts the deal's
    // anchor cannot be constructed — which is why no rejection RULE lives in
    // this service. The mismatch check belongs where an instance is written
    // (T-020), and this service has no such write path (see the port comment
    // in src/ports.ts and the tenancy suite's surface assertion).
    expectTypeOf<Extract<keyof VehicleInstance, 'make' | 'model'>>().toBeNever();
    expectTypeOf<VehicleTarget>().toHaveProperty('make');
    expectTypeOf<VehicleTarget>().toHaveProperty('model');
  });
});

describe('wiring-bug guard: an off-type envelope is poison, never silently ignored (design §3.2/§3.4/§3.5)', () => {
  /**
   * The in-memory queue only ever hands a handler an event of the type that
   * handler subscribed to, so this branch is unreachable through it. A queue
   * that can deliver an off-type envelope is what a mis-wired subscription
   * looks like in production, and the guard's whole point is that such a bug
   * is LOUD (immediate dead-letter, envelope intact) rather than a message
   * quietly discarded as "not mine".
   */
  const offType: SpineEvent = {
    event_id: 'evt-off-type',
    type: 'valuation.refresh.completed.v1',
    occurred_at: T1,
    deal_id: 'deal-a',
    idempotency_key: 'deal-a:valuation-complete',
    payload: {
      deal_id: 'deal-a',
      snapshot: {
        vehicle_instance_id: 'vi-1',
        retail: 24_000_00,
        source: 'mock-kbb',
        captured_at: T1,
      },
    },
  };

  it.each(['inbound-router', 'extraction-worker', 'extraction-apply'])(
    '%s returns poison for an event type it does not own',
    async (consumer) => {
      const queue = new CapturingQueue();
      const store = new InMemoryCommsStore();
      createCommsService({
        telephony: new FixtureTelephonyAdapter(),
        email: new FixtureEmailAdapter(),
        queue,
        store,
        raw_payloads: new InMemoryRawPayloadStore(),
        now: () => T1,
        new_event_id: () => 'evt-fixed',
      });

      const verdict = await queue.deliverTo(consumer, offType);
      expect(verdict.status).toBe('poison');
      if (verdict.status !== 'poison') throw new Error('unreachable');
      expect(verdict.reason).toBe('unexpected_event_type:valuation.refresh.completed.v1');
      // Nothing was written, and no follow-up was published.
      expect(queue.published).toHaveLength(0);
      expect(store.listQuarantined()).toHaveLength(0);
      expect(store.listUnrouted()).toHaveLength(0);
    },
  );

  it('exactly three consumers are registered — the speech-capture stage is gone (D1)', () => {
    const queue = new CapturingQueue();
    createCommsService({
      telephony: new FixtureTelephonyAdapter(),
      email: new FixtureEmailAdapter(),
      queue,
      store: new InMemoryCommsStore(),
      raw_payloads: new InMemoryRawPayloadStore(),
      now: () => T1,
      new_event_id: () => 'evt-fixed',
    });

    expect(queue.consumers.sort()).toStrictEqual([
      'extraction-apply',
      'extraction-worker',
      'inbound-router',
    ]);
    expect(queue.typesFor('inbound-router')).toStrictEqual(['comms.inbound.received.v1']);
    expect(queue.typesFor('extraction-worker')).toStrictEqual(['offer.extraction.requested.v1']);
    expect(queue.typesFor('extraction-apply')).toStrictEqual(['offer.extraction.completed.v1']);
  });
});
