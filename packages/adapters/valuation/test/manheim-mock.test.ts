/**
 * T-003 tester — Manheim-mock adapter (docs/design/T-003.md §6, mock tests 1–6;
 * error table §4.1). Wholesale/auction (MMR) role: snapshots carry `wholesale`
 * ONLY (specs/00 "Valuation" table row 2).
 *
 * Fully offline (AC-5). Mirrors kbb-mock.test.ts on the shared machinery and
 * adds the Manheim-side fixture-discipline and error rows.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ValuationAdapter, ValuationRequest } from '@core';
import {
  MANHEIM_DEFAULT_FIXTURES,
  MANHEIM_MOCK_SOURCE,
  createManheimMockAdapter,
  type ValuationFixtureRow,
} from '@adapters/valuation';

const T0 = '2026-08-07T12:00:00.000Z';
const clock = () => T0;

const TESLA_VIN = '5YJ3E1EA7KF317000'; // 2019 Tesla Model 3 fixture (VIN-keyed)

describe('createManheimMockAdapter — spine interface & provenance (AC-1, AC-2)', () => {
  it('returns exactly the one spine ValuationAdapter type', () => {
    expectTypeOf(createManheimMockAdapter).returns.toEqualTypeOf<ValuationAdapter>();
  });

  it('source is the mock id string', () => {
    expect(MANHEIM_MOCK_SOURCE).toBe('mock-manheim');
    expect(createManheimMockAdapter().source).toBe(MANHEIM_MOCK_SOURCE);
  });
});

describe('getValuation — happy paths (§6 tests 1–2)', () => {
  it('known VIN → ok snapshot with wholesale ONLY, pinned fetched_at', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: TESLA_VIN } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const snap = res.value;
    expect(snap.values.wholesale).toBe(2_050_000);
    expect(snap.values.trade_in).toBeUndefined(); // wholesale role never supplies these
    expect(snap.values.retail).toBeUndefined();
    expect(snap.values.private_party).toBeUndefined();
    expect(snap.source).toBe(MANHEIM_MOCK_SOURCE);
    expect(snap.fetched_at).toBe(T0);
    expect(snap.vehicle).toEqual({ vin: TESLA_VIN });
  });

  it('VIN matches case-insensitively; echo is uppercased (D4)', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: TESLA_VIN.toLowerCase() } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.vehicle).toEqual({ vin: TESLA_VIN });
  });

  it('spec-key match is case-insensitive and ignores trim', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const res = await adapter.getValuation({
      vehicle: { make: 'FORD', model: 'f-150', year: 2019, trim: 'Lariat' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.wholesale).toBe(2_600_000);
  });

  it('spec without a year → invalid_input (D4)', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { make: 'Ford', model: 'F-150' } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid_input');
    expect(res.error.retryable).toBe(false);
    expect(res.error.source).toBe(MANHEIM_MOCK_SOURCE);
  });
});

describe('getValuation — error paths (§4.1, §6 test 3)', () => {
  it('unknown vehicle → not_found, retryable:false, VIN-free message', async () => {
    const unknownVin = '9XYZZ99Z9XZ999999';
    const adapter = createManheimMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: unknownVin } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not_found');
    expect(res.error.retryable).toBe(false);
    expect(res.error.message).not.toContain(unknownVin);
  });

  it('bad VIN length → invalid_input; negative mileage → invalid_input', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const shortVin = await adapter.getValuation({ vehicle: { vin: 'ABC123' } });
    expect(!shortVin.ok && shortVin.error.code === 'invalid_input').toBe(true);
    const negMiles = await adapter.getValuation({ vehicle: { vin: TESLA_VIN }, mileage: -5 });
    expect(!negMiles.ok && negMiles.error.code === 'invalid_input').toBe(true);
  });

  it('default fixture: 2015 BMW X5 simulates provider_unavailable (retryable:true) — the partial-blend row', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { make: 'BMW', model: 'X5', year: 2015 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('provider_unavailable');
    expect(res.error.retryable).toBe(true);
    expect(res.error.source).toBe(MANHEIM_MOCK_SOURCE);
  });

  it('default fixture: 2012 Jaguar XJ simulates rate_limited (retryable:true)', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { make: 'Jaguar', model: 'XJ', year: 2012 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('rate_limited');
    expect(res.error.retryable).toBe(true);
  });
});

describe('getValuation — mileage adjustment & purity (D7/D8, §6 tests 4–5)', () => {
  it('deterministic linear delta on the Tesla fixture (baseline 30_000, 10 c/mi)', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const above = await adapter.getValuation({ vehicle: { vin: TESLA_VIN }, mileage: 40_000 });
    const below = await adapter.getValuation({ vehicle: { vin: TESLA_VIN }, mileage: 20_000 });
    expect(above.ok && below.ok).toBe(true);
    if (!above.ok || !below.ok) return;
    expect(above.value.values.wholesale).toBe(2_050_000 - 100_000);
    expect(below.value.values.wholesale).toBe(2_050_000 + 100_000);
  });

  it('adjustment floors at 0', async () => {
    const fixtures: readonly ValuationFixtureRow[] = [
      {
        spec_key: { make: 'Junker', model: 'Special', year: 1999 },
        values: { wholesale: 500 },
        mileage_adjustment: { baseline_mileage: 0, cents_per_mile: 100 },
      },
    ];
    const adapter = createManheimMockAdapter({ fixtures, now: clock });
    const res = await adapter.getValuation({
      vehicle: { make: 'Junker', model: 'Special', year: 1999 },
      mileage: 999_999,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.wholesale).toBe(0);
  });

  it('two identical calls produce deeply equal results (idempotent, §4.4)', async () => {
    const adapter = createManheimMockAdapter({ now: clock });
    const req: ValuationRequest = { vehicle: { vin: TESLA_VIN }, mileage: 33_000 };
    const a = await adapter.getValuation(req);
    const b = await adapter.getValuation(req);
    expect(a).toEqual(b);
  });
});

describe('default fixture discipline (§3, §6 test 6)', () => {
  it('every Manheim value row populates wholesale ONLY — never trade_in/retail', () => {
    expect(MANHEIM_DEFAULT_FIXTURES.length).toBeGreaterThan(0);
    for (const row of MANHEIM_DEFAULT_FIXTURES) {
      expect(row.values !== undefined || row.error !== undefined).toBe(true);
      expect(row.values !== undefined && row.error !== undefined).toBe(false);
      if (row.values !== undefined) {
        expect(row.values.wholesale).toBeDefined();
        expect(row.values.trade_in).toBeUndefined();
        expect(row.values.retail).toBeUndefined();
      }
      expect(row.vin !== undefined || row.spec_key !== undefined).toBe(true);
    }
  });
});
