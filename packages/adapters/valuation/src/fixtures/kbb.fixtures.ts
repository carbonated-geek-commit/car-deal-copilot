/**
 * Default fixture rows for the KBB-mock adapter (retail / trade-in / private-party
 * needs, specs/00 "Valuation" table rows 1 and 3).
 *
 * Discipline (docs/design/T-013.md §3.3, asserted by tests):
 * - KBB rows populate ONLY `trade_in` / `retail` / `private_party` — never `wholesale`.
 * - Q15 RESOLVED: the private-party number comes through THIS mock's
 *   `private_party` band. There is no comps source, no marketplace integration
 *   and no scraping path anywhere in this package; buyer-entered comps are user
 *   data, not an external feed.
 * - Every vehicle also appears in manheim.fixtures.ts with coherent numbers
 *   satisfying `wholesale < trade_in < private_party < retail`.
 * - Rows carry both match keys where a demo vehicle has a known VIN, so the Q16
 *   fall-through (malformed/unknown VIN → spec key) is exercisable.
 * - At least one row carries a `condition_adjustment` and at least one a
 *   `trim_adjustment`, so "year, trim, mileage and condition are all
 *   load-bearing" (specs/00 "Budget ceiling vs. fair price") is provable.
 * - Deterministic TypeScript modules: no JSON, no I/O, no randomness, no clock.
 * - Error rows simulate provider failure paths offline: the 2015 BMW X5
 *   succeeds here but fails on the Manheim side (partial-blend demo); the
 *   2014 Audi A4 fails here (`rate_limited`); the 2012 Jaguar XJ fails on
 *   both sides (total-failure demo).
 *
 * All amounts are integer USD cents (`MoneyCents`).
 */

import type { ValuationFixtureRow } from '../mock-adapter.js';

export const KBB_DEFAULT_FIXTURES: readonly ValuationFixtureRow[] = [
  // ---- VIN-keyed demo vehicles (spec key also present, so an unmatched VIN falls through) ----
  {
    vin: '1HGCV1F34LA123456', // 2020 Honda Accord
    spec_key: { make: 'Honda', model: 'Accord', year: 2020 },
    values: { trade_in: 1_850_000, private_party: 2_000_000, retail: 2_150_000 },
    mileage_adjustment: { baseline_mileage: 45_000, cents_per_mile: 8 },
    condition_adjustment: { certified: 80_000, new: 250_000 },
    trim_adjustment: { lx: -40_000, sport: 60_000, touring: 140_000 },
  },
  {
    vin: '5YJ3E1EA7KF317000', // 2019 Tesla Model 3
    spec_key: { make: 'Tesla', model: 'Model 3', year: 2019 },
    values: { trade_in: 2_200_000, private_party: 2_340_000, retail: 2_480_000 },
    mileage_adjustment: { baseline_mileage: 30_000, cents_per_mile: 10 },
    condition_adjustment: { certified: 70_000 },
  },

  // ---- spec-keyed demo vehicles (make|model|year; trim is priced, not matched) ----
  {
    spec_key: { make: 'Toyota', model: 'RAV4', year: 2021 },
    values: { trade_in: 2_400_000, private_party: 2_560_000, retail: 2_720_000 },
    mileage_adjustment: { baseline_mileage: 35_000, cents_per_mile: 9 },
    condition_adjustment: { certified: 95_000, new: 300_000 },
  },
  {
    spec_key: { make: 'Ford', model: 'F-150', year: 2019 },
    values: { trade_in: 2_780_000, private_party: 2_960_000, retail: 3_150_000 },
    mileage_adjustment: { baseline_mileage: 55_000, cents_per_mile: 7 },
    trim_adjustment: { xl: -60_000, xlt: 90_000, lariat: 320_000 },
  },
  {
    spec_key: { make: 'Honda', model: 'Civic', year: 2022 },
    values: { trade_in: 2_020_000, private_party: 2_150_000, retail: 2_290_000 },
  },
  {
    spec_key: { make: 'Chevrolet', model: 'Silverado 1500', year: 2018 },
    values: { trade_in: 2_300_000, private_party: 2_470_000, retail: 2_650_000 },
  },

  // ---- vehicle that succeeds here but fails on the Manheim side (partial blend) ----
  {
    spec_key: { make: 'BMW', model: 'X5', year: 2015 },
    values: { trade_in: 1_450_000, private_party: 1_580_000, retail: 1_720_000 },
  },

  // ---- simulated error rows (§7.1) ----
  {
    spec_key: { make: 'Audi', model: 'A4', year: 2014 },
    error: 'rate_limited',
  },
  {
    spec_key: { make: 'Jaguar', model: 'XJ', year: 2012 },
    error: 'provider_unavailable',
  },
];
