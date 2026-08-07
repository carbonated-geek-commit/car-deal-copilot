/**
 * T-004 tester — `toVehicleData` assembly (design D5, AC-3) and the public
 * export surface / anti-corruption boundary (design §1, §5, AC-1).
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  IsoTimestamp,
  RecallRecord,
  VehicleData,
  VehicleDataAdapter,
  VinDecode,
} from '@core';
import {
  createNhtsaVehicleDataAdapter,
  NHTSA_SOURCE,
  toVehicleData,
  type NhtsaAdapterOptions,
} from '@adapters/nhtsa';
import * as publicApi from '@adapters/nhtsa';
import { clone, expectOk, jsonResponse, loadFixture, recordingFetch } from './helpers.js';

const VIN = '1FTFW1ET5DFC10312';
const T0: IsoTimestamp = '2026-08-07T12:00:00.000Z';

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

describe('toVehicleData — cached, timestamped aggregate (AC-3, D5)', () => {
  it('assembles the spine VehicleData from decode + recalls + caller timestamp', () => {
    const vd = toVehicleData(DECODE, RECALLS, T0);
    expect(vd).toEqual({
      vin: VIN,
      decode: DECODE,
      recalls: RECALLS,
      fetched_at: T0,
    });
    expect(vd.vin).toBe(vd.decode.vin); // aggregate keyed by the decode's VIN
  });

  it('uses the caller-supplied fetched_at verbatim — staleness policy is caller-side (§4.3)', () => {
    const later: IsoTimestamp = '2027-01-01T00:00:00.000Z';
    expect(toVehicleData(DECODE, RECALLS, later).fetched_at).toBe(later);
  });

  it('omits history entirely — Carfax/AutoCheck is T-005 territory (D5)', () => {
    const vd = toVehicleData(DECODE, RECALLS, T0);
    expect('history' in vd).toBe(false);
    // Exactly the aggregate's fields, nothing extra.
    expect(Object.keys(vd).sort()).toEqual(['decode', 'fetched_at', 'recalls', 'vin']);
  });

  it('accepts an empty recall list (a clean vehicle is a valid aggregate)', () => {
    const vd = toVehicleData(DECODE, [], T0);
    expect(vd.recalls).toEqual([]);
  });

  it('is pure — does not mutate its inputs', () => {
    const decodeIn = clone(DECODE);
    const recallsIn = clone(RECALLS);
    toVehicleData(decodeIn, recallsIn, T0);
    expect(decodeIn).toEqual(DECODE);
    expect(recallsIn).toEqual(RECALLS);
  });

  it('composes end-to-end from adapter outputs against the recorded fixtures', async () => {
    const vpic = loadFixture('vpic-decode-success.json');
    const recallsFixture = loadFixture('recalls-success.json');
    const { fetchFn } = recordingFetch((url) =>
      url.includes('/DecodeVinValues/') ? jsonResponse(vpic) : jsonResponse(recallsFixture),
    );
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    const decode = expectOk(await adapter.decodeVin(VIN));
    const recalls = expectOk(await adapter.getRecalls(VIN));
    const vd: VehicleData = toVehicleData(decode, recalls, T0);
    expect(vd.vin).toBe(VIN);
    expect(vd.decode.make).toBe('FORD');
    expect(vd.recalls).toHaveLength(2);
    expect(vd.fetched_at).toBe(T0);
  });
});

describe('public export surface — anti-corruption boundary (§1, §5, AC-1)', () => {
  it('exports exactly NHTSA_SOURCE, createNhtsaVehicleDataAdapter, toVehicleData', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'NHTSA_SOURCE',
      'createNhtsaVehicleDataAdapter',
      'toVehicleData',
    ]);
  });

  it('exposes no raw provider shape or internal narrowing helper', () => {
    const api = publicApi as Record<string, unknown>;
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

  it('NHTSA_SOURCE is the design-D4 adapter id', () => {
    expect(NHTSA_SOURCE).toBe('nhtsa-vpic');
  });

  it('factory returns the frozen @core VehicleDataAdapter contract — nothing more', () => {
    expectTypeOf(createNhtsaVehicleDataAdapter).returns.toEqualTypeOf<VehicleDataAdapter>();
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn: (() => {
      throw new Error('unused');
    }) as unknown as typeof fetch });
    expect(adapter.source).toBe('nhtsa-vpic');
    expect(typeof adapter.decodeVin).toBe('function');
    expect(typeof adapter.getRecalls).toBe('function');
    // No webhook/comms/write surface of any kind (§4.5): exactly the contract's members.
    expect(Object.keys(adapter).sort()).toEqual(['decodeVin', 'getRecalls', 'source']);
  });

  it('options type accepts only the four documented knobs (§2)', () => {
    const full: NhtsaAdapterOptions = {
      fetchFn: (() => {
        throw new Error('unused');
      }) as unknown as typeof fetch,
      vpicBaseUrl: 'https://vpic.example.test/api',
      recallsBaseUrl: 'https://recalls.example.test',
      timeoutMs: 5_000,
    };
    expect(() => createNhtsaVehicleDataAdapter(full)).not.toThrow();
    // All options optional: a bare factory call must construct (defaults live).
    expect(() => createNhtsaVehicleDataAdapter()).not.toThrow();
    expectTypeOf<NhtsaAdapterOptions>().toHaveProperty('fetchFn');
    expectTypeOf<NhtsaAdapterOptions>().toHaveProperty('timeoutMs');
  });

  it('adapter is stateless across calls — two adapters from one options bag do not interfere', async () => {
    const vpic = loadFixture('vpic-decode-success.json');
    const { fetchFn: f1 } = recordingFetch(() => jsonResponse(vpic));
    const { fetchFn: f2 } = recordingFetch(() => jsonResponse(vpic));
    const a = createNhtsaVehicleDataAdapter({ fetchFn: f1 });
    const b = createNhtsaVehicleDataAdapter({ fetchFn: f2 });
    const [ra, rb] = await Promise.all([a.decodeVin(VIN), b.decodeVin(VIN)]);
    expect(expectOk(ra)).toEqual(expectOk(rb));
  });
});
