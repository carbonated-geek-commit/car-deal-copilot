/**
 * T-013 tester — `@adapters/credit-prequal` verification gate
 * (docs/design/T-013.md §6, D12; AC-5, AC-7, AC-10, AC-11; specs/01 "Credit
 * data residency"; Q3).
 *
 * T-013 changes NOTHING in this package: a prequal is a property of the BUYER,
 * not of a car, so binding it to a `VehicleInstance` would widen a deliberately
 * minimal residency surface (D12). The design lists four re-verified properties
 * and calls them "a T-013 regression gate" — this file is that gate. Each one is
 * an ABSENCE, so each is asserted structurally rather than by calling something.
 *
 * The existing T-006 suite still carries the behavioral coverage and is
 * untouched.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CreditPrequalAdapter, PrequalResult } from '@core';
import * as api from '@adapters/credit-prequal';
import {
  createMockCreditPrequal,
  MOCK_CREDIT_PREQUAL_SOURCE,
} from '@adapters/credit-prequal';

const T0 = '2026-08-07T12:00:00.000Z';
const { adapter, hostedFlow } = createMockCreditPrequal({ now: () => T0 });

describe('D12 / AC-10 — the prequal surface has NO vehicle binding', () => {
  it('getPrequal takes an opaque token and nothing car-shaped', () => {
    expectTypeOf<CreditPrequalAdapter['getPrequal']>().parameters.toEqualTypeOf<[string]>();
    const _typeOnly = (): void => {
      // @ts-expect-error — there is no instance-bound overload, by design
      void adapter.getPrequal({ vehicle_instance_id: 'vi-1' });
      // @ts-expect-error — nor a second vehicle argument
      void adapter.getPrequal('tok', 'vi-1');
    };
    expect(typeof _typeOnly).toBe('function');
  });

  it('PrequalResult carries exactly the four token+prequal keys — no vehicle field', async () => {
    const { provider_token } = hostedFlow.complete('prime');
    const res = await adapter.getPrequal(provider_token);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.value).sort()).toEqual(
      ['approved_amount_max', 'fetched_at', 'provider_token', 'qualified_apr'].sort(),
    );
    expectTypeOf<keyof PrequalResult>().toEqualTypeOf<
      'provider_token' | 'qualified_apr' | 'approved_amount_max' | 'fetched_at'
    >();
  });

  it('the hosted flow takes a scenario id only — nothing applicant- or vehicle-shaped', () => {
    const _typeOnly = (): void => {
      // @ts-expect-error — no applicant fields exist on the harness input
      void hostedFlow.complete({ ssn: '000-00-0000' });
      // @ts-expect-error — nor a vehicle
      void hostedFlow.complete('prime', { vehicle_instance_id: 'vi-1' });
    };
    expect(typeof _typeOnly).toBe('function');
  });

  it('the factory result exposes exactly { adapter, hostedFlow }', () => {
    const built = createMockCreditPrequal();
    expect(Object.keys(built).sort()).toEqual(['adapter', 'hostedFlow']);
    expect(Object.keys(built.adapter).sort()).toEqual(['getPrequal', 'source']);
    expect(built.adapter.source).toBe(MOCK_CREDIT_PREQUAL_SOURCE);
  });
});

// ------------------------------------------------------------ source gates

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

describe('AC-10 / Q3 — nothing here can hold raw credit data', () => {
  it('the scan sees the package', () => {
    expect(files.map((f) => f.path).sort()).toEqual(['fixtures.ts', 'index.ts', 'mock-adapter.ts']);
  });

  it('no field name anywhere could carry a score, report, tradeline, or applicant identity', () => {
    // Comment-stripped: the doc comments deliberately NAME what is absent
    // ("no applicant identity (name, SSN, DOB, address, income)"), and matching
    // that prose would be a false positive. Only declared code may be scanned.
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(
        /\b(?:ssn|social_security|fico|credit_score|creditScore|tradeline|bureau_report|date_of_birth|dob)\b/i,
      );
    }
  });

  it('no vehicle vocabulary reaches the credit surface (D12)', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(
        /\b(?:VehicleInstance|VehicleTarget|vehicle_instance_id|ValuationSnapshot|\bvin\b)\b/i,
      );
    }
  });
});

describe('AC-7 — the credit provider stays mock-only (pass-through, no live path)', () => {
  it.each([
    ['a fetch call', /\bfetch\s*\(/],
    ['an http(s) URL', /https?:\/\//],
    ['an env read', /\bprocess\s*\.\s*env\b/],
    ['a node transport/fs import', /from\s+['"](?:node:)?(?:http|https|net|tls|fs|child_process)['"]/],
    ['a credential-shaped identifier', /\b(?:apiKey|api_key|accessToken|clientSecret|Authorization)\b/],
    ['a named provider SDK', /\b(?:plaid|measureone|array|equifax|experian|transunion)\b/i],
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
});

describe('AC-5 / AC-11 — boundary and vocabulary', () => {
  it('the public surface is exactly the designed set; nothing provider-shaped', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_PREQUAL_FIXTURES',
      'MOCK_CREDIT_PREQUAL_SOURCE',
      'createMockCreditPrequal',
    ]);
  });

  it('no spine type is redefined here', () => {
    for (const f of files) {
      for (const name of [
        'PrequalResult',
        'CreditPrequalAdapter',
        'AdapterResult',
        'AdapterError',
        'AdapterErrorCode',
        'MoneyCents',
        'IsoTimestamp',
      ]) {
        expect(f.code, `${f.path} redefines ${name}`).not.toMatch(
          new RegExp(`(?:interface|type|class|enum)\\s+${name}\\b`),
        );
      }
    }
  });

  it('isolation — no account, owner, deal, thread, or dealership identifier appears', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(
        /\b(?:account_id|accountId|owner_id|ownerId|deal_id|dealId|thread_id|threadId)\b/,
      );
      expect(f.code, f.path).not.toMatch(/\bDealership(?:Contact)?\b/);
    }
  });

  it('append-only posture: the adapter exposes a single read operation', () => {
    const a: CreditPrequalAdapter = adapter;
    expect(Object.keys(a).sort()).toEqual(['getPrequal', 'source']);
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/\b(?:update|delete|remove|purge)[A-Z]\w*\s*\(/);
    }
  });
});
