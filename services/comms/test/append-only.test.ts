/**
 * T-009 tester — append-only message history (specs/00 receipt posture;
 * design D7, §2.2, §8).
 *
 *   - messages accumulate; earlier messages are never mutated or removed;
 *   - enrichments (transcript, extracted_offer) are fill-once — never
 *     overwrite, never delete;
 *   - the read model returns deep snapshots: no caller can reach through and
 *     mutate stored state;
 *   - no stored message ever carries recording_url (specs/01 transcribe-only).
 */

import { describe, expect, it } from 'vitest';
import {
  callPayload,
  emailPayload,
  IDENTITY_A,
  makeDeal,
  makeHarness,
  smsPayload,
  T0,
  T1,
  T2,
} from './fixtures/harness.js';

describe('append-only message history (D7, §8)', () => {
  it('messages accumulate in arrival order; earlier rows stay byte-identical', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: 'first', at: T0 }));
    await h.queue.drain();
    const firstSnapshot = h.service.read.getDeal('deal-a')!.dealer_threads[0]!.messages[0]!;

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-2', body: 'The price is $23,500 for this one.', at: T1 }));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-3', body: 'third', at: T2 }));
    await h.queue.drain();

    const messages = h.service.read.getDeal('deal-a')!.dealer_threads[0]!.messages;
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.body)).toStrictEqual(['first', 'The price is $23,500 for this one.', 'third']);
    // The first message is exactly what it was before the later appends.
    expect(messages[0]).toStrictEqual(firstSnapshot);
  });

  it('the read model returns deep snapshots — mutating a returned aggregate never touches the store', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: 'The price is $23,500 for this one.', at: T1 }));
    await h.queue.drain();

    const stolen = h.service.read.getDeal('deal-a')!;
    const thread = stolen.dealer_threads[0]!;
    // Hostile caller tries to rewrite history through the snapshot.
    thread.messages[0]!.body = 'REWRITTEN';
    thread.messages[0]!.extracted_offer!.sale_price = 1;
    thread.messages.push({ channel: 'sms', direction: 'in', body: 'INJECTED', timestamp: T2 });
    thread.current_offer!.sale_price = 1;
    stolen.dealer_threads.pop();

    const fresh = h.service.read.getDeal('deal-a')!;
    expect(fresh.dealer_threads).toHaveLength(1);
    expect(fresh.dealer_threads[0]!.messages).toHaveLength(1);
    expect(fresh.dealer_threads[0]!.messages[0]!.body).toBe('The price is $23,500 for this one.');
    expect(fresh.dealer_threads[0]!.messages[0]!.extracted_offer!.sale_price).toBe(23_500_00);
    expect(fresh.dealer_threads[0]!.current_offer!.sale_price).toBe(23_500_00);
  });

  it('operator holding areas are snapshots too', async () => {
    const h = makeHarness();
    await h.service.intake.ingest('telephony', { garbage: true });
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-u', toPhone: '+15550109999' }));
    await h.queue.drain();

    const quarantined = h.service.read.listQuarantined();
    const unrouted = h.service.read.listUnrouted();
    (quarantined as unknown[]).pop();
    unrouted[0]!.inbound.provider_message_ref = 'TAMPERED';

    expect(h.service.read.listQuarantined()).toHaveLength(1);
    expect(h.service.read.listUnrouted()[0]!.inbound.provider_message_ref).toBe('sms-u');
  });

  it('transcript is fill-once: a second write reports already_set and the first transcript survives', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    h.transcripts.set('call-audio-1', 'The price is $23,500 for this one.');
    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', callRef: 'call-audio-1', at: T1 }));
    await h.queue.drain();

    // Direct port-level overwrite attempt (D7: never overwrites, never deletes).
    expect(h.store.setTranscript('deal-a', 'call-1', 'REVISED TRANSCRIPT')).toBe('already_set');
    expect(h.store.setTranscript('deal-a', 'no-such-ref', 'x')).toBe('not_found');

    const msg = h.service.read.getDeal('deal-a')!.dealer_threads[0]!.messages[0]!;
    expect(msg.transcript).toBe('The price is $23,500 for this one.');
  });

  it('extracted_offer is fill-once at the port level too', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: 'The price is $23,500 for this one.', at: T1 }));
    await h.queue.drain();

    expect(
      h.store.attachExtractedOffer('deal-a', 'sms-1', { fees: [], flags: [], sale_price: 1 }),
    ).toBe('already_set');
    expect(h.store.attachExtractedOffer('deal-a', 'ghost', { fees: [], flags: [] })).toBe('not_found');

    const msg = h.service.read.getDeal('deal-a')!.dealer_threads[0]!.messages[0]!;
    expect(msg.extracted_offer!.sale_price).toBe(23_500_00);
  });

  it('invariant sweep: no stored message on any channel ever carries recording_url (specs/01)', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    h.transcripts.set('call-audio-1', 'We can do 72 months at 4.9% APR.');

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: '$450/mo', at: T0 }));
    await h.service.intake.ingest('email', emailPayload({ ref: 'em-1', body: 'The price is $23,500 for this one.', at: T1 }));
    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', callRef: 'call-audio-1', at: T2 }));
    await h.queue.drain();

    const deal = h.service.read.getDeal('deal-a')!;
    const all = deal.dealer_threads.flatMap((t) => t.messages);
    expect(all).toHaveLength(3);
    for (const m of all) {
      expect('recording_url' in m).toBe(false);
    }
    // And the call message carries no body either (§4.3).
    const call = all.find((m) => m.channel === 'call')!;
    expect('body' in call).toBe(false);
  });
});
