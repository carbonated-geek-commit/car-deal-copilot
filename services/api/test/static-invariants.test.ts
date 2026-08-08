/**
 * Static tests (docs/design/T-019.md §6): properties that are true of the
 * SOURCE rather than of a request, and that a runtime test cannot observe —
 * an absent import, an absent cast, an absent word.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '..');
const SRC = join(SERVICE, 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });

const SOURCES = walk(SRC).map((path) => ({
  path,
  name: relative(SRC, path).replace(/\\/gu, '/'),
  text: readFileSync(path, 'utf8'),
}));

/**
 * Comments are prose and may legitimately NAME the thing they forbid; code may
 * not. Line-based because every block comment in this service is a JSDoc block
 * opened at the start of a line.
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

const code = (name: string): string => codeOnly(SOURCES.find((s) => s.name === name)?.text ?? '');

describe('the source itself', () => {
  it('collected the service it is asserting about', () => {
    expect(SOURCES.length).toBeGreaterThan(15);
    expect(SOURCES.map((s) => s.name)).toContain('auth/deal-gate.ts');
  });

  it('creates no src/routes/** — that subtree belongs to T-020', () => {
    expect(readdirSync(SRC)).not.toContain('routes');
    expect(SOURCES.some((s) => s.name.startsWith('routes/'))).toBe(false);
    expect(readdirSync(join(SERVICE, 'test'))).not.toContain('routes');
  });

  it('mints a DealHandle in exactly one file (D2)', () => {
    const minting = SOURCES.filter((s) => /as\s+(?:unknown\s+as\s+)?DealHandle/u.test(codeOnly(s.text)));
    expect(minting.map((s) => s.name)).toEqual(['auth/deal-gate.ts']);
    // …and the brand is never exported, so nothing else can reconstruct one.
    expect(code('auth/deal-gate.ts')).toContain('declare const DEAL_HANDLE_BRAND: unique symbol');
    expect(code('auth/deal-gate.ts')).not.toContain('export const DEAL_HANDLE_BRAND');
    expect(code('index.ts')).not.toContain('DEAL_HANDLE_BRAND');
  });

  it('reads an identity off the wire in exactly one file (D1)', () => {
    const readers = SOURCES.filter((s) => /req(?:uest)?\.headers\s*[[.]/u.test(codeOnly(s.text)))
      .map((s) => s.name)
      // `http/request-log.ts` names header PATHS as strings for pino's redact
      // list — the opposite of reading one, and the reason `x-dc-account-id`
      // never reaches a log line.
      .filter((name) => name !== 'http/request-log.ts');
    expect(readers).toEqual(['context/account-context.ts']);
    expect(code('http/request-log.ts')).not.toMatch(/req(?:uest)?\.headers\s*\[[^'"\]]/u);
  });

  it('touches the real process.env in exactly one file', () => {
    const readers = SOURCES.filter((s) => codeOnly(s.text).includes('process.env')).map((s) => s.name);
    expect(readers).toEqual(['start.ts']);
  });

  it('never reaches an unscoped operator surface (@comms ports.ts rule, inherited)', () => {
    for (const source of SOURCES) {
      const text = codeOnly(source.text);
      expect(text, source.name).not.toContain('listQuarantined(');
      // The unscoped call is `listUnrouted()` — no deal id. Every use in this
      // service passes `handle.deal_id`.
      expect(/listUnrouted\(\s*\)/u.test(text), source.name).toBe(false);
    }
  });

  it('selects no authentication provider anywhere (AC-4)', () => {
    // Prose may cite specs/00's list of ALTERNATES; code may not name one,
    // because naming one in code is what choosing one looks like.
    for (const source of SOURCES) {
      const lower = codeOnly(source.text).toLowerCase();
      for (const provider of ['auth0', 'clerk', 'cognito', 'okta', 'firebase']) {
        expect(lower, `${source.name} names ${provider}`).not.toContain(provider);
      }
    }
  });

  it('never spells the removed vocabulary in code (AC-9, AC-11)', () => {
    const forbidden = [
      're' + 'cording',
      'trans' + 'cript',
      'audio_url',
      'audio_ref',
      'media_url',
      'provider_token',
      'credit_report',
      'bureau_response',
    ];
    for (const source of SOURCES) {
      // `projection/guards.ts` is the checker; it assembles the audio names
      // from fragments and holds the credit names on purpose.
      if (source.name === 'projection/guards.ts') continue;
      const text = codeOnly(source.text);
      for (const token of forbidden) {
        expect(text, `${source.name} contains ${token}`).not.toContain(token);
      }
    }
  });

  it('computes nothing the domain owns — no flag engine, no valuation, no extraction (D10, ADR-006, ADR-007)', () => {
    for (const source of SOURCES) {
      for (const forbidden_import of ['@flag-engine', '@adapters/', '@offer-extraction']) {
        expect(source.text, `${source.name} imports ${forbidden_import}`).not.toContain(`'${forbidden_import}`);
      }
    }
  });

  it('imports only what ADR-008 and ADR-009 allow', () => {
    const allowed = new Set(['fastify', 'zod', 'node:process', '@core', '@comms', '@db', '@object-store', '@receipt', '@store-pg']);
    const specifiers = new Set<string>();
    for (const source of SOURCES) {
      for (const match of source.text.matchAll(/from\s+'([^']+)'/gu)) {
        const specifier = match[1] ?? '';
        if (specifier.startsWith('.')) continue;
        specifiers.add(specifier);
      }
    }
    for (const specifier of specifiers) {
      expect(allowed.has(specifier), `unexpected dependency: ${specifier}`).toBe(true);
    }
    // The two ADR-008 libraries this service is allowed to add are present…
    expect(specifiers.has('fastify')).toBe(true);
    expect(specifiers.has('zod')).toBe(true);
  });
});

describe('the manifest (ADR-009: scripts only)', () => {
  const manifest = JSON.parse(readFileSync(join(SERVICE, 'package.json'), 'utf8')) as {
    name: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('gained a typecheck script and nothing else', () => {
    expect(manifest.name).toBe('@deal-copilot/api');
    expect(manifest.scripts).toEqual({ typecheck: 'tsc -p . --noEmit' });
  });

  it('declares exactly the ADR-008 dependency set T-015 installed', () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['fastify', 'zod']);
    expect(manifest.devDependencies).toBeUndefined();
  });
});
