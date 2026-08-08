/**
 * Year drift is a SOFT GUIDE, and the VIN is user-entered and unvalidated
 * (docs/design/T-020.md §5.2, §5.3; AC-5, AC-6; Q16).
 *
 * specs/00 "Cardinality invariants": year drift is "a **soft guide, not a hard
 * rejection**". Q16: "VIN is **user-entered and unvalidated** at launch — the
 * buyer's own record, not a lookup key."
 *
 * Both are absences, so both are asserted as absences: "no 4xx, ever" across the
 * boundary years and the no-range case, and "no lookup happened" proved by a
 * spy that records every call rather than by reading the source.
 */

import type { DealerThread, VehicleInstance } from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_A,
  bodyOf,
  boot,
  call,
  scenario,
  spyValuations,
  vehicleBody,
  type Booted,
  type Scenario,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const putInstance = (
  s: Scenario,
  body: Record<string, unknown>,
): Promise<import('fastify').LightMyRequestResponse> =>
  call(s.booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, body);

interface WarRoomThread {
  readonly year_drift?: { readonly instance_year: number; readonly year_range: { from: number; to: number } };
  readonly vehicle_instance?: VehicleInstance;
}

const warRoomThread = async (s: Scenario): Promise<WarRoomThread> => {
  const res = await call(s.booted, 'GET', `/deals/${s.deal_id}/war-room`, ACCOUNT_A);
  expect(res.statusCode).toBe(200);
  const threads = bodyOf<{ threads: readonly WarRoomThread[] }>(res).threads;
  const thread = threads[0];
  if (thread === undefined) throw new Error('no thread in war room');
  return thread;
};

describe('year drift is accepted, never rejected (AC-5)', () => {
  it('accepts every year in and around the range — no 4xx, ever', async () => {
    booted = await boot();
    const s = await scenario(booted); // year_range 2019..2023

    for (const year of [1900, 2000, 2018, 2019, 2021, 2023, 2024, 2100, 2200]) {
      const res = await putInstance(s, vehicleBody({ year }));
      expect(res.statusCode, `year ${String(year)}`).toBe(200);
      expect((bodyOf<DealerThread>(res).vehicle_instance as VehicleInstance).year).toBe(year);
    }
  });

  it('accepts a drifting year when the deal has NO range at all', async () => {
    booted = await boot();
    const s = await scenario(booted, {
      deal: { target_vehicle: { make: 'Honda', model: 'Accord' } },
    });

    const res = await putInstance(s, vehicleBody({ year: 1995 }));
    expect(res.statusCode).toBe(200);
    expect((await warRoomThread(s)).year_drift).toBeUndefined();
  });

  it('surfaces drift as an ADVISORY on the war-room view, not as a failure', async () => {
    booted = await boot();
    const s = await scenario(booted);

    await putInstance(s, vehicleBody({ year: 2016 }));
    expect((await warRoomThread(s)).year_drift).toEqual({
      instance_year: 2016,
      year_range: { from: 2019, to: 2023 },
    });
  });

  it('emits no advisory on the inclusive boundaries', async () => {
    for (const year of [2019, 2023]) {
      const b = await boot();
      try {
        const s = await scenario(b);
        await putInstance(s, vehicleBody({ year }));
        expect((await warRoomThread(s)).year_drift, `year ${String(year)}`).toBeUndefined();
      } finally {
        await b.close();
      }
    }
  });

  it('keeps the advisory a view — widening the guide clears it without touching the car', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await putInstance(s, vehicleBody({ year: 2016 }));
    expect((await warRoomThread(s)).year_drift).toBeDefined();

    await call(booted, 'PATCH', `/deals/${s.deal_id}`, ACCOUNT_A, {
      target_vehicle: { year_range: { from: 2015, to: 2024 } },
    });

    const after = await warRoomThread(s);
    expect(after.year_drift).toBeUndefined();
    expect(after.vehicle_instance?.year).toBe(2016);
  });
});

describe('VIN is user-entered and unvalidated (AC-6)', () => {
  it('accepts any non-empty string, including implausible ones', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const vins = ['A', '12345', 'not-a-vin', '1HGCV1F34LA012345', 'x'.repeat(64), '  padded-vin  '];
    for (const vin of vins) {
      const res = await putInstance(s, vehicleBody({ vin }));
      expect(res.statusCode, vin).toBe(200);
      const stored = (bodyOf<DealerThread>(res).vehicle_instance as VehicleInstance).vin;
      // Only the schema's own trim is applied — no checksum, no length-17 rule,
      // no charset rule beyond a printable bound.
      expect(stored).toBe(vin.trim());
    }
  });

  it('accepts an absent VIN and omits the key rather than nulling it', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const body = vehicleBody();
    delete body['vin'];
    const res = await putInstance(s, body);
    expect(res.statusCode).toBe(200);

    const instance = bodyOf<DealerThread>(res).vehicle_instance as VehicleInstance;
    expect(Object.keys(instance)).not.toContain('vin');
    expect(res.body).not.toContain('null');
  });

  it('rejects only a structurally impossible VIN — a blank one is not a record', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const res = await putInstance(s, vehicleBody({ vin: '   ' }));
    expect(res.statusCode).toBe(400);
  });

  it('gates acceptance on NO lookup of any kind — the spy is never called', async () => {
    const valuations = spyValuations();
    booted = await boot({ valuations });
    const s = await scenario(booted);

    const res = await putInstance(s, vehicleBody({ vin: 'not-a-vin' }));
    expect(res.statusCode).toBe(200);
    // The vehicle-instance write consults nothing external. The mock-only
    // integrations (KBB/Manheim/Carfax/AutoCheck) are not even importable from
    // this service, so acceptance cannot depend on one.
    expect(valuations.calls).toEqual([]);
  });
});
