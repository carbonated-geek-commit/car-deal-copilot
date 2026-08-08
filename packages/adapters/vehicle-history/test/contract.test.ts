/**
 * T-005 tester — provider-agnosticism + error-path assertions
 * (docs/design/T-005.md §4 error table, §6.3, §6.5, §6.6; T-001 §5.1).
 *
 * Kit mandates touched here:
 * - anti-corruption boundary: no provider-specific shape is expressible or
 *   exported; both mocks speak only @core types (AC-1);
 * - mock_only enforcement: no auth error path exists (no credentials to
 *   fail), no URL/key/env option exists in the public surface;
 * - T-001 §5.1 outbound-feed error contract, row by row, offline.
 *
 * Webhook ack-then-queue, identity routing, receipts, flag engine: N/A to
 * this package by design (§4 "Webhooks — none") — asserted structurally
 * below by pinning the public export surface (no handler, route, or bus
 * symbol can exist unexported-yet-reachable).
 */
import { describe, expect, it } from 'vitest';
import type {
  AdapterResult,
  VehicleHistoryAdapter,
  VehicleHistorySummary,
} from '@core';
import * as api from '@adapters/vehicle-history';
import {
  AUTOCHECK_MOCK_SOURCE,
  CARFAX_MOCK_SOURCE,
  createAutoCheckMock,
  createCarfaxMock,
  FIXTURE_VINS,
} from '@adapters/vehicle-history';

const T0 = '2026-08-07T12:00:00.000Z';
const fixedClock = () => T0;

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

const carfax = createCarfaxMock({ now: fixedClock });
const autocheck = createAutoCheckMock({ now: fixedClock });
const both: ReadonlyArray<[string, VehicleHistoryAdapter]> = [
  ['carfax', carfax],
  ['autocheck', autocheck],
];

async function mustErr(
  adapter: VehicleHistoryAdapter,
  vin: string,
): Promise<Extract<AdapterResult<VehicleHistorySummary>, { ok: false }>['error']> {
  const res = await adapter.getHistory(vin);
  if (res.ok) {
    throw new Error(`expected error for ${vin}, got ok`);
  }
  return res.error;
}

describe('public export surface (design §2 — closed; anti-corruption by construction)', () => {
  it('exports exactly the design §2 runtime surface — no fixture tables, no provider types, no config', () => {
    expect(Object.keys(api).sort()).toEqual([
      'AUTOCHECK_MOCK_SOURCE',
      'CARFAX_MOCK_SOURCE',
      'FIXTURE_VINS',
      'createAutoCheckMock',
      'createCarfaxMock',
    ]);
  });

  it('no exported name references a provider-specific result/config shape (design §6.5)', () => {
    // Everything exported is either a factory returning the @core interface,
    // a source-id string, or the VIN constants. Nothing named *Carfax*/*AutoCheck*
    // beyond factories and source ids exists.
    expect(typeof api.createCarfaxMock).toBe('function');
    expect(typeof api.createAutoCheckMock).toBe('function');
    expect(typeof api.CARFAX_MOCK_SOURCE).toBe('string');
    expect(typeof api.AUTOCHECK_MOCK_SOURCE).toBe('string');
    expect(typeof api.FIXTURE_VINS).toBe('object');
  });

  it('FIXTURE_VINS has exactly the six documented VINs, all syntactically valid 17-char VINs (D2)', () => {
    expect(Object.keys(FIXTURE_VINS).sort()).toEqual([
      'accident',
      'branded_title',
      'clean',
      'trigger_malformed_response',
      'trigger_provider_unavailable',
      'trigger_rate_limited',
    ]);
    for (const vin of Object.values(FIXTURE_VINS)) {
      expect(vin).toMatch(VIN_PATTERN);
    }
  });

  it('source ids are distinct per provider and stamped on every ok result', async () => {
    expect(CARFAX_MOCK_SOURCE).not.toBe(AUTOCHECK_MOCK_SOURCE);
    const c = await carfax.getHistory(FIXTURE_VINS.clean);
    const a = await autocheck.getHistory(FIXTURE_VINS.clean);
    if (!c.ok || !a.ok) throw new Error('expected ok');
    expect(c.value.source).toBe(CARFAX_MOCK_SOURCE);
    expect(a.value.source).toBe(AUTOCHECK_MOCK_SOURCE);
  });
});

