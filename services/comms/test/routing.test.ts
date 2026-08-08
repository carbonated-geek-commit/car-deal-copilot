/**
 * T-014 tester — identity-routing correctness (AC-13; design §3.2, §4 routing
 * row). Re-based to v0.5; the assertions are the T-009 ones, unchanged in
 * substance, because "identity routing exactly as built" is what this task
 * promised to preserve.
 *
 * The product promise under test: a message must NEVER thread to the wrong
 * deal or the wrong account. Adversarial cases:
 *   - unknown identity → unrouted holding area, never a guessed deal, never a
 *     drop (the record is held whole and replayable);
 *   - near-miss identity (adjacent number) → NON-match;
 *   - two deals contacted by the SAME dealership → each message lands only on
 *     the deal whose identity was addressed;
 *   - burned deal whose identity was re-bound → new inbound goes to the new
 *     deal only; the burned deal's history is untouched;
 *   - normalization is identical at bind and at resolve (formatted vs E.164)
 *     but never guesses (a missing country code is a non-match).
 */

import { describe, expect, it } from 'vitest';
import type { Deal } from '@core';
import {
  CONTACT_A,
  DEALER_EMAIL,
  DEALER_PHONE,
  DEALERSHIP_A,
  IDENTITY_A,
  IDENTITY_B,
  makeDeal,
  makeHarness,
  makeThread,
  seedDeal,
  smsPayload,
  emailPayload,
  T0,
  T1,
  T2,
} from './fixtures/harness.js';

