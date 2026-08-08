/**
 * T-013 tester — `toVehicleData` rebound to the `VehicleInstance`
 * (docs/design/T-013.md §4, §7.4, D7–D11; AC-3, AC-5, AC-6, AC-8, AC-11)
 * plus the public export surface / anti-corruption boundary.
 *
 * Everything here is offline: the recorded fixtures under test/fixtures/ and an
 * injected `fetchFn` are the entire data source (AC-8). NHTSA is the live-
 * approved feed, but the default suite never reaches the network.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  IsoTimestamp,
  RecallRecord,
  VehicleData,
  VehicleDataAdapter,
  VehicleHistorySummary,
  VehicleInstance,
  VinDecode,
} from '@core';
import {
  createNhtsaVehicleDataAdapter,
  NHTSA_SOURCE,
  toVehicleData,
  type NhtsaAdapterOptions,
  type VehicleDataParts,
} from '@adapters/nhtsa';
import * as publicApi from '@adapters/nhtsa';
import { clone, expectOk, jsonResponse, loadFixture, recordingFetch } from './helpers.js';

const VIN = '1FTFW1ET5DFC10312';
const T0: IsoTimestamp = '2026-08-07T12:00:00.000Z';
const INSTANCE_ID = 'vi-f150-thread-1';

/** The specific car one dealership is offering. Carries no make/model by design. */
const INSTANCE: VehicleInstance = {
  id: INSTANCE_ID,
  vin: VIN,
  year: 2013,
  trim: 'SuperCrew-SSV',
  mileage: 96_000,
  condition: 'used',
  additions: ['tow package'],
};

/** The same car in the normal launch case: no VIN (Q16 — absent is not an error). */
const VINLESS_INSTANCE: VehicleInstance = {
  id: 'vi-no-vin',
  year: 2013,
  condition: 'used',
  additions: [],
};

const DECODE: VinDecode = {
  vin: VIN,
  make: 'FORD',
  model: 'F-150',
  year: 2013,
  trim: 'SuperCrew-SSV',
  body_class: 'Pickup',
  engine: 'GTDI',
};

const RECALLS: RecallRecord[] = [
  {
    campaign_id: '16V643000',
    component: 'LATCHES/LOCKS/LINKAGES:DOORS:LATCH',
    summary: 'Door latches may not latch.',
    issued_at: '2016-09-06T00:00:00.000Z',
  },
];

const HISTORY: VehicleHistorySummary = {
  vin: VIN,
  accident_count: 1,
  title_brands: [],
  owner_count: 2,
  source: 'mock-carfax',
  fetched_at: T0,
};

