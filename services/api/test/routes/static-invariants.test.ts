/**
 * Properties of the ROUTE SOURCE rather than of a request (docs/design/T-020.md
 * §1.2) — an absent import, an absent cast, an absent word. A runtime test
 * cannot observe these, and each one is a rule a future edit could quietly
 * break without failing any behavioural case.
 *
 * Scope is `services/api/src/routes/**` only. The rest of `src/**` is T-019's
 * and is asserted by T-019's own static suite.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = join(HERE, '..', '..', 'src', 'routes');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });

/**
 * Comments are prose and may legitimately NAME the thing they forbid; code may
 * not. Same construction T-019's static suite uses, and for the same reason: a
 * checker that spells the words it looks for poisons its own corpus.
 */
const codeOnly = (text: string): string => {
  const out: string[] = [];
  let in_block = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (in_block) {
      if (line.includes('*/')) in_block = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) in_block = true;
      continue;
    }
    if (line.startsWith('//')) continue;
    out.push(raw.replace(/\s\/\/.*$/u, ''));
  }
  return out.join('\n');
};

const SOURCES = walk(ROUTES).map((path) => {
  const text = readFileSync(path, 'utf8');
  return { name: relative(ROUTES, path).replace(/\\/gu, '/'), text, code: codeOnly(text) };
});

