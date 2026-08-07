/**
 * T-009 tester — identity-routing correctness (AC-3; design D5/D6, §8
 * invariant 1).
 *
 * The product promise under test: a message must NEVER thread to the wrong
 * deal/user. Adversarial cases:
 *   - unknown identity → unrouted holding area, never a guessed deal, never
 *     a drop (record held whole, replayable);
 *   - near-miss identity (adjacent number) → NON-match;
 *   - two deals contacted by the SAME dealer → each message lands only on
 *     the deal whose identity was addressed;
 *   - burned deal whose identity was re-bound → new inbound goes to the new
 *     deal only; the burned deal's history is untouched;
 *   - normalization is identical at bind and resolve (formatted vs E.164),
 *     but never guesses (missing country code is a non-match).
 */

import { describe, expect, it } from 'vitest';
import type { Deal } from '@core';
import {
  DEALER_EMAIL,
  DEALER_PHONE,
  IDENTITY_A,
  IDENTITY_B,
  makeDeal,
  makeHarness,
  smsPayload,
  emailPayload,
  T0,
  T1,
  T2,
} from './fixtures/harness.js';

describe('identity routing — never the wrong deal (AC-3, D5)', () => {
  it('unknown identity: message goes to the unrouted holding area, held whole — no deal touched', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    h.store.putDeal(makeDeal('deal-b', IDENTITY_B));

    const payload = smsPayload({ ref: 'sms-x', toPhone: '+15550109999', body: 'The price is $9,000.' });
    const outcome = await h.service.intake.ingest('telephony', payload);
    expect(outcome.http_status).toBe(200); // parse succeeded; routing is a consumer concern
    await h.queue.drain();

    const unrouted = h.service.read.listUnrouted();
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0]!.reason).toBe('no_identity_match');
    expect(unrouted[0]!.inbound).toStrictEqual(payload); // held whole — replayable
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
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A)); // +15550100001

    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-near', toPhone: '+15550100002' }), // adjacent, unbound
    );
    await h.queue.drain();

    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
    expect(h.service.read.listUnrouted()).toHaveLength(1);
  });

  it('two deals, same dealer: each message threads ONLY to the deal whose identity was addressed', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    h.store.putDeal(makeDeal('deal-b', IDENTITY_B));

    // The SAME dealer phone contacts both of our identities.
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'to-a', toPhone: IDENTITY_A.phone_number!, fromPhone: DEALER_PHONE, body: 'For deal A: the price is $20,000.', at: T1 }),
    );
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'to-b', toPhone: IDENTITY_B.phone_number!, fromPhone: DEALER_PHONE, body: 'For deal B: the price is $21,000.', at: T2 }),
    );
    await h.queue.drain();

    const dealA = h.service.read.getDeal('deal-a')!;
    const dealB = h.service.read.getDeal('deal-b')!;
    expect(dealA.dealer_threads).toHaveLength(1);
    expect(dealB.dealer_threads).toHaveLength(1);

    // Same dealer, two isolated threads — one per deal, no cross-pollination.
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
        {
          dealer_id: 'dealer:sms:' + DEALER_PHONE,
          dealer_name: DEALER_PHONE,
          contact: { phone: DEALER_PHONE },
          messages: [{ channel: 'sms', direction: 'in', body: 'old world', timestamp: T0 }],
        },
      ],
    };
    h.store.putDeal(burned);

    // Identity X is recycled onto deal B (authoritative re-bind).
    h.store.putDeal(makeDeal('deal-b'));
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
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A)); // bound as +15550100001

    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-nocc', toPhone: '5550100001' }), // no +1 — conservative non-match
    );
    await h.queue.drain();

    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
    expect(h.service.read.listUnrouted()).toHaveLength(1);
  });

  it('the same dealer texting and emailing one deal threads by contact, not provider identity logic', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    await h.service.intake.ingest('telephony', smsPayload({ ref: 's-1', fromPhone: DEALER_PHONE }));
    await h.service.intake.ingest('email', emailPayload({ ref: 'e-1', fromEmail: DEALER_EMAIL }));
    await h.queue.drain();

    const deal = h.service.read.getDeal('deal-a')!;
    // Distinct contact points → distinct (deterministic) threads; no guessing
    // that a phone and an email are the same dealer.
    expect(deal.dealer_threads).toHaveLength(2);
    const ids = deal.dealer_threads.map((t) => t.dealer_id).sort();
    expect(ids).toStrictEqual(['dealer:email:' + DEALER_EMAIL, 'dealer:sms:' + DEALER_PHONE]);
  });
});
