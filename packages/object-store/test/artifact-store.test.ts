/**
 * T-018 tester — the artifact store: put / get / head / list, plus every error
 * path design §4.3–§4.5 enumerates.
 *
 * Runs against the in-process backend (design §1.2) and, for the provider
 * failure rows, against a stub backend. No network, no endpoint, no credential,
 * so nothing here is environment-gated: only `s3-live.test.ts` is (ADR-008).
 */

import { describe, expect, it } from 'vitest';
import type { ObjectStore } from '../src/contract.js';
import {
  createInMemoryObjectStore,
  createObjectStoreOverBackend,
  MAX_LIST_LIMIT,
} from '../src/artifact-store.js';
import { createMemoryBackend } from '../src/memory-backend.js';
import { META_ACCOUNT_ID, META_DEAL_ID, META_KIND, META_SHA256 } from '../src/backend.js';
import { sha256Hex } from '../src/keys.js';
import {
  backendError,
  bytesFrom,
  captureLog,
  CSV_BYTES,
  expectErr,
  expectOk,
  fixedClock,
  PDF_BYTES,
  PDF_BYTES_ALT,
  PNG_BYTES,
  stubBackend,
  TEXT_BYTES,
  unreachableBackend,
} from './helpers.js';

const ACCOUNT = 'acct_1';
const DEAL = 'deal_1';

function memoryStore(): ObjectStore & { readonly size: () => number } {
  return createInMemoryObjectStore({ clock: fixedClock() });
}

describe('put — the happy path (AC-2, AC-5)', () => {
  it('stores a dossier and returns a bucket-free ref a Postgres row can carry', async () => {
    const store = memoryStore();
    const result = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'dossier',
        content_type: 'application/pdf',
        bytes: PDF_BYTES,
        origin_ref: 'receipt_bundle_77',
      }),
    );

    expect(result.outcome).toBe('stored');
    expect(result.ref).toBe(`acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`);
    // AC-5: the ref carries no bucket, so moving buckets does not invalidate a
    // single stored row.
    expect(result.ref).not.toContain('s3');
    expect(result.ref).not.toMatch(/^https?:/);
    expect(result.metadata).toMatchObject({
      ref: result.ref,
      account_id: ACCOUNT,
      deal_id: DEAL,
      kind: 'dossier',
      content_type: 'application/pdf',
      byte_length: PDF_BYTES.byteLength,
      content_sha256: sha256Hex(PDF_BYTES),
      origin_ref: 'receipt_bundle_77',
    });
    expect(store.size()).toBe(1);
  });

  it('stores each of the three artifact classes (AC-2, AC-6)', async () => {
    const store = memoryStore();
    for (const [kind, type, bytes] of [
      ['email_attachment', 'application/pdf', PDF_BYTES],
      ['document', 'image/png', PNG_BYTES],
      ['dossier', 'application/pdf', PDF_BYTES_ALT],
    ] as const) {
      const put = expectOk(
        await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind, content_type: type, bytes }),
      );
      const fetched = expectOk(await store.get(ACCOUNT, put.ref));
      expect(fetched.metadata.kind).toBe(kind);
      expect([...fetched.bytes]).toEqual([...bytes]);
    }
    expect(store.size()).toBe(3);
  });

  it('normalizes the declared content type before storing it', async () => {
    const store = memoryStore();
    const put = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'document',
        content_type: 'TEXT/PLAIN; charset=utf-8',
        bytes: TEXT_BYTES,
      }),
    );
    expect(put.metadata.content_type).toBe('text/plain');
    expect(expectOk(await store.head(ACCOUNT, put.ref)).content_type).toBe('text/plain');
  });

  it('omits an absent filename and origin_ref rather than emitting undefined (ADR-005 discipline)', async () => {
    const store = memoryStore();
    const put = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'document',
        content_type: 'text/csv',
        bytes: CSV_BYTES,
      }),
    );
    expect('filename' in put.metadata).toBe(false);
    expect('origin_ref' in put.metadata).toBe(false);
    const head = expectOk(await store.head(ACCOUNT, put.ref));
    expect('filename' in head).toBe(false);
    expect('origin_ref' in head).toBe(false);
  });

  it('sanitizes a display filename and never lets it into the key', async () => {
    const store = memoryStore();
    const put = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'document',
        content_type: 'application/pdf',
        bytes: PDF_BYTES,
        filename: '../../etc/passwd\r\nX-Injected: 1.pdf',
      }),
    );
    expect(put.metadata.filename).toBe('../../etc/passwdX-Injected: 1.pdf');
    // §3.1 rule 6: no filename ever appears in a key.
    expect(put.ref).not.toContain('passwd');
    expect(put.ref).toBe(`acct/${ACCOUNT}/${DEAL}/document/${sha256Hex(PDF_BYTES)}`);
  });

  it('copies the caller buffer, so a later mutation cannot rewrite a stored object', async () => {
    const store = memoryStore();
    const mutable = bytesFrom('%PDF-1.7\nbody\n%%EOF\n');
    const put = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'dossier',
        content_type: 'application/pdf',
        bytes: mutable,
      }),
    );
    mutable[10] = 0x21;
    const fetched = expectOk(await store.get(ACCOUNT, put.ref));
    expect(sha256Hex(fetched.bytes)).toBe(put.metadata.content_sha256);
  });

  it('returns a copy on read, so a caller cannot corrupt stored state', async () => {
    const store = memoryStore();
    const put = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    const first = expectOk(await store.get(ACCOUNT, put.ref));
    first.bytes[0] = 0x00;
    const second = expectOk(await store.get(ACCOUNT, put.ref));
    expect(sha256Hex(second.bytes)).toBe(put.metadata.content_sha256);
  });

  it('stamps stored_at from the injected clock', async () => {
    const store = createInMemoryObjectStore({ clock: fixedClock(Date.parse('2026-08-07T12:00:00.000Z'), 0) });
    const put = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    expect(put.metadata.stored_at).toBe('2026-08-07T12:00:00.000Z');
  });
});

