/**
 * INTERNAL shared machinery for the fixture-backed valuation mocks.
 *
 * v0.5 spine (T-013, docs/design/T-013.md §2, §3): a valuation is ALWAYS of one
 * specific car. The request carries the deal's `VehicleTarget` (make/model — the
 * anchor a `VehicleInstance` deliberately lacks) plus the `VehicleInstance`
 * itself, which supplies the four priceable attributes specs/00 "Budget ceiling
 * vs. fair price" says no source can price without: year, trim, mileage,
 * condition. Every snapshot is stamped `vehicle_instance_id = req.instance.id`
 * and there is no code path that produces one without an instance (AC-1).
 *
 * Nothing here is provider-shaped: fixtures speak `MoneyCents`, requests and
 * responses are the spine types from `@core` (anti-corruption rule, specs/00).
 * The public types declared here (`ValuationFixtureRow`, `MockValuationOptions`)
 * are re-exported through `src/index.ts`, the package's only import surface.
 *
 * mock_only: no HTTP, no credentials, no env reads — fixtures are the entire
 * data source. Pure functions of (request, fixtures, clock); naturally
 * idempotent (docs/design/T-013.md §7.1).
 */

import type {
  AdapterErrorCode,
  AdapterResult,
  IsoTimestamp,
  MoneyCents,
  ValuationAdapter,
  ValuationRequest,
  ValuationSnapshot,
  VehicleCondition,
  Vin,
} from '@core';

// ---- fixture shape (neutral: MoneyCents fields, NOT a provider payload shape) ----

/**
 * One mock source's knowledge of one vehicle. Neutral by construction:
 * `MoneyCents` fields only, no provider field names, no wire shape.
 * A row has `values` XOR `error`.
 */
export interface ValuationFixtureRow {
  /**
   * Match key A — OPTIONAL, matched case-insensitively after trim.
   * NOT validated: Q16 makes the VIN the buyer's own record, not a lookup key,
   * so an unmatched or malformed VIN falls through to `spec_key` and is never
   * an error (docs/design/T-013.md D1).
   */
  vin?: Vin;

  /**
   * Match key B — `target.make` | `target.model` | `instance.year` (D2).
   * `make`/`model` can only come from the deal anchor: a `VehicleInstance`
   * carries neither, precisely so a thread cannot contradict the anchor.
   */
  spec_key?: { make: string; model: string; year: number };

  /**
   * Bands this source knows. KBB rows populate `trade_in` / `retail` /
   * `private_party` (Q15: KBB private-party value is the private-party source);
   * Manheim rows populate `wholesale`. The type does not enforce the split —
   * the default fixture files and their tests do.
   */
  values?: {
    wholesale?: MoneyCents;
    trade_in?: MoneyCents;
    retail?: MoneyCents;
    /**
     * Q15 RESOLVED: KBB private-party value. There is deliberately NO comps or
     * marketplace source anywhere in this package — buyer-entered comps are
     * user data, not an external feed (D4, D5).
     */
    private_party?: MoneyCents;
  };

  /** Opt-in deterministic mileage plausibility: linear, floored at 0. Uses `instance.mileage`. */
  mileage_adjustment?: {
    baseline_mileage: number;
    /** Subtracted per mile ABOVE baseline, added per mile below. */
    cents_per_mile: number;
  };

  /** Deterministic delta per condition; unlisted condition ⇒ 0 (D3). */
  condition_adjustment?: Partial<Record<VehicleCondition, MoneyCents>>;

  /** Deterministic delta per trim, keyed by trimmed+lowercased trim; unlisted ⇒ 0 (D3). */
  trim_adjustment?: Readonly<Record<string, MoneyCents>>;

  /**
   * Simulated provider failure: when set, the mock returns this
   * `AdapterErrorCode` instead of values — lets downstream callers exercise
   * every error path offline. A row has `values` XOR `error`.
   */
  error?: AdapterErrorCode;
}

export interface MockValuationOptions {
  /** Defaults to the package's built-in fixture set for that mock. */
  fixtures?: readonly ValuationFixtureRow[];
  /** Injectable clock for deterministic `captured_at`. Defaults to system UTC now. */
  now?: () => IsoTimestamp;
}

