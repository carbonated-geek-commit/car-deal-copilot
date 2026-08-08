/**
 * T-004 tester — OPT-IN live smoke against the real public NHTSA endpoints
 * (design D7; task note "must be opt-in (skipped by default)").
 *
 * Runs ONLY when NHTSA_LIVE=1 is set in the environment; the default run —
 * and CI — never touches the network (AC-4). The endpoints are the free,
 * credential-free vPIC + Recall APIs on the CLAUDE.md "build and wire now"
 * list; no credential exists or is used.
 */

import { describe, expect, it } from 'vitest';
import { createNhtsaVehicleDataAdapter, toVehicleData } from '@adapters/nhtsa';
import { expectOk } from './helpers.js';

const LIVE = typeof process !== 'undefined' && process.env['NHTSA_LIVE'] === '1';

// A well-known production VIN (2013 Ford F-150) with published recalls.
const VIN = '1FTFW1ET5DFC10312';

describe.skipIf(!LIVE)('NHTSA live smoke (opt-in: NHTSA_LIVE=1)', () => {
  it(
    'decodes a real VIN, fetches recalls, and assembles VehicleData',
    async () => {
      const adapter = createNhtsaVehicleDataAdapter({ timeoutMs: 30_000 });

      const decode = expectOk(await adapter.decodeVin(VIN));
      expect(decode.vin).toBe(VIN);
      expect(decode.make.toUpperCase()).toBe('FORD');
      expect(decode.year).toBe(2013);

      const recalls = expectOk(await adapter.getRecalls(VIN));
      expect(Array.isArray(recalls)).toBe(true);

      const vd = toVehicleData(decode, recalls, new Date().toISOString());
      expect(vd.vin).toBe(VIN);
      expect('history' in vd).toBe(false);
    },
    90_000,
  );
});
