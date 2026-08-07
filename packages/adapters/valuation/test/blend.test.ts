/**
 * T-003 tester — blend step (docs/design/T-003.md §6 blend tests 1–6; rules
 * D1–D3, §4.2, §4.3).
 *
 * Kit-mandate touchpoints:
 * - Anti-corruption: the composite IS the one spine `ValuationAdapter`; the
 *   public export surface carries no provider-shaped type or value (AC-1).
 * - Async backbone (§4.4): this package exposes NO webhook-facing API — the
 *   export-surface test pins that; composite purity keeps at-least-once
 *   redelivery of `valuation.refresh.requested.v1` safe.
 * - Bus-readiness: a blended `ValuationSnapshot` JSON round-trips unchanged
 *   (payload of `valuation.refresh.completed.v1`).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AdapterResult,
  ValuationAdapter,
  ValuationRequest,
  ValuationSnapshot,
} from '@core';
import * as api from '@adapters/valuation';
import {
  BLEND_SOURCE_PREFIX,
  KBB_DEFAULT_FIXTURES,
  KBB_MOCK_SOURCE,
  MANHEIM_DEFAULT_FIXTURES,
  MANHEIM_MOCK_SOURCE,
  blendSnapshots,
  createBlendedValuationAdapter,
  createKbbMockAdapter,
  createManheimMockAdapter,
  type ValuationFixtureRow,
} from '@adapters/valuation';

const T_OLD = '2026-08-07T10:00:00.000Z';
const T_NEW = '2026-08-07T12:00:00.000Z';

const ACCORD_VIN = '1HGCV1F34LA123456';

/** Minimal hand-rolled spine adapter — proves the composite accepts ANY ValuationAdapter. */
const fakeAdapter = (
  source: string,
  result: (req: ValuationRequest) => AdapterResult<ValuationSnapshot>,
): ValuationAdapter => ({
  source,
  getValuation: async (req) => result(req),
});

const okSnapshot = (
  source: string,
  values: ValuationSnapshot['values'],
  fetched_at: string,
): ValuationSnapshot => ({
  vehicle: { vin: ACCORD_VIN },
  values,
  source,
  fetched_at,
});

const defaultBlend = (kbbClock = () => T_NEW, manheimClock = () => T_OLD) =>
  createBlendedValuationAdapter({
    retail_trade_in: createKbbMockAdapter({ now: kbbClock }),
    wholesale: createManheimMockAdapter({ now: manheimClock }),
  });

// ---------------------------------------------------------------- AC-3 / test 1

describe('composite — both sources ok (§4.3 row 1, §6 blend test 1)', () => {
  it('blends into the wholesale vs trade-in vs retail view with full provenance', async () => {
    const adapter = defaultBlend();
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const snap = res.value;
    expect(snap.values.wholesale).toBe(1_700_000);
    expect(snap.values.trade_in).toBe(1_850_000);
    expect(snap.values.retail).toBe(2_150_000);
    expect(snap.source).toBe('blend(mock-kbb+mock-manheim)');
    expect(snap.source.startsWith(BLEND_SOURCE_PREFIX)).toBe(true);
    // D3: blend is only as fresh as its stalest input.
    expect(snap.fetched_at).toBe(T_OLD);
    // spread ordering — the pro's daily bread (AC-3)
    expect(snap.values.wholesale!).toBeLessThan(snap.values.trade_in!);
    expect(snap.values.trade_in!).toBeLessThan(snap.values.retail!);
  });

  it('echoes vehicle and mileage from the request (§4.3)', async () => {
    const adapter = defaultBlend();
    const req: ValuationRequest = {
      vehicle: { make: 'Toyota', model: 'RAV4', year: 2021, trim: 'XLE' },
      mileage: 41_000,
    };
    const res = await adapter.getValuation(req);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.vehicle).toEqual(req.vehicle);
    expect(res.value.mileage).toBe(41_000);
  });

  it('adapter.source is the blend id even before any call (D1)', () => {
    expect(defaultBlend().source).toBe('blend(mock-kbb+mock-manheim)');
  });

  it('is itself exactly the one spine ValuationAdapter type (D1, AC-1)', () => {
    expectTypeOf(createBlendedValuationAdapter).returns.toEqualTypeOf<ValuationAdapter>();
  });

  it('repeated calls are deeply equal — safe under at-least-once redelivery (§4.4)', async () => {
    const adapter = defaultBlend();
    const req: ValuationRequest = { vehicle: { vin: ACCORD_VIN }, mileage: 50_000 };
    expect(await adapter.getValuation(req)).toEqual(await adapter.getValuation(req));
  });
});

// ---------------------------------------------------------------- D2 / test 2

