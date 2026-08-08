/**
 * T-011 tester — the `above_market` flag and the per-VehicleInstance
 * market-value input (docs/design/T-011.md §5.3 "New above_market suite",
 * §5.4 "The four budget × market combinations", §4.1 "Error paths").
 *
 * `test/engine.test.ts` is the T-002 suite as migrated by T-011 off the
 * four-flag vocabulary. It proves the fifth flag lands in the existing arrays.
 * THIS file is the flag's own suite: band selection (ADR-007), tolerance
 * injection (D10), the four unevaluable paths (ADR-005 / §4.1 rows 1–4), the
 * instance-binding guard (D12), independence from `over_walkaway` in all four
 * combinations (AC-4), and the structural mandates that must hold for a pure
 * engine (no I/O, no clock, no audio/transcription path, no tenancy inputs).
 *
 * Binding rules exercised here:
 *  - ADR-007 — `above_market` compares the offer's PRICE against
 *    `ValuationSnapshot.retail` for THAT `VehicleInstance`; tolerance is
 *    configuration, never a hard-coded threshold.
 *  - ADR-005 — a flag missing a required input is UNEVALUABLE: never zero,
 *    never "evaluated, not triggered", never a silent clean bill.
 *  - specs/00 "Budget ceiling vs. fair price" — `over_walkaway` stays the
 *    deal-level budget ceiling; both questions must be independently sayable.
 *
 * No test here depends on DATABASE_URL, object-store config, or an HTTP
 * endpoint (ADR-008): this package is a pure function with zero dependencies,
 * so nothing in this file is skippable — every case runs everywhere.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFER_FLAGS } from '@core';
import type { Offer, OfferFlag, ValuationSnapshot } from '@core';
import { evaluateOffer } from '@flag-engine';
import * as flagEngineApi from '@flag-engine';
import type { FlagContext, FlagEngineConfig } from '@flag-engine';
import {
  BENIGN_CONTEXT,
  FIXTURE_CONFIG,
  FIXTURE_INSTANCE_ID,
  deepFreeze,
  makeEverythingWrongOffer,
  makeOffer,
  makeOfferWithout,
  makeValuation,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// Local helpers — kept out of fixtures.ts so the shared benign fixtures keep
// exactly the meaning the T-002/T-011 suites give them.
// ---------------------------------------------------------------------------

/** A context built from the benign one. `exactOptionalPropertyTypes` forbids
 * `{ valuation: undefined }`, so absence is expressed by deletion, not by an
 * explicit undefined. */
function context(overrides: Partial<FlagContext> = {}): FlagContext {
  return { ...BENIGN_CONTEXT, ...overrides } as FlagContext;
}

/** Drop optional fields from a context — "the caller has no valuation yet". */
function contextWithout(
  keys: ReadonlyArray<'valuation' | 'vehicle_instance_id' | 'qualified_apr'>,
  overrides: Partial<FlagContext> = {},
): FlagContext {
  const ctx = context(overrides);
  for (const key of keys) {
    delete ctx[key];
  }
  return ctx;
}

/** Drop bands from a snapshot — "the source returned no retail figure". */
function valuationWithout(
  keys: ReadonlyArray<'retail' | 'wholesale' | 'trade_in' | 'private_party'>,
  overrides: Partial<ValuationSnapshot> = {},
): ValuationSnapshot {
  const snapshot = makeValuation(overrides);
  for (const key of keys) {
    delete snapshot[key];
  }
  return snapshot;
}

const withBps = (bps: number): FlagEngineConfig => ({
  ...FIXTURE_CONFIG,
  above_market_tolerance_bps: bps,
});

/** Fees are excluded from the above_market comparison (D9); a fee-free offer
 * keeps `junk_fee` and `over_walkaway` from confounding a price assertion. */
function pricedOffer(salePrice: number, overrides: Partial<Offer> = {}): Offer {
  return makeOffer({ sale_price: salePrice, fees: [], ...overrides });
}

