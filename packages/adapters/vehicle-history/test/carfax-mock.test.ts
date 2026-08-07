/**
 * T-005 tester — Carfax mock (docs/design/T-005.md §6.1, §6.2, §6.4).
 *
 * Contract conformance, fixture paths (clean / accident / branded_title),
 * determinism under an injected clock, and cache-serializability. Fully
 * offline: the mock is a pure lookup + clock stamp.
 */
import { describe, expect, it } from 'vitest';
import type { VehicleHistoryAdapter, VehicleHistorySummary } from '@core';
import {
  CARFAX_MOCK_SOURCE,
  createCarfaxMock,
  FIXTURE_VINS,
} from '@adapters/vehicle-history';

const T0 = '2026-08-07T12:00:00.000Z';
const fixedClock = () => T0;

/** Unwrap an ok result or fail the test with the error. */
async function mustOk(
  adapter: VehicleHistoryAdapter,
  vin: string,
): Promise<VehicleHistorySummary> {
  const res = await adapter.getHistory(vin);
  if (!res.ok) {
    throw new Error(`expected ok for ${vin}, got ${res.error.code}`);
  }
  return res.value;
}

describe('createCarfaxMock — contract conformance (design §6.1)', () => {
  it('factory returns a VehicleHistoryAdapter with the exported source id', () => {
    const adapter: VehicleHistoryAdapter = createCarfaxMock({ now: fixedClock });
    expect(adapter.source).toBe(CARFAX_MOCK_SOURCE);
    expect(CARFAX_MOCK_SOURCE).toBe('mock-carfax');
    expect(typeof adapter.getHistory).toBe('function');
  });

  it('fixture-VIN results are valid VehicleHistorySummary values (field presence + types)', async () => {
    const adapter = createCarfaxMock({ now: fixedClock });
    for (const vin of [
      FIXTURE_VINS.clean,
      FIXTURE_VINS.accident,
      FIXTURE_VINS.branded_title,
    ]) {
      const value = await mustOk(adapter, vin);
      // Typecheck: assignment above already constrains to VehicleHistorySummary;
      // runtime-assert every contract field.
      expect(value.vin).toBe(vin);
      expect(typeof value.accident_count).toBe('number');
      expect(Number.isInteger(value.accident_count)).toBe(true);
      expect(Array.isArray(value.title_brands)).toBe(true);
      for (const brand of value.title_brands) {
        expect(typeof brand).toBe('string');
      }
      if (value.owner_count !== undefined) {
        expect(typeof value.owner_count).toBe('number');
      }
      expect(value.source).toBe(CARFAX_MOCK_SOURCE);
      expect(value.fetched_at).toBe(T0);
    }
  });
});

describe('createCarfaxMock — fixture paths (design §6.2; task note clean + branded)', () => {
  const adapter = createCarfaxMock({ now: fixedClock });

  it('clean VIN → 0 accidents, no title brands', async () => {
    const value = await mustOk(adapter, FIXTURE_VINS.clean);
    expect(value.accident_count).toBe(0);
    expect(value.title_brands).toEqual([]);
  });

  it('accident VIN → accidents >= 1, clean title (distinguishes accident from brand)', async () => {
    const value = await mustOk(adapter, FIXTURE_VINS.accident);
    expect(value.accident_count).toBeGreaterThanOrEqual(1);
    expect(value.title_brands).toEqual([]);
  });

  it('branded_title VIN → non-empty brands with accident(s)', async () => {
    const value = await mustOk(adapter, FIXTURE_VINS.branded_title);
    expect(value.title_brands.length).toBeGreaterThan(0);
    expect(value.accident_count).toBeGreaterThanOrEqual(1);
  });
});

describe('createCarfaxMock — determinism + timestamping (design §6.4, D3, AC-3)', () => {
  it('repeated calls with a fixed clock return deeply-equal results, unbounded call count', async () => {
    const adapter = createCarfaxMock({ now: fixedClock });
    const first = await mustOk(adapter, FIXTURE_VINS.branded_title);
    for (let i = 0; i < 5; i++) {
      expect(await mustOk(adapter, FIXTURE_VINS.branded_title)).toEqual(first);
    }
  });

  it('results survive a JSON round-trip unchanged (cache-serializable for VehicleData)', async () => {
    const adapter = createCarfaxMock({ now: fixedClock });
    const value = await mustOk(adapter, FIXTURE_VINS.branded_title);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it('fetched_at comes from the injected clock — a moving clock moves the stamp', async () => {
    let tick = 0;
    const adapter = createCarfaxMock({
      now: () => `2026-08-07T12:00:0${tick++}.000Z`,
    });
    const a = await mustOk(adapter, FIXTURE_VINS.clean);
    const b = await mustOk(adapter, FIXTURE_VINS.clean);
    expect(a.fetched_at).toBe('2026-08-07T12:00:00.000Z');
    expect(b.fetched_at).toBe('2026-08-07T12:00:01.000Z');
  });

  it('default clock (no options) stamps a parseable ISO timestamp', async () => {
    const adapter = createCarfaxMock();
    const value = await mustOk(adapter, FIXTURE_VINS.clean);
    expect(Number.isNaN(Date.parse(value.fetched_at))).toBe(false);
  });

  it('callers can never mutate fixtures — returned arrays are fresh per call', async () => {
    const adapter = createCarfaxMock({ now: fixedClock });
    const first = await mustOk(adapter, FIXTURE_VINS.branded_title);
    first.title_brands.push('MUTATED');
    first.accident_count = 999;
    const second = await mustOk(adapter, FIXTURE_VINS.branded_title);
    expect(second.title_brands).not.toContain('MUTATED');
    expect(second.accident_count).not.toBe(999);
  });
});
