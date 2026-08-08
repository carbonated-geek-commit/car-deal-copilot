/**
 * T-013 tester — KBB-mock adapter against the v0.5 spine
 * (docs/design/T-013.md §2, §3, error table §7.1; AC-1, AC-2, AC-5, AC-6, AC-9).
 *
 * Fully offline: fixtures + an injected clock are the entire data source
 * (AC-7 / AC-12). Kit-mandate touchpoints exercised here:
 * - AC-1: every snapshot is stamped `vehicle_instance_id = req.instance.id`.
 * - AC-2: year, trim, mileage and condition are all LOAD-BEARING — each one,
 *   changed alone, moves a band (design D3).
 * - AC-6 / Q16: a malformed or unknown VIN is NOT an error; it falls through
 *   to the make/model/year key.
 * - AC-9 / Q15: KBB is the private-party source; the band comes from this mock.
 * - ADR-007: the `retail` band survives verbatim as the `above_market` basis.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ValuationAdapter, ValuationRequest } from '@core';
import {
  KBB_DEFAULT_FIXTURES,
  KBB_MOCK_SOURCE,
  createKbbMockAdapter,
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

const kbb = (fixtures?: readonly ValuationFixtureRow[]): ValuationAdapter =>
  createKbbMockAdapter(
    fixtures !== undefined ? { fixtures, now: clockAt() } : { now: clockAt() },
  );

// Accord row (kbb.fixtures.ts): trade_in 1_850_000 / private_party 2_000_000 /
// retail 2_150_000; mileage baseline 45_000 @ 8 c/mi; condition
// { certified: +80_000, new: +250_000 }; trim { lx: -40_000, sport: +60_000,
// touring: +140_000 }.
const ACCORD_TRADE_IN = 1_850_000;
const ACCORD_PRIVATE_PARTY = 2_000_000;
const ACCORD_RETAIL = 2_150_000;

describe('createKbbMockAdapter — spine interface & provenance (AC-5)', () => {
  it('returns exactly the one spine ValuationAdapter type', () => {
    expectTypeOf(createKbbMockAdapter).returns.toEqualTypeOf<ValuationAdapter>();
  });

  it('source is the mock id string — the ONLY runtime trace of the provider name', () => {
    expect(KBB_MOCK_SOURCE).toBe('mock-kbb');
    expect(createKbbMockAdapter().source).toBe(KBB_MOCK_SOURCE);
  });

  it('the adapter exposes exactly { source, getValuation } — no provider affordance', () => {
    expect(Object.keys(createKbbMockAdapter()).sort()).toEqual(['getValuation', 'source']);
  });
});

describe('AC-1 — every snapshot is bound to ONE VehicleInstance', () => {
  it('stamps vehicle_instance_id from req.instance.id, never from anywhere else', async () => {
    const snap = expectOk(await kbb().getValuation(request()));
    expect(snap.vehicle_instance_id).toBe(INSTANCE_ID);
  });

  it('two threads on the same car spec produce two distinct instance-bound snapshots', async () => {
    const adapter = kbb();
    const a = expectOk(
      await adapter.getValuation(request(target(), instance({ id: 'vi-a', vin: ACCORD_VIN }))),
    );
    const b = expectOk(
      await adapter.getValuation(request(target(), instance({ id: 'vi-b', vin: ACCORD_VIN }))),
    );
    expect(a.vehicle_instance_id).toBe('vi-a');
    expect(b.vehicle_instance_id).toBe('vi-b');
    // Same car spec ⇒ same numbers; different thread ⇒ different binding.
    expect(a.retail).toBe(b.retail);
  });

  it('the snapshot carries exactly the flat spine fields — no vehicle{}, values{}, mileage or fetched_at', async () => {
    const snap = expectOk(await kbb().getValuation(request()));
    expect(Object.keys(snap).sort()).toEqual(
      [
        'captured_at',
        'private_party',
        'retail',
        'source',
        'trade_in',
        'vehicle_instance_id',
      ].sort(),
    );
    for (const removed of ['vehicle', 'values', 'mileage', 'fetched_at', 'vin']) {
      expect(removed in snap).toBe(false);
    }
  });

  it('captured_at comes from the injected clock (AC-4 snapshot timestamping)', async () => {
    const snap = expectOk(await kbb().getValuation(request()));
    expect(snap.captured_at).toBe(T0);
  });
});

describe('AC-9 / Q15 — KBB supplies retail, trade-in AND private-party; never wholesale', () => {
  it('the Accord row yields trade_in / private_party / retail and no wholesale band', async () => {
    const snap = expectOk(await kbb().getValuation(request()));
    expect(snap.trade_in).toBe(ACCORD_TRADE_IN);
    expect(snap.private_party).toBe(ACCORD_PRIVATE_PARTY);
    expect(snap.retail).toBe(ACCORD_RETAIL);
    expect('wholesale' in snap).toBe(false);
  });

  it('ADR-007: the retail band is present and is the highest of the three', async () => {
    const snap = expectOk(await kbb().getValuation(request()));
    expect(snap.retail).toBeGreaterThan(snap.private_party as number);
    expect(snap.private_party as number).toBeGreaterThan(snap.trade_in as number);
  });
});

describe('AC-2 / D3 — year, trim, mileage and condition are all LOAD-BEARING', () => {
  it('mileage above baseline lowers every band linearly; below raises them', async () => {
    const adapter = kbb();
    const above = expectOk(
      await adapter.getValuation(request(target(), instance({ vin: ACCORD_VIN, mileage: 55_000 }))),
    );
    const below = expectOk(
      await adapter.getValuation(request(target(), instance({ vin: ACCORD_VIN, mileage: 35_000 }))),
    );
    // delta = (45_000 - mileage) * 8
    expect(above.trade_in).toBe(ACCORD_TRADE_IN - 80_000);
    expect(above.retail).toBe(ACCORD_RETAIL - 80_000);
    expect(above.private_party).toBe(ACCORD_PRIVATE_PARTY - 80_000);
    expect(below.retail).toBe(ACCORD_RETAIL + 80_000);
  });

  it('condition alone moves a band (certified +80_000 on the Accord row)', async () => {
    const adapter = kbb();
    const used = expectOk(await adapter.getValuation(request()));
    const certified = expectOk(
      await adapter.getValuation(
        request(target(), instance({ vin: ACCORD_VIN, condition: 'certified' })),
      ),
    );
    expect(certified.retail).toBe((used.retail as number) + 80_000);
    expect(certified.retail).not.toBe(used.retail);
  });

  it('trim alone moves a band, matched case-insensitively after trimming', async () => {
    const adapter = kbb();
    const base = expectOk(await adapter.getValuation(request()));
    const sport = expectOk(
      await adapter.getValuation(
        request(target(), instance({ vin: ACCORD_VIN, trim: '  SpOrT ' })),
      ),
    );
    const lx = expectOk(
      await adapter.getValuation(request(target(), instance({ vin: ACCORD_VIN, trim: 'LX' }))),
    );
    expect(sport.retail).toBe((base.retail as number) + 60_000);
    expect(lx.retail).toBe((base.retail as number) - 40_000);
  });

  it('an unlisted trim / condition contributes 0 rather than failing', async () => {
    const snap = expectOk(
      await kbb().getValuation(
        request(target(), instance({ vin: ACCORD_VIN, trim: 'Nonexistent Trim' })),
      ),
    );
    expect(snap.retail).toBe(ACCORD_RETAIL);
  });

  it('year is load-bearing through the match key: same anchor, other year → not_found', async () => {
    const res = await kbb().getValuation(request(target(), instance({ year: 1999 })));
    expectFailure(res, 'not_found', KBB_MOCK_SOURCE);
  });

  it('the three adjustments compose in the fixed order and floor at 0', async () => {
    const snap = expectOk(
      await kbb().getValuation(
        request(
          target(),
          instance({
            vin: ACCORD_VIN,
            mileage: 55_000, // -80_000
            condition: 'certified', // +80_000
            trim: 'Touring', // +140_000
          }),
        ),
      ),
    );
    expect(snap.retail).toBe(ACCORD_RETAIL + 140_000);

    const floored = expectOk(
      await kbb([
        {
          spec_key: { make: 'Junker', model: 'Special', year: 1999 },
          values: { trade_in: 1_000, retail: 2_000 },
          mileage_adjustment: { baseline_mileage: 0, cents_per_mile: 100 },
        },
      ]).getValuation(
        request(target('Junker', 'Special'), instance({ year: 1999, mileage: 1_000_000 })),
      ),
    );
    expect(floored.trade_in).toBe(0);
    expect(floored.retail).toBe(0);
  });

  it('instance.additions are deliberately NOT priced (add-ons live on the offer as OfferFee)', async () => {
    const adapter = kbb();
    const bare = expectOk(await adapter.getValuation(request()));
    const loaded = expectOk(
      await adapter.getValuation(
        request(
          target(),
          instance({ vin: ACCORD_VIN, additions: ['roof rack', 'ceramic coating', 'nitrogen'] }),
        ),
      ),
    );
    expect(loaded.retail).toBe(bare.retail);
  });
});

describe('AC-6 / Q16 — VIN is user-entered and UNVALIDATED', () => {
  it('a 4-character VIN is not an error: it falls through to the make/model/year key', async () => {
    const snap = expectOk(
      await kbb().getValuation(request(target(), instance({ vin: '1HGC' }))),
    );
    expect(snap.retail).toBe(ACCORD_RETAIL);
    expect(snap.vehicle_instance_id).toBe(INSTANCE_ID);
  });

  it('a well-formed but unknown VIN also falls through to the spec key', async () => {
    const snap = expectOk(
      await kbb().getValuation(request(target(), instance({ vin: 'WBA3B1C50EK590210' }))),
    );
    expect(snap.retail).toBe(ACCORD_RETAIL);
  });

  it('hostile VIN input never throws and never becomes invalid_input', async () => {
    const adapter = kbb();
    for (const vin of ['', "'; DROP TABLE deals;--", '\u{1F697}\u{1F697}', ' '.repeat(40)]) {
      const res = await adapter.getValuation(request(target(), instance({ vin })));
      expect(res.ok).toBe(true); // spec key still matches the Accord row
    }
  });

  it('a matching VIN is normalized case-insensitively with whitespace trimmed', async () => {
    const snap = expectOk(
      await kbb().getValuation(
        request(target(), instance({ vin: `  ${ACCORD_VIN.toLowerCase()}  ` })),
      ),
    );
    expect(snap.retail).toBe(ACCORD_RETAIL);
  });

  it('no decode is required or performed: a VIN-less instance still values fine', async () => {
    const snap = expectOk(await kbb().getValuation(request(target(), instance())));
    expect(snap.retail).toBe(ACCORD_RETAIL);
  });
});

describe('D2 — make/model come from the deal anchor and from NOWHERE else', () => {
  it('a target that does not match the anchor of any row → not_found (mismatch is rejected)', async () => {
    // Same instance (year 2020), different anchor: the Accord row must not match.
    const res = await kbb().getValuation(
      request(target('Toyota', 'Accord'), instance({ year: 2020 })),
    );
    expectFailure(res, 'not_found', KBB_MOCK_SOURCE);
  });

  it('anchor matching is case-insensitive and whitespace-trimmed', async () => {
    const snap = expectOk(
      await kbb().getValuation(request(target('  toyota ', ' rav4 '), instance({ year: 2021 }))),
    );
    expect(snap.trade_in).toBe(2_400_000);
    expect(snap.retail).toBe(2_720_000);
  });

  it('VehicleInstance carries no make/model — a contradicting thread is unrepresentable', () => {
    const i = instance();
    expect('make' in i).toBe(false);
    expect('model' in i).toBe(false);
    // @ts-expect-error — the spine deliberately has no `make` on VehicleInstance
    const _make: string = i.make;
    // @ts-expect-error — nor a `model`
    const _model: string = i.model;
    expect([_make, _model]).toBeDefined();
  });

  it('target.make / target.model are write-once (readonly) on the spine', () => {
    const t = target();
    // @ts-expect-error — VehicleTarget.make is readonly (write-once anchor)
    t.make = 'Toyota';
    // @ts-expect-error — VehicleTarget.model is readonly (write-once anchor)
    t.model = 'Civic';
    expect(typeof t.make).toBe('string');
  });
});

describe('§7.1 error table — validation rows', () => {
  it('blank instance id → invalid_input, terminal (a snapshot must name a car)', async () => {
    const res = await kbb().getValuation(request(target(), instance({ id: '   ' })));
    expectFailure(res, 'invalid_input', KBB_MOCK_SOURCE);
  });

  it('blank target make or model → invalid_input, terminal', async () => {
    const adapter = kbb();
    expectFailure(
      await adapter.getValuation(request(target('   ', 'Accord'), instance())),
      'invalid_input',
      KBB_MOCK_SOURCE,
    );
    expectFailure(
      await adapter.getValuation(request(target('Honda', '  '), instance())),
      'invalid_input',
      KBB_MOCK_SOURCE,
    );
  });

  it('non-integer year (fractional, NaN, Infinity) → invalid_input', async () => {
    const adapter = kbb();
    for (const year of [2020.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectFailure(
        await adapter.getValuation(request(target(), instance({ year }))),
        'invalid_input',
        KBB_MOCK_SOURCE,
      );
    }
  });

  it('negative or non-finite mileage → invalid_input', async () => {
    const adapter = kbb();
    for (const mileage of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectFailure(
        await adapter.getValuation(request(target(), instance({ vin: ACCORD_VIN, mileage }))),
        'invalid_input',
        KBB_MOCK_SOURCE,
      );
    }
  });

  it('mileage 0 is legitimate, not a validation failure', async () => {
    const snap = expectOk(
      await kbb().getValuation(request(target(), instance({ vin: ACCORD_VIN, mileage: 0 }))),
    );
    expect(snap.retail).toBe(ACCORD_RETAIL + 45_000 * 8);
  });

  it('validation precedes matching: a blank id fails even for an unknown car', async () => {
    const res = await kbb().getValuation(
      request(target('Nope', 'Nothing'), instance({ id: '', year: 1900 })),
    );
    expectFailure(res, 'invalid_input', KBB_MOCK_SOURCE);
  });
});

describe('§7.1 error table — not_found and simulated-failure rows', () => {
  it('unknown vehicle → not_found, terminal, message never echoes the VIN', async () => {
    const unknownVin = '9XYZZ99Z9XZ999999';
    const err = expectFailure(
      await kbb().getValuation(
        request(target('Nope', 'Nothing'), instance({ vin: unknownVin, year: 1990 })),
      ),
      'not_found',
      KBB_MOCK_SOURCE,
    );
    expect(err.message).not.toContain(unknownVin);
  });

  it('2014 Audi A4 fixture simulates rate_limited (retryable)', async () => {
    expectFailure(
      await kbb().getValuation(request(target('Audi', 'A4'), instance({ year: 2014 }))),
      'rate_limited',
      KBB_MOCK_SOURCE,
    );
  });

  it('2012 Jaguar XJ fixture simulates provider_unavailable (retryable)', async () => {
    expectFailure(
      await kbb().getValuation(request(target('Jaguar', 'XJ'), instance({ year: 2012 }))),
      'provider_unavailable',
      KBB_MOCK_SOURCE,
    );
  });

  it('custom rows drill the terminal codes: auth / malformed_response / invalid_input', async () => {
    const adapter = kbb([
      { spec_key: { make: 'A', model: 'B', year: 2000 }, error: 'auth' },
      { spec_key: { make: 'C', model: 'D', year: 2001 }, error: 'malformed_response' },
      { spec_key: { make: 'E', model: 'F', year: 2002 }, error: 'invalid_input' },
    ]);
    expectFailure(
      await adapter.getValuation(request(target('A', 'B'), instance({ year: 2000 }))),
      'auth',
      KBB_MOCK_SOURCE,
    );
    expectFailure(
      await adapter.getValuation(request(target('C', 'D'), instance({ year: 2001 }))),
      'malformed_response',
      KBB_MOCK_SOURCE,
    );
    expectFailure(
      await adapter.getValuation(request(target('E', 'F'), instance({ year: 2002 }))),
      'invalid_input',
      KBB_MOCK_SOURCE,
    );
  });

  it("mock_only: 'auth' is unreachable through the DEFAULT fixtures — no credential exists to fail", async () => {
    const adapter = kbb();
    const probes: ValuationRequest[] = [
      request(),
      request(target('Audi', 'A4'), instance({ year: 2014 })),
      request(target('Jaguar', 'XJ'), instance({ year: 2012 })),
      request(target('BMW', 'X5'), instance({ year: 2015 })),
      request(target('Nope', 'Nothing'), instance({ year: 1900 })),
    ];
    for (const req of probes) {
      const res = await adapter.getValuation(req);
      if (!res.ok) expect(res.error.code).not.toBe('auth');
    }
  });

  it('every error message is log-safe: no URL, no credential-shaped text, no band value', async () => {
    const adapter = kbb();
    const PRIVATE_ID = 'vi-thread-of-account-42';
    const failing: ValuationRequest[] = [
      request(target('  ', 'Accord'), instance({ id: PRIVATE_ID })), // invalid_input
      request(target('Nope', 'Nothing'), instance({ id: PRIVATE_ID, year: 1900 })), // not_found
      request(target('Audi', 'A4'), instance({ id: PRIVATE_ID, year: 2014 })), // rate_limited
    ];
    for (const req of failing) {
      const res = await adapter.getValuation(req);
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error.message).not.toMatch(/https?:\/\//i);
      expect(res.error.message).not.toMatch(/api[_-]?key|secret|token|password/i);
      expect(res.error.message).not.toContain(String(ACCORD_RETAIL));
      // §7.1 "Never logged": the instance id is deliberately kept out of messages.
      expect(res.error.message).not.toContain(req.instance.id);
    }
  });
});

describe('purity / idempotency (§7.1 — at-least-once redelivery safe)', () => {
  it('two identical calls produce deeply equal results', async () => {
    const adapter = kbb();
    const req = request(target(), instance({ vin: ACCORD_VIN, mileage: 50_000 }));
    expect(await adapter.getValuation(req)).toEqual(await adapter.getValuation(req));
  });

  it('never throws across the boundary — adversarial requests resolve', async () => {
    const adapter = kbb();
    const hostile = request(
      target(' ', 'x'.repeat(5000)),
      instance({ id: 'x'.repeat(5000), vin: '\u{1F697}', year: -0, mileage: 0 }),
    );
    await expect(adapter.getValuation(hostile)).resolves.toBeDefined();
  });

  it('the request object is not mutated by the adapter', async () => {
    const req = request(target(), instance({ vin: ACCORD_VIN, mileage: 50_000, trim: 'Sport' }));
    const before: unknown = JSON.parse(JSON.stringify(req));
    await kbb().getValuation(req);
    expect(JSON.parse(JSON.stringify(req))).toEqual(before);
  });

  it('a blended-ready snapshot JSON round-trips unchanged (bus payload)', async () => {
    const snap = expectOk(await kbb().getValuation(request()));
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});

describe('default fixture discipline (§3.3)', () => {
  it('every KBB value row populates trade_in / retail / private_party and NEVER wholesale', () => {
    expect(KBB_DEFAULT_FIXTURES.length).toBeGreaterThan(0);
    for (const row of KBB_DEFAULT_FIXTURES) {
      // values XOR error
      expect(row.values !== undefined || row.error !== undefined).toBe(true);
      expect(row.values !== undefined && row.error !== undefined).toBe(false);
      if (row.values !== undefined) {
        expect(row.values.wholesale).toBeUndefined();
        expect(row.values.trade_in).toBeDefined();
        expect(row.values.retail).toBeDefined();
        expect(row.values.private_party).toBeDefined();
      }
      expect(row.vin !== undefined || row.spec_key !== undefined).toBe(true);
    }
  });

  it('at least one default row carries a condition_adjustment and one a trim_adjustment (D3)', () => {
    expect(KBB_DEFAULT_FIXTURES.some((r) => r.condition_adjustment !== undefined)).toBe(true);
    expect(KBB_DEFAULT_FIXTURES.some((r) => r.trim_adjustment !== undefined)).toBe(true);
  });

  it('fixtures are integer cents throughout — never floats', () => {
    for (const row of KBB_DEFAULT_FIXTURES) {
      for (const v of Object.values(row.values ?? {})) {
        expect(Number.isInteger(v)).toBe(true);
      }
      for (const v of Object.values(row.condition_adjustment ?? {})) {
        expect(Number.isInteger(v)).toBe(true);
      }
      for (const v of Object.values(row.trim_adjustment ?? {})) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it('fixture rows carry no provider-shaped field — the neutral row shape is the whole vocabulary', () => {
    const allowed = new Set([
      'vin',
      'spec_key',
      'values',
      'mileage_adjustment',
      'condition_adjustment',
      'trim_adjustment',
      'error',
    ]);
    for (const row of KBB_DEFAULT_FIXTURES) {
      for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
    }
  });
});