describe('put — idempotency and immutability (AC-7, D4)', () => {
  it('is idempotent: re-putting identical bytes yields already_present and one object', async () => {
    const store = memoryStore();
    const req = {
      account_id: ACCOUNT,
      deal_id: DEAL,
      kind: 'dossier' as const,
      content_type: 'application/pdf',
      bytes: PDF_BYTES,
    };
    const first = expectOk(await store.put(req));
    const second = expectOk(await store.put(req));
    expect(first.outcome).toBe('stored');
    expect(second.outcome).toBe('already_present');
    expect(second.ref).toBe(first.ref);
    expect(store.size()).toBe(1);
  });

  it('does not re-issue the write when the object is already present', async () => {
    const backend = createMemoryBackend({ clock: fixedClock() });
    let puts = 0;
    const counted = {
      ...backend,
      put: async (input: Parameters<typeof backend.put>[0]) => {
        puts += 1;
        return backend.put(input);
      },
    };
    const store = createObjectStoreOverBackend(counted);
    const req = {
      account_id: ACCOUNT,
      deal_id: DEAL,
      kind: 'dossier' as const,
      content_type: 'application/pdf',
      bytes: PDF_BYTES,
    };
    expectOk(await store.put(req));
    expectOk(await store.put(req));
    // The HEAD-first sequence is what makes AC-7 structural: the code path
    // that would overwrite an existing object literally does not run.
    expect(puts).toBe(1);
  });

  it('does not churn stored_at on a repeat put', async () => {
    const store = memoryStore();
    const req = {
      account_id: ACCOUNT,
      deal_id: DEAL,
      kind: 'dossier' as const,
      content_type: 'application/pdf',
      bytes: PDF_BYTES,
    };
    const ref = expectOk(await store.put(req)).ref;
    const before = expectOk(await store.head(ACCOUNT, ref));
    expectOk(await store.put(req));
    const after = expectOk(await store.head(ACCOUNT, ref));
    // A rewrite would churn `stored_at` — which is exactly the in-place
    // mutation AC-7 forbids.
    expect(after.stored_at).toBe(before.stored_at);
  });

  it('reports metadata for an already-present object that agrees with what a read returns', async () => {
    // §5.6: "Nothing in this package invents a value it did not retrieve."
    // Two allowed types share the same magic requirement (no NUL byte), so the
    // same bytes can arrive twice under different labels. The stored object
    // keeps the FIRST label — the PutResult must not report the second.
    const store = memoryStore();
    const first = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'document',
        content_type: 'text/csv',
        bytes: CSV_BYTES,
      }),
    );
    const second = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'document',
        content_type: 'text/plain',
        bytes: CSV_BYTES,
      }),
    );
    expect(second.outcome).toBe('already_present');
    const stored = expectOk(await store.head(ACCOUNT, first.ref));
    expect(second.metadata.content_type).toBe(stored.content_type);
  });

  it('makes a revision a NEW object and leaves the previous revision readable', async () => {
    const store = memoryStore();
    const v1 = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    const v2 = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES_ALT }),
    );
    expect(v2.ref).not.toBe(v1.ref);
    expect(store.size()).toBe(2);
    expect([...expectOk(await store.get(ACCOUNT, v1.ref)).bytes]).toEqual([...PDF_BYTES]);
    expect([...expectOk(await store.get(ACCOUNT, v2.ref)).bytes]).toEqual([...PDF_BYTES_ALT]);
  });
});

