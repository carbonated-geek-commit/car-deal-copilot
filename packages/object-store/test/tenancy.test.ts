/**
 * T-018 tester — AC-4: account and deal isolation.
 *
 * specs/01 "Account model": "`Account` owns `Deals`."
 * specs/00 "Dealership data tenancy": private data is never exposed to another
 * account. `Dealership` is the GLOBAL record; anything account-private
 * (`DealershipContact`, and here every stored artifact) stays inside the
 * account that owns it. This package holds bytes plus a location, so its share
 * of that split is: an object stored by one account is not addressable,
 * listable, or probeable from another.
 *
 * The construction under test (design §5.2):
 *   - `account_id` is the FIRST, MANDATORY parameter of `get`/`head`/`list`, so
 *     an unscoped read is inexpressible.
 *   - the list prefix is `acct/{account_id}/`, so isolation is enforced by the
 *     request rather than by post-filtering.
 *   - a foreign ref is refused LOCALLY, before any network call, and yields
 *     `not_found` (never a distinct "forbidden"), so a probe learns nothing
 *     from the answer or from the timing.
 *
 * Never skipped: this is a property of our own rules (design §1.2).
 */

import { describe, expect, it } from 'vitest';
import { createInMemoryObjectStore, createObjectStoreOverBackend } from '../src/artifact-store.js';
import { rawPayloadKey, sha256Hex } from '../src/keys.js';
import {
  captureLog,
  expectErr,
  expectOk,
  fixedClock,
  PDF_BYTES,
  PDF_BYTES_ALT,
  stubBackend,
  TEXT_BYTES,
  unreachableBackend,
} from './helpers.js';

const OWNER = 'acct_owner';
const INTRUDER = 'acct_intruder';
const DEAL = 'deal_1';

async function seeded() {
  const capture = captureLog();
  const store = createInMemoryObjectStore({ clock: fixedClock(), log: capture.log });
  const put = expectOk(
    await store.put({
      account_id: OWNER,
      deal_id: DEAL,
      kind: 'dossier',
      content_type: 'application/pdf',
      bytes: PDF_BYTES,
      filename: 'owner-only.pdf',
    }),
  );
  return { store, capture, ref: put.ref };
}

describe('a read never crosses an account', () => {
  it('refuses a get of another account\'s ref with not_found', async () => {
    const { store, ref } = await seeded();
    const error = expectErr(await store.get(INTRUDER, ref), 'not_found');
    expect(error.retryable).toBe(false);
    // The owner still reads it — the object exists; the intruder is simply
    // told nothing.
    expect([...expectOk(await store.get(OWNER, ref)).bytes]).toEqual([...PDF_BYTES]);
  });

  it('refuses a head of another account\'s ref with not_found', async () => {
    const { store, ref } = await seeded();
    expectErr(await store.head(INTRUDER, ref), 'not_found');
    expect(expectOk(await store.head(OWNER, ref)).filename).toBe('owner-only.pdf');
  });

  it('gives a cross-account probe the same verdict as a genuine miss', async () => {
    // Returning `not_found` rather than a distinct "forbidden" means a probe
    // cannot confirm that an object exists in another account.
    const { store, ref } = await seeded();
    const foreign = expectErr(await store.get(INTRUDER, ref));
    const missing = expectErr(
      await store.get(INTRUDER, `acct/${INTRUDER}/${DEAL}/dossier/${sha256Hex(PDF_BYTES_ALT)}`),
    );
    expect(foreign.code).toBe(missing.code);
    expect(foreign.retryable).toBe(missing.retryable);
  });

  it('decides the refusal locally, before any network call, so there is no timing signal', async () => {
    const backend = stubBackend();
    const store = createObjectStoreOverBackend(backend);
    const ref = `acct/${OWNER}/${DEAL}/dossier/${sha256Hex(PDF_BYTES)}`;
    expectErr(await store.get(INTRUDER, ref), 'not_found');
    expectErr(await store.head(INTRUDER, ref), 'not_found');
    expect(backend.calls).toEqual([]);
  });

  it('logs the attempt at warn as a security signal, even though the caller learns nothing', async () => {
    const { store, capture, ref } = await seeded();
    expectErr(await store.get(INTRUDER, ref), 'not_found');
    const event = capture.events.find((e) => e.outcome === 'tenancy_reject');
    expect(event).toBeDefined();
    expect(event?.level).toBe('warn');
    expect(event?.op).toBe('get');
    expect(event?.account_id).toBe(INTRUDER);
    expect(event?.message).toContain(OWNER);
    // Still no capability and no content in the log line.
    expect(JSON.stringify(capture.events)).not.toContain(ref);
    expect(JSON.stringify(capture.events)).not.toContain('owner-only.pdf');
  });
});

