/**
 * T-013 tester — structural posture gates for `@adapters/nhtsa`
 * (docs/design/T-013.md §8, §9 obligation 10; AC-5, AC-8, AC-11, D11).
 *
 * NHTSA is the ONE live-approved vehicle-data source, so unlike the mock-only
 * packages this tree is allowed to contain `fetch`. What must still hold:
 * HTTP is confined to the adapter module and injectable, there is no credential
 * or env read anywhere, no spine type is redefined, and no audio, recording, or
 * transcription path exists.
 *
 * Comment text is stripped before every code-affordance scan — the doc comments
 * deliberately name the forbidden things ("credential-free"), and matching those
 * would be a false positive.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createNhtsaVehicleDataAdapter } from '@adapters/nhtsa';
import { forbiddenFetch } from './helpers.js';

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

describe('the scan sees the package', () => {
  it('collects every src module', () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      'adapter.ts',
      'index.ts',
      'recalls.ts',
      'vin.ts',
      'vpic.ts',
    ]);
  });
});

describe('AC-8 — HTTP is confined, injectable, and credential-free', () => {
  it('only adapter.ts performs a fetch; the narrowing modules are pure', () => {
    for (const f of files) {
      if (f.path === 'adapter.ts') continue;
      expect(f.code, f.path).not.toMatch(/\bfetch\s*\(|\bfetchFn\b/);
    }
    expect(files.find((f) => f.path === 'adapter.ts')?.code).toMatch(/fetchFn\(/);
  });

  it('the fetch implementation is injectable, so the suite can be hermetic', () => {
    const { fetchFn, calls } = forbiddenFetch();
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    expect(adapter.source).toBe('nhtsa-vpic');
    expect(calls).toHaveLength(0);
  });

  it('no credential, no auth header, and no env read exists anywhere', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/\bprocess\s*\.\s*env\b/);
      expect(f.code, f.path).not.toMatch(
        /\b(?:apiKey|api_key|accessToken|clientSecret|bearerToken|Authorization)\b/,
      );
      expect(f.code, f.path).not.toMatch(/\bheaders\s*:/);
    }
  });

  it('the only hosts referenced are the two free public NHTSA endpoints', () => {
    const urls = files.flatMap((f) => f.code.match(/https?:\/\/[^'"`\s)]+/g) ?? []);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/(?:vpic\.nhtsa\.dot\.gov|api\.nhtsa\.gov)/);
    }
  });

  it('no mock-only provider is referenced from this tree (KBB/Manheim/Carfax/AutoCheck/credit)', () => {
    for (const f of files) {
      expect(f.raw, f.path).not.toMatch(/\b(?:kbb|manheim|carfax|autocheck|equifax|experian)\b/i);
    }
  });
});

describe('D11 — the internal decode→recalls two-step is not a valuation precondition', () => {
  it('nothing in this tree references the valuation package or a valuation type', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/@adapters\/valuation|ValuationSnapshot|ValuationRequest/);
    }
  });

  it('the VIN guard is a local shape check, not a network validation call', () => {
    const vin = files.find((f) => f.path === 'vin.ts');
    expect(vin?.code).toMatch(/A-HJ-NPR-Z0-9\]\{17\}/);
    expect(vin?.code).not.toMatch(/\bfetch\b|https?:\/\//);
  });
});

describe('AC-11 / ADR-001 — no spine type is redefined here', () => {
  it('no src file declares a name @core already owns', () => {
    const spineNames = [
      'VehicleData',
      'VehicleDataAdapter',
      'VehicleInstance',
      'VinDecode',
      'RecallRecord',
      'VehicleHistorySummary',
      'AdapterError',
      'AdapterResult',
      'AdapterErrorCode',
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

  it('the package declares no runtime dependency', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe('tenancy, isolation and scope', () => {
  it('no account, owner, deal, or thread identifier reaches this layer', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(
        /\b(?:account_id|accountId|owner_id|ownerId|deal_id|dealId|thread_id|threadId|tenant)\b/,
      );
    }
  });

  it('Q13 — no dealership record or directory lookup exists', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/\bDealership(?:Contact)?\b/);
    }
  });

  it('no audio, recording, or transcription path exists anywhere in this package', () => {
    for (const f of files) {
      expect(f.raw, f.path).not.toMatch(
        /\b(?:audio|transcript|transcription|recording_url|speech|voicemail|\.mp3|\.wav)\b/i,
      );
    }
  });

  it('append-only posture: the adapter exposes only two read operations', () => {
    const { fetchFn } = forbiddenFetch();
    const adapter = createNhtsaVehicleDataAdapter({ fetchFn });
    expect(Object.keys(adapter).sort()).toEqual(['decodeVin', 'getRecalls', 'source']);
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/\b(?:update|delete|remove|purge)[A-Z]\w*\s*\(/);
      expect(f.code, f.path).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
    }
  });

  it('the package holds no module-level mutable state', () => {
    for (const f of files) {
      expect(f.code, f.path).not.toMatch(/^(?:let|var)\s+\w+/m);
    }
  });
});
