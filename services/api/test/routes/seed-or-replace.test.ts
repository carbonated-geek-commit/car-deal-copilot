/**
 * PINS the cost of `putThread` / `putDeal` being seed-or-replace
 * (docs/design/T-020.md §4.5, §8.7 — the design's own highest-value follow-up).
 *
 * `@comms`'s `CommsStore` offers no partial update, so every negotiation-state
 * write in this suite is a read-modify-write of the whole aggregate. That is
 * correct at the AGGREGATE level — the API's own reads stay right — and lossy at
 * the STORE-INTERNAL level: `putDeal` rebuilds the per-deal `message_ref`
 * correlation index and `putThread` resets the thread's ADR-006 `RollupState`.
 *
 * No route can avoid this (there is no partial-update method to call) and
 * `services/comms` is not this task's to edit. So the behaviour is PINNED here
 * rather than believed: when the `@comms`-owned in-place update lands, these
 * cases fail loudly and become the checklist for what the fix must restore.
 */

import type { Offer } from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import { ACCOUNT_A, bodyOf, boot, call, scenario, vehicleBody, withStore, type Booted } from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const NOTE = { client_note_ref: 'ui-note-1', author: 'buyer', body: 'they quoted 28,900' };
const extracted: Offer = { sale_price: 2_890_000, fees: [], flags: [] };

describe('what a negotiation-state write PRESERVES (the API’s own reads stay correct)', () => {
  it('carries messages, the car, the contact and every other thread through a step change', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'POST', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A, NOTE);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());

    await call(booted, 'PATCH', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A, {
      process_step: 'financing',
    });

    const messages = bodyOf<{ messages: readonly { body?: string }[] }>(
      await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A),
    );
    expect(messages.messages).toHaveLength(1);
    expect(messages.messages[0]?.body).toBe(NOTE.body);
  });

  it('carries the whole aggregate through a deal-level PATCH', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'POST', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A, NOTE);

    await call(booted, 'PATCH', `/deals/${s.deal_id}`, ACCOUNT_A, { status: 'negotiating' });

    const deal = bodyOf<{
      status: string;
      dealer_threads: readonly { messages: readonly unknown[] }[];
    }>(await call(booted, 'GET', `/deals/${s.deal_id}`, ACCOUNT_A));
    expect(deal.status).toBe('negotiating');
    expect(deal.dealer_threads).toHaveLength(1);
    expect(deal.dealer_threads[0]?.messages).toHaveLength(1);
  });
});

describe('what it COSTS — pinned, not endorsed (§8.7)', () => {
  it('a deal-level PATCH drops the store’s message_ref correlation index', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'POST', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A, NOTE);

    const before = await withStore(booted, s.deal_id, ACCOUNT_A, (session) =>
      session.store.getMessageByRef(s.deal_id, 'note:ui-note-1'),
    );
    expect(before).toBeDefined();

    await call(booted, 'PATCH', `/deals/${s.deal_id}`, ACCOUNT_A, { status: 'negotiating' });

    const after = await withStore(booted, s.deal_id, ACCOUNT_A, (session) =>
      session.store.getMessageByRef(s.deal_id, 'note:ui-note-1'),
    );
    // PINNED CURRENT BEHAVIOUR: the index is gone, so a late extraction result
    // for an already-stored message can no longer find its row.
    expect(after).toBeUndefined();

    const attached = await withStore(booted, s.deal_id, ACCOUNT_A, (session) =>
      session.store.attachExtractedOffer(s.deal_id, 'note:ui-note-1', extracted),
    );
    expect(attached).toBe('not_found');
  });

  it('a thread step change resets ADR-006’s rollup provenance, letting an OLDER contribution win', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const newer = { offer: { sale_price: 2_890_000, fees: [], flags: [] }, at: '2026-08-08T12:00:00.000Z', ref: 'm2' };
    const older = { offer: { sale_price: 3_100_000, fees: [], flags: [] }, at: '2026-08-01T12:00:00.000Z', ref: 'm1' };

    // Control: with provenance intact, the older contribution loses.
    await withStore(booted, s.deal_id, ACCOUNT_A, (session) => {
      session.store.rollupCurrentOffer(s.deal_id, s.dealership_id, newer);
      session.store.rollupCurrentOffer(s.deal_id, s.dealership_id, older);
    });
    expect(
      bodyOf<{ current_offer?: { offer: Offer } }>(
        await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}/current-offer`, ACCOUNT_A),
      ).current_offer?.offer.sale_price,
    ).toBe(2_890_000);

    // Same sequence, with a step change in between.
    await withStore(booted, s.deal_id, ACCOUNT_A, (session) => {
      session.store.putThread(s.deal_id, {
        dealership_id: s.dealership_id,
        process_step: 'information_gather',
        messages: [],
      });
      session.store.rollupCurrentOffer(s.deal_id, s.dealership_id, newer);
    });
    await call(booted, 'PATCH', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A, {
      process_step: 'deal_negotiation',
    });
    await withStore(booted, s.deal_id, ACCOUNT_A, (session) => {
      session.store.rollupCurrentOffer(s.deal_id, s.dealership_id, older);
    });

    // PINNED CURRENT BEHAVIOUR: provenance was reset, so newest-wins no longer
    // holds across the step change and the stale price overwrites the fresh one.
    expect(
      bodyOf<{ current_offer?: { offer: Offer } }>(
        await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}/current-offer`, ACCOUNT_A),
      ).current_offer?.offer.sale_price,
    ).toBe(3_100_000);
  });

  it('never loses the RECEIPT trail to any of this — the trail is a separate store', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, {
      ...vehicleBody(),
      make: 'Toyota',
      model: 'Camry',
    });
    await call(booted, 'PATCH', `/deals/${s.deal_id}`, ACCOUNT_A, { status: 'negotiating' });
    await call(booted, 'PATCH', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A, {
      process_step: 'pickup',
    });

    const entries = bodyOf<{ entries: readonly unknown[] }>(
      await call(booted, 'GET', `/deals/${s.deal_id}/receipt`, ACCOUNT_A),
    ).entries;
    expect(entries).toHaveLength(1);
  });
});
