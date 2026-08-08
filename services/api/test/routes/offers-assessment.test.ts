/**
 * Offer representation: ADR-005 unevaluable, ADR-006 rollup, ADR-007 retail
 * band, and the two-question split (docs/design/T-020.md D9, D10, D11, D14;
 * AC-11 – AC-15).
 *
 * The rule these tests exist to protect is the one specs/00 states outright: "a
 * thread with no valuation yet reports fair-price as **unevaluable** … never as
 * 'fine'". Nothing in this epic runs the flag engine, so every stored `Offer`
 * carries an empty `flags[]` — and reading that emptiness as "evaluated, nothing
 * fired" would report EVERY offer as fine. The API therefore emits three states
 * and never a fourth, and the assertions below are written to fail if a
 * "clear"/"passing"/"fair" state ever appears.
 */

import type { Offer, OfferFlag, ValuationSnapshot } from '@core';
import { OFFER_FLAGS } from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_A,
  NORTHSIDE,
  bodyOf,
  boot,
  call,
  idFor,
  scenario,
  spyValuations,
  vehicleBody,
  withStore,
  type Booted,
  type Scenario,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

interface FlagStatusView {
  readonly flag: OfferFlag;
  readonly status: 'flagged' | 'unevaluable' | 'not_evaluated';
  readonly reason?: string;
}

interface OfferAssessmentView {
  readonly offer: Offer;
  readonly flags: readonly OfferFlag[];
  readonly unevaluable: readonly OfferFlag[];
  readonly statuses: readonly FlagStatusView[];
}

interface ThreadAssessmentView {
  readonly dealership_id: string;
  readonly current_offer?: OfferAssessmentView;
  readonly budget: { readonly over_walkaway: string; readonly reason?: string };
  readonly fair_price: {
    readonly above_market: string;
    readonly reason?: string;
    readonly vehicle_instance_id?: string;
    readonly valuation_source?: string;
    readonly valuation_captured_at?: string;
  };
}

const instanceIdFor = (s: Scenario): string => `vi:${s.deal_id}:${s.dealership_id}`;

/**
 * The id `scenario()` will mint, known BEFORE the server boots — every
 * identifier this API mints is deterministic (D2), which is what lets a
 * valuation table be seeded for a car that does not exist yet.
 */
const SEEDED_INSTANCE_ID = `vi:deal-1:${idFor(NORTHSIDE)}`;

const offer = (over: Partial<Offer> = {}): Offer => ({ fees: [], flags: [], ...over });

