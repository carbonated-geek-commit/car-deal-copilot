/**
 * T-018 tester — the ONLY environment-gated suite in this package.
 *
 * ADR-008: the API defaults to the in-memory store and uses the object store
 * only when configured, and an endpoint-dependent test SKIPS — reported
 * skipped, never passed — when its configuration is absent. This file is
 * therefore gated on `OBJECT_STORE_BUCKET`, the same switch
 * `readObjectStoreConfig` uses, and nothing here is asserted when it is unset.
 *
 * Everything AC-3 (no audio) and AC-4 (tenancy) claim is a property of OUR
 * rules, so those suites run unconditionally against the in-process backend
 * (design §1.2). This file only re-proves that the same behaviour survives a
 * real S3-compatible endpoint.
 *
 * NO CREDENTIAL IS READ, WRITTEN, OR REQUIRED HERE. The AWS SDK's standard
 * provider chain supplies them at the deployment that runs this; the repo
 * contains none, and credential absence is the structural enforcement the
 * constitution relies on. Point `OBJECT_STORE_ENDPOINT` at a local
 * S3-compatible server (MinIO or equivalent) to run it.
 */

import { describe, expect, it } from 'vitest';
import { createS3ObjectStore, createS3RawPayloadStore, readObjectStoreConfig } from '../src/index.js';
import type { ObjectStoreConfig } from '../src/contract.js';
import { createRawPayloadStoreOverBackend } from '../src/raw-payloads.js';
import { createMemoryBackend } from '../src/memory-backend.js';
import { sha256Hex } from '../src/keys.js';
import { bytesFrom, DENIED_MEDIA_FIXTURES, expectErr, expectOk, PDF_BYTES } from './helpers.js';

const env: Record<string, string | undefined> =
  typeof process === 'undefined' ? {} : (process.env as Record<string, string | undefined>);

const bucket = env['OBJECT_STORE_BUCKET'];
const CONFIGURED = typeof bucket === 'string' && bucket.trim() !== '';

/**
 * Resolved at collection time. A skipped suite must not construct a client or
 * throw, so the unconfigured case falls back to a placeholder that no skipped
 * test ever touches.
 */
const resolved = CONFIGURED ? readObjectStoreConfig(env) : undefined;
const config: ObjectStoreConfig =
  resolved !== undefined && resolved.ok ? resolved.value : { bucket: 'unconfigured', region: 'unconfigured' };

/** A per-run id so a shared bucket never collides between runs. */
const RUN = `t018${Date.now().toString(36)}`;
const ACCOUNT = `acct${RUN}`;
const OTHER_ACCOUNT = `other${RUN}`;
const DEAL = `deal${RUN}`;

describe.skipIf(!CONFIGURED)('S3-compatible endpoint (skipped unless OBJECT_STORE_BUCKET is set)', () => {
  it('is coherently configured — a partial configuration fails fast, it never degrades (§4.6)', () => {
    expect(resolved).toBeDefined();
    expect(resolved?.ok, 'OBJECT_STORE_BUCKET is set but OBJECT_STORE_REGION is missing').toBe(true);
  });

  it('stores and retrieves a dossier, and reports it already present on a repeat put', async () => {
    const store = createS3ObjectStore(config);
    const bytes = bytesFrom('%PDF-1.7\nlive ', RUN, '\n%%EOF\n');
    const put = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'dossier',
        content_type: 'application/pdf',
        bytes,
        origin_ref: 'receipt_bundle_live',
      }),
    );
    expect(put.outcome).toBe('stored');
    expect(put.ref).toBe(`acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(bytes)}`);

    const fetched = expectOk(await store.get(ACCOUNT, put.ref));
    expect([...fetched.bytes]).toEqual([...bytes]);
    expect(fetched.metadata.origin_ref).toBe('receipt_bundle_live');

    const again = expectOk(await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes }));
    expect(again.outcome).toBe('already_present');
    expect(again.ref).toBe(put.ref);
  });

  it('refuses a cross-account read with not_found against the real endpoint', async () => {
    const store = createS3ObjectStore(config);
    const bytes = bytesFrom('%PDF-1.7\ntenancy ', RUN, '\n%%EOF\n');
    const put = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes }),
    );
    expectErr(await store.get(OTHER_ACCOUNT, put.ref), 'not_found');
    expectErr(await store.head(OTHER_ACCOUNT, put.ref), 'not_found');
    expect(expectOk(await store.list(OTHER_ACCOUNT)).items.map((i) => i.ref)).not.toContain(put.ref);
  });

  it('lists only this account, scoped to one deal', async () => {
    const store = createS3ObjectStore(config);
    const bytes = bytesFrom('%PDF-1.7\nlist ', RUN, '\n%%EOF\n');
    const put = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'document', content_type: 'application/pdf', bytes }),
    );
    const page = expectOk(await store.list(ACCOUNT, { deal_id: DEAL, kind: 'document' }));
    expect(page.items.map((i) => i.ref)).toContain(put.ref);
    for (const item of page.items) {
      expect(item.account_id).toBe(ACCOUNT);
      expect(item.deal_id).toBe(DEAL);
      expect(item.kind).toBe('document');
    }
  });

  it('refuses audio at the endpoint too — by declared type and by magic bytes', async () => {
    const store = createS3ObjectStore(config);
    expectErr(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'email_attachment', content_type: 'audio/mpeg', bytes: PDF_BYTES }),
      'invalid_input',
    );
    const wave = DENIED_MEDIA_FIXTURES.find((f) => f.label === 'RIFF/WAVE audio');
    expect(wave).toBeDefined();
    expectErr(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'email_attachment',
        content_type: 'image/webp',
        bytes: wave?.bytes ?? PDF_BYTES,
      }),
      'invalid_input',
    );
  });

  it('returns not_found for an object that was never written', async () => {
    const store = createS3ObjectStore(config);
    const ref = `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(bytesFrom('never written ', RUN))}`;
    expectErr(await store.get(ACCOUNT, ref), 'not_found');
  });

  it('durably stashes and replays a raw provider payload through the operator key space', async () => {
    const store = createS3RawPayloadStore(config);
    const payload = { provider: 'unknown', run: RUN, body: 'not parseable' };
    const ref = store.stash(payload);
    expect(store.pendingCount()).toBe(1);
    await store.flush();
    expect(store.failedRefs()).toEqual([]);
    expect(expectOk(await store.fetch(ref))).toEqual(payload);
  });

  it('keeps the live ref identical to the in-memory ref, so quarantine idempotency survives the swap', async () => {
    const payload = { provider: 'unknown', run: RUN, body: 'not parseable' };
    const live = createS3RawPayloadStore(config);
    const local = createRawPayloadStoreOverBackend(createMemoryBackend());
    expect(live.stash(payload)).toBe(local.stash(payload));
    await live.flush();
    await local.flush();
  });
});
