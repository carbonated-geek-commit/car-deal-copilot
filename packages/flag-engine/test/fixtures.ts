/**
 * Fixture offers + fixture config for the flag-engine test suite
 * (docs/design/T-002.md §5; docs/design/T-011.md §5.1).
 *
 * Numeric fixture values are cited to the spec's own examples (design D1):
 * `stretched_term_min_months: 72` comes from specs/00 "Flag engine (shared)"
 * ("72/84 mo"); all other constants are arbitrary test data, not business
 * constants — the engine itself ships no defaults.
 *
 * All spine types come from `@core`; engine input types come from the public
 * `@flag-engine` surface (design §2 — tests go through the public API only).
 */

import type { Offer, ValuationSnapshot } from '@core';
import type { FlagContext, FlagEngineConfig } from '@flag-engine';

/** Base injectable config (design D1). No unmatched_fee_cap — unmatched fees never flag (D6). */
export const FIXTURE_CONFIG: FlagEngineConfig = {
  stretched_term_min_months: 72, // specs/00 "72/84 mo" — 72 itself is stretched (D4)
  rate_markup_tolerance_points: 0,
  fee_fair_caps: [{ name: 'Doc Fee', max_amount: 50_000 }], // $500 doc-fee cap
  above_market_tolerance_bps: 0, // any price above retail flags — clearest boundary (T-011 D10)
};

/** Same config plus a catch-all cap for fees matching no fee_fair_caps entry (D6). */
export const CONFIG_WITH_UNMATCHED_CAP: FlagEngineConfig = {
  ...FIXTURE_CONFIG,
  unmatched_fee_cap: 20_000, // $200
};

/** The VehicleInstance every fixture valuation is bound to (T-011 D12). */
export const FIXTURE_INSTANCE_ID = 'vi-fixture-1';

/**
 * A ValuationSnapshot for the fixture instance (T-011 D8 — the whole spine
 * snapshot travels, not a pre-picked number).
 *
 * `retail` deliberately EQUALS the benign offer's sale_price, so the benign
 * fixture stays clean under the strict `>` boundary (design D4) while
 * `makeEverythingWrongOffer()` (2_600_000) sits above it.
 */
export function makeValuation(overrides: Partial<ValuationSnapshot> = {}): ValuationSnapshot {
  return {
    vehicle_instance_id: FIXTURE_INSTANCE_ID,
    retail: 2_500_000, // $25,000 — ADR-007's comparison band
    source: 'mock-kbb', // adapter id only — never a provider payload
    captured_at: '2026-08-07T00:00:00.000Z', // read by nothing (T-011 D13)
    ...overrides,
  };
}

/**
 * Benign buyer context: prequal present, walk-away comfortably above the
 * benign offer's out-the-door total (2_540_000 with makeOffer defaults), and
 * a valuation for the instance the offer belongs to — without one,
 * `above_market` would be (correctly) unevaluable rather than clean (ADR-005).
 */
export const BENIGN_CONTEXT: FlagContext = {
  qualified_apr: 5.9,
  walk_away_number: 2_600_000, // $26,000
  valuation: makeValuation(),
  vehicle_instance_id: FIXTURE_INSTANCE_ID,
};

/**
 * Benign offer factory: no flag fires against BENIGN_CONTEXT + FIXTURE_CONFIG.
 *  - term 60 < 72 (no payment_packing)
 *  - apr 5.9 == qualified 5.9 + tolerance 0 (equal-to is not "above" — D4)
 *  - doc fee 40_000 <= 50_000 cap (no junk_fee)
 *  - total 2_500_000 + 40_000 = 2_540_000 <= 2_600_000 (no over_walkaway)
 *  - sale_price 2_500_000 == retail 2_500_000 (equal-to is not "above" — D4;
 *    no above_market, and evaluated rather than unevaluable)
 */
export function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    sale_price: 2_500_000, // $25,000
    fees: [{ name: 'doc fee', amount: 40_000 }],
    apr: 5.9,
    term_months: 60,
    monthly: 48_000,
    flags: [],
    ...overrides,
  };
}

/**
 * Benign offer with optional fields removed (design D3 "not assessed";
 * ADR-005 "unevaluable"). `sale_price` is removable since ADR-005 made it
 * optional (absent = dealer did not state a price).
 * `delete` (not spread-with-undefined) keeps exactOptionalPropertyTypes happy.
 */
export function makeOfferWithout(
  keys: ReadonlyArray<'apr' | 'term_months' | 'monthly' | 'sale_price'>,
  overrides: Partial<Offer> = {},
): Offer {
  const offer = makeOffer(overrides);
  for (const key of keys) {
    delete offer[key];
  }
  return offer;
}

/**
 * The "everything wrong" fixture (design §5 combined suite): every flag fires
 * against BENIGN_CONTEXT + FIXTURE_CONFIG.
 *  - term 84 >= 72
 *  - apr 9.9 > 5.9 + 0
 *  - doc fee 60_000 > 50_000 cap
 *  - total 2_600_000 + 60_000 = 2_660_000 > 2_600_000
 *  - sale_price 2_600_000 > retail 2_500_000 + 0 bps (above_market — T-011)
 */
export function makeEverythingWrongOffer(): Offer {
  return makeOffer({
    sale_price: 2_600_000,
    fees: [{ name: 'doc fee', amount: 60_000 }],
    apr: 9.9,
    term_months: 84,
  });
}

/** Recursive freeze so any mutation attempt throws in strict mode (purity suite). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