describe('put — local rejections never reach the network (§4.3 steps 1–6)', () => {
  it.each([
    ['account_id', { account_id: '../other', deal_id: DEAL }],
    ['deal_id', { account_id: ACCOUNT, deal_id: 'a/b' }],
  ])('refuses an invalid %s without touching the backend', async (_label, ids) => {
    const store = createObjectStoreOverBackend(unreachableBackend());
    const error = expectErr(
      await store.put({ ...ids, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
      'invalid_input',
    );
    expect(error.retryable).toBe(false);
  });

  it('refuses a policy violation without touching the backend', async () => {
    const store = createObjectStoreOverBackend(unreachableBackend());
    expectErr(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'dossier',
        content_type: 'audio/mpeg',
        bytes: PDF_BYTES,
      }),
      'invalid_input',
    );
  });

  it('refuses an oversize object at the configured cap', async () => {
    const store = createInMemoryObjectStore({ max_bytes: 32 });
    const error = expectErr(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'dossier',
        content_type: 'application/pdf',
        bytes: bytesFrom('%PDF-', 'x'.repeat(64)),
      }),
      'invalid_input',
    );
    expect(error.message).toContain('32-byte cap');
    expect(store.size()).toBe(0);
  });
});

describe('put — provider failure rows (§4.1)', () => {
  it('propagates a non-not_found HEAD failure and does not write', async () => {
    const backend = stubBackend({ head: async () => ({ ok: false, error: backendError('auth', 'denied') }) });
    const store = createObjectStoreOverBackend(backend);
    const error = expectErr(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
      'auth',
    );
    expect(error.retryable).toBe(false);
    expect(backend.calls.filter((c) => c.startsWith('put:'))).toHaveLength(0);
  });

  it('propagates a write failure with its retryable flag intact', async () => {
    const backend = stubBackend({
      put: async () => ({ ok: false, error: backendError('provider_unavailable', 'origin down') }),
    });
    const store = createObjectStoreOverBackend(backend);
    const error = expectErr(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
      'provider_unavailable',
    );
    expect(error.retryable).toBe(true);
  });

  it('raises an integrity alarm when an existing object length disagrees with its hash (§4.3 step 9)', async () => {
    const backend = stubBackend({
      head: async () => ({
        ok: true,
        value: { byte_length: PDF_BYTES.byteLength + 1, content_type: 'application/pdf', metadata: {}, stored_at: '2026-08-07T12:00:00.000Z' },
      }),
    });
    const store = createObjectStoreOverBackend(backend);
    const error = expectErr(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
      'malformed_response',
    );
    expect(error.retryable).toBe(false);
    expect(backend.calls.filter((c) => c.startsWith('put:'))).toHaveLength(0);
  });
});

