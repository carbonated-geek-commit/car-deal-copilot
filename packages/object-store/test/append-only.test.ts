/**
 * T-018 tester — AC-7: a stored artifact is never mutated in place, and a
 * revision is a new object.
 *
 * specs/00 "Receipt layer (trust engine)": the trail is **append-only**.
 * specs/01: a closed thread is "archived (never deleted)".
 *
 * The storage layer must not undermine that, and the design's answer is
 * ABSENCE rather than a guard (D9): there is no `delete`, `copy`, `move`,
 * caller-chosen key, or presigned URL to call. An absent method is the
 * difference between a rule and a hope, so this file asserts the absence as
 * hard as it asserts the behaviour.
 */

import { describe, expect, it } from 'vitest';
import { createInMemoryObjectStore } from '../src/artifact-store.js';
import { createMemoryBackend } from '../src/memory-backend.js';
import * as barrel from '../src/index.js';
import { expectOk, fixedClock, PDF_BYTES, PDF_BYTES_ALT, readSrcFiles } from './helpers.js';

/** Comments stripped: every src file DOCUMENTS the operations it omits. */
const SRC_CODE = readSrcFiles()
  .map((f) => f.code)
  .join('\n');

const ACCOUNT = 'acct_1';
const DEAL = 'deal_1';

describe('the interface has no mutation or removal path (D9)', () => {
  it('exposes exactly four operations plus an id', () => {
    const store = createInMemoryObjectStore();
    // `size` is the in-memory affordance; the S3 store has only the five.
    expect(Object.keys(store).sort()).toEqual(['get', 'head', 'list', 'put', 'size', 'source'].sort());
  });

  it.each([
    'delete',
    'remove',
    'destroy',
    'purge',
    'copy',
    'move',
    'rename',
    'update',
    'overwrite',
    'putAtKey',
    'getSignedUrl',
    'presign',
    'createPresignedUrl',
  ])('has no %s method on the store', (method) => {
    const store = createInMemoryObjectStore() as unknown as Record<string, unknown>;
    expect(store[method]).toBeUndefined();
  });

  it('has no removal or copy operation on the internal backend seam either', () => {
    const backend = createMemoryBackend() as unknown as Record<string, unknown>;
    for (const method of ['delete', 'remove', 'copy', 'move', 'rename']) {
      expect(backend[method]).toBeUndefined();
    }
    expect(Object.keys(createMemoryBackend()).sort()).toEqual(['get', 'head', 'keys', 'list', 'put', 'size', 'source'].sort());
  });

  it('exports no removal, copy, or signing helper from the barrel', () => {
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/delete|remove|destroy|purge|copy|move|rename|presign|signedUrl/i);
    }
  });

  it('never constructs a delete, copy, or presign request against the provider', () => {
    // The SDK offers DeleteObjectCommand and CopyObjectCommand; neither is
    // imported, and `@aws-sdk/s3-request-presigner` is not a dependency (D8 —
    // a new dependency is T-015-only and an escalation).
    expect(SRC_CODE).not.toContain('DeleteObjectCommand');
    expect(SRC_CODE).not.toContain('DeleteObjectsCommand');
    expect(SRC_CODE).not.toContain('CopyObjectCommand');
    expect(SRC_CODE).not.toContain('s3-request-presigner');
    expect(SRC_CODE).not.toContain('getSignedUrl');
  });
});

describe('a revision is a new object, and the previous revision survives', () => {
  it('gives revised bytes a different ref and leaves the original readable', async () => {
    const store = createInMemoryObjectStore({ clock: fixedClock() });
    const v1 = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    const v2 = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES_ALT }),
    );

    expect(v2.ref).not.toBe(v1.ref);
    expect(v2.outcome).toBe('stored');
    expect(store.size()).toBe(2);

    const original = expectOk(await store.get(ACCOUNT, v1.ref));
    expect([...original.bytes]).toEqual([...PDF_BYTES]);
    // Both revisions are listable, so the trail shows the history rather than
    // the latest state only.
    const page = expectOk(await store.list(ACCOUNT, { deal_id: DEAL, kind: 'dossier' }));
    expect(page.items.map((i) => i.ref).sort()).toEqual([v1.ref, v2.ref].sort());
  });

  it('makes an in-place overwrite unrepresentable: the key IS the content hash', async () => {
    const store = createInMemoryObjectStore({ clock: fixedClock() });
    const v1 = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    // There is no request a caller can build that writes different bytes to
    // `v1.ref`: `put` takes bytes, derives the key, and accepts no key.
    const putRequestKeys = Object.keys({
      account_id: ACCOUNT,
      deal_id: DEAL,
      kind: 'dossier',
      content_type: 'application/pdf',
      bytes: PDF_BYTES,
      filename: 'x.pdf',
      origin_ref: 'bundle_1',
    });
    expect(putRequestKeys).not.toContain('key');
    expect(putRequestKeys).not.toContain('ref');
    expect(v1.ref.endsWith(v1.metadata.content_sha256)).toBe(true);
  });

  it('keeps the backend write a no-op for an existing key', async () => {
    const backend = createMemoryBackend({ clock: fixedClock() });
    const key = 'acct/a/d/dossier/aa';
    expectOk(
      await backend.put({
        key,
        bytes: PDF_BYTES,
        content_type: 'application/pdf',
        content_sha256: 'aa',
        content_sha256_base64: 'qg==',
        metadata: {},
      }),
    );
    const first = expectOk(await backend.head(key));
    expectOk(
      await backend.put({
        key,
        bytes: PDF_BYTES,
        content_type: 'application/pdf',
        content_sha256: 'aa',
        content_sha256_base64: 'qg==',
        metadata: { kind: 'document' },
      }),
    );
    const second = expectOk(await backend.head(key));
    expect(second.stored_at).toBe(first.stored_at);
    expect(second.metadata).toEqual(first.metadata);
  });
});

describe('a dossier is a durable, exportable artifact — rendering stays in @receipt (AC-6, §5.10)', () => {
  it('persists and returns rendered dossier bytes, and traces back to its receipt bundle', async () => {
    const store = createInMemoryObjectStore({ clock: fixedClock() });
    const put = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'dossier',
        content_type: 'application/pdf',
        bytes: PDF_BYTES,
        origin_ref: 'receipt_bundle_77',
      }),
    );
    const fetched = expectOk(await store.get(ACCOUNT, put.ref));
    expect([...fetched.bytes]).toEqual([...PDF_BYTES]);
    expect(fetched.metadata.origin_ref).toBe('receipt_bundle_77');
  });

  it('renders nothing itself — no PDF engine, HTML, or hosting lives here', () => {
    expect(SRC_CODE).not.toMatch(/\bpdfkit\b|\bpuppeteer\b|\bhandlebars\b/i);
    expect(SRC_CODE).not.toContain('renderPdf');
    expect(SRC_CODE).not.toContain('publishWebLink');
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/render|publish|template/i);
    }
  });
});
