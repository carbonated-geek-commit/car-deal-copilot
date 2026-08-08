/**
 * T-012 tester — authorship, entry-kind closure, call-metadata purity, and the
 * structurally append-only surface (docs/design/T-012.md §2.1–§2.5, §6 tests
 * 8–12 and 16).
 *
 * The guarantee under test is the one specs/00 "Receipt layer (trust engine)"
 * states outright: "Each entry carries its author — buyer, concierge operator,
 * or dealer — so self-authored evidence is never presented as if it came from
 * the dealer." That guarantee fails in exactly two ways, and both are covered
 * here: an entry entering the trail WITHOUT an author (which a later reader or
 * renderer would have to guess at), and an entry acquiring a `dealer` label it
 * did not earn.
 *
 * Also covered: the two v0.4 kinds that pointed at captured audio and verbatim
 * call text are gone from the surface rather than deprecated on it (AC-5, Q14),
 * call-metadata entries are structurally incapable of carrying audio or call
 * text (AC-7), the store exposes no update/delete path in any form (AC-8), and
 * a read never crosses a bundle — the receipt layer's deal-isolation boundary.
 *
 * Pure package: no test here reaches a database, an object store, or an HTTP
 * endpoint, so ADR-008's skip-when-config-absent rule gates nothing in this
 * file — there is no DB- or endpoint-dependent case to skip or to fake.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_AUTHORS } from '@core';
import type { CallMeta, MessageAuthor } from '@core';
import * as receiptApi from '@receipt';
import {
  createDossierExporter,
  createInMemoryReceiptStore,
  type CallMetaEntryInput,
  type EmailEntryInput,
  type NoteEntryInput,
  type ReceiptEntry,
  type ReceiptEntryInput,
  type ReceiptEntryKind,
  type ReceiptError,
  type ReceiptResult,
  type SmsEntryInput,
} from '@receipt';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const T1 = '2026-08-07T10:00:00.000Z';
const T2 = '2026-08-07T11:00:00.000Z';
const T3 = '2026-08-07T12:00:00.000Z';

const clock = (): string => '2026-08-07T20:00:00.000Z';

function unwrap<T>(result: ReceiptResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function unwrapErr<T>(result: ReceiptResult<T>): ReceiptError {
  if (result.ok) throw new Error('expected an error result, got ok');
  return result.error;
}

function sms(overrides: Partial<SmsEntryInput> = {}): SmsEntryInput {
  return {
    kind: 'sms',
    author: 'dealer',
    direction: 'in',
    occurred_at: T1,
    body: 'We can do $23,500 out the door.',
    ...overrides,
  };
}

function email(overrides: Partial<EmailEntryInput> = {}): EmailEntryInput {
  return {
    kind: 'email',
    author: 'dealer',
    direction: 'in',
    occurred_at: T2,
    subject: 'Your quote',
    body: 'Attached is the OTD breakdown.',
    ...overrides,
  };
}

function note(overrides: Partial<NoteEntryInput> = {}): NoteEntryInput {
  return {
    kind: 'note',
    author: 'buyer',
    direction: 'internal',
    occurred_at: T3,
    body: 'He said twenty nine grand out the door.',
    ...overrides,
  };
}

function callMeta(overrides: Partial<CallMetaEntryInput> = {}): CallMetaEntryInput {
  return {
    kind: 'call_meta',
    author: 'concierge',
    direction: 'out',
    occurred_at: T3,
    call_meta: { started_at: T3, duration_seconds: 412, party: '+1-555-867-5309' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Author is mandatory — no default, no derivation (AC-6, D5, §6 test 8)
// ---------------------------------------------------------------------------

describe('author is mandatory and is never inferred (AC-6, D5)', () => {
  it('the author field is REQUIRED on every member of ReceiptEntryInput (compile-time)', () => {
    expectTypeOf<NoteEntryInput>().toHaveProperty('author');
    expectTypeOf<SmsEntryInput>().toHaveProperty('author');
    expectTypeOf<EmailEntryInput>().toHaveProperty('author');
    expectTypeOf<CallMetaEntryInput>().toHaveProperty('author');
    // Non-optional: `undefined` is not assignable to any of them.
    expectTypeOf<SmsEntryInput['author']>().toEqualTypeOf<MessageAuthor>();
    expectTypeOf<EmailEntryInput['author']>().toEqualTypeOf<MessageAuthor>();
    expectTypeOf<NoteEntryInput['author']>().toEqualTypeOf<'buyer' | 'concierge'>();
    expectTypeOf<CallMetaEntryInput['author']>().toEqualTypeOf<'buyer' | 'concierge'>();
    expectTypeOf<ReceiptEntry['author']>().not.toEqualTypeOf<MessageAuthor | undefined>();
  });

  it('omitting author is a compile error on every kind (types, not just runtime)', () => {
    // @ts-expect-error — an sms entry without an author must not typecheck
    const noAuthorSms: SmsEntryInput = { kind: 'sms', direction: 'in', occurred_at: T1, body: 'x' };
    // @ts-expect-error — a note without an author must not typecheck
    const noAuthorNote: NoteEntryInput = {
      kind: 'note',
      direction: 'internal',
      occurred_at: T1,
      body: 'x',
    };
    expect(noAuthorSms).toBeDefined();
    expect(noAuthorNote).toBeDefined();
  });

  it('an authorless entry is REJECTED and nothing is written (JS/JSON boundary)', async () => {
    const store = createInMemoryReceiptStore(clock);
    const authorless: unknown[] = [undefined, null, '', '   ', 'operator', 'system', 'agent', 'DEALER', 42, {}];
    for (const author of authorless) {
      const input = { ...sms(), author } as unknown as ReceiptEntryInput;
      const error = unwrapErr(await store.append('bundle-1', input));
      expect(error.code, `author ${JSON.stringify(author)} must be rejected`).toBe('invalid_input');
      expect(error.retryable).toBe(false);
    }
    // AC-6: not merely reported — nothing entered the trail.
    expect(unwrap(await store.read('bundle-1'))).toEqual([]);
  });

  it('a missing author is never defaulted to dealer (the one failure mode the field exists to prevent)', async () => {
    const store = createInMemoryReceiptStore(clock);
    const stripped = { ...sms() } as Partial<SmsEntryInput>;
    delete stripped.author;
    const result = await store.append('b', stripped as ReceiptEntryInput);
    expect(result.ok).toBe(false);
    const entries = unwrap(await store.read('b'));
    expect(entries.some((e) => e.author === 'dealer')).toBe(false);
    expect(entries).toEqual([]);
  });

  it('the author is stored verbatim for each of the three ratified labels, never rewritten', async () => {
    const store = createInMemoryReceiptStore(clock);
    const cases: ReadonlyArray<[ReceiptEntryInput, MessageAuthor]> = [
      [sms({ author: 'dealer' }), 'dealer'],
      [note({ author: 'buyer' }), 'buyer'],
      [note({ author: 'concierge' }), 'concierge'],
      [callMeta({ author: 'buyer' }), 'buyer'],
    ];
    for (const [input, expected] of cases) {
      expect(unwrap(await store.append('b', input)).entry.author).toBe(expected);
    }
    expect(unwrap(await store.read('b')).map((e) => e.author)).toEqual([
      'dealer',
      'buyer',
      'concierge',
      'buyer',
    ]);
  });

  it('the accepted author set is exactly the spine MESSAGE_AUTHORS — no local vocabulary (ADR-001)', async () => {
    const store = createInMemoryReceiptStore(clock);
    expect([...MESSAGE_AUTHORS].sort()).toEqual(['buyer', 'concierge', 'dealer']);
    for (const author of MESSAGE_AUTHORS) {
      // `dealer` is only coherent on a provider-originated, non-internal entry.
      const input = author === 'dealer' ? sms({ author }) : note({ author });
      expect(
        (await store.append(`b-${author}`, input)).ok,
        `spine author "${author}" must be acceptable somewhere on the surface`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Authorship coherence (D6, D7, §6 test 9)
// ---------------------------------------------------------------------------

describe('authorship coherence — self-authored evidence cannot wear a dealer label (D6, D7)', () => {
  it('the incoherent combinations are compile errors first (type-level enforcement)', () => {
    // @ts-expect-error — a note is the buyer's/operator's own record; `dealer` is incoherent
    const dealerNote: NoteEntryInput = { ...note(), author: 'dealer' };
    // @ts-expect-error — a note must be `internal`
    const outboundNote: NoteEntryInput = { ...note(), direction: 'in' };
    // @ts-expect-error — a provider-originated entry is never `internal`
    const internalSms: SmsEntryInput = { ...sms(), direction: 'internal' };
    // @ts-expect-error — author on a call-metadata record is who logged it account-side
    const dealerCall: CallMetaEntryInput = { ...callMeta(), author: 'dealer' };
    expect([dealerNote, outboundNote, internalSms, dealerCall]).toHaveLength(4);
    expectTypeOf<NoteEntryInput['direction']>().toEqualTypeOf<'internal'>();
    expectTypeOf<SmsEntryInput['direction']>().toEqualTypeOf<'in' | 'out'>();
    expectTypeOf<EmailEntryInput['direction']>().toEqualTypeOf<'in' | 'out'>();
    expectTypeOf<CallMetaEntryInput['direction']>().toEqualTypeOf<'in' | 'out'>();
  });

  it('and they are rejected at runtime too, with nothing written (JS/JSON boundary)', async () => {
    const store = createInMemoryReceiptStore(clock);
    const incoherent: ReadonlyArray<[string, unknown]> = [
      ['dealer-authored note', { ...note(), author: 'dealer' }],
      ['internal record authored by the dealer', { ...sms(), direction: 'internal', author: 'dealer' }],
      ['note with an inbound direction', { ...note(), direction: 'in' }],
      ['note with an outbound direction', { ...note(), direction: 'out' }],
      ['internal sms', { ...sms(), direction: 'internal' }],
      ['internal email', { ...email(), direction: 'internal' }],
      ['internal call_meta', { ...callMeta(), direction: 'internal' }],
      ['dealer-logged call_meta', { ...callMeta(), author: 'dealer' }],
    ];
    for (const [label, input] of incoherent) {
      const error = unwrapErr(await store.append('b', input as ReceiptEntryInput));
      expect(error.code, `${label} must be rejected`).toBe('invalid_input');
      expect(error.retryable, `${label} is a caller bug, not a transient failure`).toBe(false);
    }
    expect(unwrap(await store.read('b'))).toEqual([]);
  });

  it('the coherent combinations all append (the guard is not simply refusing everything)', async () => {
    const store = createInMemoryReceiptStore(clock);
    const coherent: ReceiptEntryInput[] = [
      sms({ author: 'dealer', direction: 'in' }),
      sms({ author: 'buyer', direction: 'out' }),
      sms({ author: 'concierge', direction: 'out' }),
      email({ author: 'dealer', direction: 'in' }),
      note({ author: 'buyer' }),
      note({ author: 'concierge' }),
      callMeta({ author: 'buyer', direction: 'in' }),
      callMeta({ author: 'concierge', direction: 'out' }),
    ];
    for (const input of coherent) {
      expect((await store.append('b', input)).ok, `${input.kind}/${input.author} must append`).toBe(
        true,
      );
    }
    expect(unwrap(await store.read('b'))).toHaveLength(coherent.length);
  });

  it('the rejection message names the author label but never any payload content (§4.5)', async () => {
    const store = createInMemoryReceiptStore(clock);
    const error = unwrapErr(
      await store.append('b', {
        ...note({ body: 'Jim at Shady Motors said 555-867-5309 is his cell' }),
        author: 'dealer',
      } as unknown as ReceiptEntryInput),
    );
    expect(error.message).toContain('note');
    expect(error.message).not.toContain('555-867-5309');
    expect(error.message).not.toContain('Shady Motors');
  });
});

// ---------------------------------------------------------------------------
// 3. Entry kinds are closed; the audio / call-text kinds are gone (AC-5, §6 test 11)
// ---------------------------------------------------------------------------

/** Assembled from fragments so this file's own scan cannot self-trip. */
const BANNED_TOKENS: readonly string[] = [
  'transcr' + 'ipt',
  'record' + 'ing',
  'recording' + '_ref',
  'transcri' + 'be',
  'transcri' + 'ption',
  'A' + 'SR',
  'speech-to-' + 'text',
  'audio_' + 'url',
  'whis' + 'per',
  'deep' + 'gram',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe('entry kinds are exactly note|sms|email|call_meta (AC-5, D4, Q14)', () => {
  it('ReceiptEntryKind is the closed four-value set at the type level', () => {
    expectTypeOf<ReceiptEntryKind>().toEqualTypeOf<'note' | 'sms' | 'email' | 'call_meta'>();
    expectTypeOf<ReceiptEntryInput['kind']>().toEqualTypeOf<ReceiptEntryKind>();
  });

  it('the deleted kinds are unrepresentable — not deprecated, not aliased (D4)', () => {
    // @ts-expect-error — the audio-pointer kind no longer exists on the surface
    const audioKind: ReceiptEntryKind = 'recording_ref';
    // @ts-expect-error — the verbatim-call-text kind no longer exists on the surface
    const callTextKind: ReceiptEntryKind = 'transcript';
    expect([audioKind, callTextKind]).toHaveLength(2);
  });

  it('the deleted kinds are rejected at runtime and write nothing', async () => {
    const store = createInMemoryReceiptStore(clock);
    for (const kind of ['recording_ref', 'transcript', 'audio', 'call']) {
      const input = { ...sms(), kind } as unknown as ReceiptEntryInput;
      expect(unwrapErr(await store.append('b', input)).code, `kind "${kind}"`).toBe('invalid_input');
    }
    expect(unwrap(await store.read('b'))).toEqual([]);
  });

  it('the exported API declares no input type for a deleted kind', () => {
    for (const name of Object.keys(receiptApi)) {
      expect(name.toLowerCase()).not.toContain('recording');
      expect(name.toLowerCase()).not.toContain('transcript');
    }
  });

  it('no source or test file in the package references audio, transcription, or an ASR provider', () => {
    const files = walk(PKG_ROOT).filter(
      (f) => /\.(ts|json|md)$/.test(f) && !f.endsWith('authorship.test.ts'),
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const token of BANNED_TOKENS) {
        expect(text, `${file} must not reference "${token}"`).not.toContain(token.toLowerCase());
      }
    }
  });

  it('every kind maps to exactly one channel, and the mapping is a bijection (§2.3)', async () => {
    const store = createInMemoryReceiptStore(clock);
    const expected: ReadonlyArray<[ReceiptEntryInput, string]> = [
      [note(), 'note'],
      [sms(), 'sms'],
      [email(), 'email'],
      [callMeta(), 'call'],
    ];
    const channels: string[] = [];
    for (const [input, channel] of expected) {
      const entry = unwrap(await store.append('b', input)).entry;
      expect(entry.channel).toBe(channel);
      channels.push(entry.channel);
    }
    expect(new Set(channels).size).toBe(channels.length); // injective: no two kinds share a channel
  });
});

