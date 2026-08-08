/**
 * T-013 tester — the blend step against the v0.5 spine
 * (docs/design/T-013.md §2.3, §3.4, §7.2; AC-4, AC-5, AC-9; ADR-005, ADR-007).
 *
 * Kit-mandate touchpoints:
 * - AC-4: the wholesale vs trade-in vs retail spread survives, PER INSTANCE.
 * - D6: a contributor naming a different `vehicle_instance_id` is DISCARDED,
 *   never averaged — a blend is always of one specific car.
 * - ADR-005: a band no survivor supplies is ABSENT, never 0 and never "not
 *   triggered". Partial degradation is visible in `source`, not in a zero.
 * - ADR-007: the `retail` band flows through the blend verbatim, so the flag
 *   engine's `above_market` basis is this instance's own retail.
 * - AC-5: the composite IS the one spine `ValuationAdapter`; the package's
 *   runtime export surface carries nothing provider-shaped and no webhook.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ValuationAdapter, ValuationRequest } from '@core';
import * as api from '@adapters/valuation';
import {
  BLEND_SOURCE_PREFIX,
  KBB_MOCK_SOURCE,
  MANHEIM_MOCK_SOURCE,
  blendSnapshots,
  createBlendedValuationAdapter,
  createKbbMockAdapter,
  createManheimMockAdapter,
} from '@adapters/valuation';
import {
  ACCORD_VIN,
  INSTANCE_ID,
  OTHER_INSTANCE_ID,
  T0,
  T_NEW,
  T_OLD,
  clockAt,
  expectFailure,
  expectOk,
  fakeAdapter,
  instance,
  request,
  snapshot,
  target,
} from './helpers.js';

const defaultBlend = (
  kbbClock = clockAt(T_NEW),
  manheimClock = clockAt(T_OLD),
): ValuationAdapter =>
  createBlendedValuationAdapter({
    retail_trade_in: createKbbMockAdapter({ now: kbbClock }),
    wholesale: createManheimMockAdapter({ now: manheimClock }),
  });

// ------------------------------------------------------ AC-4: the full spread

describe('composite — both sources ok (§7.2 row 1)', () => {
  it('blends into the wholesale / trade-in / private-party / retail view for ONE instance', async () => {
    const snap = expectOk(await defaultBlend().getValuation(request()));
    expect(snap.vehicle_instance_id).toBe(INSTANCE_ID);
    expect(snap.wholesale).toBe(1_700_000);
    expect(snap.trade_in).toBe(1_850_000);
    expect(snap.private_party).toBe(2_000_000);
    expect(snap.retail).toBe(2_150_000);
    expect(snap.source).toBe('blend(mock-kbb+mock-manheim)');
    expect(snap.source.startsWith(BLEND_SOURCE_PREFIX)).toBe(true);
    // D3: the blend is only as fresh as its stalest input.
    expect(snap.captured_at).toBe(T_OLD);
  });

  it('the spread ordering holds — wholesale < trade_in < private_party < retail', async () => {
    const snap = expectOk(await defaultBlend().getValuation(request()));
    expect(snap.wholesale as number).toBeLessThan(snap.trade_in as number);
    expect(snap.trade_in as number).toBeLessThan(snap.private_party as number);
    expect(snap.private_party as number).toBeLessThan(snap.retail as number);
  });

  it('the priceable attributes still move every band through the composite (AC-2)', async () => {
    const adapter = defaultBlend();
    const base = expectOk(await adapter.getValuation(request()));
    const adjusted = expectOk(
      await adapter.getValuation(
        request(
          target(),
          instance({ vin: ACCORD_VIN, mileage: 55_000, condition: 'certified', trim: 'Touring' }),
        ),
      ),
    );
    // -80_000 + 80_000 + 140_000 = +140_000 on every band
    expect(adjusted.wholesale).toBe((base.wholesale as number) + 140_000);
    expect(adjusted.retail).toBe((base.retail as number) + 140_000);
  });

  it('the blended snapshot has exactly the flat spine fields — no vehicle{} / values{} / fetched_at', async () => {
    const snap = expectOk(await defaultBlend().getValuation(request()));
    expect(Object.keys(snap).sort()).toEqual(
      [
        'captured_at',
        'private_party',
        'retail',
        'source',
        'trade_in',
        'vehicle_instance_id',
        'wholesale',
      ].sort(),
    );
  });

  it('adapter.source is the blend id before any call, naming every WIRED role', () => {
    expect(defaultBlend().source).toBe('blend(mock-kbb+mock-manheim)');
  });

  it('is itself exactly the one spine ValuationAdapter type (AC-5)', () => {
    expectTypeOf(createBlendedValuationAdapter).returns.toEqualTypeOf<ValuationAdapter>();
    expect(Object.keys(defaultBlend()).sort()).toEqual(['getValuation', 'source']);
  });

  it('repeated calls are deeply equal — safe under at-least-once redelivery', async () => {
    const adapter = defaultBlend();
    const req = request(target(), instance({ vin: ACCORD_VIN, mileage: 50_000 }));
    expect(await adapter.getValuation(req)).toEqual(await adapter.getValuation(req));
  });

  it('a blended snapshot JSON round-trips unchanged (bus payload)', async () => {
    const snap = expectOk(await defaultBlend().getValuation(request()));
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});

// ------------------------------------------- ADR-005: partial ⇒ absent, not 0

describe('composite — partial degradation (§7.2 row 2, ADR-005)', () => {
  it('wholesale source down (2015 BMW X5) → ok partial; wholesale ABSENT, never 0', async () => {
    const snap = expectOk(
      await defaultBlend().getValuation(request(target('BMW', 'X5'), instance({ year: 2015 }))),
    );
    expect(snap.trade_in).toBe(1_450_000);
    expect(snap.private_party).toBe(1_580_000);
    expect(snap.retail).toBe(1_720_000);
    expect('wholesale' in snap).toBe(false); // UNEVALUABLE, not zero
    expect(snap.wholesale).toBeUndefined();
    expect(snap.source).toBe('blend(mock-kbb)'); // provenance IS the degradation signal
    expect(snap.captured_at).toBe(T_NEW); // only the KBB contributor survived
    expect(snap.vehicle_instance_id).toBe(INSTANCE_ID);
  });

  it('retail/trade-in source down (2014 Audi A4) → wholesale-only partial; retail ABSENT', async () => {
    const snap = expectOk(
      await defaultBlend().getValuation(request(target('Audi', 'A4'), instance({ year: 2014 }))),
    );
    expect(snap.wholesale).toBe(780_000);
    expect('trade_in' in snap).toBe(false);
    expect('retail' in snap).toBe(false); // ADR-007 basis is UNEVALUABLE here
    expect('private_party' in snap).toBe(false);
    expect(snap.source).toBe('blend(mock-manheim)');
  });

  it('a degraded blend never fabricates a zero band that could read as "free car"', async () => {
    const snap = expectOk(
      await defaultBlend().getValuation(request(target('Audi', 'A4'), instance({ year: 2014 }))),
    );
    for (const band of ['trade_in', 'retail', 'private_party'] as const) {
      expect(snap[band]).not.toBe(0);
      expect(snap[band]).toBeUndefined();
    }
  });
});

// ------------------------------------------------------ §7.2 row 3: all failed

describe('composite — all sources fail (§7.2 row 3)', () => {
  it('2012 Jaguar XJ fails on both sides → ONE error, blend-id source, codes-only message', async () => {
    const err = expectFailure(
      await defaultBlend().getValuation(request(target('Jaguar', 'XJ'), instance({ year: 2012 }))),
      'provider_unavailable', // both retryable → wired-role order decides
      'blend(mock-kbb+mock-manheim)',
    );
    expect(err.message).toContain('retail_trade_in=provider_unavailable');
    expect(err.message).toContain('wholesale=rate_limited');
    expect(err.message).not.toMatch(/https?:\/\//i);
  });

  it('a retryable contributor beats a terminal one even when the terminal is the retail role', async () => {
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
    const res = await adapter.getValuation(request());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('rate_limited');
    expect(res.error.retryable).toBe(true); // OR over contributors
    expect(res.error.source).toBe('blend(fake-retail+fake-wholesale)');
  });

  it('both terminal → the retail_trade_in role code wins, retryable:false (deterministic)', async () => {
    const adapter = createBlendedValuationAdapter({
      retail_trade_in: fakeAdapter('fake-retail', () => ({
        ok: false,
        error: { code: 'not_found', retryable: false, source: 'fake-retail', message: 'x' },
      })),
      wholesale: fakeAdapter('fake-wholesale', () => ({
        ok: false,
        error: {
          code: 'malformed_response',
          retryable: false,
          source: 'fake-wholesale',
          message: 'x',
        },
      })),
    });
    const res = await adapter.getValuation(request());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not_found');
    expect(res.error.retryable).toBe(false);
  });

  it('total failure is an error, NOT an all-bands-zero snapshot (ADR-005)', async () => {
    const res = await defaultBlend().getValuation(
      request(target('Jaguar', 'XJ'), instance({ year: 2012 })),
    );
    expect(res.ok).toBe(false);
    expect('value' in res).toBe(false);
  });

  it('one slow/failing source never blocks the other — fan-out is concurrent', async () => {
    let wholesaleStarted = false;
    const adapter = createBlendedValuationAdapter({
      retail_trade_in: {
        source: 'slow-retail',
        getValuation: async (req: ValuationRequest) => {
          await new Promise((r) => setTimeout(r, 20));
          expect(wholesaleStarted).toBe(true); // wholesale ran while retail waited
          return {
            ok: true as const,
            value: snapshot('slow-retail', { retail: 5 }, T0, req.instance.id),
          };
        },
      },
      wholesale: {
        source: 'fast-wholesale',
        getValuation: async (req: ValuationRequest) => {
          wholesaleStarted = true;
          return {
            ok: true as const,
            value: snapshot('fast-wholesale', { wholesale: 1 }, T0, req.instance.id),
          };
        },
      },
    });
    const snap = expectOk(await adapter.getValuation(request()));
    expect(snap.retail).toBe(5);
    expect(snap.wholesale).toBe(1);
  });
});

// ------------------------------------------------- D6: one specific car only

describe('D6 / AC-1 — a blend is ALWAYS of one specific car', () => {
  it('blendSnapshots discards a contributor naming a different vehicle_instance_id', () => {
    const merged = blendSnapshots([
      snapshot('kbb', { retail: 100, trade_in: 90 }, T0, INSTANCE_ID),
      snapshot('foreign', { wholesale: 50 }, T0, OTHER_INSTANCE_ID),
    ]);
    expect(merged.vehicle_instance_id).toBe(INSTANCE_ID);
    expect(merged.retail).toBe(100);
    expect('wholesale' in merged).toBe(false); // the other car's band never lands here
    expect(merged.source).toBe('blend(kbb)'); // discarded contributor is absent from provenance
  });

  it('ADR-007: another car’s retail can never become this instance’s above_market basis', () => {
    const merged = blendSnapshots([
      snapshot('mine', { trade_in: 1_000_000 }, T0, INSTANCE_ID),
      snapshot('other-car', { retail: 9_999_999 }, T0, OTHER_INSTANCE_ID),
    ]);
    expect(merged.vehicle_instance_id).toBe(INSTANCE_ID);
    expect(merged.retail).toBeUndefined();
    expect('retail' in merged).toBe(false); // UNEVALUABLE beats a wrong number
  });

  it('the head always survives, so a non-empty input always yields a result', () => {
    const merged = blendSnapshots([
      snapshot('head', { retail: 7 }, T0, INSTANCE_ID),
      snapshot('f1', { wholesale: 1 }, T0, 'x'),
      snapshot('f2', { trade_in: 2 }, T0, 'y'),
    ]);
    expect(merged.vehicle_instance_id).toBe(INSTANCE_ID);
    expect(merged.retail).toBe(7);
    expect(merged.source).toBe('blend(head)');
  });

  it('a real composite always agrees on the instance, so nothing is ever discarded', async () => {
    const snap = expectOk(await defaultBlend().getValuation(request()));
    expect(snap.source).toBe('blend(mock-kbb+mock-manheim)');
    expect(snap.vehicle_instance_id).toBe(INSTANCE_ID);
  });

  it('every in-repo source stamps req.instance.id, so the discard rule is never reached in practice', async () => {
    for (const adapter of [
      createKbbMockAdapter({ now: clockAt() }),
      createManheimMockAdapter({ now: clockAt() }),
    ]) {
      const snap = expectOk(
        await adapter.getValuation(request(target(), instance({ id: 'vi-q', vin: ACCORD_VIN }))),
      );
      expect(snap.vehicle_instance_id).toBe('vi-q');
    }
  });

  it('composite: D6 filters against the HEAD, then §3.4 relabels the result to the requested instance', async () => {
    // Documented consequence of §3.4 + D6 read together. Reachable ONLY through
    // a misbehaving adapter that answers about a car it was not asked about —
    // the test above proves no in-repo source can do that. Recorded here so the
    // behaviour is pinned rather than latent: if a caching or third-party source
    // is ever wired into a role, filtering survivors against `req.instance.id`
    // (rather than against the head) is the change that closes the gap.
    const adapter = createBlendedValuationAdapter({
      retail_trade_in: fakeAdapter('rogue-retail', () => ({
        ok: true,
        value: snapshot('rogue-retail', { retail: 9_999_999 }, T0, OTHER_INSTANCE_ID),
      })),
      wholesale: fakeAdapter('honest-wholesale', (req) => ({
        ok: true,
        value: snapshot('honest-wholesale', { wholesale: 1_700_000 }, T0, req.instance.id),
      })),
    });
    const snap = expectOk(await adapter.getValuation(request()));
    expect(snap.vehicle_instance_id).toBe(INSTANCE_ID);
    // `source` is the honest signal: it names exactly who contributed.
    expect(snap.source).toBe('blend(rogue-retail)');
    expect('wholesale' in snap).toBe(false);
  });

  it('the composite stamps req.instance.id — the requested car is authoritative (§3.4)', async () => {
    const adapter = createBlendedValuationAdapter({
      retail_trade_in: createKbbMockAdapter({ now: clockAt() }),
      wholesale: createManheimMockAdapter({ now: clockAt() }),
    });
    const snap = expectOk(
      await adapter.getValuation(request(target(), instance({ id: 'vi-zzz', vin: ACCORD_VIN }))),
    );
    expect(snap.vehicle_instance_id).toBe('vi-zzz');
  });
});

// ------------------------------------------------------ pure merge mechanics

describe('blendSnapshots — pure merge (§2.3)', () => {
  it('takes each band from the survivor that supplies it', () => {
    const merged = blendSnapshots([
      snapshot('a', { trade_in: 100, retail: 200 }, T_NEW),
      snapshot('b', { wholesale: 50 }, T_OLD),
      snapshot('c', { private_party: 150 }, T_NEW),
    ]);
    expect(merged.wholesale).toBe(50);
    expect(merged.trade_in).toBe(100);
    expect(merged.retail).toBe(200);
    expect(merged.private_party).toBe(150);
    expect(merged.source).toBe('blend(a+b+c)');
    expect(merged.captured_at).toBe(T_OLD); // oldest survivor
  });

  it('band collision → the newest captured_at wins', () => {
    const merged = blendSnapshots([
      snapshot('stale', { wholesale: 111 }, T_OLD),
      snapshot('fresh', { wholesale: 222 }, T_NEW),
    ]);
    expect(merged.wholesale).toBe(222);
  });

  it('band collision with equal captured_at → earliest input order wins (deterministic)', () => {
    const merged = blendSnapshots([
      snapshot('first', { wholesale: 111 }, T_NEW),
      snapshot('second', { wholesale: 222 }, T_NEW),
    ]);
    expect(merged.wholesale).toBe(111);
  });

  it('captured_at is the OLDEST survivor even when it supplies no band', () => {
    const merged = blendSnapshots([
      snapshot('rich', { retail: 1 }, T_NEW),
      snapshot('empty', {}, T_OLD),
    ]);
    expect(merged.captured_at).toBe(T_OLD);
    expect(merged.source).toBe('blend(rich+empty)');
  });

  it('a single snapshot blends to itself', () => {
    const merged = blendSnapshots([snapshot('solo', { retail: 999 }, T_NEW)]);
    expect(merged.retail).toBe(999);
    expect(merged.captured_at).toBe(T_NEW);
    expect(merged.source).toBe('blend(solo)');
    expect(merged.vehicle_instance_id).toBe(INSTANCE_ID);
  });

  it('an all-empty merge yields NO bands rather than zeros (ADR-005)', () => {
    const merged = blendSnapshots([snapshot('a', {}, T0), snapshot('b', {}, T0)]);
    expect(Object.keys(merged).sort()).toEqual(
      ['captured_at', 'source', 'vehicle_instance_id'].sort(),
    );
  });

  it('does not mutate its inputs', () => {
    const inputs = [snapshot('a', { retail: 1 }, T0), snapshot('b', { wholesale: 2 }, T0)] as const;
    const before: unknown = JSON.parse(JSON.stringify(inputs));
    blendSnapshots([inputs[0], inputs[1]]);
    expect(JSON.parse(JSON.stringify(inputs))).toEqual(before);
  });

  it('blending zero snapshots is a COMPILE error — there is no runtime path', () => {
    const _typeOnly = (): void => {
      // @ts-expect-error — non-empty tuple parameter forbids an empty array
      blendSnapshots([]);
    };
    expect(typeof _typeOnly).toBe('function');
  });
});

// ------------------------------------- Q15 / D5: the third slot stays unwired

describe('AC-9 / D5 — the private_party role is DECLARED BUT UNWIRED', () => {
  it('the default composition wires exactly two roles; private-party rides on the KBB band', async () => {
    const snap = expectOk(await defaultBlend().getValuation(request()));
    expect(snap.source).toBe('blend(mock-kbb+mock-manheim)');
    // Q15: the private-party number is present and it came from the KBB mock.
    expect(snap.private_party).toBe(2_000_000);
    const kbbOnly = expectOk(
      await createKbbMockAdapter({ now: clockAt() }).getValuation(request()),
    );
    expect(kbbOnly.private_party).toBe(snap.private_party);
  });

  it('the slot is optional in the type and a wired third source joins provenance', async () => {
    const pp = fakeAdapter('fake-pp', (req) => ({
      ok: true,
      value: snapshot('fake-pp', { private_party: 1_800_000 }, T_NEW, req.instance.id),
    }));
    const adapter = createBlendedValuationAdapter({
      retail_trade_in: createKbbMockAdapter({ now: clockAt(T_NEW) }),
      wholesale: createManheimMockAdapter({ now: clockAt(T_NEW) }),
      private_party: pp,
    });
    expect(adapter.source).toBe('blend(mock-kbb+mock-manheim+fake-pp)');
    const snap = expectOk(await adapter.getValuation(request()));
    // Same captured_at across all three ⇒ earliest input order wins the collision.
    expect(snap.private_party).toBe(2_000_000);
    expect(snap.wholesale).toBe(1_700_000);
    expect(snap.source).toBe('blend(mock-kbb+mock-manheim+fake-pp)');
  });

  it('nothing in this package can fill the slot: no comps/marketplace factory is exported', () => {
    const exported = Object.keys(api);
    for (const name of exported) {
      expect(name).not.toMatch(/comps|marketplace|facebook|craigslist|scrape/i);
    }
  });
});

// -------------------------------------------------- AC-5: the export boundary

describe('public API surface — anti-corruption & no webhook path (AC-5)', () => {
  it('runtime exports are exactly the designed set', () => {
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

  it('no internal narrowing helper or provider shape leaks through the alias', () => {
    const surface = api as unknown as Record<string, unknown>;
    for (const forbidden of [
      'createFixtureMockAdapter',
      'isRetryable',
      'normalizeVin',
      'KbbResponse',
      'ManheimResponse',
      'MmrQuote',
    ]) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });

  it('provider names surface ONLY as mock-* provenance ids (mock_only posture)', () => {
    expect(KBB_MOCK_SOURCE).toBe('mock-kbb');
    expect(MANHEIM_MOCK_SOURCE).toBe('mock-manheim');
  });
});
