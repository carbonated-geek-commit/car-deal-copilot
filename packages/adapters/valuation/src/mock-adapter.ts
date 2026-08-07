/**
 * INTERNAL shared machinery for the fixture-backed valuation mocks.
 *
 * Not part of the design's named file list (docs/design/T-003.md §1) — it holds
 * the logic both mocks share so neither file re-implements it. Nothing here is
 * provider-shaped: fixtures speak `MoneyCents`, requests/responses are the
 * spine types from `@core` (anti-corruption rule, specs/00). The public types
 * declared here (`ValuationFixtureRow`, `MockValuationOptions`) are re-exported
 * through `src/index.ts`, the package's only import surface.
 *
 * mock_only: no HTTP, no credentials, no env reads — fixtures are the entire
 * data source. Pure functions of (request, fixtures, clock); naturally
 * idempotent (docs/design/T-003.md §4.1).
 */

import type {
  AdapterErrorCode,
  AdapterResult,
  IsoTimestamp,
  MoneyCents,
  ValuationAdapter,
  ValuationRequest,
  ValuationSnapshot,
  Vin,
} from '@core';

// ---- fixture shape (neutral: MoneyCents fields, NOT a provider payload shape) ----
export interface ValuationFixtureRow {
  /** Match key A: exact 17-char VIN (matched case-insensitively, stored uppercased). */
  vin?: Vin;
  /** Match key B: normalized make|model|year. At least one of vin/spec_key per row. */
  spec_key?: { make: string; model: string; year: number };
  /**
   * The values this mock source knows. KBB fixture rows populate trade_in/retail;
   * Manheim rows populate wholesale. The type does not enforce the split —
   * the default fixture files do (docs/design/T-003.md §3).
   */
  values?: {
    wholesale?: MoneyCents;
    trade_in?: MoneyCents;
    retail?: MoneyCents;
  };
  /** Opt-in deterministic mileage plausibility (D7): linear, floored at 0. */
  mileage_adjustment?: {
    baseline_mileage: number;
    /** Subtracted per mile ABOVE baseline, added per mile below. */
    cents_per_mile: number;
  };
  /**
   * Simulated failure (D4): when set, the mock returns this AdapterErrorCode
   * instead of values — lets downstream tests exercise every error path offline.
   * A row has values XOR error.
   */
  error?: AdapterErrorCode;
}

export interface MockValuationOptions {
  /** Defaults to the package's built-in fixture set for that mock. */
  fixtures?: readonly ValuationFixtureRow[];
  /** Injectable clock for deterministic fetched_at (D8). Defaults to system UTC now. */
  now?: () => IsoTimestamp;
}

/** `retryable` derived from code, per the spine taxonomy (T-001 §3.1, §5.1). */
export function isRetryable(code: AdapterErrorCode): boolean {
  return code === 'rate_limited' || code === 'provider_unavailable';
}

function systemNowUtc(): IsoTimestamp {
  return new Date().toISOString();
}

function normalizeVin(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Case-insensitive, trimmed `make|model|year` key; `trim` field ignored (D4). */
function specKey(make: string, model: string, year: number): string {
  return `${make.trim().toLowerCase()}|${model.trim().toLowerCase()}|${year}`;
}

function invalidInput(source: string, message: string): AdapterResult<never> {
  return {
    ok: false,
    error: { code: 'invalid_input', retryable: false, source, message },
  };
}

/**
 * Shared fixture-backed implementation of the ONE spine `ValuationAdapter`
 * interface. Both mocks are this function with a different id + fixture set.
 */
export function createFixtureMockAdapter(
  source: string,
  defaultFixtures: readonly ValuationFixtureRow[],
  opts: MockValuationOptions = {},
): ValuationAdapter {
  const fixtures = opts.fixtures ?? defaultFixtures;
  const now = opts.now ?? systemNowUtc;

  return {
    source,
    async getValuation(
      req: ValuationRequest,
    ): Promise<AdapterResult<ValuationSnapshot>> {
      // ---- validation (D4; §4.1 row 1) — log-safe messages, never a VIN ----
      if (req.mileage !== undefined && (!Number.isFinite(req.mileage) || req.mileage < 0)) {
        return invalidInput(source, 'valuation request mileage must be a non-negative finite number');
      }

      let row: ValuationFixtureRow | undefined;
      let echoVehicle: ValuationSnapshot['vehicle'];

      if ('vin' in req.vehicle) {
        const vin = normalizeVin(req.vehicle.vin);
        if (vin.length !== 17) {
          return invalidInput(source, 'valuation request VIN must be 17 characters after trim');
        }
        echoVehicle = { vin };
        row = fixtures.find((r) => r.vin !== undefined && normalizeVin(r.vin) === vin);
      } else {
        const { make, model, year } = req.vehicle;
        if (make.trim() === '' || model.trim() === '' || year === undefined) {
          return invalidInput(
            source,
            'spec-keyed valuation request requires non-empty make, model, and a year',
          );
        }
        echoVehicle = req.vehicle;
        const key = specKey(make, model, year);
        row = fixtures.find(
          (r) =>
            r.spec_key !== undefined &&
            specKey(r.spec_key.make, r.spec_key.model, r.spec_key.year) === key,
        );
      }

      if (row === undefined) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            retryable: false,
            source,
            message: 'no valuation data available for the requested vehicle',
          },
        };
      }

      // ---- simulated failure rows (D4; §4.1) ----
      if (row.error !== undefined) {
        return {
          ok: false,
          error: {
            code: row.error,
            retryable: isRetryable(row.error),
            source,
            message: `simulated ${row.error} from valuation fixture`,
          },
        };
      }

      // ---- values, with opt-in deterministic mileage adjustment (D7) ----
      const base = row.values ?? {};
      const adj = row.mileage_adjustment;
      const delta =
        adj !== undefined && req.mileage !== undefined
          ? Math.round((adj.baseline_mileage - req.mileage) * adj.cents_per_mile)
          : 0;
      const apply = (v: MoneyCents): MoneyCents => Math.max(0, v + delta);

      const values: ValuationSnapshot['values'] = {};
      if (base.wholesale !== undefined) values.wholesale = apply(base.wholesale);
      if (base.trade_in !== undefined) values.trade_in = apply(base.trade_in);
      if (base.retail !== undefined) values.retail = apply(base.retail);

      const snapshot: ValuationSnapshot = {
        vehicle: echoVehicle,
        values,
        source,
        fetched_at: now(),
        ...(req.mileage !== undefined ? { mileage: req.mileage } : {}),
      };
      return { ok: true, value: snapshot };
    },
  };
}
