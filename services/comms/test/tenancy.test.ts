/**
 * T-014 tester — thread resolution and the dealership tenancy split
 * (AC-8, AC-9; design §1.1, §2.2, D9, D10).
 *
 * specs/00 "Dealership data tenancy" (Q12 AMENDED) splits one real dealership
 * into two records with two different rules:
 *   - `Dealership` is GLOBAL — one shared row per real dealership, referenced
 *     by any account's deals;
 *   - `DealershipContact` is PRIVATE to the account that entered it, embedded
 *     in that account's own `DealerThread`, never global and never shared.
 *
 * Both halves are load-bearing here. This service resolves an inbound sender
 * to a dealership through the account-private half, and it NEVER writes the
 * global half: minting a `Dealership` from an unrecognised phone number would
 * inject account-guessed rows into the shared namespace the split exists to
 * protect. The consequence is D10 — an unmatched sender on a known deal is
 * HELD in the unrouted area rather than guessed onto a new thread.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryCommsStore } from '../src/index.js';
import {
  CONTACT_A,
  DEALER_EMAIL,
  DEALER_PHONE,
  DEALERSHIP_A,
  DEALERSHIP_B,
  FIXED_NOW,
  IDENTITY_A,
  IDENTITY_B,
  makeDeal,
  makeHarness,
  makeThread,
  onlyThread,
  seedDeal,
  smsPayload,
  T1,
  T2,
} from './fixtures/harness.js';

describe('thread resolution (AC-8)', () => {
  it('a bound contact routes to its dealership_id and creates the row at information_gather', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', at: T1 }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.dealership_id).toBe(DEALERSHIP_A);
    expect(thread.process_step).toBe('information_gather');
    // A first-contact row carries no car and no named person: both are the
    // buyer's to supply through the API, never inferred from a message.
    expect(thread.vehicle_instance).toBeUndefined();
    expect(thread.working_with).toBeUndefined();
  });

  it('a thread seeded with working_with routes by that account-private contact', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    // No explicit bindThreadContact: seeding the thread with its
    // `working_with` is what establishes the account-private contact index.
    h.store.putThread('deal-a', makeThread({ working_with: CONTACT_A }));

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', at: T1 }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.dealership_id).toBe(DEALERSHIP_A);
    expect(thread.working_with).toStrictEqual(CONTACT_A);
    expect(thread.messages).toHaveLength(1);
  });

  it('a second message never re-creates the row and never resets process_step or working_with', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    // A relationship already well past first contact.
    h.store.putThread(
      'deal-a',
      makeThread({ process_step: 'deal_negotiation', working_with: CONTACT_A }),
    );

    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-1', at: T1 }));
    await h.service.intake.ingest('telephony', smsPayload({ ref: 'sms-2', at: T2 }));
    await h.queue.drain();

    const thread = onlyThread(h);
    expect(thread.messages).toHaveLength(2);
    // A message ARRIVING cannot advance — or rewind — a negotiation step.
    expect(thread.process_step).toBe('deal_negotiation');
    expect(thread.working_with).toStrictEqual(CONTACT_A);
  });
});

describe('tenancy: Dealership global, DealershipContact account-private (AC-9, D9/D10)', () => {
  it('an unknown sender on a KNOWN deal is held as no_thread_match — no thread, no minted dealership', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);

    const payload = smsPayload({
      ref: 'sms-stranger',
      fromPhone: '+15550209999', // never bound inside this deal
      body: 'The price is $19,000.',
      at: T1,
    });
    await h.service.intake.ingest('telephony', payload);
    await h.queue.drain();

    const unrouted = h.service.read.listUnrouted();
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0]!.reason).toBe('no_thread_match');
    expect(unrouted[0]!.deal_id).toBe('deal-a'); // the deal IS known — say so
    expect(unrouted[0]!.inbound).toStrictEqual(payload); // held whole, replayable

    // Nothing was guessed into existence: no thread, and no dealership id
    // anywhere in the read model derived from the stranger's number.
    const deal = h.service.read.getDeal('deal-a')!;
    expect(deal.dealer_threads).toHaveLength(0);
    expect(JSON.stringify(deal)).not.toContain('+15550209999');
    expect(h.queue.deadLetters).toHaveLength(0); // held, not dead-lettered
  });

  it('once the contact is bound, LATER messages from that sender thread normally', async () => {
    // The forward path recovers on its own: the binding is all that was
    // missing, and nothing about the sender was blacklisted.
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-stranger', fromPhone: '+15550209999', at: T1 }),
    );
    await h.queue.drain();
    expect(h.service.read.listUnrouted()).toHaveLength(1);

    h.store.bindThreadContact('deal-a', DEALERSHIP_B, { phone: '+15550209999' });
    await h.service.intake.ingest(
      'telephony',
      smsPayload({
        ref: 'sms-later',
        fromPhone: '+15550209999',
        body: 'The price is $19,000.',
        at: T2,
      }),
    );
    await h.queue.drain();

    const threads = h.service.read.getDeal('deal-a')!.dealer_threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]!.dealership_id).toBe(DEALERSHIP_B);
    expect(threads[0]!.messages).toHaveLength(1);
    expect(threads[0]!.current_offer!.sale_price).toBe(19_000_00);
  });

  it('D10: the HELD item IS replayable — replaying it verbatim threads it once the buyer names the dealership', async () => {
    // REGRESSION GUARD for the fixed finding. docs/design/T-014.md D10 is the
    // one behavior change this task introduced, and its entire justification is
    // that nothing is lost: "the item is held whole, operator-visible, and
    // replayable once the buyer names the dealership" (§7 deviation 3; §3.2
    // rows 4-5 both say "Held whole, replayable").
    //
    // It was NOT replayable as first built: `inbound-router` called
    // `markProcessed` on BOTH unrouted branches, and `intake.ts` derives the
    // idempotency key deterministically from the payload
    // (`<source>:<provider_message_ref>`), identical before and after the
    // operator's fix. So the honest replay — re-entering the held
    // `InboundComms` through `parseInboundWebhook`, the replay path the design
    // itself names — hit the ledger belt and returned `done` without routing,
    // stranding the dealership's FIRST message forever.
    //
    // Fix: the two unrouted branches no longer mark the ledger. §3.2's own
    // "Retry / idempotency" cell for those rows names the KEYED WRITE, not the
    // ledger — `recordUnrouted` no-ops on `(source, provider_message_ref)`,
    // which is what "a redelivered unroutable message does not duplicate the
    // holding record" (routing.test.ts) actually relies on. Dedupe preserved,
    // replay restored. The quarantine branch still marks and is unaffected: a
    // fixed adapter changes ITS key from `<source>:quarantine:<ref>` to the
    // parsed key, so its replay was never blocked by its own ledger entry.
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    const held = smsPayload({
      ref: 'sms-stranger',
      fromPhone: '+15550209999',
      body: 'The price is $19,000.',
      at: T1,
    });
    await h.service.intake.ingest('telephony', held);
    await h.queue.drain();
    expect(h.service.read.listUnrouted()).toHaveLength(1);

    // The buyer names the dealership, then the held item is replayed verbatim.
    h.store.bindThreadContact('deal-a', DEALERSHIP_B, { phone: '+15550209999' });
    await h.service.intake.ingest('telephony', held);
    await h.queue.drain();

    const threads = h.service.read.getDeal('deal-a')!.dealer_threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]!.dealership_id).toBe(DEALERSHIP_B);
    expect(threads[0]!.messages).toHaveLength(1);
    // …and the holding area is not left carrying a phantom copy of a message
    // that is now properly threaded.
    expect(h.service.read.listUnrouted()).toHaveLength(1);
    expect(h.service.read.listUnrouted()[0]!.inbound.provider_message_ref).toBe('sms-stranger');
  });

  it('replaying a held item that only PARTLY recovers upgrades the holding record instead of no-oping', async () => {
    // The keyed `recordUnrouted` write is now the only dedupe these branches
    // have, so it must not silently swallow a CHANGED verdict. Recovery can
    // arrive in two steps: the buyer binds the identity first, and only later
    // names the dealership. The middle replay resolves the deal but still
    // misses the contact — the operator must see `no_thread_match` WITH the
    // deal_id on it, not the stale `no_identity_match` it was first held under.
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a')); // no identity_ref yet — nothing is bound

    const held = smsPayload({
      ref: 'sms-stranger',
      fromPhone: '+15550209999',
      body: 'The price is $19,000.',
      at: T1,
    });
    await h.service.intake.ingest('telephony', held);
    await h.queue.drain();

    let unrouted = h.service.read.listUnrouted();
    expect(unrouted).toHaveLength(1);
    expect(unrouted[0]!.reason).toBe('no_identity_match');
    expect(unrouted[0]!.deal_id).toBeUndefined(); // no deal owns it yet

    // Step 1 of the recovery: the identity is bound, the dealership is not.
    h.store.bindIdentity('deal-a', IDENTITY_A);
    await h.service.intake.ingest('telephony', held);
    await h.queue.drain();

    unrouted = h.service.read.listUnrouted();
    expect(unrouted).toHaveLength(1); // still ONE row — dedupe intact
    expect(unrouted[0]!.reason).toBe('no_thread_match'); // …upgraded, not stale
    expect(unrouted[0]!.deal_id).toBe('deal-a');
    expect(unrouted[0]!.recorded_at).toBe(FIXED_NOW); // when it was HELD
    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);

    // Step 2: the buyer names the dealership and the same payload finally lands.
    h.store.bindThreadContact('deal-a', DEALERSHIP_B, { phone: '+15550209999' });
    await h.service.intake.ingest('telephony', held);
    await h.queue.drain();

    const thread = h.service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.dealership_id).toBe(DEALERSHIP_B);
    expect(thread.messages).toHaveLength(1);
  });

  it('listUnrouted is scopable by deal: an account-scoped view never spans deals', async () => {
    // D10 put deal-ATTRIBUTABLE content into the holding area — a
    // `no_thread_match` record carries the whole InboundComms (body, sender
    // phone) plus its deal_id. Every other read on this port is parameterized
    // by deal_id; this one must be too, or it is the single surface on which
    // account isolation is inexpressible (AC-9) — the exact inverse of the
    // pattern D9 fixed for the account-private contact index.
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    h.store.putDeal(makeDeal('deal-b', IDENTITY_B));

    // Held against deal A (known deal, unknown sender).
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-a', fromPhone: '+15550209999', body: 'deal A body', at: T1 }),
    );
    // Held against deal B.
    await h.service.intake.ingest(
      'telephony',
      smsPayload({
        ref: 'sms-b',
        toPhone: IDENTITY_B.phone_number!,
        fromPhone: '+15550208888',
        body: 'deal B body',
        at: T2,
      }),
    );
    // Attributable to NO account: nothing owns the identity that was contacted.
    await h.service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-orphan', toPhone: '+15550100999', body: 'orphan body', at: T2 }),
    );
    await h.queue.drain();

    // The operator surface sees everything.
    expect(h.service.read.listUnrouted()).toHaveLength(3);

    const scopedA = h.service.read.listUnrouted('deal-a');
    expect(scopedA).toHaveLength(1);
    expect(scopedA[0]!.inbound.provider_message_ref).toBe('sms-a');
    // Deal B's body and deal B's sender are not reachable through deal A's view.
    expect(JSON.stringify(scopedA)).not.toContain('deal B body');
    expect(JSON.stringify(scopedA)).not.toContain('+15550208888');

    const scopedB = h.service.read.listUnrouted('deal-b');
    expect(scopedB).toHaveLength(1);
    expect(scopedB[0]!.inbound.provider_message_ref).toBe('sms-b');

    // An unattributable item belongs to no account, so it appears in NEITHER
    // scoped view — only in the operator one.
    expect(JSON.stringify([...scopedA, ...scopedB])).not.toContain('orphan body');
    expect(h.service.read.listUnrouted('deal-nonexistent')).toHaveLength(0);
  });

  it('a contact bound in deal A never resolves inside deal B (the index is deal-scoped)', async () => {
    const h = makeHarness();
    // Deal A knows this dealership contact. Deal B — a different deal, and in
    // the B2B shape a different account — does not.
    seedDeal(h, 'deal-a', IDENTITY_A);
    h.store.putDeal(makeDeal('deal-b', IDENTITY_B));

    expect(h.store.resolveDealershipByContact('deal-a', { phone: DEALER_PHONE })).toBe(DEALERSHIP_A);
    expect(h.store.resolveDealershipByContact('deal-b', { phone: DEALER_PHONE })).toBeUndefined();
    expect(h.store.resolveDealershipByContact('deal-b', { email: DEALER_EMAIL })).toBeUndefined();

    // …and driving it through the real pipeline gives the same answer: the
    // message addressed to deal B's identity is HELD, not routed by deal A's
    // private knowledge.
    await h.service.intake.ingest(
      'telephony',
      smsPayload({
        ref: 'sms-b',
        toPhone: IDENTITY_B.phone_number!,
        fromPhone: DEALER_PHONE,
        at: T1,
      }),
    );
    await h.queue.drain();

    expect(h.service.read.getDeal('deal-b')!.dealer_threads).toHaveLength(0);
    expect(h.service.read.listUnrouted().map((u) => u.reason)).toStrictEqual(['no_thread_match']);
    expect(h.service.read.getDeal('deal-a')!.dealer_threads).toHaveLength(0);
  });

  it('an account-private contact seeded on deal A is not visible anywhere in deal B', async () => {
    const h = makeHarness();
    h.store.putDeal(makeDeal('deal-a', IDENTITY_A));
    h.store.putThread('deal-a', makeThread({ working_with: CONTACT_A }));
    h.store.putDeal(makeDeal('deal-b', IDENTITY_B));
    h.store.putThread('deal-b', makeThread({ dealership_id: DEALERSHIP_A }));

    const dealB = h.service.read.getDeal('deal-b')!;
    // Deal B references the SAME global dealership id — that reference is
    // shareable by design — while the person deal A entered is not.
    expect(dealB.dealer_threads[0]!.dealership_id).toBe(DEALERSHIP_A);
    expect(dealB.dealer_threads[0]!.working_with).toBeUndefined();
    expect(JSON.stringify(dealB)).not.toContain(CONTACT_A.name);
    expect(JSON.stringify(dealB)).not.toContain(DEALER_PHONE);
  });

  it('a note cannot cross deals: deal A + deal B\'s dealership is a 404, not a silent write', async () => {
    const h = makeHarness();
    seedDeal(h, 'deal-a', IDENTITY_A);
    h.store.putThread('deal-a', makeThread({ dealership_id: DEALERSHIP_A }));
    h.store.putDeal(makeDeal('deal-b', IDENTITY_B));
    h.store.putThread('deal-b', makeThread({ dealership_id: DEALERSHIP_B }));

    const outcome = await h.service.notes.submitNote({
      deal_id: 'deal-a',
      dealership_id: DEALERSHIP_B, // exists — but on the OTHER deal
      client_note_ref: 'n-cross',
      author: 'buyer',
      body: 'The price is $23,500 for this one.',
    });
    expect(outcome).toStrictEqual({ kind: 'unknown_thread', http_status: 404 });
    await h.queue.drain();

    expect(h.service.read.getThread('deal-a', DEALERSHIP_A)!.messages).toStrictEqual([]);
    expect(h.service.read.getThread('deal-b', DEALERSHIP_B)!.messages).toStrictEqual([]);
    expect(h.service.read.getThread('deal-a', DEALERSHIP_B)).toBeUndefined();
  });

  it('the store port exposes no way to create or edit a Dealership, and none to move a negotiation', () => {
    // The tenancy rule is enforced by ABSENCE: if the method does not exist,
    // no consumer can call it and no future edit can call it by accident.
    const surface = Object.getOwnPropertyNames(InMemoryCommsStore.prototype);
    const FORBIDDEN = [
      /dealership(?!ByContact|_id)/i, // no putDealership / createDealership / upsertDealership
      /process_?step/i,
      /vehicle/i,
      /target_?vehicle/i,
      /walk_?away/i,
      /working_?with/i,
    ];
    const offenders = surface.filter(
      (name) =>
        FORBIDDEN.some((re) => re.test(name)) &&
        !['bindThreadContact', 'resolveDealershipByContact'].includes(name),
    );
    expect(offenders).toStrictEqual([]);
  });

  it('the identity table and the contact table are different tables with different scopes', () => {
    // identity → deal is the AUTHORITATIVE inbound mapping and is global to
    // the service; contact → dealership is account-private and deal-scoped.
    // Conflating them is exactly how a message reaches the wrong account.
    const store = new InMemoryCommsStore();
    store.putDeal(makeDeal('deal-a', IDENTITY_A));
    store.bindThreadContact('deal-a', DEALERSHIP_A, { phone: DEALER_PHONE });

    // The dealership's own number is NOT one of our identities…
    expect(store.resolveDealByIdentity({ phone_number: DEALER_PHONE })).toBeUndefined();
    // …and our identity is not a dealership contact.
    expect(
      store.resolveDealershipByContact('deal-a', { phone: IDENTITY_A.phone_number! }),
    ).toBeUndefined();
    // Each resolves only through its own table.
    expect(store.resolveDealByIdentity({ phone_number: IDENTITY_A.phone_number! })).toBe('deal-a');
    expect(store.resolveDealershipByContact('deal-a', { phone: DEALER_PHONE })).toBe(DEALERSHIP_A);
  });
});
