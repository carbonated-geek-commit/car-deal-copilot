/**
 * T-012 tester — channel-agnosticism, the `note` channel, and the
 * transcript-free surface (docs/design/T-012.md §1.2, §1.3, §1.6, §6 tests 3–6).
 *
 * The design's own measurement of the starting state is the reason this file
 * exists: the pre-T-012 extractor narrowed `channel` with a hand-written
 * `call | email | sms` literal chain, so the v0.5 `note` channel — the PRIMARY
 * v0.5 extraction input — silently fell through to the `sms` fallback and was
 * processed as a mislabelled SMS with nothing failing. Every assertion below is
 * chosen so that regression would fail loudly rather than pass quietly.
 *
 * Covered here:
 *  - channel-swap invariance over all four v0.5 channels (AC-1, §1.6)
 *  - `note` reaches its OWN profile and is not the plain/sms fallback (§6 test 4)
 *  - unknown / missing / prototype-shaped channel values stay total and degrade
 *    to `plain`, never to a fabricated channel (D3, §6 test 5)
 *  - PROFILE_BY_CHANNEL is exhaustive over the spine's MessageChannel (D1)
 *  - no rule below normalization can see a channel (D1) — one entry point only
 *  - transcript/recording-free source AND fixture surface (AC-2, §6 test 6)
 *  - ADR-005: absent inputs stay ABSENT (never 0), and `flags` is never
 *    populated here — the flag engine owns the unevaluable distinction
 *
 * Pure package: no DATABASE_URL, no object store, no HTTP endpoint is reached
 * by any test in this file, so ADR-008's skip-when-config-absent rule has
 * nothing to gate — there is no DB- or endpoint-dependent case to skip.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_CHANNELS } from '@core';
import type { MessageChannel } from '@core';
import * as api from '@offer-extraction';
import { extractOffer } from '@offer-extraction';
import type { ExtractionInput, ExtractionResult } from '@offer-extraction';
import { PROFILE_BY_CHANNEL, normalizeText } from '../src/normalize';
import type { NormalizationProfile } from '../src/normalize';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** All four v0.5 channels, taken from the spine — never a local literal list (D13). */
const ALL_CHANNELS = MESSAGE_CHANNELS;

// ---------------------------------------------------------------------------
// 1. Channel-swap invariance (AC-1, design §1.6, §6 test 3)
// ---------------------------------------------------------------------------

/**
 * Channel-NEUTRAL texts: digit-form amounts only, no spelled-out numbers, no
 * filler words, no quote markers or signature delimiters. These are exactly the
 * texts on which every profile must agree — asserting invariance over
 * spoken-form text instead would encode a FALSE invariant (profiles exist
 * because those texts are not channel-neutral).
 */
const NEUTRAL_TEXTS: readonly string[] = [
  'The price is $23,500 for this vehicle.',
  'We can get you to $450/mo.',
  'We could structure it at 5.9% APR for 72 months.',
  'Doc fee $899 on top of the $23,900 price.',
  'They are asking 23.5k for it.',
  'Just confirming your appointment for tomorrow.',
  '',
];

