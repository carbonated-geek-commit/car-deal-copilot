/**
 * T-009 tester — idempotency / dedupe under at-least-once redelivery
 * (design §5.4: ledger belt + keyed-write braces; T-001 §5.3).
 *
 *   - provider redelivery of the same webhook (before AND after processing)
 *     never double-threads, never double-extracts, never double-rolls-up;
 *   - a redelivered bus event with the same idempotency_key is a no-op;
 *   - an adversarial duplicate with a DIFFERENT key but the same message
 *     ref is caught by the keyed writes (fill-once — braces, not just belt).
 */

import { describe, expect, it } from 'vitest';
import type { DealerThread, SpineEvent } from '@core';
import { IDENTITY_A, makeDeal, makeHarness, smsPayload, T1 } from './fixtures/harness.js';

const PRICE_TEXT = 'The price is $23,500 for this one.';

const onlyThread = (h: ReturnType<typeof makeHarness>): DealerThread =>
  h.service.read.getDeal('deal-a')!.dealer_threads[0]!;

describe('redelivery dedupe (§5.4)', () => {
  it('same webhook ingested twice before draining: one message, one extracted_offer, one rollup', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    const payload = smsPayload({ ref: 'sms-1', body: PRICE_TEXT, at: T1 });

    expect((await h.service.intake.ingest('telephony', payload)).http_status).toBe(200);
    expect((await h.service.intake.ingest('telephony', payload)).http_status).toBe(200);
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    expect(thread.current_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    expect(h.queue.deadLetters).toHaveLength(0);
  });

  it('redelivery AFTER full processing (slow provider retry): still exactly one of everything', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    const payload = smsPayload({ ref: 'sms-1', body: PRICE_TEXT, at: T1 });

    await h.service.intake.ingest('telephony', payload);
    await h.queue.drain();
    const snapshotBefore = onlyThread(h);

    await h.service.intake.ingest('telephony', payload); // provider retries long after
    await h.queue.drain();

    const snapshotAfter = onlyThread(h);
    expect(snapshotAfter).toStrictEqual(snapshotBefore); // byte-identical thread state
    expect(snapshotAfter.messages).toHaveLength(1);
  });

  it('a redelivered downstream event (same idempotency_key) is a no-op', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: PRICE_TEXT, at: T1 }));
    await h.queue.drain();
    const before = onlyThread(h);

    // Redeliver the extraction-completed fact verbatim (same key, same content).
    const redelivered: SpineEvent = {
      event_id: 'evt-redelivery',
      type: 'offer.extraction.completed.v1',
      occurred_at: T1,
      deal_id: 'deal-a',
      idempotency_key: 'deal-a:sms-1:extraction-complete',
      payload: {
        deal_id: 'deal-a',
        dealer_id: before.dealer_id,
        provider_message_ref: 'sms-1',
        offer: { fees: [], flags: [], sale_price: 23_500_00 },
      },
    };
    expect(await h.queue.publish(redelivered)).toStrictEqual({ ok: true });
    await h.queue.drain();

    expect(onlyThread(h)).toStrictEqual(before);
    expect(h.queue.deadLetters).toHaveLength(0);
  });

  it('adversarial duplicate with a DIFFERENT key but same ref: fill-once braces hold — no overwrite, no re-rollup', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: PRICE_TEXT, at: T1 }));
    await h.queue.drain();
    const before = onlyThread(h);

    // Different idempotency_key (so the ledger belt does NOT catch it) and a
    // DIFFERENT offer trying to overwrite the attached one.
    const forged: SpineEvent = {
      event_id: 'evt-forged',
      type: 'offer.extraction.completed.v1',
      occurred_at: T1,
      deal_id: 'deal-a',
      idempotency_key: 'deal-a:sms-1:extraction-complete:forged',
      payload: {
        deal_id: 'deal-a',
        dealer_id: before.dealer_id,
        provider_message_ref: 'sms-1',
        offer: { fees: [], flags: [], sale_price: 1_00 }, // would be a catastrophic overwrite
      },
    };
    expect(await h.queue.publish(forged)).toStrictEqual({ ok: true });
    await h.queue.drain();

    const after = onlyThread(h);
    expect(after.messages[0]!.extracted_offer!.sale_price).toBe(23_500_00); // fill-once: first value kept
    expect(after.current_offer!.sale_price).toBe(23_500_00); // rollup not re-applied
    expect(h.queue.deadLetters).toHaveLength(0); // already_set → done, not an error
  });

  it('thread creation is idempotent: redelivered first-contact never creates a second thread (D6)', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    const payload = smsPayload({ ref: 'sms-1', body: 'hello there', at: T1 });

    await h.service.intake.ingest('telephony', payload);
    await h.queue.drain();
    await h.service.intake.ingest('telephony', payload);
    await h.queue.drain();

    const deal = h.service.read.getDeal('deal-a')!;
    expect(deal.dealer_threads).toHaveLength(1);
    // Deterministic dealer_id derived from the normalized sender contact.
    expect(deal.dealer_threads[0]!.dealer_id).toBe('dealer:sms:+15550200001');
  });
});
