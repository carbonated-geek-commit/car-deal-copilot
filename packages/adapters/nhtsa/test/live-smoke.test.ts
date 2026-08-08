/**
 * T-013 tester — OPT-IN live smoke against the real public NHTSA endpoints
 * (design T-004 D7; T-013 AC-8 "all tests still running against recorded
 * fixtures rather than the network").
 *
 * SKIPPED BY DEFAULT. It runs ONLY when NHTSA_LIVE=1 is set; the default run —
 * and CI — never touches the network. Per ADR-008's reporting rule this is
 * reported as SKIPPED, never as a pass, whenever its opt-in flag is absent.
 *
 * The endpoints are the free, credential-free vPIC + Recall APIs on the
 * CLAUDE.md "build and wire now" list; no credential exists or is used. The
 * mock-only feeds (KBB, Manheim, Carfax, AutoCheck, credit) have no live gate
 * at all — there is deliberately nothing here that could reach them.
 */

import { describe, expect, it } from 'vitest';
import type { VehicleInstance } from '@core';
import { createNhtsaVehicleDataAdapter, toVehicleData } from '@adapters/nhtsa';
import { expectOk } from './helpers.js';

const LIVE = typeof process !== 'undefined' && process.env['NHTSA_LIVE'] === '1';

// A well-known production VIN (2013 Ford F-150) with published recalls.
const VIN = '1FTFW1ET5DFC10312';

/** v0.5: the record is bound to the dealership's specific car, not to the VIN. */
const INSTANCE: VehicleInstance = {
  id: 'vi-live-smoke',
  vin: VIN,
  year: 2013,
  condition: 'used',
  additions: [],
};

describe.skipIf(!LIVE)('NHTSA live smoke (opt-in: NHTSA_LIVE=1)', () => {
  it(
    'decodes a real VIN, fetches recalls, and assembles an instance-bound VehicleData',
    async () => {
      const adapter = createNhtsaVehicleDataAdapter({ timeoutMs: 30_000 });

      const decode = expectOk(await adapter.decodeVin(VIN));
      expect(decode.vin).toBe(VIN);
      expect(decode.make.toUpperCase()).toBe('FORD');
      expect(decode.year).toBe(2013);

      const recalls = expectOk(await adapter.getRecalls(VIN));
      expect(Array.isArray(recalls)).toBe(true);

      const vd = toVehicleData(INSTANCE, { decode, recalls }, new Date().toISOString());
      expect(vd.vehicle_instance_id).toBe('vi-live-smoke');
      expect('vin' in vd).toBe(false);
      expect('history' in vd).toBe(false);
    },
    90_000,
  );
});
