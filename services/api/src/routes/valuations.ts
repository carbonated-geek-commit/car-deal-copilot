/**
 * The market-value seam (docs/design/T-020.md §2.2; ADR-007; Q20).
 *
 * ADR-007 compares an offer to the RETAIL band of **that** `VehicleInstance`'s
 * `ValuationSnapshot`, so the lookup is keyed by `VehicleInstance.id` and never
 * by make/model — specs/00: "A `ValuationSnapshot` is meaningless without a
 * `VehicleInstance`."
 *
 * The API never selects a band and never compares anything: it hands the WHOLE
 * snapshot to the evaluability derivation, mirroring T-011 D8. Band selection
 * is the flag engine's, fixed by ADR-007, and overturning it takes a superseding
 * ADR rather than a config value.
 *
 * `NO_VALUATIONS` is the E2 default and is honest rather than empty-by-neglect:
 * no valuation adapter is reachable from this service (T-019's import allowlist
 * excludes `@adapters/*`, and nothing in this epic writes a snapshot), so every
 * lookup resolves `undefined` and every fair-price answer is UNEVALUABLE. That
 * is exactly what specs/00 requires — "a thread with no valuation yet reports
 * fair-price as **unevaluable** … never as 'fine'".
 */

import type { ValuationSnapshot } from '@core';

export interface ValuationLookup {
  snapshotFor(vehicle_instance_id: string): Promise<ValuationSnapshot | undefined>;
}

/** The E2 default. Every lookup is `undefined` ⇒ `above_market` is UNEVALUABLE. */
export const NO_VALUATIONS: ValuationLookup = {
  snapshotFor(): Promise<ValuationSnapshot | undefined> {
    return Promise.resolve(undefined);
  },
};

/** Test/fixture seam: a fixed table keyed by `VehicleInstance.id`. */
export function createFixedValuationLookup(
  snapshots: readonly ValuationSnapshot[],
): ValuationLookup {
  const by_instance = new Map(snapshots.map((snapshot) => [snapshot.vehicle_instance_id, snapshot]));
  return {
    snapshotFor(vehicle_instance_id: string): Promise<ValuationSnapshot | undefined> {
      return Promise.resolve(by_instance.get(vehicle_instance_id));
    },
  };
}
