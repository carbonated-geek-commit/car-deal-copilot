/**
 * T-018 tester — the standing surface scan.
 *
 * AC-1 / specs/00 "Integrations — anti-corruption / adapter layer (shared)":
 * "Every external feed sits behind one internal interface. Core services never
 * see a provider's shape." AC-8 / ADR-001: the spine is defined once in
 * `packages/core` and imported everywhere else.
 *
 * Both are properties of the FILE TREE, not of any single call, so they are
 * asserted by scanning the sources rather than by exercising a function. Every
 * scan runs against comments-stripped code, because each src file documents
 * the things it deliberately omits and a naive text scan would read those
 * refusals as evidence of the thing being refused.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as barrel from '../src/index.js';
import { readSrcFiles } from './helpers.js';

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readSrcFiles();
const CODE = SRC.map((f) => f.code).join('\n');

function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/\bfrom\s+'([^']+)'/g)) {
    const specifier = match[1];
    if (specifier !== undefined) out.push(specifier);
  }
  for (const match of code.matchAll(/\brequire\(\s*'([^']+)'/g)) {
    const specifier = match[1];
    if (specifier !== undefined) out.push(specifier);
  }
  return out;
}

describe('the provider SDK is confined to one module (AC-1, §5.4)', () => {
  it('is imported by exactly one file, and that file is s3-backend.ts', () => {
    const importers = SRC.filter((f) => importSpecifiers(f.code).some((s) => s.startsWith('@aws-sdk')));
    expect(importers.map((f) => f.name)).toEqual(['s3-backend.ts']);
  });

  it('is not re-exported from the barrel, so no caller can reach it', () => {
    const barrelCode = SRC.find((f) => f.name === 'index.ts')?.code ?? '';
    expect(barrelCode).not.toContain('s3-backend');
    expect(barrelCode).not.toContain('@aws-sdk');
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/^S3Client$|Command$|createS3Backend/);
    }
  });

  it('lets no provider type, command, stream, or exception escape the package surface', () => {
    for (const name of ['S3Client', 'PutObjectCommand', 'GetObjectCommand', 'HeadObjectCommand', 'ListObjectsV2Command', 'S3ServiceException']) {
      expect((barrel as Record<string, unknown>)[name]).toBeUndefined();
    }
    // `transformToByteArray()` is the ONLY place a stream type exists, and it
    // is inside s3-backend.ts.
    const elsewhere = SRC.filter((f) => f.name !== 's3-backend.ts' && f.code.includes('transformToByteArray'));
    expect(elsewhere.map((f) => f.name)).toEqual([]);
  });

  it('imports nothing outside @core, @comms, the S3 SDK, node:crypto, and its own modules', () => {
    const allowed = new Set(['@core', '@comms', '@aws-sdk/client-s3', 'node:crypto']);
    for (const file of SRC) {
      for (const specifier of importSpecifiers(file.code)) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) continue;
        expect(allowed.has(specifier), `${file.name} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('introduces no CDN, signing service, image processor, logger, or HTTP client', () => {
    expect(CODE).not.toMatch(/\bfastify\b|\bexpress\b|\baxios\b|node-fetch|\bpino\b|\bwinston\b|cloudfront/i);
    expect(CODE).not.toMatch(/from\s+'pg'/);
    expect(CODE).not.toMatch(/node:https?/);
  });
});

describe('the manifest stays exactly what T-015 and ADR-009 allow', () => {
  const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    name: string;
    private: boolean;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('is named per ADR-004 and stays private', () => {
    expect(manifest.name).toBe('@deal-copilot/object-store');
    expect(manifest.private).toBe(true);
  });

  it('declares exactly the one ADR-008 library and no other dependency', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@aws-sdk/client-s3']);
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('carries the typecheck script ADR-009 §2 permits this task to add', () => {
    expect(manifest.scripts?.typecheck).toBe('tsc -p . --noEmit');
  });
});

describe('no spine type is defined here (AC-8, ADR-001)', () => {
  it('imports every result and error type from @core rather than redeclaring one', () => {
    expect(CODE).toMatch(/import type \{[^}]*AdapterResult[^}]*\} from '@core'/);
    // A parallel error vocabulary for the same job would be the duplicate
    // definition ADR-001 forbids.
    expect(CODE).not.toMatch(/(interface|type)\s+(AdapterError|AdapterResult|AdapterErrorCode|IsoTimestamp)\b/);
  });

  it('declares no domain aggregate of its own', () => {
    for (const spine of [
      'Deal',
      'DealerThread',
      'Dealership',
      'DealershipContact',
      'Message',
      'Offer',
      'VehicleTarget',
      'VehicleInstance',
      'ValuationSnapshot',
      'VehicleData',
      'SpineEvent',
    ]) {
      expect(CODE, `${spine} must not be redefined here`).not.toMatch(
        new RegExp(`\\b(interface|class)\\s+${spine}\\b`),
      );
    }
  });

  it('imports RawPayloadStore and canonicalJson from @comms rather than copying them (ADR-009 §1, D6)', () => {
    const raw = SRC.find((f) => f.name === 'raw-payloads.ts')?.code ?? '';
    expect(raw).toContain("from '@comms'");
    expect(raw).not.toContain('const canonicalJson');
    expect(raw).not.toContain('function canonicalJson');
    // T-018 ships no second in-memory RawPayloadStore — @comms already exports one.
    expect(CODE).not.toContain('class InMemoryRawPayloadStore');
  });

  it('knows nothing about valuation, flags, or negotiation state (§5.11)', () => {
    // Protected by ABSENCE: no rollup and no valuation logic exists here, so
    // ADR-006 (newest-wins current_offer) and ADR-007 (above_market compares
    // to the RETAIL band of the VehicleInstance snapshot) cannot be
    // duplicated or contradicted by the storage layer. Write-once
    // target_vehicle and the make/model-mismatch rule live in the same
    // category: this package moves bytes plus a location.
    for (const term of [
      'above_market',
      'target_vehicle',
      'walk_away',
      'payment_packing',
      'current_offer',
      'sale_price',
      'retail_band',
      'trade_in',
      'process_step',
      'working_with',
    ]) {
      expect(CODE, `${term} must not appear in the storage layer`).not.toContain(term);
    }
  });

  it('names no mock-only integration', () => {
    expect(CODE).not.toMatch(/\bkbb\b|manheim|carfax|autocheck|prequal/i);
  });
});

describe('the barrel is the entire public surface (§2)', () => {
  it('exports exactly the documented names', () => {
    expect(Object.keys(barrel).sort()).toEqual(
      [
        'ALLOWED_CONTENT_TYPES',
        'ARTIFACT_KINDS',
        'DEFAULT_MAX_BYTES',
        'buildArtifactRef',
        'createInMemoryObjectStore',
        'createS3ObjectStore',
        'createS3RawPayloadStore',
        'isRefOwnedBy',
        'parseArtifactRef',
        'readObjectStoreConfig',
        'sha256Hex',
      ].sort(),
    );
  });

  it('exposes a factory pair a composition root can swap by assignment (ADR-008)', () => {
    expect(typeof barrel.createInMemoryObjectStore).toBe('function');
    expect(typeof barrel.createS3ObjectStore).toBe('function');
    expect(typeof barrel.createS3RawPayloadStore).toBe('function');
    expect(typeof barrel.readObjectStoreConfig).toBe('function');
  });
});
