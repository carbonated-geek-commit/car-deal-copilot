/**
 * Shared internal factory both provider modules parameterize (design §1).
 *
 * Behavioral contract: docs/design/T-001.md §5.1 as applied by
 * docs/design/T-005.md §4. `getHistory` is a pure lookup + clock stamp:
 * never throws across the boundary, performs no I/O whatsoever (no HTTP, no
 * fs, no env reads), holds no state — same VIN in, same fixture out, always.
 */

import type {
  AdapterResult,
  IsoTimestamp,
  VehicleHistoryAdapter,
  VehicleHistorySummary,
  Vin,
} from '@core';
import { TRIGGER_ERRORS, type HistoryFixture } from './fixtures.js';

/** Options shared by both mock factories. */
export interface MockHistoryOptions {
  /**
   * Injectable clock for deterministic `fetched_at` in tests (design D3).
   * Defaults to system time. This is the ONLY nondeterminism in the package.
   */
  now?: () => IsoTimestamp;
}

/** Syntactic VIN check: exactly 17 chars, charset A-HJ-NPR-Z0-9 (no I/O/Q). */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export function createMockHistoryAdapter(
  source: string,
  fixtures: ReadonlyMap<Vin, HistoryFixture>,
  options?: MockHistoryOptions,
): VehicleHistoryAdapter {
  const now = options?.now ?? (() => new Date().toISOString());

  return {
    source,
    async getHistory(vin: Vin): Promise<AdapterResult<VehicleHistorySummary>> {
      // Bad input — caller bug, fix upstream (T-001 §5.1). The message never
      // echoes the raw input: log-safe by contract.
      if (typeof vin !== 'string' || !VIN_PATTERN.test(vin)) {
        return {
          ok: false,
          error: {
            code: 'invalid_input',
            retryable: false,
            source,
            message:
              'VIN failed syntactic validation (expected 17 chars, A-HJ-NPR-Z0-9)',
          },
        };
      }

      // Reserved trigger VINs simulate the retryable/alert codes (design D2).
      const trigger = TRIGGER_ERRORS.get(vin);
      if (trigger !== undefined) {
        return {
          ok: false,
          error: {
            code: trigger.code,
            retryable: trigger.retryable,
            source,
            message: trigger.message,
          },
        };
      }

      // Unknown well-formed VIN → not_found, terminal (design D1): mocks are
      // fixture-driven lookup tables; no synthesized data. VIN-less message.
      const fixture = fixtures.get(vin);
      if (fixture === undefined) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            retryable: false,
            source,
            message: 'no history data for the requested VIN',
          },
        };
      }

      // Fresh arrays/objects per call so callers can never mutate fixtures.
      const value: VehicleHistorySummary = {
        vin,
        accident_count: fixture.accident_count,
        title_brands: [...fixture.title_brands],
        ...(fixture.owner_count !== undefined
          ? { owner_count: fixture.owner_count }
          : {}),
        source,
        fetched_at: now(),
      };
      return { ok: true, value };
    },
  };
}
