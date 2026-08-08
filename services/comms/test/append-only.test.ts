/**
 * T-014 tester — append-only message history (specs/00 receipt posture;
 * design §1.1 "append-only posture", §4).
 *
 *   - messages accumulate; earlier messages are never mutated or removed;
 *   - the ONE enrichment left is `extracted_offer`, and it is fill-once —
 *     never overwrites, never deletes (the speech-capture fill-once case that
 *     used to live here was deleted with its port, D1);
 *   - the read model returns deep snapshots: no caller can reach through and
 *     mutate stored state;
 *   - the store port exposes NO update and NO delete path for message content;
 *   - no stored message on any channel carries a field from the removed
 *     speech-capture era.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryCommsStore } from '../src/index.js';
import { REMOVED_MESSAGE_FIELDS, REMOVED_STORE_METHOD } from './fixtures/forbidden.js';
import {
  callPayload,
  DEALERSHIP_A,
  emailPayload,
  IDENTITY_A,
  makeHarness,
  onlyThread,
  seedDeal,
  smsPayload,
  T0,
  T1,
  T2,
} from './fixtures/harness.js';

describe('append-only message history', () => {
  it('messages accumulate in arrival order; earlier rows stay byte-identical', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: 'first', at: T0 }));
    await h.queue.drain();
    const firstSnapshot = onlyThread(h).messages[0]!;

    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-2', body: 'The price is $23,500 for this one.', at: T1 }),
    );
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-3', body: 'third', at: T2 }));
    await h.queue.drain();

    const messages = onlyThread(h).messages;
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.body)).toStrictEqual([
      'first',
      'The price is $23,500 for this one.',
      'third',
    ]);
    // The first message is exactly what it was before the later appends.
    expect(messages[0]).toStrictEqual(firstSnapshot);
  });

  it('the read model returns deep snapshots — mutating a returned aggregate never touches the store', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-1', body: 'The price is $23,500 for this one.', at: T1 }),
    );
    await h.queue.drain();

    const stolen = h.service.read.getDeal('deal-a')!;
    const thread = stolen.dealer_threads[0]!;
    // Hostile caller tries to rewrite history through the snapshot.
    thread.messages[0]!.body = 'REWRITTEN';
    thread.messages[0]!.extracted_offer!.sale_price = 1;
    thread.messages.push({
      channel: 'sms',
      direction: 'in',
      author: 'dealer',
      body: 'INJECTED',
      timestamp: T2,
    });
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

  it('extracted_offer is fill-once at the port level: a second write reports already_set', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-1', body: 'The price is $23,500 for this one.', at: T1 }),
    );
    await h.queue.drain();

    expect(h.store.attachExtractedOffer('deal-a', 'sms-1', { fees: [], flags: [], sale_price: 1 })).toBe(
      'already_set',
    );
    expect(h.store.attachExtractedOffer('deal-a', 'ghost', { fees: [], flags: [] })).toBe('not_found');

    expect(onlyThread(h).messages[0]!.extracted_offer!.sale_price).toBe(23_500_00);
  });

  it('the store port exposes no update and no delete path for stored message content', () => {
    // Receipt/append-only posture, structurally: the only writes are append
    // (`appendMessage`, keyed), fill-once enrichment (`attachExtractedOffer`),
    // the ADR-006 rollup, the two holding areas, and the ledger. If a mutation
    // verb ever appears on this surface, this case is the tripwire.
    const surface = Object.getOwnPropertyNames(InMemoryCommsStore.prototype).filter(
      (n) => n !== 'constructor' && !n.startsWith('#'),
    );
    const MUTATION_VERBS = /^(update|delete|remove|edit|patch|overwrite|purge|truncate|clear|drop)/i;
    expect(surface.filter((n) => MUTATION_VERBS.test(n))).toStrictEqual([]);
    // The deleted fill-once method from the speech-capture era is gone too (D1).
    expect(surface).not.toContain(REMOVED_STORE_METHOD);
    expect(REMOVED_STORE_METHOD in new InMemoryCommsStore()).toBe(false);
  });

  it('invariant sweep: no stored message on any channel carries a field from the removed capture era', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', body: '$450/mo', at: T0 }));
    await h.service.intake.ingest(
      'email',
      emailPayload({ ref: 'em-1', body: 'The price is $23,500 for this one.', at: T1 }),
    );
    await h.service.intake.ingest('telephony', callPayload({ ref: 'call-1', at: T2 }));
    await h.queue.drain(); // the thread now exists — a note may be written on it

    const submitted = await h.service.notes.submitNote({
      deal_id: 'deal-a',
      dealership_id: DEALERSHIP_A,
      client_note_ref: 'n-1',
      author: 'buyer',
      body: 'He said twenty nine grand.',
    });
    expect(submitted.kind).toBe('recorded');
    await h.queue.drain();

    const all = h.service.read.getDeal('deal-a')!.dealer_threads.flatMap((t) => t.messages);
    expect(all.map((m) => m.channel).sort()).toStrictEqual(['call', 'email', 'note', 'sms']);
    for (const m of all) {
      for (const field of REMOVED_MESSAGE_FIELDS) {
        expect(field in m).toBe(false);
      }
    }
    // And a call record carries no body either — there is no text on a call.
    const call = all.find((m) => m.channel === 'call')!;
    expect('body' in call).toBe(false);
    expect(call.call_meta).toBeDefined();
  });
});
