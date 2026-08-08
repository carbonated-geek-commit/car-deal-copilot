/**
 * T-010 tester — repo-level spine invariants (docs/design/T-010.md §1, §6, §7.5).
 *
 * AC-16 / I-11 the v0.5 spine is defined ONCE in packages/core — no parallel or
 *              compatibility-shim definitions survive anywhere.
 * §1          the delete-not-deprecate checklist, automated: every removed
 *              identifier must be absent from the package's CODE (comments that
 *              explain the absence are the point and are stripped before matching).
 * I-8         append-only receipt posture: core exports and declares no
 *              update/delete/mutate surface of any kind.
 * I-13        anti-corruption: core imports nothing external and has zero deps;
 *              only approved-stack packages appear in root config.
 * §1.4        tsconfig `paths` ↔ vitest workspace alias parity (root config is
 *              T-015-owned; this asserts the SYNC RULE, not T-015's entry list).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@core';

const testDir = dirname(fileURLToPath(import.meta.url)); // packages/core/test
const repoRoot = resolve(testDir, '..', '..', '..');
const coreSrc = resolve(repoRoot, 'packages', 'core', 'src');

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

/** Comments explaining WHY something was removed are required by the design;
 * what must not survive is the identifier in a code position. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('AC-16 / I-11 — the v0.5 spine is defined exactly once', () => {
  it('no interface/type/class/enum with a spine name exists outside packages/core', () => {
    const corePkg = resolve(repoRoot, 'packages', 'core');
    const candidates = [
      ...tsFilesUnder(resolve(repoRoot, 'packages')),
      ...tsFilesUnder(resolve(repoRoot, 'services')),
    ].filter((f) => !f.startsWith(corePkg));
    const pattern =
      /\b(?:interface|type|class|enum)\s+(Deal|DealerThread|Message|Offer|VehicleTarget|VehicleInstance|Dealership|DealershipContact|ValuationSnapshot|VehicleData)\b/;
    const offenders: string[] = [];
    for (const file of candidates) {
      if (pattern.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('each v0.5 spine type is declared exactly once inside packages/core/src', () => {
    const sources = tsFilesUnder(coreSrc).map((f) => readFileSync(f, 'utf8'));
    const names = [
      'VehicleTarget',
      'VehicleInstance',
      'Dealership',
      'DealershipContact',
      'Deal',
      'DealerThread',
      'Message',
      'Offer',
      'CallMeta',
      'ValuationSnapshot',
      'VehicleData',
      'IdentityRef',
      'InboundComms',
    ];
    for (const name of names) {
      const declarations = sources.reduce((n, text) => {
        const re = new RegExp(`\\b(?:interface|type|class|enum)\\s+${name}\\b`, 'g');
        return n + (text.match(re) ?? []).length;
      }, 0);
      expect(declarations, `${name} declaration count`).toBe(1);
    }
  });
});

describe('§1 — delete-not-deprecate checklist (a hit is a finding)', () => {
  const codeOf = (file: string) => stripComments(readFileSync(file, 'utf8'));

  const REMOVED = [
    'VehicleSpec',
    'resolved_vehicle',
    'DealerContact',
    'recording_url',
    'transcript',
    'TranscriptionRequestedV1',
    'TranscriptionCompletedV1',
    'comms.transcription.requested.v1',
    'comms.transcription.completed.v1',
    'call_ref',
    'dealer_id',
    'dealer_name',
  ];

  it.each(REMOVED)('`%s` does not appear in any code position under packages/core/src', (name) => {
    const offenders = tsFilesUnder(coreSrc).filter((f) => codeOf(f).includes(name));
    expect(offenders).toEqual([]);
  });

  it('no commented-out placeholder of a removed field survives', () => {
    const placeholder = /\/\/\s*(recording_url|transcript|call_ref|resolved_vehicle)\s*\??\s*:/;
    for (const file of tsFilesUnder(coreSrc)) {
      expect(placeholder.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  it('no compatibility alias re-exports an old name under a new one', () => {
    const aliasRe =
      /\b(?:export\s+)?type\s+(VehicleSpec|DealerContact)\s*=|\bexport\s*\{[^}]*\bas\s+(VehicleSpec|DealerContact)\b/;
    for (const file of tsFilesUnder(coreSrc)) {
      expect(aliasRe.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  it('the old nested valuation `values` block and VehicleData.vin are gone', () => {
    const domain = codeOf(resolve(coreSrc, 'domain.ts'));
    expect(/values\s*:\s*\{/.test(domain)).toBe(false);
    // VehicleData is keyed by instance, not VIN
    const vehicleDataBlock = domain.slice(domain.indexOf('interface VehicleData'));
    expect(vehicleDataBlock).toContain('vehicle_instance_id');
    expect(/\n\s+vin\s*\??\s*:/.test(vehicleDataBlock.slice(0, vehicleDataBlock.indexOf('}')))).toBe(
      false,
    );
  });
});

describe('I-8 — append-only receipt posture: no update/delete surface in core', () => {
  it('runtime exports of @core are exactly the v0.5 vocabularies + two pure guards', () => {
    const names = Object.keys(core);
    const mutatorish = names.filter((n) =>
      /(update|delete|remove|mutate|purge|redact|overwrite)/i.test(n),
    );
    expect(mutatorish).toEqual([]);
    // D13 vocabularies + the two pure, total guards. Nothing else is runtime.
    expect(names.sort()).toEqual([
      'DEALERSHIP_CONTACT_ROLES',
      'MESSAGE_AUTHORS',
      'MESSAGE_CHANNELS',
      'MESSAGE_DIRECTIONS',
      'OFFER_FLAGS',
      'PROCESS_STEPS',
      'VEHICLE_CONDITIONS',
      'isQuarantinedInbound',
      'isTargetVehicleLocked',
    ]);
  });

  it('core source declares no update/delete/remove method on any contract', () => {
    const srcFiles = tsFilesUnder(coreSrc);
    expect(srcFiles.length).toBeGreaterThanOrEqual(4); // index, domain, adapters, events
    const mutatorMethod = /\b(?:update|delete|remove|purge|redact|overwrite)[A-Z]\w*\s*\(/;
    for (const file of srcFiles) {
      expect(mutatorMethod.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  it('no adapter or contract offers a write-back/erase path for stored history', () => {
    const forbidden =
      /\b(deleteMessage|removeMessage|updateMessage|editMessage|deleteThread|purgeDeal|redactReceipt)\b/;
    for (const file of tsFilesUnder(coreSrc)) {
      expect(forbidden.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });
});

describe('I-13 — anti-corruption boundary: core imports nothing external', () => {
  it('every import in packages/core/src is relative (no provider SDKs, no deps)', () => {
    const importRe = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g;
    for (const file of tsFilesUnder(coreSrc)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(importRe)) {
        const specifier = match[1]!;
        expect(specifier.startsWith('.'), `${file} imports "${specifier}"`).toBe(true);
      }
    }
  });

  it('no provider or mock-only vendor name appears in a code position in core', () => {
    const vendors = /\b(twilio|sendgrid|postmark|kbb|manheim|carfax|autocheck|plaid|auth0|stripe)\b/i;
    for (const file of tsFilesUnder(coreSrc)) {
      // vendor names are legal in doc comments as provenance examples only
      expect(vendors.test(stripComments(readFileSync(file, 'utf8'))), file).toBe(false);
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
  /** CLAUDE.md "Approved integrations" + ADR-008's named libraries. Anything
   * outside this set in root config is an unapproved dependency. */
  const APPROVED = new Set([
    'typescript',
    'vitest',
    'pg',
    '@types/pg',
    '@types/node',
    '@aws-sdk/client-s3',
    'fastify',
    'zod',
  ]);

  it('every root dependency and devDependency is on the approved list', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(declared.filter((d) => !APPROVED.has(d))).toEqual([]);
    expect(declared).toContain('typescript');
    expect(declared).toContain('vitest');
  });
});