describe('composite — partial degradation (D2, §4.3 row 2, §6 blend test 2)', () => {
  it('wholesale source down (2015 BMW X5) → ok partial snapshot, source names survivor only', async () => {
    const adapter = defaultBlend();
    const res = await adapter.getValuation({ vehicle: { make: 'BMW', model: 'X5', year: 2015 } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.trade_in).toBe(1_450_000);
    expect(res.value.values.retail).toBe(1_720_000);
    expect(res.value.values.wholesale).toBeUndefined();
    expect(res.value.source).toBe('blend(mock-kbb)'); // provenance IS the degradation signal
  });

  it('retail/trade-in source down (2014 Audi A4) → wholesale-only partial snapshot', async () => {
    const adapter = defaultBlend();
    const res = await adapter.getValuation({ vehicle: { make: 'Audi', model: 'A4', year: 2014 } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.wholesale).toBe(780_000);
    expect(res.value.values.trade_in).toBeUndefined();
    expect(res.value.values.retail).toBeUndefined();
    expect(res.value.source).toBe('blend(mock-manheim)');
  });
});

// ---------------------------------------------------------------- §4.3 row 3 / test 3

describe('composite — all sources fail (§4.3 row 3, §6 blend test 3)', () => {
  it('2012 Jaguar XJ fails on both sides → ONE error, blend-id source, retryable OR, codes-only message', async () => {
    const adapter = defaultBlend();
    const res = await adapter.getValuation({ vehicle: { make: 'Jaguar', model: 'XJ', year: 2012 } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // both retryable → among equals the retail_trade_in-role error wins
    expect(res.error.code).toBe('provider_unavailable'); // KBB side's simulated code
    expect(res.error.retryable).toBe(true);
    expect(res.error.source).toBe('blend(mock-kbb+mock-manheim)');
    expect(res.error.message).toContain('provider_unavailable');
    expect(res.error.message).toContain('rate_limited');
  });

  it('retryable error beats a terminal one even when the terminal error is the retail role', async () => {
    const adapter = createBlendedValuationAdapter({
      retail_trade_in: fakeAdapter('fake-retail', () => ({
        ok: false,
        error: { code: 'auth', retryable: false, source: 'fake-retail', message: 'x' },
      })),
      wholesale: fakeAdapter('fake-wholesale', () => ({
        ok: false,
        error: { code: 'rate_limited', retryable: true, source: 'fake-wholesale', message: 'x' },
      })),
    });
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('rate_limited'); // retryable wins over terminal
    expect(res.error.retryable).toBe(true); // OR of contributors
    expect(res.error.source).toBe('blend(fake-retail+fake-wholesale)');
  });

  it('both terminal → retail_trade_in-role code wins, retryable:false', async () => {
    const adapter = createBlendedValuationAdapter({
      retail_trade_in: fakeAdapter('fake-retail', () => ({
        ok: false,
        error: { code: 'not_found', retryable: false, source: 'fake-retail', message: 'x' },
      })),
      wholesale: fakeAdapter('fake-wholesale', () => ({
        ok: false,
        error: { code: 'malformed_response', retryable: false, source: 'fake-wholesale', message: 'x' },
      })),
    });
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not_found');
    expect(res.error.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------- pure merge / test 4

describe('blendSnapshots — pure merge (D2/D3, §4.2, §6 blend test 4)', () => {
  it('takes each field from the snapshot that supplies it', () => {
    const merged = blendSnapshots([
      okSnapshot('a', { trade_in: 100, retail: 200 }, T_NEW),
      okSnapshot('b', { wholesale: 50 }, T_OLD),
      okSnapshot('c', { private_party: 150 }, T_NEW),
    ]);
    expect(merged.values).toEqual({ wholesale: 50, trade_in: 100, retail: 200, private_party: 150 });
    expect(merged.source).toBe('blend(a+b+c)');
    expect(merged.fetched_at).toBe(T_OLD); // oldest contributor (D3)
  });

  it('field collision (mis-wired roles) → most recent fetched_at wins', () => {
    const merged = blendSnapshots([
      okSnapshot('stale', { wholesale: 111 }, T_OLD),
      okSnapshot('fresh', { wholesale: 222 }, T_NEW),
    ]);
    expect(merged.values.wholesale).toBe(222);
  });

  it('field collision with equal fetched_at → earliest in input order wins (deterministic)', () => {
    const merged = blendSnapshots([
      okSnapshot('first', { wholesale: 111 }, T_NEW),
      okSnapshot('second', { wholesale: 222 }, T_NEW),
    ]);
    expect(merged.values.wholesale).toBe(111);
  });

  it('single snapshot blends to itself (values, oldest = own timestamp)', () => {
    const merged = blendSnapshots([okSnapshot('solo', { retail: 999 }, T_NEW)]);
    expect(merged.values).toEqual({ retail: 999 });
    expect(merged.fetched_at).toBe(T_NEW);
    expect(merged.source).toBe('blend(solo)');
  });

  it('blending zero snapshots is a compile-time error (§4.2 — no runtime path)', () => {
    const _typeOnly = () => {
      // @ts-expect-error — non-empty tuple parameter forbids an empty array
      blendSnapshots([]);
    };
    expect(typeof _typeOnly).toBe('function');
  });
});

// ---------------------------------------------------------------- D9 third slot

describe('composite — open private_party slot (D9)', () => {
  it('a wired third source contributes private_party and joins the provenance', async () => {
    const pp = fakeAdapter('fake-pp', () => ({
      ok: true,
      value: okSnapshot('fake-pp', { private_party: 1_800_000 }, T_NEW),
    }));
    const adapter = createBlendedValuationAdapter({
      retail_trade_in: createKbbMockAdapter({ now: () => T_NEW }),
      wholesale: createManheimMockAdapter({ now: () => T_NEW }),
      private_party: pp,
    });
    expect(adapter.source).toBe('blend(mock-kbb+mock-manheim+fake-pp)');
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.values.private_party).toBe(1_800_000);
    expect(res.value.values.wholesale).toBe(1_700_000);
    expect(res.value.source).toBe('blend(mock-kbb+mock-manheim+fake-pp)');
  });
});

// ---------------------------------------------------------------- test 5: surface

describe('public API surface — anti-corruption & no webhook path (AC-1, §4.4, §6 blend test 5)', () => {
  it('runtime exports are exactly the designed set — nothing provider-shaped, no handlers', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'BLEND_SOURCE_PREFIX',
        'KBB_DEFAULT_FIXTURES',
        'KBB_MOCK_SOURCE',
        'MANHEIM_DEFAULT_FIXTURES',
        'MANHEIM_MOCK_SOURCE',
        'blendSnapshots',
        'createBlendedValuationAdapter',
        'createKbbMockAdapter',
        'createManheimMockAdapter',
      ].sort(),
    );
  });

  it('provider names surface ONLY as mock-* provenance ids (mock_only posture)', () => {
    expect(KBB_MOCK_SOURCE).toBe('mock-kbb');
    expect(MANHEIM_MOCK_SOURCE).toBe('mock-manheim');
  });
});

// ---------------------------------------------------------------- test 6: bus-ready

describe('serialization — bus-ready snapshot (§6 blend test 6)', () => {
  it('a blended ValuationSnapshot JSON round-trips unchanged', async () => {
    const adapter = defaultBlend();
    const res = await adapter.getValuation({ vehicle: { vin: ACCORD_VIN }, mileage: 47_500 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const roundTripped: unknown = JSON.parse(JSON.stringify(res.value));
    expect(roundTripped).toEqual(res.value);
  });
});

// ---------------------------------------------------------------- cross-fixture spread

describe('default fixture coherence across sources (§3, §6 mock test 6)', () => {
  const rowKey = (row: ValuationFixtureRow): string =>
    row.vin !== undefined
      ? `vin:${row.vin.trim().toUpperCase()}`
      : `spec:${row.spec_key!.make.trim().toLowerCase()}|${row.spec_key!.model.trim().toLowerCase()}|${row.spec_key!.year}`;

  it('every vehicle valued on both sides satisfies wholesale < trade_in < retail', () => {
    const manheimByKey = new Map(MANHEIM_DEFAULT_FIXTURES.map((r) => [rowKey(r), r]));
    let shared = 0;
    for (const kbbRow of KBB_DEFAULT_FIXTURES) {
      if (kbbRow.values === undefined) continue;
      const twin = manheimByKey.get(rowKey(kbbRow));
      if (twin?.values === undefined) continue;
      shared += 1;
      expect(twin.values.wholesale!).toBeLessThan(kbbRow.values.trade_in!);
      expect(kbbRow.values.trade_in!).toBeLessThan(kbbRow.values.retail!);
    }
    expect(shared).toBeGreaterThanOrEqual(6); // the demo set actually overlaps
  });

  it('every default-fixture vehicle appears in BOTH files (blend view meaningful for demos)', () => {
    const kbbKeys = new Set(KBB_DEFAULT_FIXTURES.map(rowKey));
    const manheimKeys = new Set(MANHEIM_DEFAULT_FIXTURES.map(rowKey));
    expect([...kbbKeys].sort()).toEqual([...manheimKeys].sort());
  });
});