describe('get / head — reads and their failure modes (§4.4)', () => {
  it('returns bytes and metadata that agree with the key', async () => {
    const store = memoryStore();
    const put = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'email_attachment',
        content_type: 'application/pdf',
        bytes: PDF_BYTES,
        filename: 'buyers-order.pdf',
        origin_ref: 'msg_42',
      }),
    );
    const fetched = expectOk(await store.get(ACCOUNT, put.ref));
    expect([...fetched.bytes]).toEqual([...PDF_BYTES]);
    expect(fetched.metadata.filename).toBe('buyers-order.pdf');
    expect(fetched.metadata.origin_ref).toBe('msg_42');
    expect(fetched.metadata.content_sha256).toBe(sha256Hex(PDF_BYTES));

    const head = expectOk(await store.head(ACCOUNT, put.ref));
    expect(head).toEqual(fetched.metadata);
    expect('bytes' in head).toBe(false);
  });

  it('returns not_found for a well-formed ref that was never stored — never empty bytes (ADR-005)', async () => {
    const store = memoryStore();
    const ref = `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`;
    const error = expectErr(await store.get(ACCOUNT, ref), 'not_found');
    expect(error.retryable).toBe(false);
    expectErr(await store.head(ACCOUNT, ref), 'not_found');
  });

  it.each([
    ['a bare hash', sha256Hex(PDF_BYTES)],
    ['an operator raw-payload key', `ops/raw-payload/${sha256Hex(PDF_BYTES)}`],
    ['a traversal ref', `acct/${ACCOUNT}/../other/dossier/${sha256Hex(PDF_BYTES)}`],
    ['an unknown kind segment', `acct/${ACCOUNT}/${DEAL}/recording/${sha256Hex(PDF_BYTES)}`],
  ])('refuses %s locally, without a backend call', async (_label, ref) => {
    const backend = stubBackend();
    const store = createObjectStoreOverBackend(backend);
    expectErr(await store.get(ACCOUNT, ref), 'invalid_input');
    expectErr(await store.head(ACCOUNT, ref), 'invalid_input');
    expect(backend.calls).toHaveLength(0);
  });

  it('raises malformed_response when retrieved bytes do not hash to the key', async () => {
    // The content-addressing claim is VERIFIED on every read, not asserted.
    const backend = stubBackend({
      get: async () => ({
        ok: true,
        value: {
          bytes: bytesFrom('%PDF-tampered\n'),
          byte_length: 14,
          content_type: 'application/pdf',
          metadata: {},
          stored_at: '2026-08-07T12:00:00.000Z',
        },
      }),
    });
    const store = createObjectStoreOverBackend(backend);
    const ref = `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`;
    const error = expectErr(await store.get(ACCOUNT, ref), 'malformed_response');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('do not match the content hash');
  });

  it.each([
    [META_ACCOUNT_ID, 'other_account'],
    [META_DEAL_ID, 'other_deal'],
    [META_KIND, 'document'],
    [META_SHA256, 'f'.repeat(64)],
  ])('raises malformed_response when stored %s metadata disagrees with the key', async (key, value) => {
    const head = {
      byte_length: PDF_BYTES.byteLength,
      content_type: 'application/pdf',
      metadata: { [key]: value },
      stored_at: '2026-08-07T12:00:00.000Z',
    };
    const backend = stubBackend({
      head: async () => ({ ok: true, value: head }),
      get: async () => ({ ok: true, value: { ...head, bytes: PDF_BYTES } }),
    });
    const store = createObjectStoreOverBackend(backend);
    const ref = `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`;
    expectErr(await store.head(ACCOUNT, ref), 'malformed_response');
    expectErr(await store.get(ACCOUNT, ref), 'malformed_response');
  });

  it('raises malformed_response when a stored object carries no content type', async () => {
    const head = { byte_length: PDF_BYTES.byteLength, metadata: {}, stored_at: '2026-08-07T12:00:00.000Z' };
    const backend = stubBackend({
      head: async () => ({ ok: true, value: head }),
      get: async () => ({ ok: true, value: { ...head, bytes: PDF_BYTES } }),
    });
    const store = createObjectStoreOverBackend(backend);
    const ref = `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`;
    expectErr(await store.head(ACCOUNT, ref), 'malformed_response');
    expectErr(await store.get(ACCOUNT, ref), 'malformed_response');
  });

  it('propagates a transient provider failure as retryable', async () => {
    const backend = stubBackend({
      get: async () => ({ ok: false, error: backendError('rate_limited', 'slow down') }),
    });
    const store = createObjectStoreOverBackend(backend);
    const error = expectErr(
      await store.get(ACCOUNT, `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`),
      'rate_limited',
    );
    expect(error.retryable).toBe(true);
  });

  it('refuses an invalid requesting account_id outright', async () => {
    const store = createObjectStoreOverBackend(unreachableBackend());
    expectErr(await store.get('../other', `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`), 'invalid_input');
    expectErr(await store.head('', `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`), 'invalid_input');
  });
});

