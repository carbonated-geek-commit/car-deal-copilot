/**
 * T-013 tester — shared builders for the v0.5 valuation suite.
 *
 * Everything here constructs SPINE types from `@core` (ADR-001: no test-local
 * restatement of a domain type). The point of the builders is that a
 * `ValuationRequest` cannot be assembled without both halves — the deal's
 * `VehicleTarget` anchor and the dealership's `VehicleInstance` — which is the
 * structural form of AC-1/AC-2 ("a valuation of a bare make/model is not
 * expressible").
 *
 * Fully offline: fixtures + an injected clock are the entire data source.
 */

import { expect } from 'vitest';
import type {
  AdapterError,
  AdapterErrorCode,
  AdapterResult,
  IsoTimestamp,
  ValuationRequest,
  ValuationSnapshot,
  VehicleCondition,
  VehicleInstance,
  VehicleTarget,
  Vin,
} from '@core';

export const T_OLD: IsoTimestamp = '2026-08-07T10:00:00.000Z';
export const T0: IsoTimestamp = '2026-08-07T12:00:00.000Z';
export const T_NEW: IsoTimestamp = '2026-08-07T14:00:00.000Z';

/** Injectable clock — `captured_at` is never read from the system clock in tests. */
export const clockAt =
  (t: IsoTimestamp = T0) =>
  (): IsoTimestamp =>
    t;

/** 2020 Honda Accord — the VIN-keyed row present in BOTH default fixture files. */
export const ACCORD_VIN: Vin = '1HGCV1F34LA123456';
/** 2019 Tesla Model 3 — the second VIN-keyed row. */
export const TESLA_VIN: Vin = '5YJ3E1EA7KF317000';

export const INSTANCE_ID = 'vi-accord-thread-1';
export const OTHER_INSTANCE_ID = 'vi-accord-thread-2';

/** The deal anchor. `make`/`model` are `readonly` on the spine (write-once). */
export function target(make = 'Honda', model = 'Accord'): VehicleTarget {
  return { make, model };
}

export interface InstanceOverrides {
  id?: string;
  vin?: Vin;
  year?: number;
  trim?: string;
  mileage?: number;
  condition?: VehicleCondition;
  additions?: string[];
}

/**
 * A `VehicleInstance` — the specific car one dealership is offering. Note it
 * deliberately carries NO make/model: a thread that contradicts the deal anchor
 * is unrepresentable (spine comment on `VehicleInstance`).
 *
 * Optional fields are conditionally spread so `exactOptionalPropertyTypes`
 * stays honest — "absent" and "present but undefined" are different states.
 */
export function instance(o: InstanceOverrides = {}): VehicleInstance {
  return {
    id: o.id ?? INSTANCE_ID,
    ...(o.vin !== undefined ? { vin: o.vin } : {}),
    year: o.year ?? 2020,
    ...(o.trim !== undefined ? { trim: o.trim } : {}),
    ...(o.mileage !== undefined ? { mileage: o.mileage } : {}),
    condition: o.condition ?? 'used',
    additions: o.additions ?? [],
  };
}

/** The only lawful request shape: anchor + instance, nothing else. */
export function request(
  t: VehicleTarget = target(),
  i: VehicleInstance = instance({ vin: ACCORD_VIN }),
): ValuationRequest {
  return { target: t, instance: i };
}

/** A hand-rolled spine `ValuationSnapshot` for the pure-merge tests. */
export function snapshot(
  source: string,
  bands: Pick<
    ValuationSnapshot,
    'wholesale' | 'trade_in' | 'retail' | 'private_party'
  >,
  captured_at: IsoTimestamp = T0,
  vehicle_instance_id: string = INSTANCE_ID,
): ValuationSnapshot {
  return { vehicle_instance_id, ...bands, source, captured_at };
}

export function expectOk(res: AdapterResult<ValuationSnapshot>): ValuationSnapshot {
  if (!res.ok) {
    throw new Error(`expected ok, got ${res.error.code}: ${res.error.message}`);
  }
  return res.value;
}

/**
 * Unwrap the error arm and assert the uniform contract on the way through:
 * `retryable` is derived from `code` (only rate_limited / provider_unavailable
 * retry) and `source` is the adapter's own id.
 */
export function expectFailure(
  res: AdapterResult<ValuationSnapshot>,
  code: AdapterErrorCode,
  source: string,
): AdapterError {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('expected a failure result');
  expect(res.error.code).toBe(code);
  expect(res.error.source).toBe(source);
  expect(res.error.retryable).toBe(
    code === 'rate_limited' || code === 'provider_unavailable',
  );
  expect(typeof res.error.message).toBe('string');
  expect(res.error.message.length).toBeGreaterThan(0);
  return res.error;
}

/** Minimal hand-rolled spine adapter — proves the composite accepts ANY ValuationAdapter. */
export function fakeAdapter(
  source: string,
  result: (req: ValuationRequest) => AdapterResult<ValuationSnapshot>,
): { readonly source: string; getValuation(req: ValuationRequest): Promise<AdapterResult<ValuationSnapshot>> } {
  return { source, getValuation: async (req) => result(req) };
}