// ---------------------------------------------------------------------------
// 4. Call-metadata purity (AC-7, D8, §6 test 10)
// ---------------------------------------------------------------------------

describe('a call-metadata entry records time, direction, and party — and nothing else (AC-7, D8)', () => {
  it('carries the @core CallMeta verbatim, with no payload field an audio pointer could occupy', () => {
    expectTypeOf<CallMetaEntryInput['call_meta']>().toEqualTypeOf<CallMeta>();
    expectTypeOf<keyof CallMeta>().toEqualTypeOf<'started_at' | 'duration_seconds' | 'party'>();
    expectTypeOf<keyof CallMetaEntryInput>().toEqualTypeOf<
      | 'kind'
      | 'author'
      | 'direction'
      | 'occurred_at'
      | 'dedupe_key'
      | 'provider_message_ref'
      | 'call_meta'
    >();
    // No body, and no field a deleted kind could have hidden inside.
    expectTypeOf<CallMetaEntryInput>().not.toHaveProperty('body');
  });

  it('round-trips time, duration, and party, and stores no other content field', async () => {
    const store = createInMemoryReceiptStore(clock);
    const entry = unwrap(
      await store.append('b', callMeta({ call_meta: { started_at: T2, duration_seconds: 95, party: 'Jim' } })),
    ).entry;
    if (entry.kind !== 'call_meta') expect.fail('expected a call_meta entry');
    expect(entry.call_meta).toEqual({ started_at: T2, duration_seconds: 95, party: 'Jim' });
    expect(Object.keys(entry.call_meta).sort()).toEqual(['duration_seconds', 'party', 'started_at']);
    expect(Object.keys(entry).sort()).toEqual([
      'appended_at',
      'author',
      'call_meta',
      'channel',
      'direction',
      'kind',
      'occurred_at',
      'seq',
    ]);
    expect('body' in entry).toBe(false);
  });

  it('a caller-injected audio pointer or call text is DROPPED, never persisted', async () => {
    const store = createInMemoryReceiptStore(clock);
    const smuggled = {
      ...callMeta(),
      call_meta: {
        started_at: T2,
        party: 'Jim',
        // Fields no v0.5 type declares; a JS/JSON caller can still send them.
        ['record' + 'ing_url']: 'https://cdn.example/call.mp3',
        ['transcr' + 'ipt']: 'DEALER: we can do 29 grand',
      },
      body: 'DEALER: we can do 29 grand',
    } as unknown as ReceiptEntryInput;
    const entry = unwrap(await store.append('b', smuggled)).entry;
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('cdn.example');
    expect(serialized).not.toContain('29 grand');
    expect(serialized.toLowerCase()).not.toContain('record' + 'ing');
    expect(serialized.toLowerCase()).not.toContain('transcr' + 'ipt');
    // ...and the read-back agrees: the trail holds metadata only.
    const readBack = unwrap(await store.read('b'))[0];
    expect(JSON.stringify(readBack)).toBe(serialized);
  });

  it('a call_meta entry is frozen through the nested metadata object', async () => {
    const store = createInMemoryReceiptStore(clock);
    const entry = unwrap(await store.append('b', callMeta())).entry;
    if (entry.kind !== 'call_meta') expect.fail('expected a call_meta entry');
    expect(Object.isFrozen(entry.call_meta)).toBe(true);
    expect(() => {
      (entry.call_meta as unknown as Record<string, unknown>)['party'] = 'someone else';
    }).toThrow(TypeError);
    expect(entry.call_meta.party).toBe('+1-555-867-5309');
  });
});