describe('identity routing — never the wrong deal (AC-13)', () => {
  it('unknown identity: message goes to the unrouted holding area, held whole — no deal touched', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    seedDeal(h, 'deal-b', IDENTITY_B);

    const payload = smsPayload({
      ref: 'sms-x',
      toPhone: '+15550109999',
      body: 'The price is $9,000.',
    });
    const outcome = await h.service.intake.ingest('telephony', payload);
    expect(outcome.http_status).toBe(200); // parse succeeded; routing is a consumer concern
    await h.queue.drain();

    const unrouted = h.service.read.listUnrouted();
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0]!.reason).toBe('no_identity_match');
    expect(unrouted[0]!.inbound).toStrictEqual(payload); // held whole — replayable
    expect(unrouted[0]!.deal_id).toBeUndefined(); // no deal was guessed
    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
    expect(h.service.read.getDeal('deal-b')!.dealer_threads).toHaveLength(0);
    expect(h.queue.deadLetters).toHaveLength(0); // held, not dead-lettered — a valid terminal outcome
  });

  it('redelivered unroutable message does not duplicate the holding record', async () => {
    const h = makeHarness();
    const payload = smsPayload({ ref: 'sms-x', toPhone: '+15550109999' });
    await h.service.intake.ingest('telephony', payload);
    await h.service.intake.ingest('telephony', payload);
    await h.queue.drain();
    expect(h.service.read.listUnrouted()).toHaveLength(1);
  });

  it('near-miss identity (one digit off from a bound number) is a NON-match — exact match only', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A); // +15550100001

    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-near', toPhone: '+15550100002' }), // adjacent, unbound
    );
    await h.queue.drain();

    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
    expect(h.service.read.listUnrouted()).toHaveLength(1);
  });

  it('two deals, same dealership: each message threads ONLY to the deal whose identity was addressed', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    seedDeal(h, 'deal-b', IDENTITY_B);

    // The SAME dealership phone contacts both of our identities.
    await h.service.intake.ingest(
      'telephony',
      smsPayload({
        ref: 'to-a',
        toPhone: IDENTITY_A.phone_number!,
        fromPhone: DEALER_PHONE,
        body: 'For deal A: the price is $20,000.',
        at: T1,
      }),
    );
    await h.service.intake.ingest(
      'telephony',
      smsPayload({
        ref: 'to-b',
        toPhone: IDENTITY_B.phone_number!,
        fromPhone: DEALER_PHONE,
        body: 'For deal B: the price is $21,000.',
        at: T2,
      }),
    );
    await h.queue.drain();

    const dealA = h.service.read.getDeal('deal-a')!;
    const dealB = h.service.read.getDeal('deal-b')!;
    expect(dealA.dealer_threads).toHaveLength(1);
    expect(dealB.dealer_threads).toHaveLength(1);

    // Same dealership, two isolated threads — one per deal, no cross-pollination.
    const msgsA = dealA.dealer_threads[0]!.messages;
    const msgsB = dealB.dealer_threads[0]!.messages;
    expect(msgsA).toHaveLength(1);
    expect(msgsB).toHaveLength(1);
    expect(msgsA[0]!.body).toBe('For deal A: the price is $20,000.');
    expect(msgsB[0]!.body).toBe('For deal B: the price is $21,000.');

    // And the current_offer rollups stay per-deal.
    expect(dealA.dealer_threads[0]!.current_offer!.sale_price).toBe(20_000_00);
    expect(dealB.dealer_threads[0]!.current_offer!.sale_price).toBe(21_000_00);
  });

  it('burned deal whose identity was re-bound: inbound routes to the NEW deal only; burned history untouched', async () => {
    const h = makeHarness();

    // Deal A: burned, identity X still in its record, with prior history.
    const burned: Deal = {
      ...makeDeal('deal-a', IDENTITY_A),
      status: 'burned',
      burned_at: '2026-08-06T00:00:00.000Z',
      dealer_threads: [
        makeThread({
          working_with: CONTACT_A,
          messages: [
            { channel: 'sms', direction: 'in', author: 'dealer', body: 'old world', timestamp: T0 },
          ],
        }),
      ],
    };
    h.store.putDeal(burned);

    // Identity X is recycled onto deal B (authoritative re-bind), and deal B's
    // own account-private contact index is bound for the same dealership.
    seedDeal(h, 'deal-b');
    h.store.bindIdentity('deal-b', IDENTITY_A);

    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-new', toPhone: IDENTITY_A.phone_number!, body: 'new world', at: T2 }),
    );
    await h.queue.drain();

    // The new message landed on deal B…
    const dealB = h.service.read.getDeal('deal-b')!;
    expect(dealB.dealer_threads).toHaveLength(1);
    expect(dealB.dealer_threads[0]!.messages.map((m) => m.body)).toStrictEqual(['new world']);

    // …and the burned deal's history is exactly what it was — nothing added.
    const dealA = h.service.read.getDeal('deal-a')!;
    expect(dealA.dealer_threads).toHaveLength(1);
    expect(dealA.dealer_threads[0]!.messages.map((m) => m.body)).toStrictEqual(['old world']);
    expect(h.service.read.listUnrouted()).toHaveLength(0);
  });

  it('normalization is identical at bind and resolve: formatted bind matches E.164 inbound', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a'));
    h.store.bindThreadContact('deal-a', DEALERSHIP_A, {
      phone: DEALER_PHONE,
      email: DEALER_EMAIL,
    });
    h.store.bindIdentity('deal-a', {
      identity_id: 'identity-a',
      phone_number: '+1 (555) 010-0001', // formatted at bind
      email_alias: 'Deal-A@Buyer.Test', // mixed case at bind
    });

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'p-1', toPhone: '+15550100001' }));
    await h.service.intake.ingest('email', emailPayload({ ref: 'e-1', toAlias: 'deal-a@buyer.test' }));
    await h.queue.drain();

    const deal = h.service.read.getDeal('deal-a')!;
    const allMessages = deal.dealer_threads.flatMap((t) => t.messages);
    expect(allMessages).toHaveLength(2);
    expect(h.service.read.listUnrouted()).toHaveLength(0);
  });

  it('normalization never guesses: a match missing the country code is a NON-match', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A); // bound as +15550100001

    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-nocc', toPhone: '5550100001' }), // no +1 — conservative non-match
    );
    await h.queue.drain();

    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
    expect(h.service.read.listUnrouted()).toHaveLength(1);
  });

  it('the same dealership texting AND emailing one deal threads onto ONE thread (per-deal contact index)', async () => {
    const h = makeHarness();
    // Both contact points are bound to the SAME known dealership_id inside
    // this deal — that binding, not a guess about phone/email ownership, is
    // what joins the two transports onto one relationship (D9).
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 's-1', fromPhone: DEALER_PHONE }));
    await h.service.intake.ingest('email', emailPayload({ ref: 'e-1', fromEmail: DEALER_EMAIL }));
    await h.queue.drain();

    const deal = h.service.read.getDeal('deal-a')!;
    expect(deal.dealer_threads).toHaveLength(1);
    expect(deal.dealer_threads[0]!.dealership_id).toBe(DEALERSHIP_A);
    expect(deal.dealer_threads[0]!.messages).toHaveLength(2);
  });

  it('two dealerships on one deal stay on separate threads — no merging by transport', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    // A second, independently known dealership contacting the same buyer.
    h.store.bindThreadContact('deal-a', 'dealership-second-city-autos', {
      phone: '+15550200002',
    });

    await h.service.intake.ingest('telephony', smsPayload({ ref: 's-1', fromPhone: DEALER_PHONE }));
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 's-2', fromPhone: '+15550200002' }),
    );
    await h.queue.drain();

    const ids = h.service.read
      .getDeal('deal-a')!
      .dealer_threads.map((t) => t.dealership_id)
      .sort();
    expect(ids).toStrictEqual(['dealership-second-city-autos', DEALERSHIP_A].sort());
  });
});
