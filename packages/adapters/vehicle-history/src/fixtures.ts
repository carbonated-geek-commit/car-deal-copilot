/**
 * Per-VIN fixture tables + trigger-VIN constants (internal except FIXTURE_VINS).
 *
 * mock_only enforcement: this file is the ENTIRE data source for both mocks.
 * No URLs, no credentials, no provider payload facsimiles — just the
 * `VehicleHistorySummary` payload minus `vin`/`source`/`fetched_at`, which the
 * factory stamps per call (docs/design/T-005.md §2, D1–D2, D4).
 *
 * All VINs are syntactically valid 17-char VINs (charset A-HJ-NPR-Z0-9 — no
 * I/O/Q) and are test-only, documented via the exported FIXTURE_VINS constant.
 */

import type { Vin } from '@core';
import type { AdapterErrorCode } from '@core';

/** `VehicleHistorySummary` payload minus vin/source/fetched_at (design §2). */
export interface HistoryFixture {
  accident_count: number;
  title_brands: string[];
  owner_count?: number;
}

/**
 * Well-known fixture VINs, exported (via src/index.ts) so downstream
 * packages/tests can exercise every path offline without knowing fixture
 * internals (design D2). Recognized by BOTH mocks.
 */
export const FIXTURE_VINS: {
  /** Clean history: 0 accidents, no title brands. */
  readonly clean: string;
  /** Accident history, clean title. */
  readonly accident: string;
  /** Branded title (salvage + flood) with accident(s). */
  readonly branded_title: string;
  /** Triggers { code: 'rate_limited', retryable: true }. */
  readonly trigger_rate_limited: string;
  /** Triggers { code: 'provider_unavailable', retryable: true }. */
  readonly trigger_provider_unavailable: string;
  /** Triggers { code: 'malformed_response', retryable: false } (shape-drift drill). */
  readonly trigger_malformed_response: string;
} = {
  clean: '1HGCM82633A004352',
  accident: '2C3KA43R08H129584',
  branded_title: '3FAKE00SALVAGE001',
  trigger_rate_limited: 'TESTRATELM1T00429',
  trigger_provider_unavailable: 'TESTUNAVA1LBL0503',
  trigger_malformed_response: 'TESTMALF0RMED0500',
};

/**
 * Reserved trigger VINs → the retryable/alert error they simulate (design D2).
 * `auth` is deliberately absent: there are no credentials in this package to
 * fail, and that absence is the structural mock-only enforcement.
 */
export const TRIGGER_ERRORS: ReadonlyMap<
  Vin,
  { code: AdapterErrorCode; retryable: boolean; message: string }
> = new Map([
  [
    FIXTURE_VINS.trigger_rate_limited,
    {
      code: 'rate_limited',
      retryable: true,
      message: 'simulated provider rate limit (reserved trigger VIN)',
    },
  ],
  [
    FIXTURE_VINS.trigger_provider_unavailable,
    {
      code: 'provider_unavailable',
      retryable: true,
      message: 'simulated provider timeout/5xx (reserved trigger VIN)',
    },
  ],
  [
    FIXTURE_VINS.trigger_malformed_response,
    {
      code: 'malformed_response',
      retryable: false,
      message: 'simulated provider shape drift (reserved trigger VIN)',
    },
  ],
]);

/**
 * Per-provider tables. Same well-known VINs, deliberately DIVERGENT details
 * (owner_count / accident_count), as real Carfax vs AutoCheck reports diverge —
 * proving callers depend only on the interface, never on one provider's answer
 * being canonical (design D4).
 */
export const CARFAX_FIXTURES: ReadonlyMap<Vin, HistoryFixture> = new Map([
  [FIXTURE_VINS.clean, { accident_count: 0, title_brands: [], owner_count: 1 }],
  [FIXTURE_VINS.accident, { accident_count: 2, title_brands: [], owner_count: 3 }],
  [
    FIXTURE_VINS.branded_title,
    { accident_count: 1, title_brands: ['salvage', 'flood'], owner_count: 4 },
  ],
]);

export const AUTOCHECK_FIXTURES: ReadonlyMap<Vin, HistoryFixture> = new Map([
  [FIXTURE_VINS.clean, { accident_count: 0, title_brands: [], owner_count: 2 }],
  [FIXTURE_VINS.accident, { accident_count: 1, title_brands: [], owner_count: 2 }],
  [
    FIXTURE_VINS.branded_title,
    { accident_count: 2, title_brands: ['salvage', 'flood'], owner_count: 5 },
  ],
]);
