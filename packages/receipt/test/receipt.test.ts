/**
 * Receipt-layer suite, carried forward to the v0.5 surface (docs/design/T-012.md).
 *
 * Covers: append + stamping, chronological read-back, structural append-only
 * surface (AC-8), runtime immutability, idempotent dedupe (D10), validation
 * error paths (§4.2), dossier assembly + stubbed export (§4.4), error-message
 * PII hygiene (§4.5), identity routing (entries must never land in or read
 * from the wrong bundle), and the no-HTTP/webhook surface rule (§4.6 — this
 * package must own no webhook handler).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as receiptApi from '@receipt';
import {
  createDossierExporter,
  createInMemoryReceiptStore,
  type CallMetaEntryInput,
  type DealDossier,
  type DossierExporter,
  type EmailEntryInput,
  type NoteEntryInput,
  type ReceiptEntry,
  type ReceiptEntryInput,
  type ReceiptError,
  type ReceiptResult,
  type ReceiptStore,
  type SmsEntryInput,
} from '@receipt';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const T1 = '2026-08-07T10:00:00.000Z';
const T2 = '2026-08-07T11:00:00.000Z';
const T3 = '2026-08-07T12:00:00.000Z';

/** PII strings deliberately planted in fixtures; must never leak into ReceiptError.message. */
const PII = {
  body: 'Out the door $21,500 — call me at 555-867-5309',
  note: 'Jim said the doc fee is non-negotiable, ask for him at the desk',
  email: 'dealer.jim@shadymotors.example',
  subject: 'RE: your trade-in payoff 4111-1111',
  party: '+1-555-867-5309 (Jim at Shady Motors)',
};

function makeClock(start = '2026-08-07T12:00:00.000Z') {
  let now = start;
  return {
    clock: () => now,
    set(next: string) {
      now = next;
    },
  };
}

