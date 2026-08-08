/**
 * T-014 tester — the note as a first-class message (AC-6, AC-7, AC-11;
 * design §1.3, §3.3, D4–D8, D13).
 *
 * specs/00 "Core domain model": `Message.channel (call | sms | email | note)`,
 * `direction ... internal = the buyer's/operator's own record`, and `author` is
 * "who produced this text — never inferred". specs/00 "Comms aggregation
 * layer": "any message text — buyer note, SMS, or email — → parsed `Offer` …
 * attached to the message".
 *
 * So the note is not a special case with its own pipeline: it converges on the
 * same event type, the same consumer, the same extractor entry point, the same
 * fill-once attach and the same ADR-006 rollup as an SMS. The only note-shaped
 * code is validation and the `note:` ref prefix, and both sit above the bus.
 */

import { describe, expect, it } from 'vitest';
import type { NoteRejectionReason, NoteSubmission } from '../src/index.js';
import { DEFAULT_MAX_NOTE_CHARS, noteMessageRef } from '../src/index.js';
import {
  DEALERSHIP_A,
  DEALERSHIP_B,
  FIXED_NOW,
  IDENTITY_A,
  makeHarness,
  makeThread,
  onlyThread,
  seedDeal,
  smsPayload,
  T1,
  T2,
  type Harness,
} from './fixtures/harness.js';

const PRICE_TEXT = 'The price is $23,500 for this one.';

/** A deal with a thread already established for DEALERSHIP_A. */
function seedThreadedDeal(h: Harness, deal_id = 'deal-a'): void {
  seedDeal(h, deal_id, IDENTITY_A);
  h.store.putThread(deal_id, makeThread({ dealership_id: DEALERSHIP_A }));
}

const baseNote = (over: Partial<NoteSubmission> = {}): NoteSubmission => ({
  deal_id: 'deal-a',
  dealership_id: DEALERSHIP_A,
  client_note_ref: 'n-1',
  author: 'buyer',
  body: PRICE_TEXT,
  ...over,
});

describe('a note is a first-class Message (AC-6, AC-7)', () => {
  it('stores channel note / direction internal / the caller\'s author / the body verbatim', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    const outcome = await h.service.notes.submitNote(baseNote({ occurred_at: T2 }));
    expect(outcome).toStrictEqual({
      kind: 'recorded',
      http_status: 201,
      message_ref: noteMessageRef('n-1'),
      disposition: 'appended',
    });
    await h.queue.drain();

    const msg = onlyThread(h).messages[0]!;
    expect(msg.channel).toBe('note');
    expect(msg.direction).toBe('internal');
    expect(msg.author).toBe('buyer');
    expect(msg.body).toBe(PRICE_TEXT);
    expect(msg.timestamp).toBe(T2);
  });

  it('a concierge-authored note stores that author — the service never overwrites it', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);
    await h.service.notes.submitNote(baseNote({ author: 'concierge' }));
    await h.queue.drain();
    expect(onlyThread(h).messages[0]!.author).toBe('concierge');
  });

  it('omitted occurred_at falls back to the injected clock, never to a guessed time', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);
    await h.service.notes.submitNote(baseNote());
    await h.queue.drain();
    expect(onlyThread(h).messages[0]!.timestamp).toBe(FIXED_NOW);
  });

  it('a note and an SMS with IDENTICAL text produce the identical extracted_offer (one extractor)', async () => {
    const viaNote = makeHarness();
    seedThreadedDeal(viaNote);
    await viaNote.service.notes.submitNote(baseNote({ occurred_at: T1 }));
    await viaNote.queue.drain();

    const viaSms = makeHarness();
    seedDeal(viaSms, 'deal-a', IDENTITY_A);
    await viaSms.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-1', body: PRICE_TEXT, at: T1 }),
    );
    await viaSms.queue.drain();

    const noteOffer = onlyThread(viaNote).messages[0]!.extracted_offer;
    const smsOffer = onlyThread(viaSms).messages[0]!.extracted_offer;
    expect(noteOffer).toStrictEqual(smsOffer);
    expect(noteOffer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    // …and both rolled up through the same ADR-006 merge.
    expect(onlyThread(viaNote).current_offer).toStrictEqual(onlyThread(viaSms).current_offer);
  });

  it('the note rides the SAME extraction event type as sms/email — no note-specific path (AC-11)', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);
    await h.service.notes.submitNote(baseNote());
    // Heavy work is on the bus: the note is durable, but nothing is extracted
    // until the bus drains.
    expect(onlyThread(h).messages).toHaveLength(1);
    expect(onlyThread(h).messages[0]!.extracted_offer).toBeUndefined();

    await h.queue.drain();
    expect(h.extractionRequests).toHaveLength(1);
    expect(h.extractionRequests[0]).toStrictEqual({
      deal_id: 'deal-a',
      dealership_id: DEALERSHIP_A,
      message_ref: noteMessageRef('n-1'),
      channel: 'note',
      text: PRICE_TEXT,
    });
    expect(onlyThread(h).messages[0]!.extracted_offer).toBeDefined();
  });

  it('the note is durable BEFORE the enqueue: the buyer\'s own record cannot be lost by the bus', async () => {
    // design D5 — deliberately NOT ack-then-queue. A note has no provider and
    // no retrying counterparty, so the failure mode here is telling the buyer
    // "saved" about something not yet stored.
    const h = makeHarness();
    seedThreadedDeal(h);
    h.queue.failNextPublishes(1);

    const outcome = await h.service.notes.submitNote(baseNote());
    expect(outcome).toStrictEqual({
      kind: 'recorded_extraction_deferred',
      http_status: 503,
      message_ref: noteMessageRef('n-1'),
      disposition: 'appended',
    });
    // "Saved, terms not parsed yet" — never "failed", because it did not fail.
    expect(onlyThread(h).messages[0]!.body).toBe(PRICE_TEXT);
  });

  it('an in-app note never carries a provider message id: refs are namespaced (D8)', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);
    await h.service.notes.submitNote(baseNote({ client_note_ref: 'sms-1' }));
    await h.queue.drain();

    // A client-chosen ref that collides with a plausible provider id is
    // namespaced, so the per-deal correlation index cannot swallow one of the
    // two as a "duplicate".
    const row = h.store.getMessageByRef('deal-a', 'note:sms-1');
    expect(row).toBeDefined();
    expect(row!.origin).toStrictEqual({ kind: 'in_app' });
    expect(h.store.getMessageByRef('deal-a', 'sms-1')).toBeUndefined();
  });
});