describe('a list never crosses an account', () => {
  it('shows an account only its own artifacts', async () => {
    const store = createInMemoryObjectStore({ clock: fixedClock() });
    const mine = expectOk(
      await store.put({ account_id: OWNER, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    const theirs = expectOk(
      await store.put({ account_id: INTRUDER, deal_id: DEAL, kind: 'dossier', content_type: 'application/pdf', bytes: PDF_BYTES_ALT }),
    );
    // Identical bytes under two accounts land at two different keys, so even a
    // shared document is not a shared object.
    const ownerPage = expectOk(await store.list(OWNER));
    expect(ownerPage.items.map((i) => i.ref)).toEqual([mine.ref]);
    const intruderPage = expectOk(await store.list(INTRUDER));
    expect(intruderPage.items.map((i) => i.ref)).toEqual([theirs.ref]);
  });

  it('cannot be widened past the account prefix by a deal_id filter', async () => {
    const backend = stubBackend();
    const store = createObjectStoreOverBackend(backend);
    // A filter value that tried to climb out of the prefix is refused by the
    // id pattern before the prefix is built.
    expectErr(await store.list(OWNER, { deal_id: `../${INTRUDER}` }), 'invalid_input');
    expect(backend.calls).toEqual([]);
  });

  it('does not leak between accounts whose names share a prefix', async () => {
    const store = createInMemoryObjectStore({ clock: fixedClock() });
    const short = expectOk(
      await store.put({ account_id: 'acme', deal_id: DEAL, kind: 'document', content_type: 'text/plain', bytes: TEXT_BYTES }),
    );
    const long = expectOk(
      await store.put({ account_id: 'acmex', deal_id: DEAL, kind: 'document', content_type: 'text/plain', bytes: TEXT_BYTES }),
    );
    expect(expectOk(await store.list('acme')).items.map((i) => i.ref)).toEqual([short.ref]);
    expect(expectOk(await store.list('acmex')).items.map((i) => i.ref)).toEqual([long.ref]);
    expectErr(await store.get('acme', long.ref), 'not_found');
    expectErr(await store.get('acmex', short.ref), 'not_found');
  });
});

describe('a read never crosses a deal', () => {
  it('scopes a list to one deal and shows nothing from the sibling deal', async () => {
    const store = createInMemoryObjectStore({ clock: fixedClock() });
    const one = expectOk(
      await store.put({ account_id: OWNER, deal_id: 'deal_1', kind: 'document', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    const two = expectOk(
      await store.put({ account_id: OWNER, deal_id: 'deal_2', kind: 'document', content_type: 'application/pdf', bytes: PDF_BYTES_ALT }),
    );
    const page = expectOk(await store.list(OWNER, { deal_id: 'deal_1' }));
    expect(page.items.map((i) => i.ref)).toEqual([one.ref]);
    expect(page.items.map((i) => i.ref)).not.toContain(two.ref);
  });

  it('keeps identical bytes in two deals as two distinct objects', async () => {
    const store = createInMemoryObjectStore({ clock: fixedClock() });
    const one = expectOk(
      await store.put({ account_id: OWNER, deal_id: 'deal_1', kind: 'document', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    const two = expectOk(
      await store.put({ account_id: OWNER, deal_id: 'deal_2', kind: 'document', content_type: 'application/pdf', bytes: PDF_BYTES }),
    );
    expect(one.ref).not.toBe(two.ref);
    expect(one.metadata.content_sha256).toBe(two.metadata.content_sha256);
  });
});

describe('the operator key space is unreachable from an account-scoped read (D3)', () => {
  it('refuses a raw-payload key handed to get/head as an invalid ref', async () => {
    const store = createObjectStoreOverBackend(unreachableBackend());
    const key = rawPayloadKey(sha256Hex(PDF_BYTES));
    expectErr(await store.get(OWNER, key), 'invalid_input');
    expectErr(await store.head(OWNER, key), 'invalid_input');
  });

  it('never surfaces an ops/ key through an account-scoped list', async () => {
    const backend = stubBackend();
    const store = createObjectStoreOverBackend(backend);
    expectOk(await store.list(OWNER));
    // Only the account prefix is ever requested; `ops/raw-payload/` can never
    // match `acct/{account_id}/`.
    for (const call of backend.calls) {
      expect(call.startsWith(`list:acct/${OWNER}/`)).toBe(true);
      expect(call).not.toContain('ops/');
    }
  });
});

describe('an unscoped read is inexpressible', () => {
  it('requires account_id as the first argument of every read', () => {
    const store = createInMemoryObjectStore();
    // Arity is the enforcement: there is no overload without an account.
    expect(store.get.length).toBeGreaterThanOrEqual(2);
    expect(store.head.length).toBeGreaterThanOrEqual(2);
    expect(store.list.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses an empty or malformed requesting account rather than defaulting to a wildcard', async () => {
    const store = createObjectStoreOverBackend(unreachableBackend());
    expectErr(await store.list(''), 'invalid_input');
    expectErr(await store.list('*'), 'invalid_input');
    expectErr(await store.list('../'), 'invalid_input');
  });
});