describe('AC-3 / D7 — every VehicleData is bound to one VehicleInstance', () => {
  it('stamps vehicle_instance_id from the instance itself, never from the decode', () => {
    const vd = toVehicleData(INSTANCE, { decode: DECODE, recalls: RECALLS }, T0);
    expect(vd.vehicle_instance_id).toBe(INSTANCE_ID);
    // The decode's VIN is data ABOUT the car; the binding is the instance id.
    expect(vd.decode?.vin).toBe(VIN);
  });

  it('emits exactly the spine fields — no vin, no fetched_at (both removed in v0.5)', () => {
    const vd = toVehicleData(INSTANCE, { decode: DECODE, recalls: RECALLS }, T0);
    expect(Object.keys(vd).sort()).toEqual(
      ['captured_at', 'decode', 'recalls', 'vehicle_instance_id'].sort(),
    );
    for (const removed of ['vin', 'fetched_at', 'vehicle', 'reliability']) {
      expect(removed in vd).toBe(false);
    }
  });

  it('an unbound VehicleData is unrepresentable — the assembler REQUIRES the instance', () => {
    const _typeOnly = (): void => {
      // @ts-expect-error — a bare id string is not a VehicleInstance
      void toVehicleData(INSTANCE_ID, { recalls: [] }, T0);
      // @ts-expect-error — the positional pre-v0.5 form (decode, recalls, ts) is gone
      void toVehicleData(DECODE, RECALLS, T0);
      // @ts-expect-error — the instance argument cannot be omitted
      void toVehicleData({ recalls: [] }, T0);
    };
    expect(typeof _typeOnly).toBe('function');
  });

  it('a VIN-less instance still produces a properly bound record (Q16)', () => {
    const vd = toVehicleData(VINLESS_INSTANCE, { recalls: [] }, T0);
    expect(vd.vehicle_instance_id).toBe('vi-no-vin');
    expect('decode' in vd).toBe(false);
  });

  it('two threads on the same physical VIN yield two distinct instance-bound records', () => {
    const a = toVehicleData({ ...INSTANCE, id: 'vi-a' }, { decode: DECODE, recalls: [] }, T0);
    const b = toVehicleData({ ...INSTANCE, id: 'vi-b' }, { decode: DECODE, recalls: [] }, T0);
    expect(a.vehicle_instance_id).toBe('vi-a');
    expect(b.vehicle_instance_id).toBe('vi-b');
  });

  it('uses the caller-supplied captured_at verbatim — staleness policy is caller-side', () => {
    const later: IsoTimestamp = '2027-01-01T00:00:00.000Z';
    expect(toVehicleData(INSTANCE, { recalls: [] }, later).captured_at).toBe(later);
  });
});

describe('D9 / ADR-005 — assemble only from SUCCESSFUL observations', () => {
  it('recalls is required on the parts type: there is no "we did not look" state', () => {
    const _typeOnly = (): void => {
      // @ts-expect-error — `recalls` is required; an omitted array cannot mean "unknown"
      const _p: VehicleDataParts = { decode: DECODE };
      void _p;
    };
    expect(typeof _typeOnly).toBe('function');
  });

  it('an empty recall list is an ANSWER and survives assembly verbatim', () => {
    const vd = toVehicleData(INSTANCE, { decode: DECODE, recalls: [] }, T0);
    expect(vd.recalls).toEqual([]);
    expect(Array.isArray(vd.recalls)).toBe(true);
  });

  it('history is optional and its absence does not invalidate decode + recalls', () => {
    const withoutHistory = toVehicleData(INSTANCE, { decode: DECODE, recalls: RECALLS }, T0);
    expect('history' in withoutHistory).toBe(false);
    const withHistory = toVehicleData(
      INSTANCE,
      { decode: DECODE, recalls: RECALLS, history: HISTORY },
      T0,
    );
    expect(withHistory.history).toEqual(HISTORY);
  });

  it('decode is optional — a record can carry recalls without a decode', () => {
    const vd = toVehicleData(INSTANCE, { recalls: RECALLS }, T0);
    expect('decode' in vd).toBe(false);
    expect(vd.recalls).toHaveLength(1);
  });
});

describe('§7.4 — the assembler is pure and total (no failure path, no clock, no validation)', () => {
  it('does not mutate its inputs', () => {
    const instanceIn = clone(INSTANCE);
    const recallsIn = clone(RECALLS);
    const decodeIn = clone(DECODE);
    toVehicleData(instanceIn, { decode: decodeIn, recalls: recallsIn }, T0);
    expect(instanceIn).toEqual(INSTANCE);
    expect(recallsIn).toEqual(RECALLS);
    expect(decodeIn).toEqual(DECODE);
  });

  it('copies the recall array so a caller cannot mutate the source through the record', () => {
    const source: RecallRecord[] = [...RECALLS];
    const vd = toVehicleData(INSTANCE, { recalls: source }, T0);
    vd.recalls.push({ ...RECALLS[0]!, campaign_id: 'INJECTED' });
    expect(source).toHaveLength(1);
    expect(source.map((r) => r.campaign_id)).not.toContain('INJECTED');
  });

  it('is deterministic — identical inputs give deeply equal records', () => {
    const parts: VehicleDataParts = { decode: DECODE, recalls: RECALLS, history: HISTORY };
    expect(toVehicleData(INSTANCE, parts, T0)).toEqual(toVehicleData(INSTANCE, parts, T0));
  });

  it('never throws: a blank instance id is the write path’s problem, not the assembler’s', () => {
    expect(() => toVehicleData({ ...INSTANCE, id: '' }, { recalls: [] }, T0)).not.toThrow();
  });

  it('the assembled record JSON round-trips unchanged (bus/store payload)', () => {
    const vd: VehicleData = toVehicleData(
      INSTANCE,
      { decode: DECODE, recalls: RECALLS, history: HISTORY },
      T0,
    );
    expect(JSON.parse(JSON.stringify(vd))).toEqual(vd);
  });
});

