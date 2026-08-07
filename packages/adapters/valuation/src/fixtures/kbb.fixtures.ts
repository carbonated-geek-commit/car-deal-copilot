/**
 * Default fixture rows for the KBB-mock adapter (retail/trade-in need,
 * specs/00 "Valuation" table row 1).
 *
 * Discipline (docs/design/T-003.md §3, asserted by tests):
 * - KBB rows populate ONLY `trade_in` / `retail` — never `wholesale`.
 * - Every vehicle also appears in manheim.fixtures.ts with coherent numbers
 *   satisfying `wholesale < trade_in < retail`.
 * - Deterministic TypeScript modules (D5): no JSON, no I/O, no randomness.
 * - Error rows simulate provider failure paths offline (D4): the 2015 BMW X5
 *   succeeds here but fails on the Manheim side (partial-blend demo); the
 *   2014 Audi A4 fails here (`rate_limited`); the 2012 Jaguar XJ fails on
 *   both sides (total-failure demo).
 *
 * All amounts are integer USD cents (`MoneyCents`).
 */

import type { ValuationFixtureRow } from '../mock-adapter.js';

export const KBB_DEFAULT_FIXTURES: readonly ValuationFixtureRow[] = [
  // ---- VIN-keyed demo vehicles ----
  {
    vin: '1HGCV1F34LA123456', // 2020 Honda Accord Sport
    values: { trade_in: 1_850_000, retail: 2_150_000 },
    mileage_adjustment: { baseline_mileage: 45_000, cents_per_mile: 8 },
  },
  {
    vin: '5YJ3E1EA7KF317000', // 2019 Tesla Model 3 Standard Range Plus
    values: { trade_in: 2_200_000, retail: 2_480_000 },
    mileage_adjustment: { baseline_mileage: 30_000, cents_per_mile: 10 },
  },

  // ---- spec-keyed demo vehicles (make|model|year; trim ignored for matching) ----
  {
    spec_key: { make: 'Toyota', model: 'RAV4', year: 2021 },
    values: { trade_in: 2_400_000, retail: 2_720_000 },
    mileage_adjustment: { baseline_mileage: 35_000, cents_per_mile: 9 },
  },
  {
    spec_key: { make: 'Ford', model: 'F-150', year: 2019 },
    values: { trade_in: 2_780_000, retail: 3_150_000 },
    mileage_adjustment: { baseline_mileage: 55_000, cents_per_mile: 7 },
  },
  {
    spec_key: { make: 'Honda', model: 'Civic', year: 2022 },
    values: { trade_in: 2_020_000, retail: 2_290_000 },
  },
  {
    spec_key: { make: 'Chevrolet', model: 'Silverado 1500', year: 2018 },
    values: { trade_in: 2_300_000, retail: 2_650_000 },
  },

  // ---- vehicle that succeeds here but fails on the Manheim side (partial blend) ----
  {
    spec_key: { make: 'BMW', model: 'X5', year: 2015 },
    values: { trade_in: 1_450_000, retail: 1_720_000 },
  },

  // ---- simulated error rows (D4; §4.1) ----
  {
    spec_key: { make: 'Audi', model: 'A4', year: 2014 },
    error: 'rate_limited',
  },
  {
    spec_key: { make: 'Jaguar', model: 'XJ', year: 2012 },
    error: 'provider_unavailable',
  },
];