/** `retryable` derived from code, per the spine taxonomy (@core `AdapterError`). */
export function isRetryable(code: AdapterErrorCode): boolean {
  return code === 'rate_limited' || code === 'provider_unavailable';
}

function systemNowUtc(): IsoTimestamp {
  return new Date().toISOString();
}

function normalizeVin(raw: string): string {
  return raw.trim().toUpperCase();
}

function normalizeTrim(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Case-insensitive, trimmed `make|model|year` key. `trim` and `condition` are NOT match keys (D2). */
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
      const { target, instance } = req;

      // ---- validation (§7.1) — static, log-safe messages; never a VIN, never a band ----
      // A snapshot must name a car (AC-1); a blank id satisfies the type but
      // violates the spec, so it is rejected here rather than stamped.
      if (instance.id.trim() === '') {
        return invalidInput(source, 'valuation request requires a non-empty vehicle instance id');
      }
      // The deal anchor is the ONLY lawful make/model source (D2).
      if (target.make.trim() === '' || target.model.trim() === '') {
        return invalidInput(source, 'valuation request requires a non-empty target make and model');
      }
      if (!Number.isInteger(instance.year)) {
        return invalidInput(source, 'valuation request vehicle instance year must be an integer');
      }
      if (
        instance.mileage !== undefined &&
        (!Number.isFinite(instance.mileage) || instance.mileage < 0)
      ) {
        return invalidInput(
          source,
          'valuation request mileage must be a non-negative finite number',
        );
      }

      // ---- matching (§3.2), deterministic and in order ----
      // 1. VIN, when present AND some row carries the same one. NO length or
      //    charset check: Q16 makes the VIN unvalidated, so a malformed VIN is
      //    not an error — it simply matches nothing and falls through (D1).
      let row: ValuationFixtureRow | undefined;
      if (instance.vin !== undefined) {
        const vin = normalizeVin(instance.vin);
        row = fixtures.find((r) => r.vin !== undefined && normalizeVin(r.vin) === vin);
      }
      // 2. Otherwise the spec key: target make/model + instance year.
      if (row === undefined) {
        const key = specKey(target.make, target.model, instance.year);
        row = fixtures.find(
          (r) =>
            r.spec_key !== undefined &&
            specKey(r.spec_key.make, r.spec_key.model, r.spec_key.year) === key,
        );
      }

      // 3. No row → not_found, terminal: retrying the same request cannot change it.
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

      // ---- simulated failure rows (§7.1) ----
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

      // ---- band computation (§3.3): fixed order, integer cents throughout ----
      // All three optional instance attributes are load-bearing (D3) — a request
      // that carries an attribute which provably moves nothing would be a
      // request-shape gesture, not a valuation.
      const base = row.values ?? {};

      const mileageAdj = row.mileage_adjustment;
      const mileageDelta =
        mileageAdj !== undefined && instance.mileage !== undefined
          ? Math.round((mileageAdj.baseline_mileage - instance.mileage) * mileageAdj.cents_per_mile)
          : 0;
      const conditionDelta = row.condition_adjustment?.[instance.condition] ?? 0;
      const trimDelta =
        instance.trim !== undefined
          ? (row.trim_adjustment?.[normalizeTrim(instance.trim)] ?? 0)
          : 0;

      const delta = mileageDelta + conditionDelta + trimDelta;
      const apply = (v: MoneyCents): MoneyCents => Math.max(0, v + delta);

      // `instance.additions` is deliberately NOT priced: priced add-ons live on
      // the offer as `OfferFee`, and inventing a per-addition delta would be drift.
      const snapshot: ValuationSnapshot = {
        vehicle_instance_id: instance.id,
        ...(base.wholesale !== undefined ? { wholesale: apply(base.wholesale) } : {}),
        ...(base.trade_in !== undefined ? { trade_in: apply(base.trade_in) } : {}),
        ...(base.retail !== undefined ? { retail: apply(base.retail) } : {}),
        ...(base.private_party !== undefined ? { private_party: apply(base.private_party) } : {}),
        source,
        captured_at: now(),
      };
      return { ok: true, value: snapshot };
    },
  };
}
