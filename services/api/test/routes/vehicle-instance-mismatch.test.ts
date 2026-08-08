/**
 * A `VehicleInstance` that contradicts the deal anchor is REJECTED
 * (docs/design/T-020.md D3, D4, D5, D6, D8; AC-3, AC-4).
 *
 * specs/00 "Cardinality invariants": "the app **rejects the entry, highlights
 * that vehicle in red against its VIN, and offers to open a new Deal**. The
 * rejection is a receipt-trail event." specs/01 W2 says the same from the UI
 * side.
 *
 * The VIN is the load-bearing part of AC-3: the shared error envelope cannot
 * carry a rejected value (`toEnvelope` strips `details` for every code except
 * `invalid_request`), so its DURABLE home is the receipt entry. These tests
 * assert both halves — the VIN is absent from the wire and present in the trail.
 */

import type { DealerThread, VehicleInstance } from '@core';
import type { ReceiptEntry } from '@receipt';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_A,
  ACCOUNT_B,
  bodyOf,
  boot,
  call,
  errorCodeOf,
  scenario,
  vehicleBody,
  type Booted,
  type Scenario,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

const VIN = '1HGCV1F34LA012345';

const entriesOf = async (s: Scenario): Promise<readonly ReceiptEntry[]> => {
  const res = await call(s.booted, 'GET', `/deals/${s.deal_id}/receipt`, ACCOUNT_A);
  expect(res.statusCode).toBe(200);
  return bodyOf<{ entries: readonly ReceiptEntry[] }>(res).entries;
};

const threadOf = async (s: Scenario): Promise<DealerThread> => {
  const res = await call(s.booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A);
  expect(res.statusCode).toBe(200);
  return bodyOf<DealerThread>(res);
};

const putInstance = (s: Scenario, body: Record<string, unknown>, account = ACCOUNT_A): Promise<import('fastify').LightMyRequestResponse> =>
  call(s.booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, account, body);

describe('a matching vehicle is stored as the spine shape (D3)', () => {
  it('accepts and stores an instance with NO make/model field anywhere', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await putInstance(s, vehicleBody({ trim: 'EX-L', mileage: 84_210, additions: ['moonroof'] }));
    expect(res.statusCode).toBe(200);

    const instance = bodyOf<DealerThread>(res).vehicle_instance as VehicleInstance;
    expect(instance.id).toBe(`vi:${s.deal_id}:${s.dealership_id}`);
    expect(instance.vin).toBe(VIN);
    expect(instance.year).toBe(2021);
    // The wire-only claim is DISCARDED — `@core.VehicleInstance` has no field
    // for it, which is exactly why the check belongs at this boundary.
    expect(Object.keys(instance)).not.toContain('make');
    expect(Object.keys(instance)).not.toContain('model');
    expect(JSON.stringify(await threadOf(s))).not.toContain('"make"');
  });

  it('matches case- and whitespace-insensitively and nothing more (D4)', async () => {
    booted = await boot();
    const s = await scenario(booted);

    for (const claim of [
      { make: 'honda', model: 'accord' },
      { make: '  HONDA  ', model: '  Accord ' },
    ]) {
      const res = await putInstance(s, vehicleBody(claim));
      expect(res.statusCode, JSON.stringify(claim)).toBe(200);
    }

    // …and no synonym table: a nickname is a different vehicle until the
    // product rules on it.
    const chevy = await putInstance(s, vehicleBody({ make: 'Hond', model: 'Accord' }));
    expect(chevy.statusCode).toBe(422);
  });

  it('appends nothing to the trail when the vehicle matches', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await putInstance(s, vehicleBody());
    expect(await entriesOf(s)).toEqual([]);
  });
});