/** A context whose budget ceiling is far above anything under test, so only
 * the market question is in play. */
const ROOMY_BUDGET: FlagContext = context({ walk_away_number: 99_000_000 });

// ---------------------------------------------------------------------------
// Type-level guards (validated by `npx tsc -p packages/flag-engine --noEmit`).
// ---------------------------------------------------------------------------

// ADR-007 / D11: the band is fixed by ADR and is NOT a runtime knob. A band
// selector on the config would let an operator overturn an accepted ADR at
// runtime, so the type must reject one.
// @ts-expect-error -- FlagEngineConfig must expose no band selector (T-011 D11)
const _noBandSelector: FlagEngineConfig = { ...FIXTURE_CONFIG, above_market_band: 'wholesale' };

// The tolerance knob is REQUIRED, not defaulted: an omitted threshold must be a
// compile error, never a silent business constant (T-002 D1, ADR-007).
// @ts-expect-error -- above_market_tolerance_bps is required on FlagEngineConfig
const _toleranceIsRequired: FlagEngineConfig = {
  stretched_term_min_months: 72,
  rate_markup_tolerance_points: 0,
  fee_fair_caps: [],
};

// ---------------------------------------------------------------------------

describe('above_market — fires on a price above THIS car\'s retail band (AC-2, ADR-007)', () => {
  it('fires when the sale price is above the instance\'s retail band', () => {
    const result = evaluateOffer(pricedOffer(2_600_000), ROOMY_BUDGET, FIXTURE_CONFIG);
    expect(result.flags).toContain('above_market');
    expect(result.unevaluable).not.toContain('above_market');
  });

  it('does not fire below retail — absent from BOTH arrays (evaluated, not triggered)', () => {
    const result = evaluateOffer(pricedOffer(2_400_000), ROOMY_BUDGET, FIXTURE_CONFIG);
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).not.toContain('above_market');
  });

  it('boundary (D4): price == retail does not fire; retail + 1 cent does', () => {
    const atBand = evaluateOffer(pricedOffer(2_500_000), ROOMY_BUDGET, FIXTURE_CONFIG);
    const overBand = evaluateOffer(pricedOffer(2_500_001), ROOMY_BUDGET, FIXTURE_CONFIG);
    expect(atBand.flags).not.toContain('above_market');
    expect(atBand.unevaluable).not.toContain('above_market');
    expect(overBand.flags).toEqual(['above_market']);
  });

  it('sorts last in OFFER_FLAGS order when it fires alongside other flags (D7)', () => {
    const flags = evaluateOffer(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG).flags;
    expect(flags[flags.length - 1]).toBe('above_market');
    expect(flags).toEqual(OFFER_FLAGS.filter((f) => flags.includes(f)));
  });
});