describe('channel-swap invariance (AC-1, design §1.6)', () => {
  for (const text of NEUTRAL_TEXTS) {
    it(`gives an identical result across call|sms|email|note: ${JSON.stringify(text.slice(0, 44))}`, () => {
      const results = ALL_CHANNELS.map((channel) => extractOffer({ channel, text }));
      const [first] = results;
      expect(first).toBeDefined();
      for (const [i, result] of results.entries()) {
        expect(result, `channel "${ALL_CHANNELS[i]}" must not change the outcome`).toStrictEqual(
          first,
        );
      }
    });
  }

  it('treats the note channel exactly like sms and email for every extractable field (T-012 EXTRA)', () => {
    const text = 'We can do $23,500 out the door with a $899 doc fee, 5.9% APR for 72 months.';
    const asNote = extractOffer({ channel: 'note', text });
    expect(asNote).toStrictEqual(extractOffer({ channel: 'sms', text }));
    expect(asNote).toStrictEqual(extractOffer({ channel: 'email', text }));
    expect(asNote).toStrictEqual(extractOffer({ channel: 'call', text }));
    // Not vacuous: the shared result must actually be a populated offer.
    if (!asNote.found) expect.fail('expected the neutral multi-field text to extract an offer');
    expect(asNote.offer.sale_price).toBe(2350000);
    expect(asNote.offer.apr).toBe(5.9);
    expect(asNote.offer.term_months).toBe(72);
    expect(asNote.offer.fees).toEqual([{ name: 'doc fee', amount: 89900 }]);
  });

  it('no channel gates which fields are extractable — every channel yields the full field set', () => {
    const text = 'Price $23,500, 5.9% APR, 72 months, $450/mo, doc fee $899.';
    for (const channel of ALL_CHANNELS) {
      const result = extractOffer({ channel, text });
      if (!result.found) expect.fail(`channel "${channel}" dropped the offer entirely`);
      expect(Object.keys(result.offer).sort()).toEqual([
        'apr',
        'fees',
        'flags',
        'monthly',
        'sale_price',
        'term_months',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. `note` is not the fallback (design §6 test 4 — the regression that was live)
// ---------------------------------------------------------------------------

describe('the note channel reaches its own profile, not the plain fallback', () => {
  /**
   * Each case is spoken-form text a buyer types after a call. Under `note` the
   * spoken profile resolves the number; under the plain-profile channels the
   * words stay words and nothing is extracted. If `note` ever regresses to the
   * plain/sms fallback, the two halves of each case collapse and this fails.
   */
  const SPOKEN_CASES: ReadonlyArray<{ text: string; expected: Record<string, unknown> }> = [
    {
      text: 'He said he can let it go for twenty nine grand out the door, today only.',
      expected: { fees: [], flags: [], sale_price: 2900000 },
    },
    {
      text: 'He thinks they can get me to four fifty a month on that trim.',
      expected: { fees: [], flags: [], monthly: 45000 },
    },
    {
      text: 'He quoted six point nine percent APR.',
      expected: { fees: [], flags: [], apr: 6.9 },
    },
  ];

  for (const { text, expected } of SPOKEN_CASES) {
    it(`parses under note but NOT under the plain-profile channels: ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(extractOffer({ channel: 'note', text })).toStrictEqual({
        found: true,
        offer: expected,
      });
      for (const channel of ['sms', 'call'] as const) {
        expect(
          extractOffer({ channel, text }),
          `channel "${channel}" must use the plain profile — if it parses the spoken form, note is back on the fallback path`,
        ).toStrictEqual({ found: false });
      }
    });
  }

  it('the note profile is spoken and it is the ONLY channel mapped to spoken (D2)', () => {
    expect(PROFILE_BY_CHANNEL.note).toBe('spoken');
    const spokenChannels = ALL_CHANNELS.filter((c) => PROFILE_BY_CHANNEL[c] === 'spoken');
    expect(spokenChannels).toEqual(['note']);
  });

  it('call maps to plain, not spoken — no call-text path is re-created in spirit (D2, AC-2)', () => {
    expect(PROFILE_BY_CHANNEL.call).toBe('plain');
    expect(PROFILE_BY_CHANNEL.call).toBe(PROFILE_BY_CHANNEL.sms);
  });

  it('a bare call record (no text) yields no offer and never throws — the v0.5 norm', () => {
    expect(extractOffer({ channel: 'call', text: '' })).toStrictEqual({ found: false });
    expect(extractOffer({ channel: 'call', text: undefined as never })).toStrictEqual({
      found: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Profile map exhaustiveness & normalization totality (D1, D3, §6 test 5)
// ---------------------------------------------------------------------------

describe('profile map is exhaustive and normalization is total (D1, D3)', () => {
  it('every spine MessageChannel has an entry — a new channel cannot silently fall back', () => {
    for (const channel of MESSAGE_CHANNELS) {
      expect(
        Object.hasOwn(PROFILE_BY_CHANNEL, channel),
        `spine channel "${channel}" has no normalization profile`,
      ).toBe(true);
      expect(['plain', 'email', 'spoken']).toContain(PROFILE_BY_CHANNEL[channel]);
    }
    expect(Object.keys(PROFILE_BY_CHANNEL).sort()).toEqual([...MESSAGE_CHANNELS].sort());
  });

  it('the profile map is a Record over MessageChannel at the type level (compile-time trip-wire)', () => {
    expectTypeOf(PROFILE_BY_CHANNEL).toEqualTypeOf<
      Readonly<Record<MessageChannel, NormalizationProfile>>
    >();
  });

  it('the map is frozen — no caller can re-point a channel at another profile', () => {
    expect(Object.isFrozen(PROFILE_BY_CHANNEL)).toBe(true);
    expect(() => {
      (PROFILE_BY_CHANNEL as Record<string, string>)['note'] = 'plain';
    }).toThrow(TypeError);
    expect(PROFILE_BY_CHANNEL.note).toBe('spoken');
  });

  it('an unrecognized channel degrades to the plain profile and NEVER to a fabricated channel (D3)', () => {
    const spoken = 'He said twenty nine grand out the door.';
    const digits = 'The price is $23,500 for this vehicle.';
    for (const bogus of ['fax', 'toString', '__proto__', 'constructor', 'SMS', '', 'note ']) {
      const result = extractOffer({ channel: bogus as never, text: spoken });
      // plain profile ⇒ the spoken form does not resolve; identical to `sms`.
      expect(result, `bogus channel ${JSON.stringify(bogus)} must use the plain profile`).toStrictEqual(
        extractOffer({ channel: 'sms', text: spoken }),
      );
      expect(result).toStrictEqual({ found: false });
      // ...and it still extracts normally from channel-neutral text (totality).
      expect(extractOffer({ channel: bogus as never, text: digits })).toStrictEqual({
        found: true,
        offer: { fees: [], flags: [], sale_price: 2350000 },
      });
    }
  });

  it('a missing / non-string channel is total and plain (hostile JS caller)', () => {
    const text = 'The price is $23,500 for this vehicle.';
    const expected = { found: true, offer: { fees: [], flags: [], sale_price: 2350000 } };
    for (const channel of [undefined, null, 42, {}, [], true]) {
      let result: ExtractionResult | undefined;
      expect(() => {
        result = extractOffer({ channel: channel as never, text });
      }).not.toThrow();
      expect(result).toStrictEqual(expected);
    }
  });

  it('normalizeText is total over every profile — any string in, a string out, never a throw', () => {
    const profiles: readonly NormalizationProfile[] = ['plain', 'email', 'spoken'];
    const inputs = ['', '   \n\t ', ' �[31m!!!', 'On Tue someone wrote:\n> $9,999', '9'.repeat(5000)];
    for (const profile of profiles) {
      for (const raw of inputs) {
        let out: string | undefined;
        expect(() => {
          out = normalizeText(raw, profile);
        }).not.toThrow();
        expect(typeof out).toBe('string');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. One entry point; no channel reaches the rule core (D1, AC-1)
// ---------------------------------------------------------------------------

describe('single channel-agnostic entry point (AC-1)', () => {
  it('the public API is exactly extractOffer — no per-channel or note-specific entry point', () => {
    expect(Object.keys(api).sort()).toEqual(['extractOffer']);
    const forbidden = /note|sms|email|call|transcri|channel/i;
    for (const name of Object.keys(api)) {
      expect(name, `"${name}" names a channel on the public surface`).not.toMatch(forbidden);
    }
  });

  it('ExtractionInput carries channel and text only — no deal, account, or provider context', () => {
    expectTypeOf<keyof ExtractionInput>().toEqualTypeOf<'channel' | 'text'>();
    expectTypeOf<ExtractionInput['channel']>().toEqualTypeOf<MessageChannel>();
    // A library with no account/deal input cannot leak across accounts or deals.
  });

  it('the normalization profile is NOT exported from the public surface (callers cannot pick one)', () => {
    expect(Object.keys(api)).not.toContain('normalizeText');
    expect(Object.keys(api)).not.toContain('PROFILE_BY_CHANNEL');
  });

  it('no rule module under src/rules accepts or references a channel value (D1)', () => {
    const rulesDir = join(PKG_ROOT, 'src', 'rules');
    for (const file of readdirSync(rulesDir)) {
      const text = readFileSync(join(rulesDir, file), 'utf8');
      expect(text, `${file} must not branch on a channel`).not.toMatch(
        /\bMessageChannel\b|['"](?:sms|note|email|call)['"]\s*(?:===|!==|:)/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Transcript- and recording-free surface (AC-2, §6 test 6)
// ---------------------------------------------------------------------------

/** Assembled from fragments so this file's own scan cannot self-trip. */
const BANNED_TOKENS: readonly string[] = [
  'transcr' + 'ipt',
  'record' + 'ing',
  'recording' + '_url',
  'transcri' + 'be',
  'transcri' + 'ption',
  'A' + 'SR',
  'speech-to-' + 'text',
  'whis' + 'per',
  'deep' + 'gram',
  'assembly' + 'ai',
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

describe('no transcript / recording / transcription path exists (AC-2, Q14)', () => {
  it('no source, fixture, or config file in the package mentions any of them', () => {
    const files = walk(PKG_ROOT).filter(
      (f) => /\.(ts|json|md)$/.test(f) && !f.endsWith('channel-agnostic.test.ts'),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const token of BANNED_TOKENS) {
        expect(text, `${file} must not reference "${token}"`).not.toContain(token.toLowerCase());
      }
    }
  });

  it('no fixture is filed under a transcript-shaped group; the ex-call corpus is `notes/` (AC-3)', () => {
    const groups = readdirSync(join(PKG_ROOT, 'test', 'fixtures'));
    expect(groups.sort()).toEqual(['email', 'hostile', 'notes', 'sms']);
    for (const group of groups) {
      for (const file of readdirSync(join(PKG_ROOT, 'test', 'fixtures', group))) {
        for (const token of BANNED_TOKENS) {
          expect(file.toLowerCase()).not.toContain(token.toLowerCase());
        }
      }
    }
  });

  it('every notes/ fixture declares the `note` channel and keeps a non-digit number form (AC-3)', () => {
    const dir = join(PKG_ROOT, 'test', 'fixtures', 'notes');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(5); // the five re-based ex-call cases — a drop here is lost coverage
    const spokenForm =
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|point|percent)\b/i;
    let extractingFixtures = 0;
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        channel: string;
        text: string;
        expected: { found: boolean };
      };
      expect(raw.channel, `${file} must be a note fixture`).toBe('note');
      // The spelled-out / grand / point / percent forms ARE the coverage the
      // rebase had to preserve (design §1.5 binding note): a rewrite that
      // quietly turned "twenty nine grand" into "$29,000" would still pass the
      // corpus while deleting the regression the fixture exists for.
      if (raw.expected.found) {
        extractingFixtures += 1;
        expect(
          spokenForm.test(raw.text),
          `${file} extracts an offer but carries no non-digit number form — the rebase dropped its coverage`,
        ).toBe(true);
      }
    }
    expect(extractingFixtures).toBe(3); // the three ex-call cases that parse

  });
});

// ---------------------------------------------------------------------------
// 6. ADR-005 — absent stays absent, and this package never evaluates a flag
// ---------------------------------------------------------------------------

describe('ADR-005 — a missing input is absent, never zero, never "not triggered"', () => {
  it('a partial offer omits the fields it could not extract, in every channel', () => {
    for (const channel of ALL_CHANNELS) {
      const result = extractOffer({ channel, text: 'We can look at 72 months if that helps.' });
      if (!result.found) expect.fail(`channel "${channel}" lost the term-only partial offer`);
      expect(result.offer).toStrictEqual({ fees: [], flags: [], term_months: 72 });
      expect('sale_price' in result.offer).toBe(false);
      expect('apr' in result.offer).toBe(false);
      expect('monthly' in result.offer).toBe(false);
    }
  });

  it('never emits sale_price: 0 or an undefined-valued field for an unstated price', () => {
    const texts = [
      'We can get you to $450/mo.',
      'We could structure it at 5.9% APR.',
      'Doc fee $899 applies.',
    ];
    for (const channel of ALL_CHANNELS) {
      for (const text of texts) {
        const result = extractOffer({ channel, text });
        if (!result.found) continue;
        expect(result.offer.sale_price, `${channel}: ${text}`).toBeUndefined();
        expect(Object.hasOwn(result.offer, 'sale_price')).toBe(false);
        expect(JSON.stringify(result.offer)).not.toContain('"sale_price":0');
      }
    }
  });

  it('flags is always the empty array — the flag engine alone owns the unevaluable distinction', () => {
    const texts = [
      'Price $45,000, way over book value, 24% APR for 96 months.',
      'We can do $23,500 out the door.',
      'He said twenty nine grand out the door.',
    ];
    for (const channel of ALL_CHANNELS) {
      for (const text of texts) {
        const result = extractOffer({ channel, text });
        if (result.found) expect(result.offer.flags).toEqual([]);
      }
    }
  });
});