describe('D10 — "no VIN ⇒ no record" is enforced by the COMPILER, not a runtime guard', () => {
  it('an instance with an absent VIN cannot be passed to decodeVin / getRecalls', () => {
    const adapter = createNhtsaVehicleDataAdapter({
      fetchFn: (() => {
        throw new Error('unused');
      }) as unknown as typeof fetch,
    });
    const _typeOnly = (): void => {
      // @ts-expect-error — instance.vin is `Vin | undefined`; decodeVin takes `Vin`
      void adapter.decodeVin(VINLESS_INSTANCE.vin);
      // @ts-expect-error — same for getRecalls
      void adapter.getRecalls(VINLESS_INSTANCE.vin);
    };
    expect(typeof _typeOnly).toBe('function');
  });

  it('a narrowed VIN is accepted — the guard is narrowing, not validation', async () => {
    const vpic = loadFixture('vpic-decode-success.json');
    const { fetchFn } = recordingFetch(() => jsonResponse(vpic));
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    const vin = INSTANCE.vin;
    expect(vin).toBeDefined();
    if (vin === undefined) return;
    expect(expectOk(await adapter.decodeVin(vin)).make).toBe('FORD');
  });
});

describe('AC-6 / D11 — no decode is a precondition for accepting an instance', () => {
  it('the VIN-less instance is a first-class VehicleInstance, not an error state', () => {
    expect(VINLESS_INSTANCE.vin).toBeUndefined();
    expect('vin' in VINLESS_INSTANCE).toBe(false);
    // It assembles, it is bound, and nothing rejected it.
    expect(toVehicleData(VINLESS_INSTANCE, { recalls: [] }, T0).vehicle_instance_id).toBe(
      'vi-no-vin',
    );
  });

  it('the decode→recalls two-step stays INTERNAL: callers see one VIN-keyed call', async () => {
    const vpic = loadFixture('vpic-decode-success.json');
    const recallsFixture = loadFixture('recalls-success.json');
    const { fetchFn, calls } = recordingFetch((url) =>
      url.includes('/DecodeVinValues/') ? jsonResponse(vpic) : jsonResponse(recallsFixture),
    );
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    expectOk(await adapter.getRecalls(VIN));
    expect(calls).toHaveLength(2); // decode then recallsByVehicle — invisible to the caller
    expect(Object.keys(adapter).sort()).toEqual(['decodeVin', 'getRecalls', 'source']);
  });
});