describe('above_market — tolerance is injected configuration, never a constant (ADR-007, D10)', () => {
  const CTX_2M: FlagContext = context({ valuation: makeValuation({ retail: 2_000_000 }) });

  it('boundary at bps 500: threshold is retail + 5% exactly — 2_100_000 no, 2_100_001 yes', () => {
    const config = withBps(500);
    expect(evaluateOffer(pricedOffer(2_100_000), { ...CTX_2M, walk_away_number: 99_000_000 }, config).flags)
      .not.toContain('above_market');
    expect(evaluateOffer(pricedOffer(2_100_001), { ...CTX_2M, walk_away_number: 99_000_000 }, config).flags)
      .toContain('above_market');
  });

  it('the SAME offer flips verdict on the config alone — nothing is baked into the engine', () => {
    const offer = pricedOffer(2_550_000); // 2% over the 2_500_000 retail band
    expect(evaluateOffer(offer, ROOMY_BUDGET, withBps(0)).flags).toContain('above_market');
    expect(evaluateOffer(offer, ROOMY_BUDGET, withBps(1_000)).flags).not.toContain('above_market');
  });

  it('bps 0 means "any excess over retail flags" (the documented zero semantics)', () => {
    expect(evaluateOffer(pricedOffer(2_500_001), ROOMY_BUDGET, withBps(0)).flags)
      .toContain('above_market');
  });

  it('the allowance is integer-exact: trunc, never a fractional cent (spine money rule)', () => {
    // retail 1_000_003 @ 1 bps = 100.0003 → allowance 100 → threshold 1_000_103.
    const ctx = context({ valuation: makeValuation({ retail: 1_000_003 }), walk_away_number: 99_000_000 });
    const config = withBps(1);
    expect(evaluateOffer(pricedOffer(1_000_103), ctx, config).flags).not.toContain('above_market');
    expect(evaluateOffer(pricedOffer(1_000_104), ctx, config).flags).toContain('above_market');
  });

  it('the tolerance is proportional: the same bps yields a bigger allowance on a dearer car', () => {
    const cheap = context({ valuation: makeValuation({ retail: 1_000_000 }), walk_away_number: 99_000_000 });
    const dear = context({ valuation: makeValuation({ retail: 8_000_000 }), walk_away_number: 99_000_000 });
    const config = withBps(500); // 5%
    // $500 over on a $10k car flags; $500 over on an $80k car does not.
    expect(evaluateOffer(pricedOffer(1_050_001), cheap, config).flags).toContain('above_market');
    expect(evaluateOffer(pricedOffer(8_050_000), dear, config).flags).not.toContain('above_market');
  });
});