function unwrap<T>(result: ReceiptResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got error: ${result.error.code} — ${result.error.message}`);
  }
  return result.value;
}

function unwrapErr<T>(result: ReceiptResult<T>): ReceiptError {
  if (result.ok) {
    throw new Error('expected error result, got ok');
  }
  return result.error;
}

function sms(overrides: Partial<SmsEntryInput> = {}): SmsEntryInput {
  return {
    kind: 'sms',
    author: 'dealer',
    direction: 'in',
    occurred_at: T1,
    body: PII.body,
    ...overrides,
  };
}

function email(overrides: Partial<EmailEntryInput> = {}): EmailEntryInput {
  return {
    kind: 'email',
    author: 'buyer',
    direction: 'out',
    occurred_at: T2,
    subject: PII.subject,
    body: 'Please send the OTD breakdown in writing.',
    ...overrides,
  };
}

/** The buyer's/operator's own written record — always `internal`, never dealer-authored (D6). */
function note(overrides: Partial<NoteEntryInput> = {}): NoteEntryInput {
  return {
    kind: 'note',
    author: 'buyer',
    direction: 'internal',
    occurred_at: T3,
    body: PII.note,
    ...overrides,
  };
}

/** Call METADATA only — no audio pointer, no verbatim call text exists on this type (AC-7). */
function callMeta(overrides: Partial<CallMetaEntryInput> = {}): CallMetaEntryInput {
  return {
    kind: 'call_meta',
    author: 'concierge',
    direction: 'out',
    occurred_at: T3,
    call_meta: { started_at: T3, duration_seconds: 412, party: PII.party },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Append + stamp (design §7.1, R4, AC-1)
// ---------------------------------------------------------------------------

describe('append + stamp', () => {
  it('appends each of the four v0.5 kinds and derives the channel from kind (AC-5)', async () => {
    const { clock } = makeClock();
    const store = createInMemoryReceiptStore(clock);
    const cases: ReadonlyArray<[ReceiptEntryInput, string]> = [
      [note(), 'note'],
      [sms(), 'sms'],
      [email(), 'email'],
      [callMeta(), 'call'],
    ];
    for (const [input, expectedChannel] of cases) {
      const outcome = unwrap(await store.append('bundle-1', input));
      expect(outcome.deduplicated).toBe(false);
      expect(outcome.entry.channel).toBe(expectedChannel);
      expect(outcome.entry.kind).toBe(input.kind);
      expect(outcome.entry.direction).toBe(input.direction);
      // AC-6: the author survives the append verbatim, never defaulted.
      expect(outcome.entry.author).toBe(input.author);
    }
  });

  it('stamps appended_at from the injected clock, distinct from occurred_at (AC-1)', async () => {
    const { clock, set } = makeClock('2026-08-07T15:00:00.000Z');
    const store = createInMemoryReceiptStore(clock);
    const first = unwrap(await store.append('b', sms({ occurred_at: T1 }))).entry;
    expect(first.appended_at).toBe('2026-08-07T15:00:00.000Z');
    expect(first.occurred_at).toBe(T1);

    set('2026-08-07T16:30:00.000Z');
    const second = unwrap(await store.append('b', email())).entry;
    expect(second.appended_at).toBe('2026-08-07T16:30:00.000Z');
  });

  it('assigns seq starting at 1 and incrementing per bundle', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    expect(unwrap(await store.append('b', sms())).entry.seq).toBe(1);
    expect(unwrap(await store.append('b', email())).entry.seq).toBe(2);
    expect(unwrap(await store.append('b', callMeta())).entry.seq).toBe(3);
  });

  it('keeps seq sequences independent across bundles (identity routing)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    expect(unwrap(await store.append('deal-A', sms())).entry.seq).toBe(1);
    expect(unwrap(await store.append('deal-A', email())).entry.seq).toBe(2);
    expect(unwrap(await store.append('deal-B', sms())).entry.seq).toBe(1);
    expect(unwrap(await store.append('deal-A', callMeta())).entry.seq).toBe(3);
    expect(unwrap(await store.append('deal-B', email())).entry.seq).toBe(2);
  });

  it('preserves provider_message_ref and dedupe_key verbatim on a provider-originated entry (D9/D10)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const entry = unwrap(
      await store.append('b', sms({ provider_message_ref: 'twilio:SM123', dedupe_key: 'sms:SM123' })),
    ).entry;
    if (entry.kind !== 'sms') expect.fail('expected an sms entry');
    else expect(entry.provider_message_ref).toBe('twilio:SM123');
    expect(entry.dedupe_key).toBe('sms:SM123');
  });

  it('a note carries no provider_message_ref field at all (D9 — no fabricated provenance)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const entry = unwrap(await store.append('b', note())).entry;
    expect('provider_message_ref' in entry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Chronological read-back (design §7.2, R5, R3)
// ---------------------------------------------------------------------------

describe('chronological read-back', () => {
  it('reads back sorted by occurred_at ascending regardless of append order (R5)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    // The call log lands AFTER the sms that followed it — classic out-of-order append.
    await store.append('b', sms({ occurred_at: T2 }));
    await store.append('b', callMeta({ occurred_at: T1, call_meta: { started_at: T1 } }));
    await store.append('b', email({ occurred_at: T3 }));
    const entries = unwrap(await store.read('b'));
    expect(entries.map((e) => e.occurred_at)).toEqual([T1, T2, T3]);
    expect(entries.map((e) => e.kind)).toEqual(['call_meta', 'sms', 'email']);
  });

  it('breaks occurred_at ties by seq (append order), making order total and deterministic', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    await store.append('b', sms({ occurred_at: T1, body: 'first appended' }));
    await store.append('b', email({ occurred_at: T1 }));
    await store.append('b', note({ occurred_at: T1 }));
    const entries = unwrap(await store.read('b'));
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('returns ok with [] for an unknown / never-appended bundle (R3)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const entries = unwrap(await store.read('fresh-deal-bundle'));
    expect(entries).toEqual([]);
  });

  it('never leaks entries across bundles (identity routing: wrong-deal read is impossible)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    await store.append('deal-A', sms({ body: 'A-only message' }));
    await store.append('deal-B', email());
    const a = unwrap(await store.read('deal-A'));
    const b = unwrap(await store.read('deal-B'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.kind).toBe('sms');
    expect(b[0]?.kind).toBe('email');
  });

  it('read returns the same frozen entry objects the append returned (no copies, no drift)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const appended = unwrap(await store.append('b', sms())).entry;
    const entries = unwrap(await store.read('b'));
    expect(entries[0]).toBe(appended);
  });
});

// ---------------------------------------------------------------------------
// 3. Structural append-only (design §7.3, AC-2) — type surface + runtime
// ---------------------------------------------------------------------------

describe('structural append-only surface', () => {
  it('ReceiptStore type surface is exactly append | read (compile-time, AC-2)', () => {
    expectTypeOf<keyof ReceiptStore>().toEqualTypeOf<'append' | 'read'>();
  });

  it('DossierExporter type surface is exactly assemble | renderPdf | publishWebLink', () => {
    expectTypeOf<keyof DossierExporter>().toEqualTypeOf<'assemble' | 'renderPdf' | 'publishWebLink'>();
  });

  it('store instance exposes no own members beyond append and read (runtime, AC-2)', () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    expect(Reflect.ownKeys(store).sort()).toEqual(['append', 'read']);
  });

  it('exporter instance exposes no own members beyond the three declared operations', () => {
    const exporter = createDossierExporter(createInMemoryReceiptStore(makeClock().clock));
    expect(Reflect.ownKeys(exporter).sort()).toEqual(['assemble', 'publishWebLink', 'renderPdf']);
  });

  it('no exported API name suggests a mutation path (update/delete/clear/remove/truncate/set/overwrite)', () => {
    const forbidden = /update|delete|clear|remove|truncate|overwrite|purge|reset|drop|(^|[a-z])set[A-Z]/i;
    for (const name of Object.keys(receiptApi)) {
      expect(name).not.toMatch(forbidden);
    }
  });

  it('package source contains no HTTP/webhook surface (§5.4 — appends are post-ack consumer work)', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const banned =
      /node:https?\b|from ['"]https?:|createServer|\.listen\s*\(|\bexpress\b|\bfastify\b|\bfetch\s*\(|XMLHttpRequest|WebSocket/;
    for (const file of readdirSync(srcDir)) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      expect(text, `${file} must contain no HTTP/server/webhook code`).not.toMatch(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Immutability (design §7.4, AC-1)
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('mutating the caller input after append does not change the stored entry (defensive copy)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const input = sms({ body: 'original body' });
    await store.append('b', input);
    input.body = 'TAMPERED';
    (input as { occurred_at: string }).occurred_at = '1999-01-01T00:00:00.000Z';
    const entries = unwrap(await store.read('b'));
    const entry = entries[0];
    expect(entry?.kind).toBe('sms');
    if (entry?.kind === 'sms') {
      expect(entry.body).toBe('original body');
    }
    expect(entry?.occurred_at).toBe(T1);
  });

  it('stored entries are frozen; attempted mutation throws and changes nothing', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const entry = unwrap(await store.append('b', sms())).entry;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      // @ts-expect-error — ReceiptEntry is deeply readonly; runtime freeze must also hold
      entry.seq = 999;
    }).toThrow(TypeError);
    expect(() => {
      (entry as Record<string, unknown>)['injected_field'] = 'x';
    }).toThrow(TypeError);
    expect(entry.seq).toBe(1);
  });

  it('mutating a read-result array does not affect a subsequent read (fresh array per call)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    await store.append('b', sms());
    await store.append('b', email());
    const first = unwrap(await store.read('b'));
    expect(Object.isFrozen(first)).toBe(false); // the array is the caller's
    (first as ReceiptEntry[]).length = 0;
    const second = unwrap(await store.read('b'));
    expect(second).toHaveLength(2);
    expect(unwrap(await store.read('b'))).not.toBe(second); // distinct array identity each call
  });

  it('dossier entries remain the frozen store entries (no thawed copies in the export path)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const exporter = createDossierExporter(store, makeClock().clock);
    await store.append('b', sms());
    const dossier = unwrap(await exporter.assemble('b'));
    expect(dossier.entries).toHaveLength(1);
    expect(Object.isFrozen(dossier.entries[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Idempotent dedupe (design §7.5, R6)
// ---------------------------------------------------------------------------

describe('idempotent dedupe', () => {
  it('same dedupe_key twice in one bundle → deduplicated:true, identical entry, single read-back row', async () => {
    const { clock, set } = makeClock('2026-08-07T15:00:00.000Z');
    const store = createInMemoryReceiptStore(clock);
    const first = unwrap(await store.append('b', sms({ dedupe_key: 'evt-1' })));
    expect(first.deduplicated).toBe(false);

    set('2026-08-07T18:00:00.000Z'); // redelivery happens later — stamp must NOT change
    const second = unwrap(await store.append('b', sms({ dedupe_key: 'evt-1' })));
    expect(second.deduplicated).toBe(true);
    expect(second.entry).toBe(first.entry); // the existing frozen entry, untouched
    expect(second.entry.seq).toBe(1);
    expect(second.entry.appended_at).toBe('2026-08-07T15:00:00.000Z');

    expect(unwrap(await store.read('b'))).toHaveLength(1);
  });

  it('a dedupe hit never mutates the existing entry even when the redelivered payload differs (no upsert)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    await store.append('b', sms({ dedupe_key: 'evt-1', body: 'original body' }));
    const outcome = unwrap(await store.append('b', sms({ dedupe_key: 'evt-1', body: 'DIFFERENT body' })));
    expect(outcome.deduplicated).toBe(true);
    const entry = unwrap(await store.read('b'))[0];
    if (entry?.kind === 'sms') {
      expect(entry.body).toBe('original body');
    } else {
      expect.fail('expected an sms entry');
    }
  });

  it('a dedupe hit does not burn a seq — the next new append continues the sequence', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    await store.append('b', sms({ dedupe_key: 'evt-1' }));
    await store.append('b', sms({ dedupe_key: 'evt-1' }));
    const next = unwrap(await store.append('b', email({ dedupe_key: 'evt-2' })));
    expect(next.entry.seq).toBe(2);
  });

  it('different dedupe_keys and keyless appends always add entries', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    await store.append('b', sms({ dedupe_key: 'evt-1' }));
    await store.append('b', sms({ dedupe_key: 'evt-2' }));
    await store.append('b', sms());
    await store.append('b', sms());
    expect(unwrap(await store.read('b'))).toHaveLength(4);
  });

  it('dedupe is scoped per bundle — the same key in another bundle appends normally (identity routing)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const a = unwrap(await store.append('deal-A', sms({ dedupe_key: 'evt-1' })));
    const b = unwrap(await store.append('deal-B', sms({ dedupe_key: 'evt-1' })));
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(false);
    expect(a.entry).not.toBe(b.entry);
    expect(unwrap(await store.read('deal-A'))).toHaveLength(1);
    expect(unwrap(await store.read('deal-B'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Validation error paths (design §7.6, §5.1–§5.2)
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('append with blank bundle id → invalid_input, not retryable', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    for (const bad of ['', '   ']) {
      const error = unwrapErr(await store.append(bad, sms()));
      expect(error.code).toBe('invalid_input');
      expect(error.retryable).toBe(false);
    }
  });

  it('read with blank bundle id → invalid_input, not retryable', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const error = unwrapErr(await store.read(''));
    expect(error.code).toBe('invalid_input');
    expect(error.retryable).toBe(false);
  });

  it('empty payload for each kind → invalid_input, and nothing is written', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const bads: ReceiptEntryInput[] = [
      note({ body: '  ' }),
      callMeta({ call_meta: { started_at: 'not-a-timestamp' } }),
      sms({ body: '' }),
      email({ body: '   ' }),
    ];
    for (const bad of bads) {
      const error = unwrapErr(await store.append('b', bad));
      expect(error.code).toBe('invalid_input');
      expect(error.retryable).toBe(false);
    }
    expect(unwrap(await store.read('b'))).toEqual([]);
  });

  it('malformed occurred_at → invalid_input, and nothing is written', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const badTimestamps = [
      'yesterday',
      '2026-08-07', // date only — no time component
      '2026-08-07T12:00:00', // missing offset
      '2026-08-07 12:00:00Z', // space separator
      '2026-13-45T12:00:00Z', // pattern-shaped but not a real instant
      '',
    ];
    for (const occurred_at of badTimestamps) {
      const error = unwrapErr(await store.append('b', sms({ occurred_at })));
      expect(error.code, `timestamp ${JSON.stringify(occurred_at)} must be rejected`).toBe('invalid_input');
      expect(error.retryable).toBe(false);
    }
    expect(unwrap(await store.read('b'))).toEqual([]);
  });

  it('unknown kind and bad direction (type-unsafe callers) → invalid_input', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const unknownKind = {
      kind: 'audit',
      direction: 'in',
      occurred_at: T1,
      body: 'x',
    } as unknown as ReceiptEntryInput;
    expect(unwrapErr(await store.append('b', unknownKind)).code).toBe('invalid_input');

    const badDirection = { ...sms(), direction: 'sideways' } as unknown as ReceiptEntryInput;
    expect(unwrapErr(await store.append('b', badDirection)).code).toBe('invalid_input');

    const notAnObject = null as unknown as ReceiptEntryInput;
    expect(unwrapErr(await store.append('b', notAnObject)).code).toBe('invalid_input');

    expect(unwrap(await store.read('b'))).toEqual([]);
  });

  it('kind names inherited from Object.prototype must not slip past validation (append-only trail must reject garbage)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const prototypeKind = {
      kind: 'toString',
      direction: 'in',
      occurred_at: T1,
    } as unknown as ReceiptEntryInput;
    const result = await store.append('b', prototypeKind);
    expect(result.ok, "kind:'toString' is an unknown kind and must be rejected").toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
    }
    expect(unwrap(await store.read('b'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Dossier assembly + stubs (design §7.7, AC-3, AC-4, R8, §5.3)
// ---------------------------------------------------------------------------

describe('dossier export', () => {
  async function seeded(): Promise<{ store: ReceiptStore; exporter: DossierExporter }> {
    const store = createInMemoryReceiptStore(makeClock('2026-08-07T14:00:00.000Z').clock);
    const exporter = createDossierExporter(store, makeClock('2026-08-07T20:00:00.000Z').clock);
    await store.append('deal-bundle-9', sms({ occurred_at: T2 }));
    await store.append('deal-bundle-9', note({ occurred_at: T1 }));
    await store.append('deal-bundle-9', email({ occurred_at: T3 }));
    return { store, exporter };
  }

  it('assemble returns the ordered timeline with correct count, address, and first/last stamps', async () => {
    const { exporter } = await seeded();
    const dossier = unwrap(await exporter.assemble('deal-bundle-9'));
    expect(dossier.receipt_bundle_id).toBe('deal-bundle-9'); // AC-3: addressed by the Deal's receipt_bundle_id
    expect(dossier.entry_count).toBe(3);
    expect(dossier.entries.map((e) => e.occurred_at)).toEqual([T1, T2, T3]);
    expect(dossier.first_entry_at).toBe(T1);
    expect(dossier.last_entry_at).toBe(T3);
    expect(dossier.generated_at).toBe('2026-08-07T20:00:00.000Z');
  });

  it('empty / never-appended bundle → valid empty dossier without first/last stamps (R3)', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const exporter = createDossierExporter(store, makeClock().clock);
    const dossier = unwrap(await exporter.assemble('untouched-bundle'));
    expect(dossier.entry_count).toBe(0);
    expect(dossier.entries).toEqual([]);
    expect('first_entry_at' in dossier).toBe(false);
    expect('last_entry_at' in dossier).toBe(false);
  });

  it('assemble propagates the store error unchanged — never a partial dossier (§5.3)', async () => {
    const outage: ReceiptError = {
      code: 'store_unavailable',
      retryable: true,
      message: 'backend down',
    };
    const downStore: ReceiptStore = {
      append: async () => ({ ok: false, error: outage }),
      read: async () => ({ ok: false, error: outage }),
    };
    const exporter = createDossierExporter(downStore, makeClock().clock);
    const error = unwrapErr(await exporter.assemble('b'));
    expect(error).toBe(outage); // unchanged, retryable flag intact
    expect(error.retryable).toBe(true);

    const invalid = unwrapErr(await createDossierExporter(createInMemoryReceiptStore()).assemble(''));
    expect(invalid.code).toBe('invalid_input');
  });

  it('renderPdf and publishWebLink are loud stubs: not_implemented, not retryable, no fabricated artifact (R8)', async () => {
    const { exporter } = await seeded();
    const dossier = unwrap(await exporter.assemble('deal-bundle-9'));
    for (const op of ['renderPdf', 'publishWebLink'] as const) {
      const result = await exporter[op](dossier);
      const error = unwrapErr(result);
      expect(error.code).toBe('not_implemented');
      expect(error.retryable).toBe(false);
      expect(result).not.toHaveProperty('value'); // no fake URL/ref can leak into product code
    }
  });

  it('DealDossier type carries no mutation affordance beyond readonly entries', () => {
    expectTypeOf<DealDossier['entries']>().toEqualTypeOf<readonly ReceiptEntry[]>();
  });
});

// ---------------------------------------------------------------------------
// 8. Error message hygiene (design §7.8, §5.1 PII discipline)
// ---------------------------------------------------------------------------

describe('error message hygiene', () => {
  it('no ReceiptError.message produced by any path contains fixture bodies, note text, subjects, call parties, phones, or emails', async () => {
    const store = createInMemoryReceiptStore(makeClock().clock);
    const exporter = createDossierExporter(store, makeClock().clock);
    const messages: string[] = [];
    const collect = <T,>(result: ReceiptResult<T>): void => {
      if (!result.ok) messages.push(result.error.message);
    };

    // Every error-producing path, fed with PII-laden fixtures where possible.
    collect(await store.append('', sms()));
    collect(await store.append('b', sms({ body: '' })));
    collect(await store.append('b', sms({ occurred_at: 'not-a-timestamp' })));
    collect(await store.append('b', email({ body: '  ' })));
    collect(await store.append('b', note({ body: '' })));
    collect(await store.append('b', callMeta({ occurred_at: 'bogus' })));
    collect(await store.read(''));
    collect(await exporter.assemble(''));
    await store.append('b', sms());
    const dossier = unwrap(await exporter.assemble('b'));
    collect(await exporter.renderPdf(dossier));
    collect(await exporter.publishWebLink(dossier));

    expect(messages.length).toBeGreaterThanOrEqual(10);
    const piiFragments = [
      PII.body,
      PII.note,
      PII.email,
      PII.subject,
      PII.party,
      '555-867-5309',
      '21,500',
      '4111-1111',
      'shadymotors',
    ];
    for (const message of messages) {
      for (const fragment of piiFragments) {
        expect(message, `error message must not leak ${JSON.stringify(fragment)}`).not.toContain(fragment);
      }
    }
  });
});
