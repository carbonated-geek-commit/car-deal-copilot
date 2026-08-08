/**
 * T-007 tester — fixture-corpus runner (docs/design/T-007.md §6, AC-5).
 *
 * The corpus is DATA: one JSON file per case under test/fixtures/<group>/,
 * compared by deep equality against the full ExtractionResult. Absent fields
 * must be ABSENT (not undefined-valued) — asserting omission is how the D5
 * precision gate is enforced, not just presence. Growing coverage means
 * adding a JSON file, never new test code (design D7).
 *
 * Fully offline: no network, no timers, no filesystem beyond loading the
 * checked-in synthetic fixtures. Run from root:
 *   npx vitest run packages/offer-extraction
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_CHANNELS } from '@core';
import { extractOffer } from '@offer-extraction';
import type { ExtractionInput, ExtractionResult } from '@offer-extraction';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Fixture groups (T-012 §1.5); hostile inputs prove totality (D4).
 * `notes` is the re-based ex-call corpus: the buyer typing what the dealer
 * said, keeping every original `expected` block (AC-3).
 */
const GROUPS = ['notes', 'sms', 'email', 'hostile'] as const;

/**
 * The channel vocabulary is the spine's (T-012 D13) — a locally-declared Set
 * is a parallel enum (ADR-001 in a different syntax), and it is why a `note`
 * fixture would have been rejected by this harness rather than run.
 */
const CHANNELS: ReadonlySet<string> = new Set<string>(MESSAGE_CHANNELS);

interface Fixture {
  readonly file: string;
  readonly name: string;
  readonly channel: ExtractionInput['channel'];
  readonly text: string;
  readonly expected: ExtractionResult;
}

/** Load + shape-validate every fixture in a group; a malformed fixture fails loudly. */
function loadGroup(group: string): Fixture[] {
  const dir = join(FIXTURE_ROOT, group);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`${group}/${file}: fixture must be a JSON object`);
    }
    const rec = raw as Record<string, unknown>;
    const name = rec['name'];
    const channel = rec['channel'];
    const text = rec['text'];
    const expected = rec['expected'];
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${group}/${file}: missing "name"`);
    }
    if (typeof channel !== 'string' || !CHANNELS.has(channel)) {
      throw new Error(`${group}/${file}: "channel" must be a @core MessageChannel (AC-1)`);
    }
    if (typeof text !== 'string') {
      throw new Error(`${group}/${file}: "text" must be a string`);
    }
    if (
      expected === null ||
      typeof expected !== 'object' ||
      typeof (expected as Record<string, unknown>)['found'] !== 'boolean'
    ) {
      throw new Error(`${group}/${file}: "expected" must be a full ExtractionResult`);
    }
    return {
      file,
      name,
      channel: channel as ExtractionInput['channel'],
      text,
      expected: expected as ExtractionResult,
    };
  });
}

const corpus = GROUPS.map((group) => ({ group, fixtures: loadGroup(group) }));

describe('offer-extraction fixture corpus (design §6, AC-1/AC-4/AC-5)', () => {
  it('every group is populated (minimum corpus coverage)', () => {
    for (const { group, fixtures } of corpus) {
      expect(fixtures.length, `fixture group "${group}" must not be empty`).toBeGreaterThan(0);
    }
  });

  it('corpus exercises both terminal outcomes (found and not-found — D2)', () => {
    const all = corpus.flatMap((g) => g.fixtures);
    expect(all.some((f) => f.expected.found)).toBe(true);
    expect(all.some((f) => !f.expected.found)).toBe(true);
  });

  for (const { group, fixtures } of corpus) {
    describe(group, () => {
      for (const f of fixtures) {
        it(`${f.name} (${f.file})`, () => {
          const input: ExtractionInput = { channel: f.channel, text: f.text };

          // Full-result deep equality: absent fields must be absent (D5).
          const first = extractOffer(input);
          expect(first).toStrictEqual(f.expected);

          // Determinism-as-idempotency (§4.3): re-running is byte-identical...
          const second = extractOffer(input);
          expect(second).toStrictEqual(first);

          // ...but every result is a FRESH object (§4.3 non-mutating — the
          // receipt trail's append-only posture starts with nobody holding
          // mutable references into message-derived data).
          expect(second).not.toBe(first);
          if (first.found && second.found) {
            expect(second.offer).not.toBe(first.offer);
            expect(second.offer.fees).not.toBe(first.offer.fees);
            expect(second.offer.flags).not.toBe(first.offer.flags);
            // D3: the extractor never emits flags — flag vocabulary is T-002's.
            expect(first.offer.flags).toEqual([]);
          }
        });
      }
    });
  }
});