describe('above_market — retail is the ONLY band read; no fallback (ADR-007, D11)', () => {
  it('a snapshot with no retail band is UNEVALUABLE — the other bands are never substituted', () => {
    // Every other band is present and the price is above all three: a fallback
    // would fire here. ADR-007 says the honest answer is "we cannot price this".
    const noRetail = valuationWithout(['retail'], {
      wholesale: 1_800_000,
      trade_in: 1_700_000,
      private_party: 2_100_000,
    });
    const result = evaluateOffer(
      pricedOffer(2_600_000),
      context({ valuation: noRetail, walk_away_number: 99_000_000 }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toContain('above_market');
  });

  it('retail governs even when the other bands would give the opposite verdict', () => {
    // retail high, wholesale/trade_in low: comparing against wholesale would fire.
    const retailHigh = makeValuation({
      retail: 3_000_000,
      wholesale: 1_500_000,
      trade_in: 1_400_000,
      private_party: 1_900_000,
    });
    expect(
      evaluateOffer(
        pricedOffer(2_600_000),
        context({ valuation: retailHigh, walk_away_number: 99_000_000 }),
        FIXTURE_CONFIG,
      ).flags,
    ).not.toContain('above_market');

    // retail low, every other band high: comparing against private_party would clear it.
    const retailLow = makeValuation({
      retail: 2_000_000,
      wholesale: 2_900_000,
      trade_in: 2_800_000,
      private_party: 3_100_000,
    });
    expect(
      evaluateOffer(
        pricedOffer(2_600_000),
        context({ valuation: retailLow, walk_away_number: 99_000_000 }),
        FIXTURE_CONFIG,
      ).flags,
    ).toContain('above_market');
  });

  it('a band selector smuggled onto the config at runtime changes nothing (D11)', () => {
    const smuggled = { ...FIXTURE_CONFIG, above_market_band: 'wholesale' } as FlagEngineConfig;
    const valuation = makeValuation({ retail: 3_000_000, wholesale: 1_500_000 });
    const ctx = context({ valuation, walk_away_number: 99_000_000 });
    // Above wholesale, below retail — still not above market.
    expect(evaluateOffer(pricedOffer(2_600_000), ctx, smuggled).flags).not.toContain('above_market');
  });
});

describe('above_market — unevaluable, never zero, never a silent clean bill (ADR-005, AC-5, AC-6)', () => {
  it('no valuation for the instance → unevaluable, in NEITHER a fired nor a clean verdict', () => {
    const result = evaluateOffer(makeOffer(), contextWithout(['valuation']), FIXTURE_CONFIG);
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toContain('above_market');
  });

  it('no valuation on a wildly overpriced offer is still unevaluable, never "not triggered"', () => {
    const result = evaluateOffer(
      pricedOffer(9_900_000),
      contextWithout(['valuation'], { walk_away_number: 99_000_000 }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toEqual(['above_market']);
  });

  it('a benign offer with no valuation NEVER returns a clean bill of health', () => {
    // The structural guard: "no flags fired" and "we could not price this car"
    // must not look alike (ADR-005 consequences).
    const result = evaluateOffer(makeOffer(), contextWithout(['valuation']), FIXTURE_CONFIG);
    expect(result).toEqual({ flags: [], unevaluable: ['above_market'] });
  });

  it('no valuation leaves every other flag unaffected', () => {
    const result = evaluateOffer(
      makeEverythingWrongOffer(),
      contextWithout(['valuation']),
      FIXTURE_CONFIG,
    );
    expect(result.flags).toEqual([
      'payment_packing',
      'rate_markup',
      'junk_fee',
      'over_walkaway',
    ]);
    expect(result.unevaluable).toEqual(['above_market']);
  });

  it('no sale_price → above_market AND over_walkaway both unevaluable (shared price input)', () => {
    const result = evaluateOffer(
      makeOfferWithout(['sale_price']),
      BENIGN_CONTEXT,
      FIXTURE_CONFIG,
    );
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toEqual(['over_walkaway', 'above_market']);
  });

  it('a missing sale_price is NEVER defaulted to zero for the market comparison', () => {
    // retail is negative nonsense: a price defaulted to 0 would be "above" it
    // and fire. Absence must produce unevaluable instead (ADR-005 §2).
    const result = evaluateOffer(
      makeOfferWithout(['sale_price']),
      context({ valuation: makeValuation({ retail: -1 }) }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toContain('above_market');
  });

  it('a missing retail band is NEVER defaulted to zero (which would flag every offer)', () => {
    const result = evaluateOffer(
      pricedOffer(1),
      context({ valuation: valuationWithout(['retail']), walk_away_number: 99_000_000 }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toContain('above_market');
  });

  it('the unevaluable set is duplicate-free and in OFFER_FLAGS order across the unevaluable paths', () => {
    const cases: Array<[Offer, FlagContext]> = [
      [makeOffer(), contextWithout(['valuation'])],
      [makeOfferWithout(['sale_price']), BENIGN_CONTEXT],
      [makeOffer(), context({ valuation: valuationWithout(['retail']) })],
      [makeOffer(), context({ vehicle_instance_id: 'vi-some-other-car' })],
      [makeOfferWithout(['sale_price', 'apr', 'term_months']), contextWithout(['valuation'])],
    ];
    for (const [offer, ctx] of cases) {
      const { flags, unevaluable } = evaluateOffer(offer, ctx, FIXTURE_CONFIG);
      expect(unevaluable).toContain('above_market');
      expect(new Set(unevaluable).size).toBe(unevaluable.length);
      expect(unevaluable).toEqual(OFFER_FLAGS.filter((f) => unevaluable.includes(f)));
      expect(flags).not.toContain('above_market');
    }
  });
});

describe('above_market — the comparison is bound to THAT VehicleInstance (D12, ADR-007)', () => {
  const OTHER_INSTANCE = 'vi-some-other-dealerships-car';

  it('a snapshot from a different instance is unevaluable, even when the numbers would fire', () => {
    const result = evaluateOffer(
      pricedOffer(2_900_000), // far above the snapshot's 2_500_000 retail
      context({
        valuation: makeValuation({ vehicle_instance_id: OTHER_INSTANCE }),
        walk_away_number: 99_000_000,
      }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toContain('above_market');
  });

  it('a snapshot from a different instance never yields a CLEAN verdict either', () => {
    // The dangerous direction: another car's snapshot silently blessing this price.
    const result = evaluateOffer(
      pricedOffer(2_400_000), // would read as fairly priced against the wrong car
      context({
        valuation: makeValuation({ vehicle_instance_id: OTHER_INSTANCE }),
        walk_away_number: 99_000_000,
      }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toContain('above_market');
  });

  it('a cross-instance snapshot does not throw — purity is absolute (§4.1 row 3)', () => {
    expect(() =>
      evaluateOffer(
        makeEverythingWrongOffer(),
        context({ valuation: makeValuation({ vehicle_instance_id: OTHER_INSTANCE }) }),
        FIXTURE_CONFIG,
      ),
    ).not.toThrow();
  });

  it('a cross-instance snapshot leaves the deal-level flags untouched', () => {
    const result = evaluateOffer(
      makeEverythingWrongOffer(),
      context({ valuation: makeValuation({ vehicle_instance_id: OTHER_INSTANCE }) }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).toEqual([
      'payment_packing',
      'rate_markup',
      'junk_fee',
      'over_walkaway',
    ]);
    expect(result.unevaluable).toEqual(['above_market']);
  });

  it('matching instance ids evaluate normally', () => {
    const result = evaluateOffer(
      pricedOffer(2_600_000),
      context({
        valuation: makeValuation({ vehicle_instance_id: FIXTURE_INSTANCE_ID }),
        vehicle_instance_id: FIXTURE_INSTANCE_ID,
        walk_away_number: 99_000_000,
      }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).toContain('above_market');
    expect(result.unevaluable).not.toContain('above_market');
  });

  it('the guard is opt-in: with no context instance id the snapshot is taken as given', () => {
    const result = evaluateOffer(
      pricedOffer(2_600_000),
      contextWithout(['vehicle_instance_id'], {
        valuation: makeValuation({ vehicle_instance_id: OTHER_INSTANCE }),
        walk_away_number: 99_000_000,
      }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).toContain('above_market');
    expect(result.unevaluable).not.toContain('above_market');
  });
});

describe('budget ceiling vs. fair price — all four combinations (AC-4, design §5.4)', () => {
  /**
   * specs/00 "Budget ceiling vs. fair price": "A cheap car can be a bad deal
   * and an expensive one a fair deal — both must be sayable". Fees are a flat
   * 40_000 (under the 50_000 cap, so junk_fee never confounds); term/APR stay
   * benign. Out-the-door total = sale_price + 40_000; tolerance 0 bps.
   */
  const FEES = [{ name: 'doc fee', amount: 40_000 }];

  function combination(salePrice: number, retail: number, walkAway: number): OfferFlag[] {
    return evaluateOffer(
      makeOffer({ sale_price: salePrice, fees: FEES }),
      context({ valuation: makeValuation({ retail }), walk_away_number: walkAway }),
      FIXTURE_CONFIG,
    ).flags;
  }

  it('1 — cheap car, fair price: neither flag', () => {
    expect(combination(2_400_000, 2_500_000, 2_600_000)).toEqual([]);
  });

  it('2 — "inside your budget and still a bad price": above_market ONLY', () => {
    expect(combination(2_550_000, 2_500_000, 2_600_000)).toEqual(['above_market']);
  });

  it('3 — "over budget and priced fairly": over_walkaway ONLY', () => {
    expect(combination(2_700_000, 2_800_000, 2_600_000)).toEqual(['over_walkaway']);
  });

  it('4 — over budget and overpriced: both', () => {
    expect(combination(2_900_000, 2_800_000, 2_600_000)).toEqual([
      'over_walkaway',
      'above_market',
    ]);
  });

  it('over_walkaway is not re-pointed at valuation: its verdict is invariant in retail (AC-3)', () => {
    const offer = makeOffer({ sale_price: 2_700_000, fees: FEES }); // total 2_740_000
    const retails = [1_000_000, 2_700_000, 2_800_000, 9_000_000];
    for (const retail of retails) {
      const flags = evaluateOffer(
        offer,
        context({ valuation: makeValuation({ retail }), walk_away_number: 2_600_000 }),
        FIXTURE_CONFIG,
      ).flags;
      expect(flags).toContain('over_walkaway');
    }
  });

  it('above_market is not re-pointed at the budget: its verdict is invariant in walk_away_number', () => {
    const offer = makeOffer({ sale_price: 2_550_000, fees: FEES });
    for (const walkAway of [0, 2_600_000, 99_000_000]) {
      const { flags } = evaluateOffer(
        offer,
        context({ valuation: makeValuation({ retail: 2_500_000 }), walk_away_number: walkAway }),
        FIXTURE_CONFIG,
      );
      expect(flags).toContain('above_market');
    }
  });

  it('above_market reads the bare price, over_walkaway the out-the-door total (D9)', () => {
    // Price exactly AT retail, fees large enough to cross the ceiling: the
    // budget question answers yes, the fair-price question answers no.
    const offer = makeOffer({
      sale_price: 2_500_000,
      fees: [{ name: 'doc fee', amount: 45_000 }], // under the 50_000 junk cap
    });
    const { flags } = evaluateOffer(
      offer,
      context({ valuation: makeValuation({ retail: 2_500_000 }), walk_away_number: 2_520_000 }),
      FIXTURE_CONFIG,
    );
    expect(flags).toEqual(['over_walkaway']);
  });

  it('neither flag gates the other: each is reachable with the other unevaluable', () => {
    // over_walkaway fires while above_market is unevaluable (no valuation).
    const noValuation = evaluateOffer(
      makeOffer({ sale_price: 2_700_000, fees: FEES }),
      contextWithout(['valuation'], { walk_away_number: 2_600_000 }),
      FIXTURE_CONFIG,
    );
    expect(noValuation.flags).toEqual(['over_walkaway']);
    expect(noValuation.unevaluable).toEqual(['above_market']);
  });
});

describe('above_market — totality and purity (AC-7, §4.1 rows 5–6, D13)', () => {
  it('NaN retail: no throw, does not fire, and is EVALUATED rather than unevaluable (§4.1 row 5)', () => {
    let result;
    expect(() => {
      result = evaluateOffer(
        pricedOffer(2_600_000),
        context({ valuation: makeValuation({ retail: Number.NaN }), walk_away_number: 99_000_000 }),
        FIXTURE_CONFIG,
      );
    }).not.toThrow();
    expect(result!.flags).not.toContain('above_market');
    expect(result!.unevaluable).not.toContain('above_market');
  });

  it('NaN tolerance bps: no throw, conservatively does not fire', () => {
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(pricedOffer(2_600_000), ROOMY_BUDGET, withBps(Number.NaN)).flags;
    }).not.toThrow();
    expect(flags).not.toContain('above_market');
  });

  it('NaN sale_price: no throw, does not fire (same posture as over_walkaway)', () => {
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(pricedOffer(Number.NaN), ROOMY_BUDGET, FIXTURE_CONFIG).flags;
    }).not.toThrow();
    expect(flags).not.toContain('above_market');
  });

  it('an empty-string context instance id fails the binding check safely — unevaluable, not a verdict', () => {
    // Degenerate caller input errs toward the non-answer, never toward a
    // confident comparison against a snapshot it cannot prove belongs here.
    const result = evaluateOffer(
      pricedOffer(2_900_000),
      context({ vehicle_instance_id: '', walk_away_number: 99_000_000 }),
      FIXTURE_CONFIG,
    );
    expect(result.flags).not.toContain('above_market');
    expect(result.unevaluable).toContain('above_market');
  });

  it('negative retail and negative bps: no throw, result stays inside the vocabulary', () => {
    const result = evaluateOffer(
      pricedOffer(-500_000),
      context({ valuation: makeValuation({ retail: -2_000_000 }), walk_away_number: 99_000_000 }),
      withBps(-250),
    );
    for (const flag of [...result.flags, ...result.unevaluable]) {
      expect(OFFER_FLAGS).toContain(flag);
    }
  });

  it('no clock: captured_at is never read — past, present and future snapshots agree (D13)', () => {
    const price = pricedOffer(2_600_000);
    const results = [
      '1999-01-01T00:00:00.000Z',
      '2026-08-07T00:00:00.000Z',
      '2999-12-31T23:59:59.000Z',
    ].map(
      (captured_at) =>
        evaluateOffer(
          price,
          context({ valuation: makeValuation({ captured_at }), walk_away_number: 99_000_000 }),
          FIXTURE_CONFIG,
        ).flags,
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0]).toContain('above_market');
  });

  it('provider-agnostic: the snapshot source id never changes the verdict', () => {
    const price = pricedOffer(2_600_000);
    const a = evaluateOffer(
      price,
      context({ valuation: makeValuation({ source: 'mock-kbb' }), walk_away_number: 99_000_000 }),
      FIXTURE_CONFIG,
    );
    const b = evaluateOffer(
      price,
      context({ valuation: makeValuation({ source: 'mock-manheim' }), walk_away_number: 99_000_000 }),
      FIXTURE_CONFIG,
    );
    expect(a).toEqual(b);
  });

  it('a deeply frozen valuation is accepted and left untouched (no mutation path)', () => {
    const valuation = deepFreeze(makeValuation());
    const ctx = deepFreeze<FlagContext>(context({ valuation }));
    const snapshot = JSON.parse(JSON.stringify(ctx));
    expect(() => evaluateOffer(makeEverythingWrongOffer(), ctx, FIXTURE_CONFIG)).not.toThrow();
    expect(ctx).toEqual(snapshot);
  });

  it('is deterministic across repeated evaluation of the same market inputs', () => {
    const offer = pricedOffer(2_600_000);
    const first = evaluateOffer(offer, ROOMY_BUDGET, FIXTURE_CONFIG);
    const second = evaluateOffer(offer, ROOMY_BUDGET, FIXTURE_CONFIG);
    expect(second).toEqual(first);
    expect(second.flags).not.toBe(first.flags);
  });

  it('a later valuation legitimately changes the answer — flags are recomputed, never accumulated', () => {
    const offer = pricedOffer(2_600_000);
    const stale = evaluateOffer(
      offer,
      context({ valuation: makeValuation({ retail: 2_500_000 }), walk_away_number: 99_000_000 }),
      FIXTURE_CONFIG,
    );
    expect(stale.flags).toContain('above_market');
    // A refreshed snapshot with a higher retail band clears the flag on the
    // SAME offer, including one already carrying the old flag (replace-not-merge).
    const refreshed = evaluateOffer(
      { ...offer, flags: stale.flags },
      context({ valuation: makeValuation({ retail: 2_700_000 }), walk_away_number: 99_000_000 }),
      FIXTURE_CONFIG,
    );
    expect(refreshed.flags).toEqual([]);
    expect(refreshed.unevaluable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structural mandates — properties that must hold for the whole package, not
// just for one call. Read from source so a future edit cannot quietly break
// them (docs/design/T-011.md §6 "Invariant touchpoints").
// ---------------------------------------------------------------------------

const testDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(testDir, '..');
const engineSource = readFileSync(resolve(pkgDir, 'src', 'engine.ts'), 'utf8');
const indexSource = readFileSync(resolve(pkgDir, 'src', 'index.ts'), 'utf8');
const packageJson = readFileSync(resolve(pkgDir, 'package.json'), 'utf8');
const allSource = `${engineSource}\n${indexSource}`;

/** Comments are where the design's reasoning lives — the ban is on CODE. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const engineCode = stripComments(engineSource);
const allCode = stripComments(allSource);

describe('structural mandates (design §6)', () => {
  it('no audio, recording, or transcription path exists anywhere in the package', () => {
    // specs/01 "Consent & recording posture": no audio is stored and no
    // transcription happens. A pure pricing engine is the last place it could
    // appear, so the absence is asserted rather than assumed.
    for (const banned of [
      'recording_url',
      'transcript',
      'transcription',
      'audio',
      'whisper',
      'deepgram',
      'speech',
      'recordingSid',
    ]) {
      expect(allCode.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it('no I/O of any kind: the engine imports only @core and touches no host API', () => {
    // §4.1 rows 9–10: provider outage/timeout/auth are IMPOSSIBLE here because
    // there is nothing to call.
    const imports = [...allCode.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(imports.filter((m) => m === '@core' || m?.startsWith('./')));
    for (const banned of [
      'fetch(',
      'XMLHttpRequest',
      'node:fs',
      'node:http',
      'require(',
      'process.env',
      'Date.now',
      'new Date',
      'Math.random',
      'setTimeout',
      'await ',
      'async ',
    ]) {
      expect(allCode).not.toContain(banned);
    }
  });

  it('no live provider credential or hostname can reach this package (mock-only mandate)', () => {
    for (const banned of ['http://', 'https://', 'api_key', 'apiKey', 'Bearer', 'kbb.com', 'manheim']) {
      expect(allCode.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    // ADR-008 / design §1: zero dependency keys, still.
    const manifest = JSON.parse(packageJson) as Record<string, unknown>;
    expect(manifest['dependencies']).toBeUndefined();
    expect(manifest['devDependencies']).toBeUndefined();
  });

  it('the engine takes no account, deal, tenant, or product parameter — isolation by construction', () => {
    // specs/00 "Dealership data tenancy": Dealership is global, DealershipContact
    // is account-private. The engine is structurally incapable of crossing that
    // line because neither shape — nor any account/tenant key — enters it.
    for (const banned of [
      'account_id',
      'accountId',
      'tenant',
      'Dealership',
      'DealershipContact',
      'DealerThread',
      'Deal ',
      'VehicleTarget',
      'Message',
    ]) {
      expect(engineCode).not.toContain(banned);
    }
    expect(evaluateOffer.length).toBe(3); // (offer, context, config) — nothing else
  });

  it('no mutation, update, or delete surface is exported (append-only posture)', () => {
    expect(Object.keys(flagEngineApi).sort()).toEqual(['evaluateOffer']);
    for (const banned of ['function update', 'function delete', 'function mutate', 'splice(', 'push(']) {
      expect(engineCode).not.toContain(banned);
    }
  });

  it('the flag vocabulary is imported from @core, never re-declared (ADR-001, ADR-002)', () => {
    expect(engineCode).toContain("from '@core'");
    expect(engineCode).not.toMatch(/type\s+OfferFlag\s*=/);
    expect(engineCode).not.toMatch(/OFFER_FLAGS\s*[:=]\s*\[/);
    expect(engineCode).not.toContain("'packing'");
  });

  it('retail is the only valuation band named in the engine (ADR-007, D11)', () => {
    expect(engineCode).toContain('retail');
    for (const otherBand of ['wholesale', 'trade_in', 'private_party']) {
      expect(engineCode).not.toContain(otherBand);
    }
  });

  it('no business constant is baked into the market comparison — the threshold is config', () => {
    // The only numeric literal permitted in the above_market rule is the
    // basis-point denominator 10_000, a unit conversion (T-011 D10).
    const rule = engineCode.slice(engineCode.indexOf('const valuation = context.valuation'));
    const literals = [...rule.matchAll(/\b\d[\d_]*\b/g)].map((m) => m[0]);
    expect(literals).toEqual(['10_000']);
    expect(rule).toContain('config.above_market_tolerance_bps');
  });
});