describe('list (§4.5)', () => {
  async function seed(store: ObjectStore, deal: string, count: number): Promise<string[]> {
    const refs: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const put = expectOk(
        await store.put({
          account_id: ACCOUNT,
          deal_id: deal,
          kind: 'document',
          content_type: 'text/plain',
          bytes: bytesFrom(`row ${i} for ${deal}\n`),
        }),
      );
      refs.push(put.ref);
    }
    return refs;
  }

  it('returns every artifact of the account, with only what a key and a list response carry', async () => {
    const store = memoryStore();
    const refs = await seed(store, DEAL, 3);
    const page = expectOk(await store.list(ACCOUNT));
    expect(page.items.map((i) => i.ref).sort()).toEqual([...refs].sort());
    expect(page.truncated).toBe(false);
    expect('next_cursor' in page).toBe(false);
    for (const item of page.items) {
      expect(item.account_id).toBe(ACCOUNT);
      expect(item.deal_id).toBe(DEAL);
      expect(item.kind).toBe('document');
      // §3.5 / ADR-005: content_type and filename need a HEAD, so they are
      // ABSENT here rather than fabricated.
      expect('content_type' in item).toBe(false);
      expect('filename' in item).toBe(false);
    }
  });

  it('scopes to one deal when asked — a read must not cross deals', async () => {
    const store = memoryStore();
    const dealOne = await seed(store, 'deal_1', 2);
    const dealTwo = await seed(store, 'deal_2', 2);
    const page = expectOk(await store.list(ACCOUNT, { deal_id: 'deal_1' }));
    expect(page.items.map((i) => i.ref).sort()).toEqual([...dealOne].sort());
    for (const ref of dealTwo) expect(page.items.map((i) => i.ref)).not.toContain(ref);
  });

  it('scopes to one kind within a deal', async () => {
    const store = memoryStore();
    await seed(store, DEAL, 2);
    const dossier = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    const page = expectOk(await store.list(ACCOUNT, { deal_id: DEAL, kind: 'dossier' }));
    expect(page.items.map((i) => i.ref)).toEqual([dossier.ref]);
  });

  it('refuses a kind filter without a deal_id rather than silently ignoring it', async () => {
    const store = memoryStore();
    const error = expectErr(await store.list(ACCOUNT, { kind: 'dossier' }), 'invalid_input');
    expect(error.message).toContain('kind requires deal_id');
  });

  it('refuses an invalid account_id or deal_id', async () => {
    const store = createObjectStoreOverBackend(unreachableBackend());
    expectErr(await store.list('../other'), 'invalid_input');
    expectErr(await store.list(ACCOUNT, { deal_id: 'a/b' }), 'invalid_input');
  });

  it('reports a truncated page with a cursor instead of a short page that looks complete', async () => {
    const store = memoryStore();
    const refs = await seed(store, DEAL, 5);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = expectOk(await store.list(ACCOUNT, cursor === undefined ? { limit: 2 } : { limit: 2, cursor }));
      seen.push(...page.items.map((i) => i.ref));
      cursor = page.next_cursor;
      if (page.truncated) expect(page.next_cursor).toBeDefined();
      else expect('next_cursor' in page).toBe(false);
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== undefined);
    expect(seen.sort()).toEqual([...refs].sort());
  });

  it('clamps an over-large limit to the documented maximum', async () => {
    const backend = stubBackend();
    const store = createObjectStoreOverBackend(backend);
    expectOk(await store.list(ACCOUNT, { limit: MAX_LIST_LIMIT + 5000 }));
    expect(backend.listOptions[0]?.limit).toBe(MAX_LIST_LIMIT);
    expect(MAX_LIST_LIMIT).toBe(1000);
  });

  it('issues the list against the account prefix, so "list everything" is inexpressible', async () => {
    const backend = stubBackend();
    const store = createObjectStoreOverBackend(backend);
    expectOk(await store.list(ACCOUNT));
    expectOk(await store.list(ACCOUNT, { deal_id: DEAL, kind: 'dossier' }));
    expect(backend.calls).toEqual([`list:acct/${ACCOUNT}/`, `list:acct/${ACCOUNT}/${DEAL}/dossier/`]);
  });

  it('raises an integrity alarm for a stored key that is not a valid artifact ref', async () => {
    const backend = stubBackend({
      list: async () => ({
        ok: true,
        value: {
          items: [{ key: `acct/${ACCOUNT}/${DEAL}/not-a-kind/abc`, byte_length: 1, stored_at: '2026-08-07T12:00:00.000Z' }],
          truncated: false,
        },
      }),
    });
    const store = createObjectStoreOverBackend(backend);
    expectErr(await store.list(ACCOUNT), 'malformed_response');
  });

  it('propagates a provider failure', async () => {
    const backend = stubBackend({ list: async () => ({ ok: false, error: backendError('provider_unavailable') }) });
    const store = createObjectStoreOverBackend(backend);
    expectErr(await store.list(ACCOUNT), 'provider_unavailable');
  });
});

