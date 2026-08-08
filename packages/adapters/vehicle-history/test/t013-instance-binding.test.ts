/**
 * T-013 tester — `@adapters/vehicle-history` verification gate
 * (docs/design/T-013.md §5, D8, D10; AC-3, AC-5, AC-6, AC-7, AC-11).
 *
 * T-013 makes NO signature change here — the design is explicit that "a builder
 * who finds themselves rewriting vehicle-history has left the task". What it
 * adds is a RECORDED GUARANTEE, and a guarantee that is only written in a doc
 * comment is untested. This file is that test:
 *
 * - D10: an instance whose `vin` is absent cannot reach `getHistory` — the
 *   compiler is the enforcement, so the gate is `@ts-expect-error`.
 * - D8: the history contribution reaches a `VehicleData` ONLY through
 *   `toVehicleData(instance, parts, captured_at)`; this package never produces a
 *   `VehicleData` and never sees a `vehicle_instance_id`.
 * - D9: a successful summary is an ANSWER — `title_brands: []` means "clean",
 *   never "we did not look", because a failed call yields no summary at all.
 * - AC-7: Carfax and AutoCheck stay mock-only; no credential, no HTTP, no audio.
 *
 * The existing T-005 suites (carfax-mock / autocheck-mock / contract) still
 * carry the behavioral coverage and are untouched.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { VehicleHistoryAdapter, VehicleHistorySummary, VehicleInstance } from '@core';
import { toVehicleData } from '@adapters/nhtsa';
import {
  createAutoCheckMock,
  createCarfaxMock,
  FIXTURE_VINS,
} from '@adapters/vehicle-history';

const T0 = '2026-08-07T12:00:00.000Z';
const clock = (): string => T0;

const carfax = createCarfaxMock({ now: clock });

/** The normal launch case: the buyer never entered a VIN (Q16). */
const VINLESS: VehicleInstance = {
  id: 'vi-no-vin',
  year: 2019,
  condition: 'used',
  additions: [],
};

const WITH_VIN: VehicleInstance = {
  id: 'vi-with-vin',
  vin: FIXTURE_VINS.clean,
  year: 2019,
  condition: 'used',
  additions: [],
};

describe('D10 — "no VIN ⇒ no history call" is a COMPILE error, not a runtime guard', () => {
  it('an instance with an absent VIN cannot be passed to getHistory', () => {
    const _typeOnly = (): void => {
      // @ts-expect-error — instance.vin is `Vin | undefined`; getHistory takes `Vin`
      void carfax.getHistory(VINLESS.vin);
      // @ts-expect-error — the same holds for the AutoCheck mock
      void createAutoCheckMock().getHistory(VINLESS.vin);
    };
    expect(typeof _typeOnly).toBe('function');
  });

  it('a narrowed VIN is accepted — narrowing, never validation of the buyer’s record', async () => {
    const vin = WITH_VIN.vin;
    expect(vin).toBeDefined();
    if (vin === undefined) return;
    const res = await carfax.getHistory(vin);
    expect(res.ok).toBe(true);
  });

  it('the adapter takes a Vin and nothing instance-shaped (AC-5, no widening)', () => {
    const _typeOnly = (): void => {
      // @ts-expect-error — the adapter is VIN-keyed; it never receives an instance
      void carfax.getHistory(WITH_VIN);
    };
    expectTypeOf<VehicleHistoryAdapter['getHistory']>().parameters.toEqualTypeOf<[string]>();
    expect(typeof _typeOnly).toBe('function');
  });
});

describe('D8 / AC-3 — a history summary becomes instance-bound only at assembly', () => {
  it('VehicleHistorySummary itself carries no vehicle_instance_id (it is VIN-keyed)', async () => {
    const res = await carfax.getHistory(FIXTURE_VINS.accident);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('vehicle_instance_id' in res.value).toBe(false);
    expect(Object.keys(res.value).sort()).toEqual(
      ['accident_count', 'fetched_at', 'owner_count', 'source', 'title_brands', 'vin'].sort(),
    );
  });

  it('the assembler is the ONE place the summary gets bound to an instance', async () => {
    const res = await carfax.getHistory(FIXTURE_VINS.accident);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const history: VehicleHistorySummary = res.value;
    const vd = toVehicleData(WITH_VIN, { recalls: [], history }, T0);
    expect(vd.vehicle_instance_id).toBe('vi-with-vin');
    expect(vd.history).toEqual(history);
    expect('vin' in vd).toBe(false);
  });

  it('this package exports no VehicleData producer of its own (D8)', async () => {
    const api = (await import('@adapters/vehicle-history')) as unknown as Record<string, unknown>;
    for (const forbidden of ['toVehicleData', 'buildVehicleData', 'assemble']) {
      expect(api[forbidden]).toBeUndefined();
    }
  });
});