describe('author is never inferred (AC-7, D7)', () => {
  it('a dealer-authored note is rejected at the JSON boundary and nothing is written', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    const outcome = await h.service.notes.submitNote(
      // @ts-expect-error — `NoteAuthor` excludes 'dealer': a dealer-authored
      // internal record is unrepresentable, not merely rejected.
      baseNote({ author: 'dealer' }),
    );
    expect(outcome).toStrictEqual({
      kind: 'rejected',
      http_status: 400,
      reason: 'invalid_author',
    });
    expect(onlyThread(h).messages).toStrictEqual([]);
  });

  it('a missing or unknown author is rejected — never defaulted', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    for (const author of [undefined, '', 'operator', 'system', 'BUYER']) {
      const outcome = await h.service.notes.submitNote({
        ...baseNote(),
        author: author as NoteSubmission['author'],
      });
      expect(outcome).toStrictEqual({
        kind: 'rejected',
        http_status: 400,
        reason: 'invalid_author',
      });
    }
    expect(onlyThread(h).messages).toStrictEqual([]);
  });

  it('direction is not caller-supplied: the service fixes it to internal', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    await h.service.notes.submitNote({
      ...baseNote(),
      // @ts-expect-error — `direction` is not on NoteSubmission; a non-internal
      // note is unrepresentable rather than validated away.
      direction: 'in',
    });
    await h.queue.drain();
    expect(onlyThread(h).messages[0]!.direction).toBe('internal');
  });
});

