/**
 * `target_vehicle` is WRITE-ONCE (docs/design/T-020.md §5.1, D5, D7, D8;
 * AC-2, AC-4).
 *
 * specs/00 "Cardinality invariants": "`target_vehicle.make`/`model` are
 * write-once — settable while the deal is `draft`, immutable once any offer is
 * attached." Q11 (AMENDED) adds the reason and the consequence: the rejection is
 * a receipt-trail event, so a substitution attempt leaves a mark instead of
 * vanishing.
 *
 * Every rejection case asserts THREE things, never just the status: the
 * status/code, that the stored aggregate is unchanged, and that the trail gained
 * exactly the expected number of entries.
 */

import type { Deal, Offer } from '@core';
import { isTargetVehicleLocked } from '@core';
import type { ReceiptEntry } from '@receipt';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_A,
  ACCOUNT_B,
  NOW,
  bodyOf,
  boot,
  call,
  dealBody,
  errorCodeOf,
  withStore,
  type Booted,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const DEAL = 'deal-7';

interface Trail {
  readonly receipt_bundle_id: string;
  readonly entries: readonly ReceiptEntry[];
}

const trail = async (b: Booted, deal_id = DEAL, account = ACCOUNT_A): Promise<Trail> => {
  const res = await call(b, 'GET', `/deals/${deal_id}/receipt`, account);
  expect(res.statusCode).toBe(200);
  return bodyOf<Trail>(res);
};

const anchorOf = async (b: Booted): Promise<Deal['target_vehicle']> =>
  bodyOf<Deal>(await call(b, 'GET', `/deals/${DEAL}`, ACCOUNT_A)).target_vehicle;

const makeOffer = (over: Partial<Offer> = {}): Offer => ({ fees: [], flags: [], ...over });

/** Attaches an offer the way nothing in this API can (there is no POST /offers). */
async function attachDealOffer(b: Booted): Promise<void> {
  await withStore(b, DEAL, ACCOUNT_A, (session) => {
    const deal = session.store.getDeal(DEAL);
    if (deal === undefined) throw new Error('deal missing');
    session.store.putDeal({ ...deal, offers: [makeOffer({ sale_price: 2_890_000 })] });
  });
}

async function attachThreadOffer(b: Booted, dealership_id: string): Promise<void> {
  await withStore(b, DEAL, ACCOUNT_A, (session) => {
    const thread = session.store.getThread(DEAL, dealership_id);
    if (thread === undefined) throw new Error('thread missing');
    session.store.putThread(DEAL, { ...thread, current_offer: makeOffer({ sale_price: 2_890_000 }) });
  });
}

describe('settable while the deal is draft', () => {
  it('writes the anchor and returns the deal', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());

    const res = await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, {
      make: 'Toyota',
      model: 'RAV4',
      year_range: { from: 2018, to: 2022 },
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf<Deal>(res).target_vehicle).toEqual({
      make: 'Toyota',
      model: 'RAV4',
      year_range: { from: 2018, to: 2022 },
    });
    expect(await anchorOf(booted)).toEqual({ make: 'Toyota', model: 'RAV4', year_range: { from: 2018, to: 2022 } });
  });

  it('writes NOTHING to the receipt trail on a successful write', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, { make: 'Toyota', model: 'RAV4' });
    expect((await trail(booted)).entries).toEqual([]);
  });
});

