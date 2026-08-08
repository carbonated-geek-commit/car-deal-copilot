/**
 * T-013 tester — structural posture gates for `@adapters/valuation`
 * (docs/design/T-013.md §8, §9 obligations 9 and 10; AC-5, AC-6, AC-7, AC-9,
 * AC-11; CLAUDE.md mock-only invariant; Q13, Q15, Q16, Q20).
 *
 * These are grep-style gates over the package's own `src/` tree plus type-level
 * assertions. They exist because the mandates they protect are ABSENCES, and an
 * absence cannot be exercised by calling a function — the only way to test it is
 * to prove nothing in the tree can express it.
 *
 * Comment text is stripped before every code-affordance scan: the doc comments
 * deliberately NAME the forbidden things ("no marketplace source", "no
 * credential") and matching those would be a false positive.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ValuationAdapter, ValuationRequest } from '@core';
import { createKbbMockAdapter } from '@adapters/valuation';
import { instance, request, target } from './helpers.js';

const SRC = new URL('../src/', import.meta.url);

interface SourceFile {
  readonly path: string;
  /** Raw text, comments included. */
  readonly raw: string;
  /** Comments stripped — what the runtime can actually express. */
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

describe('the scan itself is wired correctly', () => {
  it('sees every src file in the package', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.map((f) => f.path).sort()).toContain('mock-adapter.ts');
    expect(files.map((f) => f.path).sort()).toContain('fixtures/kbb.fixtures.ts');
  });

  it('comment stripping removes the doc text that names forbidden things', () => {
    const stripped = files.map((f) => f.code).join('\n');
    // The words exist in the docs; they must not survive into the code scan.
    expect(files.map((f) => f.raw).join('\n')).toMatch(/marketplace/i);
    expect(stripped).not.toMatch(/marketplace/i);
  });
});