describe('a contradicting vehicle is rejected with 422 (AC-3)', () => {
  it('rejects a mismatched make and stores nothing', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await putInstance(s, vehicleBody({ make: 'Toyota', model: 'Accord' }));
    expect(res.statusCode).toBe(422);
    expect(errorCodeOf(res)).toBe('unprocessable');
    expect(res.body).toContain('open a new deal');

    expect('vehicle_instance' in (await threadOf(s))).toBe(false);
  });

  it('rejects a mismatched model and stores nothing', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await putInstance(s, vehicleBody({ make: 'Honda', model: 'Civic' }));
    expect(res.statusCode).toBe(422);
    expect('vehicle_instance' in (await threadOf(s))).toBe(false);
  });

  it('never replaces an already-stored instance with a rejected one', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await putInstance(s, vehicleBody({ year: 2021, trim: 'EX-L' }));

    const res = await putInstance(s, vehicleBody({ make: 'Toyota', model: 'Camry', year: 2016, trim: 'SE' }));
    expect(res.statusCode).toBe(422);

    const instance = (await threadOf(s)).vehicle_instance as VehicleInstance;
    expect(instance.year).toBe(2021);
    expect(instance.trim).toBe('EX-L');
  });

  it('does NOT echo the VIN or the rejected values on the wire (D6)', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await putInstance(s, vehicleBody({ make: 'Toyota', model: 'Camry', vin: VIN }));
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(VIN);
    expect(res.body).not.toContain('Toyota');
    expect(res.body).not.toContain('Camry');
    // …and the envelope carries no `details` for a 422 at all.
    expect(bodyOf<{ error: Record<string, unknown> }>(res).error['details']).toBeUndefined();
  });

  it('is 422 unprocessable and never the write-once 409 — two different invariants (D5)', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const res = await putInstance(s, vehicleBody({ make: 'Toyota', model: 'Camry' }));
    expect(res.statusCode).toBe(422);
    expect(res.statusCode).not.toBe(409);
  });
});

describe('the rejection is a receipt-trail event, and the VIN lives there (AC-4, D6)', () => {
  it('writes one mark naming the VIN, the submitted vehicle, and the anchor', async () => {
    booted = await boot();
    const s = await scenario(booted);

    await putInstance(s, vehicleBody({ make: 'Toyota', model: 'Camry', vin: VIN }));

    const entries = await entriesOf(s);
    expect(entries).toHaveLength(1);
    const entry = entries[0] as ReceiptEntry & { body: string };
    expect(entry.kind).toBe('note');
    expect(entry.direction).toBe('internal');
    expect(entry.author).toBe('buyer');
    expect(entry.body.startsWith('[system]')).toBe(true);
    expect(entry.body).toContain(`vin=${VIN}`);
    expect(entry.body).toContain(`dealership_id=${s.dealership_id}`);
    expect(entry.body).toContain('submitted=Toyota/Camry');
    expect(entry.body).toContain('anchor=Honda/Accord');
  });

  it('records a VIN-less rejection without inventing one (Q16 — an absent VIN is normal)', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const body = vehicleBody({ make: 'Toyota', model: 'Camry' });
    delete body['vin'];
    await putInstance(s, body);

    const entries = await entriesOf(s);
    expect(entries).toHaveLength(1);
    expect((entries[0] as ReceiptEntry & { body: string }).body).not.toContain('vin=');
  });

  it('keeps two substitution attempts as two marks (evidence prefers a duplicate to a loss)', async () => {
    booted = await boot();
    const s = await scenario(booted);

    await putInstance(s, vehicleBody({ make: 'Toyota', model: 'Camry', vin: 'VIN-A' }));
    await putInstance(s, vehicleBody({ make: 'Nissan', model: 'Altima', vin: 'VIN-B' }));

    const entries = await entriesOf(s);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => (e as ReceiptEntry & { seq: number }).seq)).toEqual([1, 2]);
    expect(JSON.stringify(entries)).toContain('VIN-A');
    expect(JSON.stringify(entries)).toContain('VIN-B');
  });

  it('collapses a client-anchored retry to one mark', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const attempt = vehicleBody({ make: 'Toyota', model: 'Camry', client_attempt_ref: 'ui-7f2c' });
    await putInstance(s, attempt);
    await putInstance(s, attempt);

    const entries = await entriesOf(s);
    expect(entries).toHaveLength(1);
    expect((entries[0] as ReceiptEntry & { dedupe_key?: string }).dedupe_key).toBe(
      `reject:instance_mismatch:${s.deal_id}:${s.dealership_id}:ui-7f2c`,
    );
  });

  it('never exposes another account’s rejection mark', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await putInstance(s, vehicleBody({ make: 'Toyota', model: 'Camry', vin: VIN }));

    const stranger = await call(s.booted, 'GET', `/deals/${s.deal_id}/receipt`, ACCOUNT_B);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).not.toContain(VIN);
  });

  it('refuses a foreign account’s submission before it can mark anything', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await putInstance(s, vehicleBody({ make: 'Toyota', model: 'Camry' }), ACCOUNT_B);
    expect(res.statusCode).toBe(404);
    // No mark was written for a request that was never authorized.
    expect(await entriesOf(s)).toEqual([]);
  });
});