describe('§1.4 sync rule — tsconfig paths ↔ vitest workspace alias parity', () => {
  const paths = (
    JSON.parse(readFileSync(resolve(repoRoot, 'tsconfig.base.json'), 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    }
  ).compilerOptions.paths;
  const workspaceText = readFileSync(resolve(repoRoot, 'vitest.workspace.ts'), 'utf8');

  it('@core resolves to packages/core/src/index.ts in both files (this package\'s only alias dependency)', () => {
    expect(paths['@core']).toEqual(['packages/core/src/index.ts']);
    expect(workspaceText).toContain("'@core': r('packages/core/src/index.ts')");
  });

  it('every tsconfig alias is bare — deep `/*` imports remain impossible (D3)', () => {
    for (const alias of Object.keys(paths)) {
      expect(alias.endsWith('/*'), alias).toBe(false);
      expect(paths[alias], alias).toHaveLength(1);
    }
  });

  it('vitest.workspace.ts carries the same alias set, entry-for-entry, with no extras', () => {
    for (const [alias, [target]] of Object.entries(paths)) {
      expect(workspaceText, `alias ${alias} missing`).toContain(`'${alias}'`);
      expect(workspaceText, `target for ${alias} missing`).toContain(`'${target}'`);
    }
    const aliasCount = (workspaceText.match(/r\('/g) ?? []).length;
    expect(aliasCount, 'vitest declares an alias tsconfig does not').toBe(
      Object.keys(paths).length,
    );
  });

  it('workspace test globs cover every package location', () => {
    for (const glob of [
      'packages/**/src/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'services/**/src/**/*.test.ts',
      'services/**/test/**/*.test.ts',
    ]) {
      expect(workspaceText).toContain(glob);
    }
  });
});