describe('the route source itself', () => {
  it('collected the subtree it is asserting about', () => {
    expect(SOURCES.length).toBeGreaterThan(10);
    expect(SOURCES.map((s) => s.name)).toContain('index.ts');
    expect(SOURCES.map((s) => s.name)).toContain('target-vehicle.ts');
  });

  it('computes no verdict — no @flag-engine, no adapter, no extractor (D9, D10)', () => {
    for (const source of SOURCES) {
      for (const forbidden of ['@flag-engine', '@adapters/', '@offer-extraction']) {
        expect(source.text, `${source.name} imports ${forbidden}`).not.toContain(`'${forbidden}`);
      }
    }
  });

  it('imports only what T-019’s allowlist permits', () => {
    const allowed = new Set(['fastify', 'zod', '@core', '@comms', '@db', '@object-store', '@receipt', '@store-pg']);
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(/from\s+'([^']+)'/gu)) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('.')) continue;
        expect(allowed.has(specifier), `${source.name} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('imports no node builtin — no crypto, no process, no net (D2)', () => {
    for (const source of SOURCES) {
      expect(source.text, source.name).not.toContain("'node:");
      expect(source.code, source.name).not.toContain('process.env');
      expect(source.code, source.name).not.toContain('randomUUID');
      expect(source.code, source.name).not.toContain('Math.random');
    }
  });

  it('mints no DealHandle and reads no identity off the wire', () => {
    for (const source of SOURCES) {
      expect(/as\s+(?:unknown\s+as\s+)?DealHandle/u.test(source.code), source.name).toBe(false);
      expect(/req(?:uest)?\.headers\s*[[.]/u.test(source.code), source.name).toBe(false);
    }
  });

  it('declares no parallel spine type (ADR-001)', () => {
    const spine = [
      'Deal',
      'DealerThread',
      'Dealership',
      'DealershipContact',
      'Message',
      'Offer',
      'OfferFee',
      'VehicleInstance',
      'VehicleTarget',
      'YearRange',
      'ValuationSnapshot',
      'IdentityRef',
    ];
    for (const source of SOURCES) {
      for (const name of spine) {
        expect(
          new RegExp(String.raw`(?:interface|type|class)\s+${name}\b`, 'u').test(source.code),
          `${source.name} redeclares ${name}`,
        ).toBe(false);
      }
    }
  });

  it('never spells the removed audio / transcription vocabulary (specs/01 consent posture)', () => {
    const forbidden = [
      're' + 'cording',
      're' + 'cording_url',
      'trans' + 'cript',
      'trans' + 'cription',
      'audio',
      'media_url',
      'speech',
      'diariz',
    ];
    for (const source of SOURCES) {
      const lower = source.code.toLowerCase();
      for (const token of forbidden) {
        expect(lower, `${source.name} contains ${token}`).not.toContain(token);
      }
    }
  });

  it('names no credit payload field (specs/01 "Credit data residency")', () => {
    for (const source of SOURCES) {
      const lower = source.code.toLowerCase();
      for (const token of ['provider_token', 'credit_report', 'bureau_response', 'ssn', 'fico']) {
        expect(lower, `${source.name} contains ${token}`).not.toContain(token);
      }
    }
  });

  it('names no mock-only provider and reaches no network (mock-only integrations stay mocks)', () => {
    for (const source of SOURCES) {
      const lower = source.code.toLowerCase();
      for (const token of ['kbb', 'manheim', 'carfax', 'autocheck', 'experian', 'equifax', 'transunion', 'nhtsa']) {
        expect(lower, `${source.name} names ${token}`).not.toContain(token);
      }
      for (const token of ['fetch(', 'axios', 'undici', 'xmlhttprequest', 'http://', 'https://', 'new websocket']) {
        expect(lower, `${source.name} reaches out with ${token}`).not.toContain(token);
      }
    }
  });

  it('selects no authentication provider (T-019 AC-4, inherited)', () => {
    for (const source of SOURCES) {
      const lower = source.code.toLowerCase();
      for (const provider of ['auth0', 'clerk', 'cognito', 'okta', 'firebase']) {
        expect(lower, `${source.name} names ${provider}`).not.toContain(provider);
      }
    }
  });

  it('exposes no ranking, score, or fused verdict key (D11)', () => {
    for (const source of SOURCES) {
      for (const key of ['verdict', 'score', 'rank', 'ranking', 'best_offer', 'recommendation']) {
        expect(
          new RegExp(String.raw`\b${key}\b`, 'u').test(source.code),
          `${source.name} spells ${key}`,
        ).toBe(false);
      }
    }
  });

  it('has no "clear" / "passing" / "fine" flag state anywhere (D10)', () => {
    const views = SOURCES.find((s) => s.name === 'views.ts');
    expect(views).toBeDefined();
    expect(views?.code).toContain("'flagged' | 'unevaluable' | 'not_evaluated'");
    // `'ok'` is deliberately NOT in this list: it is the Result discriminant
    // this whole service uses for failures-as-values, not a flag state.
    for (const source of SOURCES) {
      for (const state of ["'clear'", "'passing'", "'fine'", "'fair'", "'triggered'", "'not_triggered'"]) {
        expect(source.code, `${source.name} spells ${state}`).not.toContain(state);
      }
    }
  });

  it('consults @core.isTargetVehicleLocked and implements no rival predicate', () => {
    const consumers = SOURCES.filter((s) => s.code.includes('isTargetVehicleLocked'));
    expect(consumers.map((s) => s.name)).toEqual(['target-vehicle.ts']);
    expect(consumers[0]?.text).toContain("from '@core'");

    // No route file restates the lock's three disjuncts on its own.
    for (const source of SOURCES) {
      expect(source.code, source.name).not.toContain("status !== 'draft'");
      expect(source.code, source.name).not.toContain('offers.length > 0');
    }
  });

  it('imports the flag vocabulary rather than re-declaring the literals', () => {
    const assessment = SOURCES.find((s) => s.name === 'assessment.ts');
    expect(assessment?.text).toContain("import { OFFER_FLAGS } from '@core'");
    for (const source of SOURCES) {
      expect(source.code, source.name).not.toContain("'payment_packing' |");
      expect(source.code, source.name).not.toContain("['payment_packing'");
    }
  });

  it('reaches the store only through the scoped seam', () => {
    for (const source of SOURCES) {
      // The unscoped operator surfaces `@comms` declares are unreachable here.
      expect(source.code, source.name).not.toContain('listQuarantined(');
      expect(/listUnrouted\(\s*\)/u.test(source.code), source.name).toBe(false);
    }
  });

  it('never registers a DELETE handler in source', () => {
    for (const source of SOURCES) {
      expect(source.code, source.name).not.toContain('app.delete(');
      expect(source.code, source.name).not.toContain(".delete('");
    }
  });
});