describe('logging (§4.8) — correlate, never a capability and never content', () => {
  it('emits an ok event carrying only a 12-char ref prefix, no bytes and no full ref', async () => {
    const capture = captureLog();
    const store = createInMemoryObjectStore({ clock: fixedClock(), log: capture.log });
    const put = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'dossier',
        content_type: 'application/pdf',
        bytes: PDF_BYTES,
        filename: 'quote-from-dealer.pdf',
      }),
    );
    const event = capture.events.find((e) => e.op === 'put' && e.outcome === 'ok');
    expect(event).toBeDefined();
    expect(event?.ref_prefix).toHaveLength(12);
    const serialized = JSON.stringify(capture.events);
    expect(serialized).not.toContain(put.ref);
    expect(serialized).not.toContain('quote-from-dealer.pdf');
    expect(serialized).not.toContain('%PDF');
  });

  it('emits a warn event naming the refused content type on a policy rejection', async () => {
    const capture = captureLog();
    const store = createInMemoryObjectStore({ log: capture.log });
    expectErr(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'audio/mpeg', bytes: PDF_BYTES }),
      'invalid_input',
    );
    const event = capture.events.find((e) => e.op === 'put' && e.outcome === 'invalid_input');
    expect(event?.level).toBe('warn');
    expect(event?.message).toContain('audio');
  });
});

// ---------------------------------------------------------------------------
// T-018 fixer — regressions for the three defects the verifier confirmed.
// Each one asserts the GUARANTEE that was broken, not the shape of the patch.
// ---------------------------------------------------------------------------

describe('an untyped caller cannot crash the boundary (@core AdapterResult)', () => {
  // The T-019 HTTP/JSON edge parses whatever a client sent, so `kind` reaches
  // this package as an arbitrary string. Every such value must come back as an
  // `invalid_input` VALUE — an adapter never throws across the boundary.
  it.each([
    ['an unknown literal', 'recording'],
    ['an empty string', ''],
    ['a traversal segment', '../dossier'],
    ['a case variant of a real kind', 'DOSSIER'],
  ])('refuses %s in kind as a value, for every content type', async (_label, kind) => {
    const store = memoryStore();
    for (const content_type of ['application/pdf', 'text/plain', 'audio/mpeg']) {
      const result = await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        // deliberately unsound: this is the untyped edge, reproduced.
        kind: kind as 'dossier',
        content_type,
        bytes: PDF_BYTES,
      });
      expect(result.ok).toBe(false);
      expectErr(result, 'invalid_input');
    }
    expect(store.size()).toBe(0);
  });

  it('never writes when the kind is refused', async () => {
    const backend = stubBackend();
    const store = createObjectStoreOverBackend(backend);
    expectErr(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'recording' as 'dossier',
        content_type: 'application/pdf',
        bytes: PDF_BYTES,
      }),
      'invalid_input',
    );
    expect(backend.calls).toHaveLength(0);
  });
});