describe('error paths — T-001 §5.1 table row by row (design §4, §6.3)', () => {
  describe.each(both)('%s mock', (_name, adapter) => {
    it('malformed VIN → invalid_input, not retryable, message never echoes the raw input', async () => {
      const hostile = 'ZZINJECTED$$PAYLOAD%%';
      const error = await mustErr(adapter, hostile);
      expect(error.code).toBe('invalid_input');
      expect(error.retryable).toBe(false);
      expect(error.source).toBe(adapter.source);
      expect(error.message).not.toContain(hostile);
      expect(error.message).not.toContain('INJECTED');
    });

    it('unknown well-formed VIN → not_found, terminal, VIN-less message (D1 — no synthesized data)', async () => {
      const unknown = 'WBA3B1C50EK590210'; // valid syntax, not in any fixture table
      expect(unknown).toMatch(VIN_PATTERN);
      const error = await mustErr(adapter, unknown);
      expect(error.code).toBe('not_found');
      expect(error.retryable).toBe(false);
      expect(error.source).toBe(adapter.source);
      expect(error.message).not.toContain(unknown);
    });

    it('trigger_rate_limited → rate_limited, retryable', async () => {
      const error = await mustErr(adapter, FIXTURE_VINS.trigger_rate_limited);
      expect(error.code).toBe('rate_limited');
      expect(error.retryable).toBe(true);
      expect(error.source).toBe(adapter.source);
    });

    it('trigger_provider_unavailable → provider_unavailable, retryable', async () => {
      const error = await mustErr(
        adapter,
        FIXTURE_VINS.trigger_provider_unavailable,
      );
      expect(error.code).toBe('provider_unavailable');
      expect(error.retryable).toBe(true);
      expect(error.source).toBe(adapter.source);
    });

    it('trigger_malformed_response → malformed_response, NOT retryable (alert path)', async () => {
      const error = await mustErr(
        adapter,
        FIXTURE_VINS.trigger_malformed_response,
      );
      expect(error.code).toBe('malformed_response');
      expect(error.retryable).toBe(false);
      expect(error.source).toBe(adapter.source);
    });

    it('trigger errors are deterministic — same VIN, same error, every call', async () => {
      const first = await mustErr(adapter, FIXTURE_VINS.trigger_rate_limited);
      for (let i = 0; i < 3; i++) {
        expect(
          await mustErr(adapter, FIXTURE_VINS.trigger_rate_limited),
        ).toEqual(first);
      }
    });

    it("the 'auth' code is unreachable — no credentials exist to fail (D2, mock_only)", async () => {
      // Exhaustive sweep: every fixture VIN, every trigger VIN, plus
      // adversarial inputs. No path may emit 'auth'.
      const probes = [
        ...Object.values(FIXTURE_VINS),
        '',
        'SHORT',
        'WAUZZZ8V5KA123456',
      ];
      for (const vin of probes) {
        const res = await adapter.getHistory(vin);
        if (!res.ok) {
          expect(res.error.code).not.toBe('auth');
        }
      }
    });

    it('error messages are log-safe: no URLs, no credential-shaped content (§4 cross-cutting)', async () => {
      const errorVins = [
        'bad',
        'WBA3B1C50EK590210',
        FIXTURE_VINS.trigger_rate_limited,
        FIXTURE_VINS.trigger_provider_unavailable,
        FIXTURE_VINS.trigger_malformed_response,
      ];
      for (const vin of errorVins) {
        const error = await mustErr(adapter, vin);
        expect(error.message).not.toMatch(/https?:\/\//i);
        expect(error.message).not.toMatch(/api[_-]?key|secret|token|password/i);
      }
    });
  });
});

describe('never-throws boundary — adversarial inputs resolve, never reject (design §6.6)', () => {
  const adversarial: ReadonlyArray<[string, string]> = [
    ['empty string', ''],
    ['lowercase vin', '1hgcm82633a004352'],
    ['16 chars', '1HGCM82633A00435'],
    ['18 chars', '1HGCM82633A0043522'],
    ['illegal letters I/O/Q', 'IOQCM82633A004352'],
    ['unicode', '1HGCM82633A00435é'],
    ['emoji', '\u{1F697}\u{1F697}\u{1F697}\u{1F697}\u{1F697}'],
    ['whitespace padded', ' 1HGCM82633A004352 '],
    ['sql-ish', "'; DROP TABLE deals;--"],
  ];

  describe.each(both)('%s mock', (_name, adapter) => {
    it.each(adversarial)('%s → resolves { ok:false, invalid_input }', async (_label, vin) => {
      const res = await adapter.getHistory(vin);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('invalid_input');
        expect(res.error.retryable).toBe(false);
      }
    });
  });
});

