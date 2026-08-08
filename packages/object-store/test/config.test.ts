/**
 * T-018 tester — configuration (design §3.6, §4.6, D2, D10, D12).
 *
 * ADR-008's posture is the load-bearing distinction and it is tested as three
 * separate states, not two:
 *
 *   NOT CONFIGURED   `undefined` ⇒ the caller composes the in-memory store.
 *                    This is DEFAULTING to in-memory.
 *   MISCONFIGURED    `{ ok:false }` ⇒ the caller FAILS FAST at startup and must
 *                    not degrade to a volatile store. A configured-but-broken
 *                    store that silently degraded would accept an artifact,
 *                    return success, and lose it — healthy-looking data loss.
 *   CONFIGURED       `{ ok:true }` ⇒ S3 selected.
 *
 * D10: the package never touches `process.env`; the composition root passes a
 * record in, so every branch here is testable with no global mutation.
 */

import { describe, expect, it } from 'vitest';
import { ENV_BUCKET, ENV_ENDPOINT, ENV_REGION, readObjectStoreConfig } from '../src/config.js';
import { expectErr, expectOk, readSrcFiles } from './helpers.js';

describe('not configured — the bucket is the switch', () => {
  it('returns undefined for an empty environment', () => {
    expect(readObjectStoreConfig({})).toBeUndefined();
  });

  it('returns undefined when a region or endpoint appears without a bucket', () => {
    // An orphan endpoint is not an intent, and it is not promoted into a
    // half-configuration we would then have to guess at.
    expect(readObjectStoreConfig({ [ENV_REGION]: 'us-east-1' })).toBeUndefined();
    expect(readObjectStoreConfig({ [ENV_ENDPOINT]: 'http://127.0.0.1:9000' })).toBeUndefined();
    expect(
      readObjectStoreConfig({ [ENV_REGION]: 'us-east-1', [ENV_ENDPOINT]: 'http://127.0.0.1:9000' }),
    ).toBeUndefined();
  });

  it('treats a blank or whitespace-only bucket as absent, not as a bucket named ""', () => {
    expect(readObjectStoreConfig({ [ENV_BUCKET]: '' })).toBeUndefined();
    expect(readObjectStoreConfig({ [ENV_BUCKET]: '   ' })).toBeUndefined();
    expect(readObjectStoreConfig({ [ENV_BUCKET]: undefined })).toBeUndefined();
  });
});

describe('misconfigured — fail fast, never degrade', () => {
  it('fails when a bucket is set but the region is missing', () => {
    const result = readObjectStoreConfig({ [ENV_BUCKET]: 'deal-copilot-artifacts' });
    expect(result).toBeDefined();
    // D2: `AdapterErrorCode` is frozen in packages/core, and 'auth' is the
    // identical handling class — never retry, alert an operator, do not degrade.
    const error = expectErr(result!, 'auth');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(ENV_BUCKET);
    expect(error.message).toContain(ENV_REGION);
  });

  it('fails when the region is present but blank', () => {
    const result = readObjectStoreConfig({ [ENV_BUCKET]: 'b', [ENV_REGION]: '  ' });
    expect(result).toBeDefined();
    expectErr(result!, 'auth');
  });

  it('is distinguishable from "not configured" — the two states are never conflated', () => {
    expect(readObjectStoreConfig({})).toBeUndefined();
    expect(readObjectStoreConfig({ [ENV_BUCKET]: 'b' })).not.toBeUndefined();
  });
});

describe('configured', () => {
  it('carries bucket and region and omits an absent endpoint', () => {
    const result = readObjectStoreConfig({ [ENV_BUCKET]: 'artifacts', [ENV_REGION]: 'us-east-1' });
    const config = expectOk(result!);
    expect(config.bucket).toBe('artifacts');
    expect(config.region).toBe('us-east-1');
    expect('endpoint' in config).toBe(false);
  });

  it('carries a custom S3-compatible endpoint when one is given (D12)', () => {
    const config = expectOk(
      readObjectStoreConfig({
        [ENV_BUCKET]: 'artifacts',
        [ENV_REGION]: 'us-east-1',
        [ENV_ENDPOINT]: 'http://127.0.0.1:9000',
      })!,
    );
    expect(config.endpoint).toBe('http://127.0.0.1:9000');
  });

  it('trims surrounding whitespace on every value', () => {
    const config = expectOk(
      readObjectStoreConfig({ [ENV_BUCKET]: ' artifacts ', [ENV_REGION]: ' us-east-1 ' })!,
    );
    expect(config.bucket).toBe('artifacts');
    expect(config.region).toBe('us-east-1');
  });

  it('introduces no fourth environment name', () => {
    expect([ENV_BUCKET, ENV_REGION, ENV_ENDPOINT]).toEqual([
      'OBJECT_STORE_BUCKET',
      'OBJECT_STORE_REGION',
      'OBJECT_STORE_ENDPOINT',
    ]);
  });
});

describe('no credential is ever a parameter or a value in this repo', () => {
  it('produces a config object with no credential-shaped field', () => {
    const config = expectOk(readObjectStoreConfig({ [ENV_BUCKET]: 'b', [ENV_REGION]: 'r' })!);
    for (const key of Object.keys(config)) {
      expect(key).not.toMatch(/key|secret|credential|token|password|access/i);
    }
  });

  it('declares no credential field on the config type and bakes in no credential value', () => {
    // Credentials come from the AWS SDK's standard provider chain. Credential
    // ABSENCE is the structural enforcement the constitution relies on, so
    // there must be nothing here that could hold one.
    const code = readSrcFiles()
      .map((f) => f.code)
      .join('\n');
    expect(code).not.toMatch(/accessKeyId|secretAccessKey|sessionToken/);
    expect(code).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(code).not.toMatch(/AWS_SECRET|AWS_ACCESS_KEY/);
    expect(code).not.toMatch(/credentials\s*:/);
  });

  it('never reads process.env from inside the package (D10)', () => {
    for (const file of readSrcFiles()) {
      expect(file.code, `${file.name} must receive an env record, not read the global`).not.toContain(
        'process.env',
      );
    }
  });
});