describe('D9 / ADR-005 — a summary is an ANSWER; a failure yields no summary at all', () => {
  it('title_brands: [] comes only from a SUCCESSFUL call, so it can only mean "clean"', async () => {
    const clean = await carfax.getHistory(FIXTURE_VINS.clean);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.value.title_brands).toEqual([]);
    expect(clean.value.accident_count).toBe(0);
  });

  it('a failed call carries no value arm — there is nothing to mistake for a clean record', async () => {
    for (const vin of [
      FIXTURE_VINS.trigger_rate_limited,
      FIXTURE_VINS.trigger_provider_unavailable,
      FIXTURE_VINS.trigger_malformed_response,
      'WBA3B1C50EK590210', // well-formed, unknown → not_found
      'nonsense', // malformed → invalid_input
    ]) {
      const res = await carfax.getHistory(vin);
      expect(res.ok).toBe(false);
      expect('value' in res).toBe(false);
    }
  });

  it('assembling a VehicleData from a failed history is unrepresentable', () => {
    const _typeOnly = (): void => {
      // @ts-expect-error — `history` must be a VehicleHistorySummary, not an AdapterResult
      void toVehicleData(WITH_VIN, { recalls: [], history: { ok: false } }, T0);
    };
    expect(typeof _typeOnly).toBe('function');
  });
});

// ------------------------------------------------------- mock-only posture

const SRC = new URL('../src/', import.meta.url);

interface SourceFile {
  readonly path: string;
  readonly raw: string;
  readonly code: string;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collect(dir: URL, prefix = ''): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...collect(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.ts')) {
      const raw = readFileSync(new URL(entry.name, dir), 'utf8');
      out.push({ path: `${prefix}${entry.name}`, raw, code: stripComments(raw) });
    }
  }
  return out;
}

const files = collect(SRC);

describe('AC-7 — Carfax and AutoCheck stay mock-only', () => {
  it('the scan sees the package', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each([
    ['a fetch call', /\bfetch\s*\(/],
    ['an http(s) URL', /https?:\/\//],
    ['an env read', /\bprocess\s*\.\s*env\b/],
    ['a node transport/fs import', /from\s+['"](?:node:)?(?:http|https|net|tls|fs|child_process)['"]/],
    ['a credential-shaped identifier', /\b(?:apiKey|api_key|accessToken|clientSecret|Authorization)\b/],
  ])('no src file contains %s', (_label, pattern) => {
    for (const f of files) expect(f.code, f.path).not.toMatch(pattern);
  });

  it('the package declares no runtime dependency', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('no audio, recording, or transcription path exists anywhere in this package', () => {
    for (const f of files) {
      expect(f.raw, f.path).not.toMatch(
        /\b(?:audio|transcript|transcription|recording_url|speech|voicemail|\.mp3|\.wav)\b/i,
      );
    }
  });

  it('AC-11 — no spine type is redefined here', () => {
    for (const f of files) {
      for (const name of [
        'VehicleHistorySummary',
        'VehicleHistoryAdapter',
        'VehicleInstance',
        'AdapterResult',
        'AdapterError',
        'Vin',
      ]) {
        expect(f.code, `${f.path} redefines ${name}`).not.toMatch(
          new RegExp(`(?:interface|type|class|enum)\\s+${name}\\b`),
        );
      }
    }
  });

  it('Q13 / isolation — no dealership, account, deal, or thread identifier appears', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/\bDealership(?:Contact)?\b/);
      expect(f.code, f.path).not.toMatch(
        /\b(?:account_id|accountId|owner_id|ownerId|deal_id|dealId|thread_id|threadId)\b/,
      );
    }
  });

  it('append-only posture: the adapter exposes a single read operation', () => {
    expect(Object.keys(carfax).sort()).toEqual(['getHistory', 'source']);
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/\b(?:update|delete|remove|purge)[A-Z]\w*\s*\(/);
    }
  });
});
