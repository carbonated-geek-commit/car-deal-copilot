/**
 * T-014 tester — the v0.5 inbound-call flow (AC-2, AC-3; design §2.1, D11, D12).
 *
 * specs/00 "Comms aggregation layer" states the flow outright:
 *   `provider webhook → Comms service → log call metadata (time, direction,
 *    party) on DealerThread → notify owner → owner writes a note → run
 *    offer-extraction on the note.`
 *
 * So a call produces a metadata-only `Message`, exactly one "write your note"
 * prompt, and NOTHING else. In particular it produces no extraction request,
 * because a call record carries no text — and there is no path by which text
 * could appear on one: specs/01 (consent posture, resolved
 * 2026-08-07) and Q14 removed audio and speech-to-text from the product, so
 * the spine has no field for either and this service has no port that could
 * produce one.
 */

import { describe, expect, it } from 'vitest';
import type { CallMeta } from '@core';
import { REMOVED_MESSAGE_FIELDS } from './fixtures/forbidden.js';
import {
  callPayload,
  DEALER_PHONE,
  DEALERSHIP_A,
  IDENTITY_A,
  makeHarness,
  onlyThread,
  seedDeal,
  T1,
  T2,
} from './fixtures/harness.js';

describe('inbound call: log metadata → notify owner, and nothing else (AC-2)', () => {
  it('threads a metadata-only Message with the transport-derived author and no body', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    const outcome = await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T1 }));
    expect(outcome).toStrictEqual({ kind: 'enqueued', http_status: 200, disposition: 'parsed' });
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1);
    const msg = thread.messages[0]!;
    expect(msg.channel).toBe('call');
    expect(msg.direction).toBe('in');
    expect(msg.author).toBe('dealer'); // the dealership called — read off the transport
    expect('body' in msg).toBe(false); // a call record has no text, ever
    expect(msg.timestamp).toBe(T1);
    expect(msg.call_meta).toBeDefined();
    for (const field of REMOVED_MESSAGE_FIELDS) {
      expect(field in msg).toBe(false);
    }
  });

  it('enqueues EXACTLY ONE call_logged alert — the "write your note" prompt (D11)', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T1 }));
    await h.queue.drain();

    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.kind).toBe('call_logged');
    expect(h.alerts[0]!.deal_id).toBe('deal-a');
    // The summary is the operator/owner prompt and must stay PII-free: no
    // number, no name, no party. (design §3: `call_meta.party` is on the
    // never-logged list precisely because it is the one PII-shaped field a
    // v0.5 call record legitimately stores.)
    expect(h.alerts[0]!.summary).not.toContain(DEALER_PHONE);
    expect(h.alerts[0]!.summary.length).toBeGreaterThan(0);
  });

  it('publishes NO extraction request for a call, and the thread gains no current_offer', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T1 }));
    await h.queue.drain();

    expect(h.extractionRequests).toStrictEqual([]);
    const thread = onlyThread(h);
    expect(thread.current_offer).toBeUndefined();
    expect(thread.messages[0]!.extracted_offer).toBeUndefined();
    expect(h.queue.deadLetters).toHaveLength(0);
  });

  it('adapter-supplied call_meta round-trips VERBATIM — the service invents nothing', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    const supplied: CallMeta = {
      started_at: '2026-08-07T10:04:31.000Z',
      duration_seconds: 412,
      party: DEALER_PHONE,
    };
    await h.service.intake.ingest(
      'telephony',
      callPayload({ ref: 'call-1', call_meta: supplied, at: T1 }),
    );
    await h.queue.drain();

    expect(onlyThread(h).messages[0]!.call_meta).toStrictEqual(supplied);
  });

  it('without adapter call_meta: started_at = received_at, party = the calling number, and NO duration (D12, ADR-005)', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest(
      'telephony',
      callPayload({ ref: 'call-1', fromPhone: DEALER_PHONE, at: T2 }),
    );
    await h.queue.drain();

    const meta = onlyThread(h).messages[0]!.call_meta!;
    // Both values are provider-supplied facts already on the envelope —
    // copying them is not inference.
    expect(meta).toStrictEqual({ started_at: T2, party: DEALER_PHONE });
    // ADR-005: a duration nothing supplied is UNEVALUABLE. It stays absent —
    // never 0, which would assert a zero-length call that did not happen.
    expect('duration_seconds' in meta).toBe(false);
    expect(meta.duration_seconds).toBeUndefined();
  });

  it('a call from a withheld number carries no party rather than an empty-string one', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    // The sender is known to the account (so it routes) but the payload's
    // `from` is what the metadata is derived from; here it carries the phone.
    // With neither phone nor email the sender cannot route at all, so the
    // honest place to prove "absent, not blank" is the derived field itself.
    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T1 }));
    await h.queue.drain();

    const meta = onlyThread(h).messages[0]!.call_meta!;
    expect(meta.party).not.toBe('');
  });

  it('a redelivered call webhook logs one message and one alert per delivery key — never two rows', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    const payload = callPayload({ ref: 'call-1', at: T1 });

    await h.service.intake.ingest('telephony', payload);
    await h.service.intake.ingest('telephony', payload);
    await h.queue.drain();

    expect(onlyThread(h).messages).toHaveLength(1);
    expect(h.alerts).toHaveLength(1);
  });
});

describe('call → note → extraction: the whole v0.5 loop (AC-2, AC-6)', () => {
  it('the call is logged, the owner writes a note, and the note is what produces the offer', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    // 1. The call arrives: metadata only, plus the prompt.
    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T1 }));
    await h.queue.drain();
    expect(h.alerts.map((a) => a.kind)).toStrictEqual(['call_logged']);
    expect(onlyThread(h).current_offer).toBeUndefined();

    // 2. The owner types what the dealer said, in their own words.
    const submitted = await h.service.notes.submitNote({
      deal_id: 'deal-a',
      dealership_id: DEALERSHIP_A,
      client_note_ref: 'note-1',
      author: 'buyer',
      body: 'He said the price is $23,500 for this one at 4.9% APR for 72 months.',
      occurred_at: T2,
    });
    expect(submitted).toStrictEqual({
      kind: 'recorded',
      http_status: 201,
      message_ref: 'note:note-1',
      disposition: 'appended',
    });
    await h.queue.drain();

    // 3. The note ran through the same extractor, on the SAME thread the call
    //    landed on, and the terms rolled up.
    const thread = onlyThread(h);
    expect(thread.dealership_id).toBe(DEALERSHIP_A);
    expect(thread.messages.map((m) => m.channel)).toStrictEqual(['call', 'note']);
    const note = thread.messages[1]!;
    expect(note.direction).toBe('internal');
    expect(note.author).toBe('buyer');
    expect(note.extracted_offer).toStrictEqual({
      fees: [],
      flags: [],
      sale_price: 23_500_00,
      apr: 4.9,
      term_months: 72,
    });
    expect(thread.current_offer).toStrictEqual({
      fees: [],
      flags: [],
      sale_price: 23_500_00,
      apr: 4.9,
      term_months: 72,
    });
    // The call record itself is still metadata-only — the note carried the terms.
    expect(thread.messages[0]!.extracted_offer).toBeUndefined();
    expect('body' in thread.messages[0]!).toBe(false);
    expect(h.queue.deadLetters).toHaveLength(0);
  });
});