// ---------------------------------------------------------------------------
// 5. Structurally append-only (AC-8, §6 test 12) — no update, no delete
// ---------------------------------------------------------------------------

describe('the store surface offers no update or delete path in any form (AC-8)', () => {
  it('ReceiptStore has exactly two members at the type level', () => {
    expectTypeOf<Exclude<keyof receiptApi.ReceiptStore, 'append' | 'read'>>().toEqualTypeOf<never>();
  });

  it('no source file in the package declares a mutation-shaped operation', () => {
    const srcFiles = walk(join(PKG_ROOT, 'src')).filter((f) => f.endsWith('.ts'));
    const mutationOp =
      /\b(?:async\s+)?(?:function\s+)?(update|delete|remove|clear|truncate|overwrite|upsert|patch|purge|drop)(?:Entry|Bundle|Receipt)?\s*[(:]/i;
    for (const file of srcFiles) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} must declare no mutation operation`).not.toMatch(mutationOp);
    }
  });

  it('an appended entry can never be removed or altered through the public API', async () => {
    const store = createInMemoryReceiptStore(clock);
    const first = unwrap(await store.append('b', sms({ dedupe_key: 'evt-1' }))).entry;
    // Every affordance a caller has: re-append with the same key, re-append a
    // contradicting payload, mutate the read-back array, mutate the entry.
    await store.append('b', sms({ dedupe_key: 'evt-1', body: 'REPLACEMENT', author: 'buyer', direction: 'out' }));
    const readBack = unwrap(await store.read('b'));
    (readBack as ReceiptEntry[]).length = 0;
    expect(() => {
      (first as unknown as Record<string, unknown>)['author'] = 'dealer-forged';
    }).toThrow(TypeError);
    const final = unwrap(await store.read('b'));
    expect(final).toHaveLength(1);
    expect(final[0]).toBe(first);
    expect(final[0]?.author).toBe('dealer');
  });

  it('the trail only ever grows: entry count is monotonic across a long append sequence', async () => {
    const store = createInMemoryReceiptStore(clock);
    let previous = 0;
    for (let i = 0; i < 25; i += 1) {
      await store.append('b', sms({ dedupe_key: `evt-${i % 5}` })); // 80% redeliveries
      const count = unwrap(await store.read('b')).length;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
    expect(previous).toBe(5); // five distinct keys, twenty absorbed duplicates
  });

  /**
   * Design §4.2 gives dedupe_key exactly one meaning — "idempotency anchor for
   * at-least-once writers … convention: event idempotency_key" — and D10's
   * first-write-wins rule is scoped to a REDELIVERY of the same event. It has
   * no row for a blank key, yet every other caller-supplied string on the write
   * path (receipt_bundle_id, body) is blank-checked, and §4.6 rule 3 states the
   * trail's governing property outright: a comms event is "never silently
   * dropped — dead-lettered comms events are the trail's feedstock, and losing
   * one falsifies the trail."
   *
   * A blank key is the realistic JS/JSON-boundary shape (an envelope whose
   * idempotency_key is absent and lands as ''), which is the boundary the
   * design says these runtime guards exist for. Two UNRELATED entries then
   * collide on '' and the second is absorbed with deduplicated: true — a
   * receipt entry that never enters the append-only trail and no error that
   * says so.
   *
   * The assertion below is deliberately remedy-agnostic: reject the blank key
   * as invalid_input, or treat it as absent and append. Either satisfies the
   * invariant. Silently swallowing a distinct entry does not.
   */
  it('a blank dedupe_key never silently swallows a distinct entry (§4.6 rule 3)', async () => {
    for (const blank of ['', '   ']) {
      const store = createInMemoryReceiptStore(clock);
      const first = await store.append('b', sms({ dedupe_key: blank, body: 'FIRST message' }));
      expect(first.ok).toBe(true);

      const second = await store.append(
        'b',
        sms({ dedupe_key: blank, body: 'SECOND, unrelated message' }),
      );

      if (second.ok) {
        expect(
          second.value.deduplicated,
          `dedupe_key ${JSON.stringify(blank)}: a distinct entry was absorbed as a redelivery`,
        ).toBe(false);
        const bodies = unwrap(await store.read('b')).map((e) =>
          e.kind === 'sms' ? e.body : undefined,
        );
        expect(bodies).toEqual(['FIRST message', 'SECOND, unrelated message']);
      } else {
        // The other acceptable remedy: a blank idempotency anchor is a caller
        // bug, rejected loudly like every other blank string on this path.
        expect(second.error.code).toBe('invalid_input');
        expect(second.error.retryable).toBe(false);
      }
    }
  });

  /**
   * The blank case above is the string-shaped half. The JS/JSON boundary that
   * §4.6 rule 2 actually names ("writers set dedupe_key from the event
   * envelope's idempotency_key") produces the other half: an envelope with no
   * idempotency_key serializes to `{"dedupe_key": null}`, and a hand-rolled
   * caller can hand over any type at all. None of these identify an EVENT, so
   * none may act as an idempotency anchor — otherwise two unrelated entries
   * collide on it and the second never enters the trail.
   *
   * Remedy-agnostic in the same way: reject, or treat as absent and append.
   * The one outcome the trail cannot survive is the silent swallow.
   */
  it('a non-string dedupe_key never silently swallows a distinct entry (§4.6 rules 2-3)', async () => {
    const degenerate: readonly unknown[] = [null, 0, false, 42, {}, []];
    for (const key of degenerate) {
      const store = createInMemoryReceiptStore(clock);
      const label = `dedupe_key ${JSON.stringify(key) ?? String(key)}`;
      const first = await store.append(
        'b',
        sms({ dedupe_key: key as string, body: 'FIRST message' }),
      );
      const second = await store.append(
        'b',
        sms({ dedupe_key: key as string, body: 'SECOND, unrelated message' }),
      );

      if (first.ok && second.ok) {
        expect(second.value.deduplicated, `${label}: a distinct entry was absorbed`).toBe(false);
        const bodies = unwrap(await store.read('b')).map((e) =>
          e.kind === 'sms' ? e.body : undefined,
        );
        expect(bodies, label).toEqual(['FIRST message', 'SECOND, unrelated message']);
      } else {
        const error = first.ok ? unwrapErr(second) : unwrapErr(first);
        expect(error.code, label).toBe('invalid_input');
        expect(error.retryable, label).toBe(false);
      }
    }
  });

  /**
   * The counterweight: refusing to honour degenerate keys must not weaken the
   * idempotency mechanism itself. A real anchor still absorbs its redelivery
   * (D10), and a degenerate value is never persisted onto the entry as an
   * anchor it is not — so a durable implementation (T-017) indexing
   * `entry.dedupe_key` inherits the same collision-free set.
   */
  it('a real dedupe_key still dedupes, and a degenerate one is never stored as an anchor', async () => {
    const store = createInMemoryReceiptStore(clock);
    const real = unwrap(await store.append('b', sms({ dedupe_key: 'evt-9', body: 'once' })));
    const redelivered = unwrap(await store.append('b', sms({ dedupe_key: 'evt-9', body: 'once' })));
    expect(redelivered.deduplicated).toBe(true);
    expect(redelivered.entry.seq).toBe(real.entry.seq);

    const blankKeyed = await store.append('b', sms({ dedupe_key: '   ', body: 'distinct' }));
    if (blankKeyed.ok) {
      expect(blankKeyed.value.deduplicated).toBe(false);
      expect(blankKeyed.value.entry.dedupe_key).toBeUndefined();
    } else {
      expect(blankKeyed.error.code).toBe('invalid_input');
    }
    expect(unwrap(await store.read('b')).map((e) => e.seq)).toEqual(
      blankKeyed.ok ? [1, 2] : [1],
    );
  });

  it('a rejected append leaves the existing trail byte-identical (failed writes never disturb history)', async () => {
    const store = createInMemoryReceiptStore(clock);
    await store.append('b', sms());
    await store.append('b', note());
    const before = JSON.stringify(unwrap(await store.read('b')));
    await store.append('b', { ...note(), author: 'dealer' } as unknown as ReceiptEntryInput);
    await store.append('b', { ...sms(), author: undefined } as unknown as ReceiptEntryInput);
    await store.append('b', { ...sms(), occurred_at: 'nope' } as unknown as ReceiptEntryInput);
    expect(JSON.stringify(unwrap(await store.read('b')))).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 6. Deal isolation — a read never crosses a bundle
// ---------------------------------------------------------------------------

describe('deal isolation — a bundle read never returns another deal (or account) entry', () => {
  it('entries stay in the bundle they were appended to, across store and dossier reads', async () => {
    const store = createInMemoryReceiptStore(clock);
    const exporter = createDossierExporter(store, clock);
    await store.append('acct-1:deal-A:bundle', note({ body: 'A-only note' }));
    await store.append('acct-2:deal-B:bundle', note({ body: 'B-only note' }));
    await store.append('acct-2:deal-B:bundle', sms({ body: 'B-only sms' }));

    const a = unwrap(await store.read('acct-1:deal-A:bundle'));
    const b = unwrap(await store.read('acct-2:deal-B:bundle'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    expect(JSON.stringify(a)).not.toContain('B-only');
    expect(JSON.stringify(b)).not.toContain('A-only');

    const dossierA = unwrap(await exporter.assemble('acct-1:deal-A:bundle'));
    expect(dossierA.entry_count).toBe(1);
    expect(JSON.stringify(dossierA.entries)).not.toContain('B-only');
  });

  it('a near-miss bundle id reads empty rather than falling back to a neighbour', async () => {
    const store = createInMemoryReceiptStore(clock);
    await store.append('bundle-1', sms());
    for (const near of ['bundle-2', 'bundle-1 ', ' bundle-1', 'BUNDLE-1', 'bundle-10']) {
      expect(unwrap(await store.read(near)), `bundle id ${JSON.stringify(near)}`).toEqual([]);
    }
  });

  it('an entry carries no dealership or contact identity — tenancy stays outside the trail', async () => {
    const store = createInMemoryReceiptStore(clock);
    for (const input of [note(), sms(), email(), callMeta()]) {
      const entry = unwrap(await store.append(`b-${input.kind}`, input)).entry;
      for (const key of Object.keys(entry)) {
        expect(key.toLowerCase(), `${input.kind}.${key}`).not.toMatch(
          /dealership|contact|account_id|salesperson/,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Dossier carries the author through to the export (AC-9, D11, §6 test 16)
// ---------------------------------------------------------------------------

describe('the exported dossier distinguishes dealer- from buyer- and concierge-authored evidence (AC-9)', () => {
  it('every exported entry carries its author, and a mixed bundle exports all three labels', async () => {
    const store = createInMemoryReceiptStore(clock);
    const exporter = createDossierExporter(store, clock);
    await store.append('bundle-9', sms({ author: 'dealer', direction: 'in', occurred_at: T1 }));
    await store.append('bundle-9', note({ author: 'buyer', occurred_at: T2 }));
    await store.append('bundle-9', callMeta({ author: 'concierge', direction: 'out', occurred_at: T3 }));

    const dossier = unwrap(await exporter.assemble('bundle-9'));
    expect(dossier.entry_count).toBe(3);
    for (const entry of dossier.entries) {
      expect(MESSAGE_AUTHORS).toContain(entry.author);
    }
    expect(dossier.entries.map((e) => e.author)).toEqual(['dealer', 'buyer', 'concierge']);
    // The distinction survives serialization — a renderer reading the artifact
    // can still tell self-authored evidence from a dealer statement.
    const serialized = JSON.parse(JSON.stringify(dossier)) as {
      entries: ReadonlyArray<{ author: string; kind: string }>;
    };
    expect(serialized.entries.map((e) => e.author)).toEqual(['dealer', 'buyer', 'concierge']);
    expect(new Set(serialized.entries.map((e) => e.author)).size).toBe(3);
  });

  it('the concierge-authored note is never exported as if the dealer had said it (specs/01 concierge tier)', async () => {
    const store = createInMemoryReceiptStore(clock);
    const exporter = createDossierExporter(store, clock);
    await store.append('b', note({ author: 'concierge', body: 'Told them we would walk at 24k.' }));
    const dossier = unwrap(await exporter.assemble('b'));
    const entry = dossier.entries[0];
    expect(entry?.author).toBe('concierge');
    expect(entry?.direction).toBe('internal');
    expect(entry?.channel).toBe('note');
    // The operator's own record cannot be mistaken for an inbound dealer message.
    expect(dossier.entries.some((e) => e.author === 'dealer')).toBe(false);
  });

  it('the dossier type exposes the author on every entry, with no way to drop it (D11)', () => {
    expectTypeOf<receiptApi.DealDossier['entries']>().toEqualTypeOf<readonly ReceiptEntry[]>();
    expectTypeOf<ReceiptEntry['author']>().toEqualTypeOf<MessageAuthor>();
  });

  it('the still-stubbed renderers cannot produce an artifact that silently drops the label', async () => {
    const store = createInMemoryReceiptStore(clock);
    const exporter = createDossierExporter(store, clock);
    await store.append('b', note({ author: 'concierge' }));
    const dossier = unwrap(await exporter.assemble('b'));
    for (const op of ['renderPdf', 'publishWebLink'] as const) {
      const result = await exporter[op](dossier);
      expect(result.ok).toBe(false);
      expect(unwrapErr(result).code).toBe('not_implemented');
      expect(unwrapErr(result).retryable).toBe(false);
    }
  });
});
