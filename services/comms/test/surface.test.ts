/**
 * T-014 tester — the standing surface gates (AC-1, AC-3, AC-12, AC-14;
 * design §4 row 1, §4 swap-seam row, tests 13 and 14).
 *
 * Two claims are checked here, and both are claims about ABSENCE, which is why
 * they need explicit tests: nothing else in a suite can notice a thing that is
 * not there.
 *
 *   1. The speech-capture stage is gone end to end — not stubbed, not
 *      deprecated, not commented out. specs/01 (consent posture,
 *      (resolved 2026-08-07) and decisions/OPEN-QUESTIONS.md Q14 removed audio
 *      and speech-to-text from the product, so no provider is approved and the
 *      socket one would plug into must not exist.
 *   2. The ports are swap seams: a second, structurally different
 *      implementation of each is accepted by `createCommsService` WITHOUT A
 *      CAST, which is the mechanical proof that T-017/T-018 can substitute
 *      Postgres and S3 behind them without redesign.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, SpineEventType } from '@core';
import * as commsSurface from '../src/index.js';
import {
  createCommsService,
  InMemoryCommsStore,
  InMemoryQueue,
  type CommsStore,
  type EnqueueResult,
} from '../src/index.js';
import { ArrayRawPayloadStore, DelegatingStore } from './fixtures/doubles.js';
import {
  REMOVED_PORT_NAME,
  REMOVED_STORE_METHOD,
  REMOVED_VOCABULARY,
} from './fixtures/forbidden.js';
import { FixtureEmailAdapter, FixtureTelephonyAdapter } from './fixtures/adapters.js';
import {
  DEALER_PHONE,
  DEALERSHIP_A,
  IDENTITY_A,
  makeDeal,
  smsPayload,
  T1,
} from './fixtures/harness.js';

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

describe('the removed capture stage leaves no surface behind (AC-1, AC-3)', () => {
  it('a text scan of services/comms finds ZERO occurrences of the removed vocabulary', () => {
    // Including comments, fixture names, and test names — this file included.
    // The search terms are assembled at runtime in fixtures/forbidden.ts so the
    // checker cannot poison its own corpus; see that file's header.
    const files = listFiles(SERVICE_ROOT);
    expect(files.length).toBeGreaterThan(10); // the scan actually looked at something

    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const term of REMOVED_VOCABULARY) {
        if (text.includes(term)) hits.push(`${relative(SERVICE_ROOT, file)} :: ${term}`);
      }
    }
    expect(hits).toStrictEqual([]);
  });

  it('the public surface exports no capture port and the store has no capture method', () => {
    // Value exports: checked at runtime. Type exports: the text scan above is
    // the gate — a deleted TYPE cannot be probed at runtime, but it cannot be
    // declared or re-exported without its name appearing in the source either.
    expect(Object.keys(commsSurface)).not.toContain(REMOVED_PORT_NAME);
    expect(Object.getOwnPropertyNames(InMemoryCommsStore.prototype)).not.toContain(
      REMOVED_STORE_METHOD,
    );

    // Compile-time: no key on the store port is capture-shaped. This catches a
    // re-added fill-once setter without this file ever spelling its name.
    expectTypeOf<
      Extract<keyof CommsStore, `${string}script${string}` | `${string}audio${string}`>
    >().toBeNever();
  });

  it('no spine Message field can hold captured speech or a handle to bytes', () => {
    expectTypeOf<
      Extract<
        keyof Message,
        `${string}script${string}` | `${string}audio${string}` | `${string}cording${string}`
      >
    >().toBeNever();
    // Positively: what a v0.5 Message may carry about a call is metadata.
    expectTypeOf<Message>().toHaveProperty('call_meta');
  });

  it('the event bus this service depends on has no capture stage (upstream guarantee)', () => {
    expectTypeOf<
      Extract<
        SpineEventType,
        `${string}scription${string}` | `${string}audio${string}` | `${string}speech${string}`
      >
    >().toBeNever();
  });

  it('the service has no HTTP client and no filesystem reach — nothing can fetch a stashed URL', () => {
    // The quarantine stash is a byte-preserving hold for operator replay. It is
    // not a back door: replay re-enters through parseInboundWebhook, whose
    // output type has no field a media reference could land in, and there is no
    // outbound network or filesystem call anywhere in src/ to fetch one with.
    const srcFiles = listFiles(resolve(SERVICE_ROOT, 'src'));
    const NETWORK_OR_FS = /\b(fetch|XMLHttpRequest|https?:\/\/|node:https?|node:fs|node:net)\b/;
    const offenders = srcFiles.filter((f) => NETWORK_OR_FS.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(SERVICE_ROOT, f))).toStrictEqual([]);
  });
});

describe('the ports are swap seams (AC-12)', () => {
  it('no port signature leaks an in-memory container type', () => {
    // A `Map`/`Set` in a signature would be an in-memory assumption a Postgres
    // or S3 implementation could not satisfy without a cast.
    const ports = readFileSync(resolve(SERVICE_ROOT, 'src', 'ports.ts'), 'utf8');
    expect(ports).not.toMatch(/\bMap</);
    expect(ports).not.toMatch(/\bSet</);
    expect(ports).not.toMatch(/\bWeakMap</);
    expect(ports).not.toMatch(/\bArray</); // plain readonly[] is fine; a mutable Array port is not
  });

  it('a second CommsStore and RawPayloadStore implementation is accepted with NO cast, and the pipeline works', async () => {
    // The types below are inferred, not asserted: if `DelegatingStore` or
    // `ArrayRawPayloadStore` failed to satisfy its port, this file would not
    // compile. That is the whole test — the assertions afterwards merely show
    // the substitution is behaviorally live, not decorative.
    const store = new DelegatingStore(new InMemoryCommsStore());
    const raw = new ArrayRawPayloadStore();
    const queue = new InMemoryQueue();
    let eid = 0;
    const service = createCommsService({
      telephony: new FixtureTelephonyAdapter(),
      email: new FixtureEmailAdapter(),
      queue,
      store,
      raw_payloads: raw,
      now: () => T1,
      new_event_id: () => `swap-evt-${++eid}`,
    });

    store.putDeal(makeDeal('deal-a', IDENTITY_A));
    store.bindThreadContact('deal-a', DEALERSHIP_A, { phone: DEALER_PHONE });

    await service.intake.ingest(
      'telephony',
      smsPayload({ ref: 'sms-1', body: 'The price is $23,500 for this one.', at: T1 }),
    );
    await queue.drain();

    const thread = service.read.getDeal('deal-a')!.dealer_threads[0]!;
    expect(thread.dealership_id).toBe(DEALERSHIP_A);
    expect(thread.current_offer).toStrictEqual({ fees: [], flags: [], sale_price: 23_500_00 });

    // The service really drove the substituted port — belt (ledger peek),
    // braces (keyed append), fill-once, rollup.
    expect(store.calls).toContain('hasProcessed');
    expect(store.calls).toContain('appendMessage');
    expect(store.calls).toContain('attachExtractedOffer');
    expect(store.calls).toContain('rollupCurrentOffer');
    expect(store.calls).toContain('markProcessed');
  });

  it('the quarantine seam works over a differently-keyed object store too', async () => {
    const store = new DelegatingStore(new InMemoryCommsStore());
    const raw = new ArrayRawPayloadStore();
    const queue = new InMemoryQueue();
    const service = createCommsService({
      telephony: new FixtureTelephonyAdapter(),
      email: new FixtureEmailAdapter(),
      queue,
      store,
      raw_payloads: raw,
      now: () => T1,
      new_event_id: () => 'swap-evt',
    });

    await service.intake.ingest('telephony', { not: 'a payload' });
    await queue.drain();

    const quarantined = service.read.listQuarantined();
    expect(quarantined).toHaveLength(1);
    // The ref is whatever THAT implementation's key scheme produces — the
    // service never assumes a hash, only that `get(ref)` round-trips.
    expect(raw.get(quarantined[0]!.raw_payload_ref)).toStrictEqual({ not: 'a payload' });
  });

  it('enqueue failure is a VALUE, never a throw — a network queue fits the seam unchanged', async () => {
    const queue = new InMemoryQueue();
    queue.failNextPublishes(1);
    const result: EnqueueResult = await queue.publish({
      event_id: 'e1',
      type: 'alert.dispatch.requested.v1',
      occurred_at: T1,
      idempotency_key: 'k',
      payload: { deal_id: 'deal-a', kind: 'message_received', summary: 'x' },
    });
    expect(result.ok).toBe(false);
    expectTypeOf<Awaited<ReturnType<InMemoryQueue['publish']>>>().toEqualTypeOf<EnqueueResult>();
  });
});