const snapshot = (over: Partial<ValuationSnapshot> & { vehicle_instance_id: string }): ValuationSnapshot => ({
  source: 'mock-kbb',
  captured_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

/** Seeds a thread's `current_offer` — nothing in this API can (design D14). */
async function seedCurrentOffer(s: Scenario, value: Offer): Promise<void> {
  await withStore(s.booted, s.deal_id, ACCOUNT_A, (session) => {
    const thread = session.store.getThread(s.deal_id, s.dealership_id);
    if (thread === undefined) throw new Error('thread missing');
    session.store.putThread(s.deal_id, { ...thread, current_offer: value });
  });
}

const assessment = async (s: Scenario): Promise<ThreadAssessmentView> => {
  const res = await call(s.booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}/current-offer`, ACCOUNT_A);
  expect(res.statusCode).toBe(200);
  return bodyOf<ThreadAssessmentView>(res);
};

const statusOf = (view: ThreadAssessmentView, flag: OfferFlag): FlagStatusView => {
  const found = view.current_offer?.statuses.find((s) => s.flag === flag);
  if (found === undefined) throw new Error(`no status for ${flag}`);
  return found;
};

describe('the three-state vocabulary, and the state that does not exist (D10)', () => {
  it('reports all five flags, in OFFER_FLAGS order, on every assessed offer (AC-11)', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000, term_months: 72 }));

    const view = await assessment(s);
    expect(view.current_offer?.statuses.map((x) => x.flag)).toEqual([...OFFER_FLAGS]);
    expect(OFFER_FLAGS).toContain('above_market');
  });

  it('never emits a clear / passing / fair / fine state for any flag', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000, term_months: 72, apr: 6.9 }));

    const view = await assessment(s);
    for (const status of view.current_offer?.statuses ?? []) {
      expect(['flagged', 'unevaluable', 'not_evaluated'], status.flag).toContain(status.status);
    }
    for (const banned of ['clear', 'passing', 'fair', 'fine', 'ok']) {
      expect(JSON.stringify(view), banned).not.toContain(`"${banned}"`);
    }
  });

  it('copies flags[] from the domain rather than recomputing them', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000, term_months: 72, flags: ['junk_fee'] }));

    const view = await assessment(s);
    expect(view.current_offer?.flags).toEqual(['junk_fee']);
    expect(statusOf(view, 'junk_fee').status).toBe('flagged');
  });

  it('says not_evaluated — not "clear" — for a flag nothing in this epic evaluated', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000, fees: [{ name: 'doc fee', amount: 199_500 }] }));

    // `fees[]` is always present, so junk_fee is never UNEVALUABLE — but no
    // consumer runs the flag engine, so it is not evaluated either.
    expect(statusOf(await assessment(s), 'junk_fee').status).toBe('not_evaluated');
  });
});

describe('ADR-005 — a missing input is unevaluable, never zero and never "not triggered"', () => {
  it('renders an offer with no stated price WITHOUT a sale_price key', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ term_months: 72, fees: [{ name: 'doc fee', amount: 199_500 }] }));

    const view = await assessment(s);
    expect(Object.keys(view.current_offer?.offer ?? {})).not.toContain('sale_price');
    // Never `0`, never `null`.
    expect(JSON.stringify(view.current_offer?.offer)).not.toContain('sale_price');
    expect(JSON.stringify(view)).not.toContain('null');
  });

  it('makes over_walkaway unevaluable when the dealer stated no price (AC-13)', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ term_months: 72 }));

    const view = await assessment(s);
    expect(view.budget).toEqual({ over_walkaway: 'unevaluable', reason: 'no_stated_price' });
    expect(statusOf(view, 'over_walkaway')).toEqual({
      flag: 'over_walkaway',
      status: 'unevaluable',
      reason: 'no_stated_price',
    });
  });

  it('names the missing input for each flag rather than shrugging', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer());

    const view = await assessment(s);
    expect(statusOf(view, 'payment_packing').reason).toBe('no_term');
    expect(statusOf(view, 'rate_markup').reason).toBe('no_offer_apr');
    expect(statusOf(view, 'over_walkaway').reason).toBe('no_stated_price');
  });

  it('keeps rate_markup unevaluable when the offer has an APR but no prequal exists (§8.8)', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ apr: 8.9, sale_price: 2_890_000, term_months: 72 }));

    expect(statusOf(await assessment(s), 'rate_markup')).toEqual({
      flag: 'rate_markup',
      status: 'unevaluable',
      reason: 'no_qualified_apr',
    });
  });

  it('reports every flag unevaluable when the thread has no offer at all', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const view = await assessment(s);
    expect(view.current_offer).toBeUndefined();
    expect(view.budget).toEqual({ over_walkaway: 'unevaluable', reason: 'no_offer' });
    expect(view.fair_price.above_market).toBe('unevaluable');
    expect(view.fair_price.reason).toBe('no_offer');
  });
});

describe('ADR-007 — fair price is judged against THIS car’s RETAIL band (AC-12)', () => {
  it('is unevaluable, never passing, when the instance has no valuation', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000, term_months: 72 }));

    const view = await assessment(s);
    expect(view.fair_price.above_market).toBe('unevaluable');
    expect(view.fair_price.reason).toBe('no_valuation');
    expect(view.fair_price.vehicle_instance_id).toBe(instanceIdFor(s));
    expect(statusOf(view, 'above_market').status).toBe('unevaluable');
  });

  it('is unevaluable when the thread has no vehicle instance to value', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000 }));

    const view = await assessment(s);
    expect(view.fair_price.above_market).toBe('unevaluable');
    expect(view.fair_price.reason).toBe('no_vehicle_instance');
    expect(view.fair_price.vehicle_instance_id).toBeUndefined();
  });

  it('is unevaluable when the snapshot carries every band EXCEPT retail (ADR-007 fixes the band)', async () => {
    const valuations = spyValuations([
      snapshot({
        vehicle_instance_id: SEEDED_INSTANCE_ID,
        wholesale: 2_400_000,
        trade_in: 2_300_000,
        private_party: 2_700_000,
      }),
    ]);
    booted = await boot({ valuations });
    const s = await scenario(booted);
    expect(instanceIdFor(s)).toBe(SEEDED_INSTANCE_ID);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000 }));

    // Three bands are present and the API still refuses to answer: ADR-007
    // fixes the basis to `retail` and there is no fallback band.
    const view = await assessment(s);
    expect(view.fair_price.above_market).toBe('unevaluable');
    expect(view.fair_price.reason).toBe('no_retail_band');
  });

  it('refuses to judge against ANOTHER car’s snapshot', async () => {
    const valuations = spyValuations([
      snapshot({ vehicle_instance_id: 'vi:some-other-deal:dl-other', retail: 2_600_000 }),
    ]);
    booted = await boot({ valuations });
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000 }));

    // The lookup is keyed by THIS instance's id, so a foreign snapshot is never
    // even reachable — the answer stays unevaluable rather than a verdict
    // computed against the wrong car.
    const view = await assessment(s);
    expect(view.fair_price.above_market).toBe('unevaluable');
    expect(view.fair_price.reason).toBe('no_valuation');
    expect(valuations.calls).toContain(instanceIdFor(s));
  });

  it('becomes evaluable — and still not "fine" — once THIS car has a retail band', async () => {
    const valuations = spyValuations([
      snapshot({ vehicle_instance_id: SEEDED_INSTANCE_ID, retail: 2_600_000 }),
    ]);
    booted = await boot({ valuations });
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000 }));

    const view = await assessment(s);
    expect(view.fair_price.above_market).toBe('not_evaluated');
    expect(view.fair_price.reason).toBeUndefined();
    // Provenance only — an adapter id and a timestamp, never a provider payload.
    expect(view.fair_price.valuation_source).toBe('mock-kbb');
    expect(view.fair_price.valuation_captured_at).toBe('2026-08-01T00:00:00.000Z');
    expect(view.current_offer?.unevaluable).not.toContain('above_market');
  });
});

describe('budget ceiling and fair price stay two questions (AC-15, D11)', () => {
  it('emits them as two objects with their own reasons, never fused', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());
    await seedCurrentOffer(s, offer({ term_months: 72 }));

    const view = await assessment(s);
    expect(Object.keys(view.budget)).toEqual(['over_walkaway', 'reason']);
    expect(view.budget.reason).toBe('no_stated_price');
    expect(view.fair_price.above_market).toBe('unevaluable');
    expect(view.fair_price.reason).toBe('no_valuation');
    // Two different reasons for two different questions, in two objects.
    expect(view.budget.reason).not.toBe(view.fair_price.reason);
  });

  it('keeps walk_away_number a DEAL-level field — no thread or offer shape carries it', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000 }));

    const view = await assessment(s);
    expect(JSON.stringify(view)).not.toContain('walk_away_number');

    const deal = await call(booted, 'GET', `/deals/${s.deal_id}`, ACCOUNT_A);
    expect(bodyOf<{ walk_away_number: number }>(deal).walk_away_number).toBe(3_000_000);
  });

  it('exposes no ranking, score, or ordering verdict anywhere', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(s, offer({ sale_price: 2_890_000 }));

    for (const url of [
      `/deals/${s.deal_id}/threads/${s.dealership_id}/current-offer`,
      `/deals/${s.deal_id}/war-room`,
      `/deals/${s.deal_id}/offers`,
    ]) {
      const res = await call(booted, 'GET', url, ACCOUNT_A);
      expect(res.statusCode, url).toBe(200);
      for (const banned of ['rank', 'score', 'verdict', 'best_offer', 'recommendation']) {
        expect(res.body, `${url} → ${banned}`).not.toContain(`"${banned}"`);
      }
    }
  });
});

describe('ADR-006 — current_offer is @comms’s rollup, read-only here (AC-14, D14)', () => {
  it('projects the stored rollup byte-identically to the deal aggregate', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await seedCurrentOffer(
      s,
      offer({ sale_price: 2_890_000, term_months: 72, fees: [{ name: 'doc fee', amount: 199_500 }] }),
    );

    const from_thread = (await assessment(s)).current_offer?.offer;
    const deal = bodyOf<{ dealer_threads: readonly { current_offer?: Offer }[] }>(
      await call(booted, 'GET', `/deals/${s.deal_id}`, ACCOUNT_A),
    );
    expect(from_thread).toEqual(deal.dealer_threads[0]?.current_offer);
  });

  it('offers no write path that could produce a second current_offer', async () => {
    booted = await boot();
    const s = await scenario(booted);

    for (const url of [
      '/offers',
      `/deals/${s.deal_id}/offers`,
      `/deals/${s.deal_id}/threads/${s.dealership_id}/current-offer`,
      `/deals/${s.deal_id}/threads/${s.dealership_id}/offers`,
    ]) {
      const res = await call(booted, 'POST', url, ACCOUNT_A, { sale_price: 1 });
      expect(res.statusCode, `POST ${url}`).toBe(404);
    }
  });

  it('answers 200 with the key absent for a thread that has no offer yet — never 404, never a zero', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const view = await assessment(s);
    expect(view.current_offer).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('sale_price');
  });
});

describe('GET /deals/:deal_id/offers — the flattened history', () => {
  it('assesses each historical offer and admits it has no car to value it against', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await withStore(booted, s.deal_id, ACCOUNT_A, (session) => {
      const deal = session.store.getDeal(s.deal_id);
      if (deal === undefined) throw new Error('deal missing');
      session.store.putDeal({
        ...deal,
        offers: [offer({ sale_price: 2_890_000, term_months: 72 }), offer({ sale_price: 2_850_000 })],
      });
    });

    const res = await call(booted, 'GET', `/deals/${s.deal_id}/offers`, ACCOUNT_A);
    expect(res.statusCode).toBe(200);
    const body = bodyOf<{ deal_id: string; offers: readonly OfferAssessmentView[] }>(res);
    expect(body.deal_id).toBe(s.deal_id);
    expect(body.offers).toHaveLength(2);
    for (const assessed of body.offers) {
      const above = assessed.statuses.find((x) => x.flag === 'above_market');
      expect(above?.status).toBe('unevaluable');
      expect(above?.reason).toBe('no_vehicle_instance');
    }
  });
});