describe('provider-agnosticism — same VINs, same shape, divergent details (D4, §6.5)', () => {
  const dataVins = [
    FIXTURE_VINS.clean,
    FIXTURE_VINS.accident,
    FIXTURE_VINS.branded_title,
  ];

  it('both mocks recognize the same well-known VIN set', async () => {
    for (const vin of dataVins) {
      expect((await carfax.getHistory(vin)).ok).toBe(true);
      expect((await autocheck.getHistory(vin)).ok).toBe(true);
    }
  });

  it('same VIN across both mocks yields the same field set (interface shape)', async () => {
    for (const vin of dataVins) {
      const c = await carfax.getHistory(vin);
      const a = await autocheck.getHistory(vin);
      if (!c.ok || !a.ok) throw new Error('expected ok');
      expect(Object.keys(c.value).sort()).toEqual(Object.keys(a.value).sort());
    }
  });

  it('per-provider details deliberately diverge — no provider answer is canonical (D4)', async () => {
    for (const vin of dataVins) {
      const c = await carfax.getHistory(vin);
      const a = await autocheck.getHistory(vin);
      if (!c.ok || !a.ok) throw new Error('expected ok');
      const diverges =
        c.value.owner_count !== a.value.owner_count ||
        c.value.accident_count !== a.value.accident_count;
      expect(diverges).toBe(true);
    }
  });

  it('clean/accident/branded semantics agree across providers even where details diverge', async () => {
    for (const adapter of [carfax, autocheck]) {
      const clean = await adapter.getHistory(FIXTURE_VINS.clean);
      const branded = await adapter.getHistory(FIXTURE_VINS.branded_title);
      if (!clean.ok || !branded.ok) throw new Error('expected ok');
      expect(clean.value.accident_count).toBe(0);
      expect(clean.value.title_brands).toEqual([]);
      expect(branded.value.title_brands.length).toBeGreaterThan(0);
    }
  });
});

describe('statelessness + idempotency (design §4 cross-cutting)', () => {
  it('interleaved calls across adapters and VINs never affect each other (no state, no ordering sensitivity)', async () => {
    const baselineC = await carfax.getHistory(FIXTURE_VINS.clean);
    const baselineA = await autocheck.getHistory(FIXTURE_VINS.clean);
    // Interleave errors, triggers, and other lookups.
    await carfax.getHistory('nonsense');
    await autocheck.getHistory(FIXTURE_VINS.trigger_rate_limited);
    await carfax.getHistory(FIXTURE_VINS.branded_title);
    await autocheck.getHistory('WBA3B1C50EK590210');
    expect(await carfax.getHistory(FIXTURE_VINS.clean)).toEqual(baselineC);
    expect(await autocheck.getHistory(FIXTURE_VINS.clean)).toEqual(baselineA);
  });

  it('two independently-created adapters of the same provider agree exactly (pure factory)', async () => {
    const a1 = createCarfaxMock({ now: fixedClock });
    const a2 = createCarfaxMock({ now: fixedClock });
    expect(await a1.getHistory(FIXTURE_VINS.accident)).toEqual(
      await a2.getHistory(FIXTURE_VINS.accident),
    );
  });
});
