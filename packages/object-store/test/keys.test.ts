/**
 * T-018 tester — key construction and content addressing (design §3.1, D3, D4).
 *
 * The key convention is where three separate guarantees are made structural, so
 * it is tested first and hardest:
 *
 *   AC-4  the account is the FIRST segment group, so `acct/{account_id}/` is a
 *         valid list prefix and the isolation is enforced by the request rather
 *         than by post-filtering (specs/01 "Account model": "`Account` owns
 *         `Deals`"; specs/00 "Dealership data tenancy").
 *   AC-7  the final segment IS the content hash, so different bytes ⇒ a
 *         different key and an in-place overwrite is UNREPRESENTABLE
 *         (specs/00 "Receipt layer": append-only).
 *   D3    `ops/raw-payload/…` is a separate key space owned by no account, and
 *         an account-scoped reader cannot even construct the key.
 *
 * Never skipped: these are properties of our own rules, not of a remote service.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactKind } from '../src/contract.js';
import {
  ACCOUNT_PREFIX,
  accountPrefix,
  buildArtifactRef,
  ID_PATTERN,
  isArtifactKind,
  isRefOwnedBy,
  isValidId,
  parseArtifactRef,
  RAW_PAYLOAD_PREFIX,
  rawPayloadKey,
  refPrefix,
  sha256Base64,
  sha256Hex,
  sha256HexOfUtf8,
  utf8Bytes,
} from '../src/keys.js';
import { bytesFrom, expectErr, expectOk, SHA256_OF_ABC, SHA256_OF_EMPTY } from './helpers.js';

const HASH = SHA256_OF_ABC;

describe('sha256 content addressing (D4)', () => {
  it('matches the published sha-256 vectors, so a ref is stable across runtimes', () => {
    expect(sha256Hex(bytesFrom())).toBe(SHA256_OF_EMPTY);
    expect(sha256Hex(bytesFrom('abc'))).toBe(SHA256_OF_ABC);
    expect(sha256HexOfUtf8('abc')).toBe(SHA256_OF_ABC);
  });

  it('is lowercase hex of exactly 64 characters', () => {
    const digest = sha256Hex(bytesFrom('anything'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits the same digest in base64 for the server-side ChecksumSHA256 header', () => {
    expect(sha256Base64(bytesFrom())).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  it('changes for a single flipped byte — the property AC-7 rests on', () => {
    expect(sha256Hex(bytesFrom('offer: 28995'))).not.toBe(sha256Hex(bytesFrom('offer: 28996')));
  });

  it('round-trips utf8 bytes through the encoder used for raw payloads', () => {
    expect(sha256Hex(utf8Bytes('abc'))).toBe(SHA256_OF_ABC);
  });
});

describe('buildArtifactRef', () => {
  it('builds the documented shape: acct/{account}/{deal}/{kind}/{sha256}', () => {
    const ref = expectOk(
      buildArtifactRef({ account_id: 'acct_1', deal_id: 'deal_1', kind: 'dossier', content_sha256: HASH }),
    );
    expect(ref).toBe(`acct/acct_1/deal_1/dossier/${HASH}`);
    expect(ref.split('/')).toHaveLength(5);
  });

  it('builds a ref for every artifact kind and for no other segment value', () => {
    for (const kind of ['email_attachment', 'document', 'dossier'] as const) {
      const ref = expectOk(buildArtifactRef({ account_id: 'a', deal_id: 'd', kind, content_sha256: HASH }));
      expect(ref).toBe(`acct/a/d/${kind}/${HASH}`);
    }
  });

  // The path-traversal guard. Without it an account_id of `../other` escapes
  // its own prefix and defeats the entire tenancy design (§3.1 rule 1).
  const BAD_IDS = [
    ['empty', ''],
    ['parent traversal', '../other'],
    ['embedded slash', 'acct/other'],
    ['dot segment', 'a.b'],
    ['percent escape', 'a%2Fother'],
    ['whitespace', 'a b'],
    ['leading space', ' a'],
    ['too long', 'a'.repeat(65)],
    ['backslash', 'a\\b'],
    ['newline', 'a\nb'],
    ['null byte', 'a\u0000b'],
  ] as const;

  it.each(BAD_IDS)('rejects an account_id (%s) before any key is built', (_label, value) => {
    const error = expectErr(
      buildArtifactRef({ account_id: value, deal_id: 'd', kind: 'document', content_sha256: HASH }),
      'invalid_input',
    );
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('account_id');
  });

  it.each(BAD_IDS)('rejects a deal_id (%s) before any key is built', (_label, value) => {
    const error = expectErr(
      buildArtifactRef({ account_id: 'a', deal_id: value, kind: 'document', content_sha256: HASH }),
      'invalid_input',
    );
    expect(error.message).toContain('deal_id');
  });

  it('accepts exactly the documented id alphabet and length bound', () => {
    expect(isValidId('a')).toBe(true);
    expect(isValidId('A-Z_az09')).toBe(true);
    expect(isValidId('a'.repeat(64))).toBe(true);
    expect(isValidId('a'.repeat(65))).toBe(false);
    expect(ID_PATTERN.source).toBe('^[A-Za-z0-9_-]{1,64}$');
  });

  it('rejects a kind that is not one of the three artifact classes', () => {
    const error = expectErr(
      buildArtifactRef({
        account_id: 'a',
        deal_id: 'd',
        // An untyped caller (HTTP JSON at the T-019 edge) can hand us anything.
        kind: 'recording' as ArtifactKind,
        content_sha256: HASH,
      }),
      'invalid_input',
    );
    expect(error.message).toContain('kind');
  });

  it.each([
    ['uppercase hex', HASH.toUpperCase()],
    ['too short', HASH.slice(0, 63)],
    ['too long', `${HASH}0`],
    ['non-hex', `${HASH.slice(0, 63)}z`],
    ['empty', ''],
  ])('rejects a content_sha256 that is %s', (_label, value) => {
    const error = expectErr(
      buildArtifactRef({ account_id: 'a', deal_id: 'd', kind: 'document', content_sha256: value }),
      'invalid_input',
    );
    expect(error.message).toContain('content_sha256');
  });
});

describe('parseArtifactRef', () => {
  it('round-trips every field of a well-formed ref', () => {
    const location = { account_id: 'acct_1', deal_id: 'deal_9', kind: 'email_attachment' as const, content_sha256: HASH };
    const ref = expectOk(buildArtifactRef(location));
    expect(parseArtifactRef(ref)).toEqual(location);
  });

  it.each([
    ['a bare hash', HASH],
    ['too few segments', `acct/a/d/${HASH}`],
    ['too many segments', `acct/a/d/document/${HASH}/extra`],
    ['the wrong top-level prefix', `other/a/d/document/${HASH}`],
    ['an unknown kind', `acct/a/d/recording/${HASH}`],
    ['a traversal account segment', `acct/../d/document/${HASH}`],
    ['an uppercase hash', `acct/a/d/document/${HASH.toUpperCase()}`],
    ['an empty account segment', `acct//d/document/${HASH}`],
    ['an empty string', ''],
  ])('returns undefined for %s', (_label, ref) => {
    expect(parseArtifactRef(ref)).toBeUndefined();
  });

  it('refuses to parse an operator-space raw-payload key (D3)', () => {
    // The two key spaces are disjoint by construction, so the account-scoped
    // reader cannot even NAME a quarantined provider payload.
    const key = rawPayloadKey(HASH);
    expect(key).toBe(`${RAW_PAYLOAD_PREFIX}/${HASH}`);
    expect(key.startsWith(`${ACCOUNT_PREFIX}/`)).toBe(false);
    expect(parseArtifactRef(key)).toBeUndefined();
  });
});

describe('isRefOwnedBy — the local tenancy predicate (AC-4)', () => {
  const ownRef = `acct/acme/deal_1/document/${HASH}`;

  it('accepts a ref whose account segment is the requesting account', () => {
    expect(isRefOwnedBy('acme', ownRef)).toBe(true);
  });

  it('rejects another account, including a prefix-neighbour name', () => {
    expect(isRefOwnedBy('other', ownRef)).toBe(false);
    // `acme` must not be able to read `acmex`'s object and vice versa.
    expect(isRefOwnedBy('acme', `acct/acmex/deal_1/document/${HASH}`)).toBe(false);
    expect(isRefOwnedBy('acmex', ownRef)).toBe(false);
  });

  it('rejects an unparseable ref rather than defaulting to owned', () => {
    expect(isRefOwnedBy('acme', 'acct/acme/deal_1/document/not-a-hash')).toBe(false);
    expect(isRefOwnedBy('acme', rawPayloadKey(HASH))).toBe(false);
    expect(isRefOwnedBy('acme', '')).toBe(false);
  });
});

describe('accountPrefix — prefix confinement (§3.1 rule 4)', () => {
  it('ends with a slash so one account name cannot prefix-match another', () => {
    expect(accountPrefix('acme')).toBe('acct/acme/');
    expect(`acct/acmex/deal/document/${HASH}`.startsWith(accountPrefix('acme'))).toBe(false);
    expect(`acct/acme/deal/document/${HASH}`.startsWith(accountPrefix('acme'))).toBe(true);
  });

  it('places the account first, so a deal prefix is nested inside it', () => {
    const prefix = `${accountPrefix('acme')}deal_1/`;
    expect(`acct/acme/deal_1/document/${HASH}`.startsWith(prefix)).toBe(true);
    expect(`acct/acme/deal_2/document/${HASH}`.startsWith(prefix)).toBe(false);
  });
});

describe('refPrefix — a log line is not a capability (§4.8)', () => {
  it('yields the first 12 hex characters of the hash and never the full ref', () => {
    const ref = `acct/acme/deal_1/document/${HASH}`;
    expect(refPrefix(ref)).toBe(HASH.slice(0, 12));
    expect(refPrefix(ref)).toHaveLength(12);
    expect(ref.includes(refPrefix(ref))).toBe(true);
    expect(refPrefix(ref)).not.toContain('acme');
    expect(refPrefix(ref)).not.toBe(ref);
  });
});

describe('isArtifactKind', () => {
  it('accepts exactly the three artifact classes and nothing audio-shaped', () => {
    expect(isArtifactKind('email_attachment')).toBe(true);
    expect(isArtifactKind('document')).toBe(true);
    expect(isArtifactKind('dossier')).toBe(true);
    for (const notAKind of ['recording', 'audio', 'call', 'transcript', 'voicemail', '']) {
      expect(isArtifactKind(notAKind)).toBe(false);
    }
  });
});