describe('AC-7 / CLAUDE.md — KBB and Manheim stay mock-only (no network, no credential)', () => {
  it.each([
    ['a fetch call', /\bfetch\s*\(/],
    ['an http(s) URL', /https?:\/\//],
    ['an env read', /\bprocess\s*\.\s*env\b/],
    ['a node transport/fs import', /from\s+['"](?:node:)?(?:http|https|net|tls|dns|fs|child_process)['"]/],
    ['XMLHttpRequest / axios / a websocket', /\b(?:XMLHttpRequest|axios|WebSocket|undici|got)\b/],
    ['a credential-shaped identifier', /\b(?:apiKey|api_key|accessToken|clientSecret|bearerToken)\b/],
  ])('no src file contains %s', (_label, pattern) => {
    for (const f of files) expect(f.code, f.path).not.toMatch(pattern);
  });

  it('the package declares no runtime dependency at all', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('fixtures are TypeScript modules — no JSON loading, no I/O, no randomness, no clock read', () => {
    const fixtureFiles = files.filter((f) => f.path.startsWith('fixtures/'));
    expect(fixtureFiles.length).toBe(2);
    for (const f of fixtureFiles) {
      expect(f.code, f.path).not.toMatch(/readFileSync|import\s*\(|require\s*\(|\.json['"]/);
      expect(f.code, f.path).not.toMatch(/Math\s*\.\s*random|new\s+Date|Date\s*\.\s*now/);
    }
  });
});

describe('AC-9 / Q15 — no private-party comps source, no marketplace, no scraping', () => {
  it.each([
    ['facebook / meta', /\bfacebook|\bmeta\s*\.\s*com|graph\.facebook/i],
    ['a marketplace or classifieds source', /\bmarketplace\b|\bcraigslist\b|\bautotrader\b|\bcars\.com\b/i],
    ['a scraping tool', /\bscrape|\bscraping|puppeteer|playwright|cheerio|jsdom/i],
    ['a comps type or loader', /\bcomps?\b/i],
  ])('no src code expresses %s', (_label, pattern) => {
    for (const f of files) expect(f.code, f.path).not.toMatch(pattern);
  });
});

describe('AC-6 / Q16 — no VIN validation or decode precondition survives', () => {
  it('no VIN charset/length regex or decode call exists in this package', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/A-HJ-NPR-Z/); // the VIN alphabet
      expect(f.code, f.path).not.toMatch(/\{\s*17\s*\}/); // a 17-char length check
      expect(f.code, f.path).not.toMatch(/decodeVin|VinDecode|@adapters\/nhtsa/);
    }
  });

  it('the only VIN handling is trim + uppercase for fixture matching', () => {
    const mock = files.find((f) => f.path === 'mock-adapter.ts');
    expect(mock).toBeDefined();
    expect(mock?.code).toMatch(/trim\(\)\.toUpperCase\(\)/);
  });
});

describe('AC-11 / ADR-001 — no spine type is redefined here', () => {
  it('no src file declares a domain type name that @core already owns', () => {
    const spineNames = [
      'ValuationSnapshot',
      'ValuationRequest',
      'ValuationAdapter',
      'VehicleInstance',
      'VehicleTarget',
      'VehicleCondition',
      'AdapterError',
      'AdapterResult',
      'AdapterErrorCode',
      'MoneyCents',
      'IsoTimestamp',
      'Vin',
    ];
    for (const f of files) {
      for (const name of spineNames) {
        expect(f.code, `${f.path} redefines ${name}`).not.toMatch(
          new RegExp(`(?:interface|type|class|enum)\\s+${name}\\b`),
        );
      }
    }
  });

  it('every domain vocabulary word is imported from @core', () => {
    const importers = files.filter((f) => /ValuationSnapshot|VehicleInstance/.test(f.code));
    expect(importers.length).toBeGreaterThan(0);
    for (const f of importers) {
      expect(f.code, f.path).toMatch(/from\s+'@core'/);
    }
  });
});

describe('tenancy, isolation and scope — what the adapter layer must NOT be able to see', () => {
  it('no adapter takes an account, owner, deal, or thread identifier (isolation by absence)', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(
        /\b(?:account_id|accountId|owner_id|ownerId|deal_id|dealId|thread_id|threadId|tenant)\b/,
      );
    }
  });

  it('Q13 — no dealership directory: neither Dealership nor DealershipContact is referenced', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/\bDealership(?:Contact)?\b/);
      expect(f.code, f.path).not.toMatch(/\b(?:zip_code|address|latitude|longitude|geocode)\b/);
    }
  });

  it('Q20 — the deal budget / walk-away number has no path into a valuation', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/walk_away|walkAway|\bbudget\b|target_price/);
    }
    // Structural: ValuationRequest is exactly { target, instance }.
    const req: ValuationRequest = request();
    expect(Object.keys(req).sort()).toEqual(['instance', 'target']);
    // @ts-expect-error — there is no slot for a budget on the request
    const _bad: ValuationRequest = { ...req, walk_away_number: 1 };
    expect(_bad).toBeDefined();
  });

  it('no audio, recording, or transcription path exists anywhere in this package', () => {
    for (const f of files) {
      // Raw text, comments included: not even a placeholder may be present.
      expect(f.raw, f.path).not.toMatch(
        /\b(?:audio|transcript|transcription|recording_url|speech|voicemail|\.mp3|\.wav)\b/i,
      );
    }
  });

  it('receipt-style append-only: the adapter exposes no update or delete affordance', () => {
    const adapter: ValuationAdapter = createKbbMockAdapter();
    expect(Object.keys(adapter).sort()).toEqual(['getValuation', 'source']);
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/\b(?:update|delete|remove|purge|mutate)[A-Z]\w*\s*\(/);
    }
  });

  it('the package holds no module-level mutable state (stateless by construction)', () => {
    for (const f of files) {
      // Column-0 `let`/`var` only — function-local bindings are fine.
      expect(f.code, f.path).not.toMatch(/^(?:let|var)\s+\w+/m);
    }
  });
});

describe('AC-1 — an unbound valuation is not expressible through the public surface', () => {
  it('getValuation cannot be called with a bare make/model (compile-time only)', () => {
    const adapter = createKbbMockAdapter();
    const _typeOnly = (): void => {
      // @ts-expect-error — no overload accepts { vehicle: { make, model } }
      void adapter.getValuation({ vehicle: { make: 'Honda', model: 'Accord' } });
      // @ts-expect-error — the instance half is required
      void adapter.getValuation({ target: target() });
      // @ts-expect-error — the anchor half is required
      void adapter.getValuation({ instance: instance() });
    };
    expect(typeof _typeOnly).toBe('function');
  });
});
