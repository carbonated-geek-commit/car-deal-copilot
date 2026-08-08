/**
 * T-003 tester — KBB-mock adapter (docs/design/T-003.md §6, mock tests 1–6;
 * error table §4.1).
 *
 * Fully offline (AC-5): fixtures + injected clock are the entire data source.
 * Kit-mandate touchpoints: purity/idempotency (at-least-once redelivery safe,
 * §4.4), log-safe error messages (no VIN/PII), anti-corruption (factory returns
 * the ONE spine `ValuationAdapter`).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ValuationAdapter, ValuationRequest } from '@core';
import {
  KBB_DEFAULT_FIXTURES,
  KBB_MOCK_SOURCE,
  createKbbMockAdapter,
  type ValuationFixtureRow,
} from '@adapters/valuation';

const T0 = '2026-08-07T12:00:00.000Z';
const clock = () => T0;

const ACCORD_VIN = '1HGCV1F34LA123456'; // 2020 Honda Accord fixture (VIN-keyed)

describe('createKbbMockAdapter — spine interface & provenance (AC-1, AC-2)', () => {
  it('returns exactly the one spine ValuationAdapter type', () => {
    expectTypeOf(createKbbMockAdapter).returns.toEqualTypeOf<ValuationAdapter>();
  });

  it('source is the mock id string', () => {
    expect(KBB_MOCK_SOURCE).toBe('mock-kbb');
    expect(createKbbMockAdapter().source).toBe(KBB_MOCK_SOURCE);
  });
});

describe('getValuation — VIN-keyed happy path (§6 test 1)', () => {
  it('known VIN → ok snapshot with retail/trade-in role fields ONLY, pinned fetched_at', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN } });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const snap = res.value;
    expect(snap.values.trade_in).toBe(1_850_000);
    expect(snap.values.retail).toBe(2_150_000);
    expect(snap.values.wholesale).toBeUndefined(); // KBB role never supplies wholesale
    expect(snap.values.private_party).toBeUndefined();
    expect(snap.source).toBe(KBB_MOCK_SOURCE);
    expect(snap.fetched_at).toBe(T0); // AC-4: timestamped from the injected clock
    expect(snap.vehicle).toEqual({ vin: ACCORD_VIN });
    expect('mileage' in snap).toBe(false); // no mileage requested → omitted
  });

  it('VIN matches case-insensitively with surrounding whitespace trimmed (D4)', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({
      vehicle: { vin: `  ${ACCORD_VIN.toLowerCase()}  ` },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.vehicle).toEqual({ vin: ACCORD_VIN }); // echoed uppercased
    expect(res.value.values.retail).toBe(2_150_000);
  });
});

describe('getValuation — spec-keyed matching (§6 test 2)', () => {
  it('matches make|model|year case-insensitively; trim field ignored', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({
      vehicle: { make: '  toyota ', model: ' rav4 ', year: 2021, trim: 'XLE Premium' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.trade_in).toBe(2_400_000);
    expect(res.value.values.retail).toBe(2_720_000);
  });

  it('spec without a year → invalid_input, not retryable (D4)', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { make: 'Toyota', model: 'RAV4' } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid_input');
    expect(res.error.retryable).toBe(false);
    expect(res.error.source).toBe(KBB_MOCK_SOURCE);
  });

  it('blank make or model → invalid_input', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { make: '   ', model: 'RAV4', year: 2021 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid_input');
  });
});

describe('getValuation — validation error paths (§4.1 row 1)', () => {
  it('VIN not 17 chars after trim → invalid_input', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: '1HGCV1F34' } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid_input');
    expect(res.error.retryable).toBe(false);
  });

  it('negative mileage → invalid_input', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN }, mileage: -1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid_input');
  });

  it('non-finite mileage → invalid_input', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN }, mileage: Number.NaN });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid_input');
  });
});

describe('getValuation — not_found and simulated-error rows (§6 test 3)', () => {
  it('unknown vehicle → not_found, retryable:false, VIN-free message (§4.1)', async () => {
    const unknownVin = '9XYZZ99Z9XZ999999';
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: unknownVin } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not_found');
    expect(res.error.retryable).toBe(false);
    expect(res.error.source).toBe(KBB_MOCK_SOURCE);
    expect(res.error.message).not.toContain(unknownVin); // log-safe: no VIN leaks
  });

  it('default fixture: 2014 Audi A4 simulates rate_limited (retryable:true)', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { make: 'Audi', model: 'A4', year: 2014 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('rate_limited');
    expect(res.error.retryable).toBe(true);
  });

  it('default fixture: 2012 Jaguar XJ simulates provider_unavailable (retryable:true)', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { make: 'Jaguar', model: 'XJ', year: 2012 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('provider_unavailable');
    expect(res.error.retryable).toBe(true);
  });

  it('custom fixture rows cover the terminal codes: auth / malformed_response → retryable:false', async () => {
    const fixtures: readonly ValuationFixtureRow[] = [
      { spec_key: { make: 'A', model: 'B', year: 2000 }, error: 'auth' },
      { spec_key: { make: 'C', model: 'D', year: 2001 }, error: 'malformed_response' },
    ];
    const adapter = createKbbMockAdapter({ fixtures, now: clock });

    const authRes = await adapter.getValuation({ vehicle: { make: 'A', model: 'B', year: 2000 } });
    expect(authRes.ok).toBe(false);
    if (!authRes.ok) {
      expect(authRes.error.code).toBe('auth');
      expect(authRes.error.retryable).toBe(false);
    }

    const malformedRes = await adapter.getValuation({ vehicle: { make: 'C', model: 'D', year: 2001 } });
    expect(malformedRes.ok).toBe(false);
    if (!malformedRes.ok) {
      expect(malformedRes.error.code).toBe('malformed_response');
      expect(malformedRes.error.retryable).toBe(false);
    }
  });
});

describe('getValuation — deterministic mileage adjustment (D7, §6 test 4)', () => {
  it('mileage above baseline lowers values linearly; below raises them', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    // Accord fixture: baseline 45_000 mi, 8 cents/mile.
    const above = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN }, mileage: 55_000 });
    const below = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN }, mileage: 35_000 });
    expect(above.ok && below.ok).toBe(true);
    if (!above.ok || !below.ok) return;
    // delta = (45_000 - mileage) * 8
    expect(above.value.values.trade_in).toBe(1_850_000 - 80_000);
    expect(above.value.values.retail).toBe(2_150_000 - 80_000);
    expect(below.value.values.trade_in).toBe(1_850_000 + 80_000);
    expect(below.value.values.retail).toBe(2_150_000 + 80_000);
    expect(above.value.mileage).toBe(55_000); // mileage echoed on the snapshot
  });

  it('no mileage on the request → baseline values unchanged', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.trade_in).toBe(1_850_000);
    expect(res.value.values.retail).toBe(2_150_000);
  });

  it('adjustment floors at 0 — values never go negative', async () => {
    const fixtures: readonly ValuationFixtureRow[] = [
      {
        spec_key: { make: 'Junker', model: 'Special', year: 1999 },
        values: { trade_in: 1_000, retail: 2_000 },
        mileage_adjustment: { baseline_mileage: 0, cents_per_mile: 100 },
      },
    ];
    const adapter = createKbbMockAdapter({ fixtures, now: clock });
    const res = await adapter.getValuation({
      vehicle: { make: 'Junker', model: 'Special', year: 1999 },
      mileage: 1_000_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.trade_in).toBe(0);
    expect(res.value.values.retail).toBe(0);
  });

  it('rows without mileage_adjustment ignore mileage for values but still echo it', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    // 2022 Honda Civic fixture has no mileage_adjustment.
    const res = await adapter.getValuation({
      vehicle: { make: 'Honda', model: 'Civic', year: 2022 },
      mileage: 90_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.trade_in).toBe(2_020_000);
    expect(res.value.values.retail).toBe(2_290_000);
    expect(res.value.mileage).toBe(90_000);
  });
});

describe('purity / idempotency (§4.1, §6 test 5 — at-least-once redelivery safe)', () => {
  it('two identical calls produce deeply equal results', async () => {
    const adapter = createKbbMockAdapter({ now: clock });
    const req: ValuationRequest = { vehicle: { vin: ACCORD_VIN }, mileage: 50_000 };
    const a = await adapter.getValuation(req);
    const b = await adapter.getValuation(req);
    expect(a).toEqual(b);
  });
});

describe('default fixture discipline (§3, §6 test 6)', () => {
  it('every KBB value row populates only trade_in/retail — never wholesale or private_party', () => {
    expect(KBB_DEFAULT_FIXTURES.length).toBeGreaterThan(0);
    for (const row of KBB_DEFAULT_FIXTURES) {
      // values XOR error (D4)
      expect(row.values !== undefined || row.error !== undefined).toBe(true);
      expect(row.values !== undefined && row.error !== undefined).toBe(false);
      if (row.values !== undefined) {
        expect(row.values.wholesale).toBeUndefined();
        expect(row.values.trade_in).toBeDefined();
        expect(row.values.retail).toBeDefined();
      }
      // every row has at least one match key
      expect(row.vin !== undefined || row.spec_key !== undefined).toBe(true);
    }
  });
});