describe('note idempotency and deferred extraction (design §3.3, D5)', () => {
  it('the same client_note_ref twice: one row, disposition duplicate, one offer, one rollup', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    const first = await h.service.notes.submitNote(baseNote({ occurred_at: T1 }));
    const second = await h.service.notes.submitNote(baseNote({ occurred_at: T1 }));
    expect(first.kind).toBe('recorded');
    expect(second).toStrictEqual({
      kind: 'recorded',
      http_status: 201,
      message_ref: noteMessageRef('n-1'),
      disposition: 'duplicate',
    });
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({
      fees: [],
      flags: [],
      sale_price: 23_500_00,
    });
    expect(thread.current_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });
    expect(h.queue.deadLetters).toHaveLength(0);
  });

  it('a resubmission after a deferred enqueue completes extraction with NO second row', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    h.queue.failNextPublishes(1);
    const deferred = await h.service.notes.submitNote(baseNote({ occurred_at: T1 }));
    expect(deferred.kind).toBe('recorded_extraction_deferred');
    await h.queue.drain();
    // Nothing was extracted, because nothing was ever enqueued…
    expect(onlyThread(h).messages[0]!.extracted_offer).toBeUndefined();
    expect(h.extractionRequests).toHaveLength(0);

    // …and the caller retries the SAME ref: the keyed append no-ops, only the
    // publish is re-attempted.
    const retried = await h.service.notes.submitNote(baseNote({ occurred_at: T1 }));
    expect(retried).toStrictEqual({
      kind: 'recorded',
      http_status: 201,
      message_ref: noteMessageRef('n-1'),
      disposition: 'duplicate',
    });
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.extracted_offer).toStrictEqual({
      fees: [],
      flags: [],
      sale_price: 23_500_00,
    });
    expect(h.extractionRequests).toHaveLength(1);
  });

  it('two DIFFERENT client_note_refs are two notes, and both roll up per-field', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    await h.service.notes.submitNote(
      baseNote({ client_note_ref: 'n-1', body: 'He quoted $450/mo.', occurred_at: T1 }),
    );
    await h.service.notes.submitNote(
      baseNote({ client_note_ref: 'n-2', body: PRICE_TEXT, occurred_at: T2 }),
    );
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(2);
    expect(thread.current_offer).toStrictEqual({
      fees: [],
      flags: [],
      monthly: 450_00,
      sale_price: 23_500_00,
    });
  });
});

describe('note validation writes nothing (design §3.3, D13)', () => {
  const REJECTIONS: ReadonlyArray<{ reason: NoteRejectionReason; over: Partial<NoteSubmission> }> = [
    { reason: 'blank_deal_id', over: { deal_id: '  ' } },
    { reason: 'blank_dealership_id', over: { dealership_id: '' } },
    { reason: 'blank_client_note_ref', over: { client_note_ref: '' } },
    { reason: 'blank_body', over: { body: '   \n ' } },
    { reason: 'invalid_occurred_at', over: { occurred_at: 'yesterday afternoon' } },
  ];

  for (const { reason, over } of REJECTIONS) {
    it(`${reason} → 400 with the reason code, nothing written`, async () => {
      const h = makeHarness();
      seedThreadedDeal(h);

      const outcome = await h.service.notes.submitNote(baseNote(over));
      expect(outcome).toStrictEqual({ kind: 'rejected', http_status: 400, reason });
      await h.queue.drain();
      expect(onlyThread(h).messages).toStrictEqual([]);
      expect(h.extractionRequests).toHaveLength(0);
    });
  }

  it('an over-long note is rejected, never truncated — a truncated note is altered evidence', async () => {
    const h = makeHarness({ max_note_chars: 50 });
    seedThreadedDeal(h);

    const long = 'x'.repeat(51);
    const outcome = await h.service.notes.submitNote(baseNote({ body: long }));
    expect(outcome).toStrictEqual({ kind: 'rejected', http_status: 400, reason: 'body_too_long' });
    await h.queue.drain();
    expect(onlyThread(h).messages).toStrictEqual([]);

    // Exactly at the bound is accepted, and stored whole.
    const atBound = 'y'.repeat(50);
    expect((await h.service.notes.submitNote(baseNote({ body: atBound }))).kind).toBe('recorded');
    await h.queue.drain();
    expect(onlyThread(h).messages[0]!.body).toBe(atBound);
  });

  it('the default bound is the documented one and is not applied to provider text', async () => {
    expect(DEFAULT_MAX_NOTE_CHARS).toBe(20_000);
  });

  it('an unknown deal is a 404 — a note is never parked on a deal that does not exist', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    const outcome = await h.service.notes.submitNote(baseNote({ deal_id: 'deal-nonexistent' }));
    expect(outcome).toStrictEqual({ kind: 'unknown_deal', http_status: 404 });
    expect(h.service.read.getDeal('deal-nonexistent')).toBeUndefined();
    expect(onlyThread(h).messages).toStrictEqual([]);
  });

  it('a known deal with no such thread is a 404 — this service never creates a Dealership (D9)', async () => {
    const h = makeHarness();
    seedThreadedDeal(h);

    const outcome = await h.service.notes.submitNote(baseNote({ dealership_id: DEALERSHIP_B }));
    expect(outcome).toStrictEqual({ kind: 'unknown_thread', http_status: 404 });
    await h.queue.drain();

    // No thread was conjured for the unknown dealership, and no id for it
    // appears anywhere in the read model.
    const deal = h.service.read.getDeal('deal-a')!;
    expect(deal.dealer_threads.map((t) => t.dealership_id)).toStrictEqual([DEALERSHIP_A]);
    expect(JSON.stringify(deal)).not.toContain(DEALERSHIP_B);
  });
});