describe('put reports what is STORED, never what was requested (§5.6, AC-5)', () => {
  // text/plain and text/csv are both allowlisted for `document` and share the
  // same magic requirement (no NUL byte), so the same bytes can be re-put under
  // either label and reach the already_present branch. What comes back must be
  // the stored label: a caller persisting PutResult.metadata into a Postgres
  // row would otherwise serve the wrong Content-Type permanently.
  it.each([
    ['text/csv', 'text/plain'],
    ['text/plain', 'text/csv'],
  ])('re-putting identical bytes stored as %s under the label %s reports the stored one', async (
    stored_type,
    relabelled,
  ) => {
    const store = memoryStore();
    const first = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'document',
        content_type: stored_type,
        bytes: CSV_BYTES,
      }),
    );
    const second = expectOk(
      await store.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'document',
        content_type: relabelled,
        bytes: CSV_BYTES,
      }),
    );
    expect(second.outcome).toBe('already_present');
    expect(second.metadata.content_type).toBe(stored_type);

    // Every read agrees with it, and with the first put.
    const headed = expectOk(await store.head(ACCOUNT, first.ref));
    const got = expectOk(await store.get(ACCOUNT, first.ref));
    expect(headed.content_type).toBe(stored_type);
    expect(got.metadata.content_type).toBe(stored_type);
    expect(second.metadata).toEqual(headed);
    expect(store.size()).toBe(1);
  });

  it('reports the RETRIEVED timestamp on the already_present branch, not a fresh reading of the clock', async () => {
    // The clock advances a second per reading, so a re-stamped `stored_at`
    // would be visibly later than the one the object actually carries.
    const store = createInMemoryObjectStore({ clock: fixedClock(Date.parse('2026-08-07T12:00:00.000Z'), 1000) });
    const first = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    const stored = expectOk(await store.head(ACCOUNT, first.ref));
    const second = expectOk(
      await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    expect(second.outcome).toBe('already_present');
    expect(second.metadata.stored_at).toBe(stored.stored_at);
    expect(second.metadata).toEqual(stored);
  });
});

describe('a field the backend did not retrieve is unevaluable, never zero (§5.6, ADR-005)', () => {
  const REF = `acct/${ACCOUNT}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`;
  const FULL = {
    byte_length: PDF_BYTES.byteLength,
    content_type: 'application/pdf',
    metadata: {},
    stored_at: '2026-08-07T12:00:00.000Z',
  };

  it.each([
    ['byte_length', 'byte length'],
    ['stored_at', 'stored_at'],
  ])('raises malformed_response on get/head when the provider omits %s', async (field, phrase) => {
    const head = { ...FULL };
    delete (head as Record<string, unknown>)[field];
    const backend = stubBackend({
      head: async () => ({ ok: true, value: head }),
      get: async () => ({ ok: true, value: { ...head, bytes: PDF_BYTES } }),
    });
    const store = createObjectStoreOverBackend(backend);
    const error = expectErr(await store.head(ACCOUNT, REF), 'malformed_response');
    expect(error.message).toContain(phrase);
    expectErr(await store.get(ACCOUNT, REF), 'malformed_response');
  });

  it.each(['byte_length', 'stored_at'])(
    'refuses the already_present branch rather than inventing %s',
    async (field) => {
      const head = { ...FULL };
      delete (head as Record<string, unknown>)[field];
      const backend = stubBackend({ head: async () => ({ ok: true, value: head }) });
      const store = createObjectStoreOverBackend(backend);
      expectErr(
        await store.put({ account_id: ACCOUNT, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
        'malformed_response',
      );
      // And it did NOT fall through to a write.
      expect(backend.calls.filter((c) => c.startsWith('put:'))).toHaveLength(0);
    },
  );

  it.each(['byte_length', 'stored_at'])('raises malformed_response on list when %s is absent', async (field) => {
    const entry: Record<string, unknown> = {
      key: REF,
      byte_length: PDF_BYTES.byteLength,
      stored_at: '2026-08-07T12:00:00.000Z',
    };
    delete entry[field];
    const backend = stubBackend({
      list: async () => ({ ok: true, value: { items: [entry as { key: string }], truncated: false } }),
    });
    const store = createObjectStoreOverBackend(backend);
    const error = expectErr(await store.list(ACCOUNT), 'malformed_response');
    expect(error.retryable).toBe(false);
  });
});