describe('immutable once any offer is attached (AC-2)', () => {
  it('rejects with 409 once an offer sits on the deal, and stores nothing', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await attachDealOffer(booted);

    const res = await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, {
      make: 'Toyota',
      model: 'Camry',
    });
    expect(res.statusCode).toBe(409);
    expect(errorCodeOf(res)).toBe('conflict');
    // The remedy the spec asks the UI to offer.
    expect(res.body).toContain('open a new deal');

    expect((await anchorOf(booted)).make).toBe('Honda');
    expect((await anchorOf(booted)).model).toBe('Accord');
  });

  it('rejects once a THREAD carries a current_offer (the ADR-006 rollup counts)', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await withStore(booted, DEAL, ACCOUNT_A, (session) => {
      session.store.putThread(DEAL, { dealership_id: 'dl-x', process_step: 'information_gather', messages: [] });
    });
    await attachThreadOffer(booted, 'dl-x');

    const res = await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, {
      make: 'Toyota',
      model: 'Camry',
    });
    expect(res.statusCode).toBe(409);
    expect((await anchorOf(booted)).model).toBe('Accord');
  });

  it('rejects once the deal has left draft, even with no offer anywhere', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await call(booted, 'PATCH', `/deals/${DEAL}`, ACCOUNT_A, { status: 'negotiating' });

    const res = await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, {
      make: 'Toyota',
      model: 'Camry',
    });
    expect(res.statusCode).toBe(409);
    expect((await anchorOf(booted)).make).toBe('Honda');
  });

  it('is 409 conflict and never 422 — the shipped envelope vocabulary (D5)', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await attachDealOffer(booted);
    const res = await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, {
      make: 'Toyota',
      model: 'Camry',
    });
    expect(res.statusCode).not.toBe(422);
    expect(res.statusCode).toBe(409);
  });

  it('agrees with @core.isTargetVehicleLocked over the whole state matrix (one predicate, one place)', async () => {
    const states: readonly { readonly label: string; readonly apply: (b: Booted) => Promise<void> }[] = [
      { label: 'draft, nothing attached', apply: () => Promise.resolve() },
      { label: 'deal offer attached', apply: attachDealOffer },
      {
        label: 'thread current_offer attached',
        apply: async (b) => {
          await withStore(b, DEAL, ACCOUNT_A, (session) => {
            session.store.putThread(DEAL, {
              dealership_id: 'dl-x',
              process_step: 'information_gather',
              messages: [],
            });
          });
          await attachThreadOffer(b, 'dl-x');
        },
      },
      {
        label: 'status left draft',
        apply: async (b) => {
          await call(b, 'PATCH', `/deals/${DEAL}`, ACCOUNT_A, { status: 'active' });
        },
      },
    ];

    for (const state of states) {
      const b = await boot();
      try {
        await call(b, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
        await state.apply(b);

        const stored = bodyOf<Deal>(await call(b, 'GET', `/deals/${DEAL}`, ACCOUNT_A));
        const expected_locked = isTargetVehicleLocked(stored);

        const res = await call(b, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, {
          make: 'Toyota',
          model: 'Camry',
        });
        expect(res.statusCode === 409, state.label).toBe(expected_locked);
      } finally {
        await b.close();
      }
    }
  });
});

describe('every rejection is a receipt-trail event (AC-4, D7, D8)', () => {
  it('appends exactly one mark, authored account-side, on a note/internal entry', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await attachDealOffer(booted);

    expect((await trail(booted)).entries).toEqual([]);
    await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, { make: 'Toyota', model: 'Camry' });

    const after = await trail(booted);
    expect(after.receipt_bundle_id).toBe(`receipt:${DEAL}`);
    expect(after.entries).toHaveLength(1);

    const entry = after.entries[0] as ReceiptEntry & { body: string };
    expect(entry.kind).toBe('note');
    expect(entry.direction).toBe('internal');
    // `dealer` is unrepresentable on a note — a product-generated mark can never
    // acquire dealer provenance (`@receipt` NoteEntryInput.author).
    expect(entry.author).toBe('buyer');
    expect(entry.channel).toBe('note');
    expect(entry.occurred_at).toBe(NOW);
    expect(entry.body.startsWith('[system]')).toBe(true);
    expect(entry.body).toContain('submitted=Toyota/Camry');
    expect(entry.body).toContain('anchor=Honda/Accord');
    expect(entry.body).toContain('write-once');
  });

  it('marks EVERY attempt when the caller supplies no attempt ref — a repeat is itself evidence', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await attachDealOffer(booted);

    await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, { make: 'Toyota', model: 'Camry' });
    await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, { make: 'Toyota', model: 'Camry' });

    expect((await trail(booted)).entries).toHaveLength(2);
  });

  it('collapses a retried attempt when the caller anchors it with client_attempt_ref', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await attachDealOffer(booted);

    const attempt = { make: 'Toyota', model: 'Camry', client_attempt_ref: 'ui-7f2c' };
    await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, attempt);
    await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, attempt);

    const entries = (await trail(booted)).entries;
    expect(entries).toHaveLength(1);
    expect((entries[0] as ReceiptEntry & { dedupe_key?: string }).dedupe_key).toBe(
      `reject:target_vehicle_write_once:${DEAL}:-:ui-7f2c`,
    );
  });

  it('keeps the trail account-private — a stranger cannot read the mark', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());
    await attachDealOffer(booted);
    await call(booted, 'PUT', `/deals/${DEAL}/target-vehicle`, ACCOUNT_A, { make: 'Toyota', model: 'Camry' });

    const stranger = await call(booted, 'GET', `/deals/${DEAL}/receipt`, ACCOUNT_B);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).not.toContain('Toyota');
  });

  it('leaves no route that could update or delete a trail entry (append-only)', async () => {
    booted = await boot();
    await call(booted, 'PUT', `/deals/${DEAL}`, ACCOUNT_A, dealBody());

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await call(booted, method, `/deals/${DEAL}/receipt`, ACCOUNT_A, {});
      expect([404, 400], `${method} /receipt`).toContain(res.statusCode);
    }
    // The trail still reads.
    expect((await trail(booted)).entries).toEqual([]);
  });
});
