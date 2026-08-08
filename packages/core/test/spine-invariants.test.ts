/**
 * T-001 tester — repo-level spine invariants (docs/design/T-001.md §7, §8).
 *
 * AC-4 / ADR-001: spine types defined ONCE in packages/core — the design's
 * grep rule ("any hit is a finding") automated.
 * Append-only receipt posture: core exports no update/delete/mutate surface.
 * CLAUDE.md invariant 2: root devDeps frozen to typescript + vitest; core has
 * no deps; core src imports nothing external (anti-corruption).
 * §1.4 sync rule: tsconfig paths ↔ vitest.workspace alias parity.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@core';

const testDir = dirname(fileURLToPath(import.meta.url)); // packages/core/test
const repoRoot = resolve(testDir, '..', '..', '..');

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('AC-4 / ADR-001 — spine defined once, no parallel type definitions', () => {
  it('no interface/type/class/enum named Deal, DealerThread, Message, or Offer exists outside packages/core', () => {
    const corePkg = resolve(repoRoot, 'packages', 'core');
    const candidates = [
      ...tsFilesUnder(resolve(repoRoot, 'packages')),
      ...tsFilesUnder(resolve(repoRoot, 'services')),
    ].filter((f) => !f.startsWith(corePkg));
    const pattern = /\b(?:interface|type|class|enum)\s+(Deal|DealerThread|Message|Offer)\b/;
    const offenders: string[] = [];
    for (const file of candidates) {
      if (pattern.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('append-only receipt posture — no update/delete surface in core', () => {
  it('runtime exports of @core contain no mutator (the spine is types + one const)', () => {
    const names = Object.keys(core);
    const mutatorish = names.filter((n) =>
      /(update|delete|remove|mutate|purge|redact|overwrite)/i.test(n),
    );
    expect(mutatorish).toEqual([]);
    // Runtime exports: the ADR-002 flag vocabulary + the pure §5.2 quarantine
    // narrowing guard (design allows "a small amount of pure helper code").
    expect(names.sort()).toEqual(['OFFER_FLAGS', 'isQuarantinedInbound']);
  });

  it('core source declares no update/delete/remove method on any contract', () => {
    const srcFiles = tsFilesUnder(resolve(repoRoot, 'packages', 'core', 'src'));
    expect(srcFiles.length).toBeGreaterThanOrEqual(4); // index, domain, adapters, events
    const mutatorMethod = /\b(?:update|delete|remove|purge|redact)[A-Z]\w*\s*\(/;
    for (const file of srcFiles) {
      expect(mutatorMethod.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });
});

describe('anti-corruption boundary — core imports nothing external', () => {
  it('every import in packages/core/src is relative (no provider SDKs, no deps)', () => {
    const srcFiles = tsFilesUnder(resolve(repoRoot, 'packages', 'core', 'src'));
    const importRe = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g;
    for (const file of srcFiles) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(importRe)) {
        const specifier = match[1]!;
        expect(specifier.startsWith('.'), `${file} imports "${specifier}"`).toBe(true);
      }
    }
  });

  it('packages/core/package.json declares zero dependencies of any kind', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages', 'core', 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg['devDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
  });
});

describe('CLAUDE.md invariant 2 — approved stack only', () => {
  it('root devDependencies are exactly typescript + vitest, and root has no dependencies', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual([
      'typescript',
      'vitest',
    ]);
  });
});

describe('AC-8 tooling — §1.4 alias sync rule (tsconfig paths ↔ vitest workspace)', () => {
  const EXPECTED_ALIASES: Record<string, string> = {
    '@core': 'packages/core/src/index.ts',
    '@flag-engine': 'packages/flag-engine/src/index.ts',
    '@adapters/valuation': 'packages/adapters/valuation/src/index.ts',
    '@adapters/nhtsa': 'packages/adapters/nhtsa/src/index.ts',
    '@adapters/vehicle-history': 'packages/adapters/vehicle-history/src/index.ts',
    '@adapters/credit-prequal': 'packages/adapters/credit-prequal/src/index.ts',
    '@offer-extraction': 'packages/offer-extraction/src/index.ts',
    '@receipt': 'packages/receipt/src/index.ts',
  };

  it('tsconfig.base.json predeclares exactly the eight bare aliases (no /* deep-import entries — D3)', () => {
    const base = JSON.parse(
      readFileSync(resolve(repoRoot, 'tsconfig.base.json'), 'utf8'),
    ) as { compilerOptions: { paths: Record<string, string[]> } };
    const paths = base.compilerOptions.paths;
    expect(Object.keys(paths).sort()).toEqual(Object.keys(EXPECTED_ALIASES).sort());
    for (const [alias, target] of Object.entries(EXPECTED_ALIASES)) {
      expect(paths[alias]).toEqual([target]);
      expect(alias.endsWith('/*')).toBe(false); // bare aliases only
    }
  });

  it('vitest.workspace.ts carries the same eight entries, entry-for-entry', () => {
    const text = readFileSync(resolve(repoRoot, 'vitest.workspace.ts'), 'utf8');
    for (const [alias, target] of Object.entries(EXPECTED_ALIASES)) {
      expect(text, `alias ${alias} missing`).toContain(`'${alias}'`);
      expect(text, `target for ${alias} missing`).toContain(`'${target}'`);
    }
    // no ninth alias sneaked in: count the r('...') resolutions
    const aliasCount = (text.match(/r\('/g) ?? []).length;
    expect(aliasCount).toBe(8);
  });

  it('workspace test globs cover every reserved package location (no future root edits needed)', () => {
    const text = readFileSync(resolve(repoRoot, 'vitest.workspace.ts'), 'utf8');
    for (const glob of [
      'packages/**/src/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'services/**/src/**/*.test.ts',
      'services/**/test/**/*.test.ts',
    ]) {
      expect(text).toContain(glob);
    }
  });
});
