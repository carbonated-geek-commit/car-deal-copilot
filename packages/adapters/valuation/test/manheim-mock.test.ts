/**
 * T-013 tester — Manheim-mock adapter against the v0.5 spine
 * (docs/design/T-013.md §2, §3, §7.1; AC-1, AC-2, AC-5, AC-7, AC-9).
 *
 * The Manheim role supplies wholesale/auction (MMR) ONLY. Its complement is
 * asserted here as the other half of the "wholesale vs trade-in vs retail"
 * spread: this mock must never emit trade_in / retail / private_party, because
 * private-party value is KBB's band (Q15) and no comps source exists.
 *
 * Fully offline; the two mocks share one implementation, so the shape rules
 * (instance binding, load-bearing attributes, Q16 fall-through) are re-asserted
 * here against the OTHER fixture set rather than assumed from the KBB suite.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ValuationAdapter } from '@core';
import {
  MANHEIM_DEFAULT_FIXTURES,
  MANHEIM_MOCK_SOURCE,
  createManheimMockAdapter,
  type ValuationFixtureRow,
} from '@adapters/valuation';
import {
  ACCORD_VIN,
  INSTANCE_ID,
  T0,
  clockAt,
  expectFailure,
  expectOk,
  instance,
  request,
  target,
} from './helpers.js';

const manheim = (fixtures?: readonly ValuationFixtureRow[]): ValuationAdapter =>
  createManheimMockAdapter(
    fixtures !== undefined ? { fixtures, now: clockAt() } : { now: clockAt() },
  );

// Accord row (manheim.fixtures.ts): wholesale 1_700_000; mileage baseline
// 45_000 @ 8 c/mi; condition { certified: +80_000, new: +250_000 };
// trim { lx: -40_000, sport: +60_000, touring: +140_000 }.
const ACCORD_WHOLESALE = 1_700_000;

describe('createManheimMockAdapter — spine interface & provenance (AC-5)', () => {
  it('returns exactly the one spine ValuationAdapter type', () => {
    expectTypeOf(createManheimMockAdapter).returns.toEqualTypeOf<ValuationAdapter>();
  });

  it('source is the mock id string — no MMR/Manheim shape is expressible', () => {
    expect(MANHEIM_MOCK_SOURCE).toBe('mock-manheim');
    expect(createManheimMockAdapter().source).toBe(MANHEIM_MOCK_SOURCE);
    expect(Object.keys(createManheimMockAdapter()).sort()).toEqual(['getValuation', 'source']);
  });
});

describe('AC-1 / AC-9 — instance-bound wholesale-only snapshot', () => {
  it('stamps vehicle_instance_id and emits ONLY the wholesale band', async () => {
    const snap = expectOk(await manheim().getValuation(request()));
    expect(snap.vehicle_instance_id).toBe(INSTANCE_ID);
    expect(snap.wholesale).toBe(ACCORD_WHOLESALE);
    expect('trade_in' in snap).toBe(false);
    expect('retail' in snap).toBe(false);
    expect('private_party' in snap).toBe(false); // Q15: private-party is KBB's band
    expect(snap.source).toBe(MANHEIM_MOCK_SOURCE);
    expect(snap.captured_at).toBe(T0);
  });

  it('the snapshot carries exactly the flat spine fields', async () => {
    const snap = expectOk(await manheim().getValuation(request()));
    expect(Object.keys(snap).sort()).toEqual(
      ['captured_at', 'source', 'vehicle_instance_id', 'wholesale'].sort(),
    );
  });
});

describe('AC-2 / D3 — the priceable attributes move the wholesale band too', () => {
  it('mileage, condition and trim each change wholesale on their own', async () => {
    const adapter = manheim();
    const base = expectOk(await adapter.getValuation(request()));
    const mileage = expectOk(
      await adapter.getValuation(request(target(), instance({ vin: ACCORD_VIN, mileage: 55_000 }))),
    );
    const condition = expectOk(
      await adapter.getValuation(
        request(target(), instance({ vin: ACCORD_VIN, condition: 'certified' })),
      ),
    );
    const trim = expectOk(
      await adapter.getValuation(request(target(), instance({ vin: ACCORD_VIN, trim: 'Touring' }))),
    );
    expect(base.wholesale).toBe(ACCORD_WHOLESALE);
    expect(mileage.wholesale).toBe(ACCORD_WHOLESALE - 80_000);
    expect(condition.wholesale).toBe(ACCORD_WHOLESALE + 80_000);
    expect(trim.wholesale).toBe(ACCORD_WHOLESALE + 140_000);
  });

  it('a row without mileage_adjustment ignores mileage entirely (2022 Civic)', async () => {
    const adapter = manheim();
    const a = expectOk(
      await adapter.getValuation(request(target('Honda', 'Civic'), instance({ year: 2022 }))),
    );
    const b = expectOk(
      await adapter.getValuation(
        request(target('Honda', 'Civic'), instance({ year: 2022, mileage: 90_000 })),
      ),
    );
    expect(a.wholesale).toBe(1_900_000);
    expect(b.wholesale).toBe(1_900_000);
  });
});

describe('AC-6 / Q16 — VIN unvalidated on this mock as well', () => {
  it('a malformed VIN falls through to make/model/year rather than erroring', async () => {
    const snap = expectOk(
      await manheim().getValuation(request(target(), instance({ vin: 'not-a-vin' }))),
    );
    expect(snap.wholesale).toBe(ACCORD_WHOLESALE);
  });

  it('a VIN-less instance values fine — no decode precondition anywhere', async () => {
    const snap = expectOk(await manheim().getValuation(request(target(), instance())));
    expect(snap.wholesale).toBe(ACCORD_WHOLESALE);
  });
});

describe('§7.1 error table — Manheim side', () => {
  it('blank instance id / blank anchor / bad year / bad mileage → invalid_input', async () => {
    const adapter = manheim();
    expectFailure(
      await adapter.getValuation(request(target(), instance({ id: '' }))),
      'invalid_input',
      MANHEIM_MOCK_SOURCE,
    );
    expectFailure(
      await adapter.getValuation(request(target('', 'Accord'), instance())),
      'invalid_input',
      MANHEIM_MOCK_SOURCE,
    );
    expectFailure(
      await adapter.getValuation(request(target(), instance({ year: 2020.25 }))),
      'invalid_input',
      MANHEIM_MOCK_SOURCE,
    );
    expectFailure(
      await adapter.getValuation(request(target(), instance({ mileage: -5 }))),
      'invalid_input',
      MANHEIM_MOCK_SOURCE,
    );
  });

  it('unknown vehicle → not_found, terminal, VIN-free message', async () => {
    const vin = '9XYZZ99Z9XZ999999';
    const err = expectFailure(
      await manheim().getValuation(
        request(target('Nope', 'Nothing'), instance({ vin, year: 1990 })),
      ),
      'not_found',
      MANHEIM_MOCK_SOURCE,
    );
    expect(err.message).not.toContain(vin);
  });

  it('2015 BMW X5 fixture simulates provider_unavailable (retryable) — the partial-blend demo', async () => {
    expectFailure(
      await manheim().getValuation(request(target('BMW', 'X5'), instance({ year: 2015 }))),
      'provider_unavailable',
      MANHEIM_MOCK_SOURCE,
    );
  });

  it('2012 Jaguar XJ fixture simulates rate_limited (retryable) — the total-failure demo', async () => {
    expectFailure(
      await manheim().getValuation(request(target('Jaguar', 'XJ'), instance({ year: 2012 }))),
      'rate_limited',
      MANHEIM_MOCK_SOURCE,
    );
  });

  it("mock_only: no default path emits 'auth' — there is no credential to fail", async () => {
    const adapter = manheim();
    for (const req of [
      request(),
      request(target('BMW', 'X5'), instance({ year: 2015 })),
      request(target('Jaguar', 'XJ'), instance({ year: 2012 })),
      request(target('Nope', 'Nothing'), instance({ year: 1900 })),
    ]) {
      const res = await adapter.getValuation(req);
      if (!res.ok) expect(res.error.code).not.toBe('auth');
    }
  });
});

describe('purity / idempotency', () => {
  it('two identical calls produce deeply equal results', async () => {
    const adapter = manheim();
    const req = request(target(), instance({ vin: ACCORD_VIN, mileage: 50_000 }));
    expect(await adapter.getValuation(req)).toEqual(await adapter.getValuation(req));
  });

  it('two independently created adapters agree exactly (pure factory, no shared state)', async () => {
    const a = manheim();
    const b = manheim();
    const req = request(target('Ford', 'F-150'), instance({ year: 2019, trim: 'Lariat' }));
    expect(await a.getValuation(req)).toEqual(await b.getValuation(req));
  });
});

describe('default fixture discipline (§3.3)', () => {
  it('every Manheim value row populates ONLY wholesale', () => {
    expect(MANHEIM_DEFAULT_FIXTURES.length).toBeGreaterThan(0);
    for (const row of MANHEIM_DEFAULT_FIXTURES) {
      expect(row.values !== undefined || row.error !== undefined).toBe(true);
      expect(row.values !== undefined && row.error !== undefined).toBe(false);
      if (row.values !== undefined) {
        expect(row.values.wholesale).toBeDefined();
        expect(row.values.trade_in).toBeUndefined();
        expect(row.values.retail).toBeUndefined();
        expect(row.values.private_party).toBeUndefined();
      }
      expect(row.vin !== undefined || row.spec_key !== undefined).toBe(true);
    }
  });

  it('all amounts are integer cents', () => {
    for (const row of MANHEIM_DEFAULT_FIXTURES) {
      for (const v of Object.values(row.values ?? {})) expect(Number.isInteger(v)).toBe(true);
    }
  });
});