describe('AC-8 — end-to-end composition against RECORDED fixtures (never the network)', () => {
  it('adapter outputs assemble into an instance-bound VehicleData', async () => {
    const vpic = loadFixture('vpic-decode-success.json');
    const recallsFixture = loadFixture('recalls-success.json');
    const { fetchFn, calls } = recordingFetch((url) =>
      url.includes('/DecodeVinValues/') ? jsonResponse(vpic) : jsonResponse(recallsFixture),
    );
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    const decode = expectOk(await adapter.decodeVin(VIN));
    const recalls = expectOk(await adapter.getRecalls(VIN));
    const vd: VehicleData = toVehicleData(INSTANCE, { decode, recalls }, T0);

    expect(vd.vehicle_instance_id).toBe(INSTANCE_ID);
    expect(vd.decode?.make).toBe('FORD');
    expect(vd.recalls).toHaveLength(2);
    expect(vd.captured_at).toBe(T0);
    // Every byte came from the injected fetch — no real request was made.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.url).toMatch(/^https:\/\/(vpic\.nhtsa|api\.nhtsa)/);
  });

  it('a zero-campaign vehicle assembles with recalls: [] — an answer, not a placeholder', async () => {
    const vpic = loadFixture('vpic-decode-success.json');
    const empty = loadFixture('recalls-empty.json');
    const { fetchFn } = recordingFetch((url) =>
      url.includes('/DecodeVinValues/') ? jsonResponse(vpic) : jsonResponse(empty),
    );
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    const recalls = expectOk(await adapter.getRecalls(VIN));
    expect(recalls).toEqual([]);
    expect(toVehicleData(INSTANCE, { recalls }, T0).recalls).toEqual([]);
  });
});

describe('public export surface — anti-corruption boundary (AC-5)', () => {
  it('exports exactly NHTSA_SOURCE, createNhtsaVehicleDataAdapter, toVehicleData', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'NHTSA_SOURCE',
      'createNhtsaVehicleDataAdapter',
      'toVehicleData',
    ]);
  });

  it('exposes no raw provider shape or internal narrowing helper', () => {
    const api = publicApi as unknown as Record<string, unknown>;
    for (const forbidden of [
      'narrowVpicDecode',
      'narrowRecalls',
      'normalizeVin',
      'VpicDecodeNarrowing',
      'RecallsNarrowing',
    ]) {
      expect(api[forbidden]).toBeUndefined();
    }
  });

  it('NHTSA_SOURCE is the adapter id', () => {
    expect(NHTSA_SOURCE).toBe('nhtsa-vpic');
  });

  it('factory returns the frozen @core VehicleDataAdapter contract — nothing more', () => {
    expectTypeOf(createNhtsaVehicleDataAdapter).returns.toEqualTypeOf<VehicleDataAdapter>();
    const adapter = createNhtsaVehicleDataAdapter({
      fetchFn: (() => {
        throw new Error('unused');
      }) as unknown as typeof fetch,
    });
    expect(adapter.source).toBe('nhtsa-vpic');
    expect(Object.keys(adapter).sort()).toEqual(['decodeVin', 'getRecalls', 'source']);
  });

  it('options accept only the four documented knobs, all optional', () => {
    const full: NhtsaAdapterOptions = {
      fetchFn: (() => {
        throw new Error('unused');
      }) as unknown as typeof fetch,
      vpicBaseUrl: 'https://vpic.example.test/api',
      recallsBaseUrl: 'https://recalls.example.test',
      timeoutMs: 5_000,
    };
    expect(() => createNhtsaVehicleDataAdapter(full)).not.toThrow();
    expect(() => createNhtsaVehicleDataAdapter()).not.toThrow();
    const _typeOnly = (): void => {
      // @ts-expect-error — no credential knob exists (NHTSA is free and credential-free)
      const _bad: NhtsaAdapterOptions = { ...full, apiKey: 'x' };
      void _bad;
    };
    expect(typeof _typeOnly).toBe('function');
  });

  it('adapter is stateless across calls — two adapters do not interfere', async () => {
    const vpic = loadFixture('vpic-decode-success.json');
    const { fetchFn: f1 } = recordingFetch(() => jsonResponse(vpic));
    const { fetchFn: f2 } = recordingFetch(() => jsonResponse(vpic));
    const a = createNhtsaVehicleDataAdapter({ fetchFn: f1 });
    const b = createNhtsaVehicleDataAdapter({ fetchFn: f2 });
    const [ra, rb] = await Promise.all([a.decodeVin(VIN), b.decodeVin(VIN)]);
    expect(expectOk(ra)).toEqual(expectOk(rb));
  });
});
