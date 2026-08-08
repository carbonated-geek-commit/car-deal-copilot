/**
 * T-018 tester — content policy (design §3.4, D7, D11).
 *
 * specs/00 "Core domain model" (**Store**): the object store holds "email
 * attachments, uploaded documents, and generated dossiers. **No audio is
 * stored.**" This file tests the label-based half of that gate plus the size
 * cap and the metadata sanitizer; `no-audio.test.ts` tests the AC-3 guarantee
 * end to end.
 *
 * Never skipped (design §1.2): the policy is ours, not a remote service's.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactKind } from '../src/contract.js';
import { ARTIFACT_KINDS } from '../src/contract.js';
import {
  ALLOWED_CONTENT_TYPES,
  checkContentPolicy,
  DEFAULT_MAX_BYTES,
  deniedSignatureLabel,
  isAllowedForKind,
  isDeniedMediaType,
  matchesDeclaredType,
  MAX_METADATA_VALUE_CHARS,
  normalizeContentType,
  sanitizeMetadataValue,
} from '../src/content-policy.js';
import {
  bytesFrom,
  CSV_BYTES,
  JPEG_BYTES,
  PDF_BYTES,
  PNG_BYTES,
  TEXT_BYTES,
  TEXT_WITH_NUL,
  WEBP_BYTES,
} from './helpers.js';

const SOURCE = 'test-store';

function check(kind: ArtifactKind, content_type: string, bytes: Uint8Array, max_bytes = DEFAULT_MAX_BYTES) {
  return checkContentPolicy({ kind, content_type, bytes, max_bytes, source: SOURCE });
}

describe('the allowlist is a literal, per artifact kind', () => {
  it('covers exactly the three artifact kinds and no other', () => {
    expect(Object.keys(ALLOWED_CONTENT_TYPES).sort()).toEqual([...ARTIFACT_KINDS].sort());
  });

  it('admits only PDF for a dossier — specs/00 says the dossier is a PDF', () => {
    expect(ALLOWED_CONTENT_TYPES.dossier).toEqual(['application/pdf']);
  });

  it('admits documents and email attachments from the same closed list', () => {
    const expected = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv'];
    expect([...ALLOWED_CONTENT_TYPES.email_attachment]).toEqual(expected);
    expect([...ALLOWED_CONTENT_TYPES.document]).toEqual(expected);
  });

  it('contains no audio or video type anywhere, on any list', () => {
    for (const kind of ARTIFACT_KINDS) {
      for (const type of ALLOWED_CONTENT_TYPES[kind]) {
        expect(type.startsWith('audio/')).toBe(false);
        expect(type.startsWith('video/')).toBe(false);
      }
    }
  });

  it('rejects a type that is allowed for another kind but not this one', () => {
    const error = check('dossier', 'text/plain', TEXT_BYTES);
    expect(error?.code).toBe('invalid_input');
    // D11: the refusal NAMES the offending type so the caller can record that
    // an artifact arrived and was refused rather than silently dropping it.
    expect(error?.message).toContain('text/plain');
    expect(error?.message).toContain('dossier');
  });
});

describe('content-type normalization', () => {
  it('lowercases, trims, and strips parameters before every decision', () => {
    expect(normalizeContentType('APPLICATION/PDF')).toBe('application/pdf');
    expect(normalizeContentType('  text/plain ; charset=utf-8 ')).toBe('text/plain');
    expect(normalizeContentType('Text/CSV;charset=UTF-8')).toBe('text/csv');
  });

  it('normalizes on the allow path and on the deny path alike', () => {
    expect(isAllowedForKind('document', 'TEXT/PLAIN; charset=utf-8')).toBe(true);
    // A denied type cannot be smuggled past the gate by casing or a parameter.
    expect(isDeniedMediaType('AUDIO/MPEG')).toBe(true);
    expect(isDeniedMediaType('audio/wav; codecs=1')).toBe(true);
    expect(isDeniedMediaType(' Video/MP4 ')).toBe(true);
    expect(isDeniedMediaType('application/pdf')).toBe(false);
  });

  it('does not treat a merely audio-ish name as audio (no false positive)', () => {
    expect(isDeniedMediaType('application/audio-notes+json')).toBe(false);
    expect(isDeniedMediaType('text/plain')).toBe(false);
  });
});

describe('allowed content passes every gate', () => {
  const CASES: readonly (readonly [ArtifactKind, string, Uint8Array])[] = [
    ['dossier', 'application/pdf', PDF_BYTES],
    ['document', 'application/pdf', PDF_BYTES],
    ['document', 'image/png', PNG_BYTES],
    ['document', 'image/jpeg', JPEG_BYTES],
    ['document', 'image/webp', WEBP_BYTES],
    ['document', 'text/plain', TEXT_BYTES],
    ['document', 'text/csv', CSV_BYTES],
    ['email_attachment', 'application/pdf', PDF_BYTES],
    ['email_attachment', 'image/webp', WEBP_BYTES],
    ['email_attachment', 'text/csv', CSV_BYTES],
  ];

  it.each(CASES)('accepts %s / %s with matching bytes', (kind, type, bytes) => {
    expect(check(kind, type, bytes)).toBeUndefined();
  });
});

describe('the RIFF trap — WebP and WAVE are both RIFF containers (§3.4)', () => {
  it('accepts a genuine WebP image', () => {
    expect(deniedSignatureLabel(WEBP_BYTES)).toBeUndefined();
    expect(check('document', 'image/webp', WEBP_BYTES)).toBeUndefined();
  });

  it('denies RIFF/WAVE audio even when it is declared as image/webp', () => {
    const wave = bytesFrom('RIFF', [0x24, 0x00, 0x00, 0x00], 'WAVE', 'fmt ');
    expect(deniedSignatureLabel(wave)).toBe('RIFF/WAVE audio');
    const error = check('document', 'image/webp', wave);
    expect(error?.code).toBe('invalid_input');
    expect(error?.message).toContain('rejected media signature');
  });

  it('rejects a RIFF container that is neither WEBP nor WAVE as a type mismatch', () => {
    const riffOther = bytesFrom('RIFF', [0x24, 0x00, 0x00, 0x00], 'AVI ', 'LIST');
    expect(matchesDeclaredType('image/webp', riffOther)).toBe(false);
    expect(check('document', 'image/webp', riffOther)?.message).toContain('does not match declared type');
  });
});

describe('declared type must match the bytes — a wrong label is a rejection, never a quiet fix', () => {
  it.each([
    ['application/pdf', PNG_BYTES],
    ['image/png', PDF_BYTES],
    ['image/jpeg', PNG_BYTES],
    ['image/webp', PDF_BYTES],
  ])('rejects %s carrying the wrong bytes', (type, bytes) => {
    const error = check('document', type, bytes);
    expect(error?.code).toBe('invalid_input');
    expect(error?.message).toContain('does not match declared type');
  });

  it('rejects text/plain and text/csv that contain a NUL byte', () => {
    expect(matchesDeclaredType('text/plain', TEXT_WITH_NUL)).toBe(false);
    expect(check('document', 'text/plain', TEXT_WITH_NUL)?.message).toContain('does not match declared type');
    expect(check('document', 'text/csv', TEXT_WITH_NUL)?.message).toContain('does not match declared type');
  });

  it('only scans the first 512 bytes for NUL, as documented', () => {
    const late = bytesFrom('x'.repeat(600), [0x00]);
    expect(matchesDeclaredType('text/plain', late)).toBe(true);
  });

  it('rejects empty bytes for a type that requires a signature', () => {
    expect(check('dossier', 'application/pdf', bytesFrom())?.message).toContain('does not match declared type');
  });
});

describe('size cap (§3.4) — the memory bound that makes single-PUT buffering safe', () => {
  it('defaults to 25 MiB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  it('accepts bytes exactly at the cap and rejects one byte over it', () => {
    const cap = 16;
    const atCap = bytesFrom('%PDF-', 'x'.repeat(cap - 5));
    expect(atCap.byteLength).toBe(cap);
    expect(check('dossier', 'application/pdf', atCap, cap)).toBeUndefined();

    const overCap = bytesFrom('%PDF-', 'x'.repeat(cap - 4));
    const error = check('dossier', 'application/pdf', overCap, cap);
    expect(error?.code).toBe('invalid_input');
    expect(error?.message).toContain(`${cap}-byte cap`);
  });
});

describe('the ordered gate (§4.3 steps 2–6)', () => {
  it('reports the audio/video denial before the allowlist message', () => {
    // Step 2 runs before step 3, so an audio type is refused as AUDIO rather
    // than as a generic allowlist miss — the intent stays legible in the log.
    const error = check('dossier', 'audio/mpeg', PDF_BYTES);
    expect(error?.message).toContain('audio and video are never stored');
    expect(error?.message).not.toContain('is not allowed for kind');
  });

  it('reports the allowlist miss before the size cap', () => {
    const error = check('dossier', 'text/plain', bytesFrom('x'.repeat(64)), 4);
    expect(error?.message).toContain('is not allowed for kind');
  });

  it('reports the media-signature denial before the declared-type mismatch', () => {
    // An MP3 announced as a PDF is refused as MEDIA, not as a mismatch: the
    // deny gate is what makes AC-3 hold against a MISLABELED upload.
    const error = check('dossier', 'application/pdf', bytesFrom('ID3', [0x03, 0x00, 0x00, 0x00]));
    expect(error?.message).toContain('rejected media signature');
  });

  it('marks every policy rejection not-retryable — retrying a refused upload cannot help', () => {
    const error = check('dossier', 'audio/mpeg', PDF_BYTES);
    expect(error?.retryable).toBe(false);
    expect(error?.source).toBe(SOURCE);
  });
});

describe('metadata sanitization (§3.3) — no user-supplied header passes through', () => {
  it('strips control characters, so a filename cannot split a response', () => {
    expect(sanitizeMetadataValue('invoice\r\nX-Injected: 1.pdf')).toBe('invoiceX-Injected: 1.pdf');
    expect(sanitizeMetadataValue('a\tb')).toBe('ab');
  });

  it('strips non-ASCII rather than emitting a raw header value', () => {
    expect(sanitizeMetadataValue('facturé-2026.pdf')).toBe('factur-2026.pdf');
    expect(sanitizeMetadataValue('価格.pdf')).toBe('.pdf');
  });

  it('caps the value length', () => {
    const long = 'a'.repeat(MAX_METADATA_VALUE_CHARS + 50);
    expect(sanitizeMetadataValue(long)).toHaveLength(MAX_METADATA_VALUE_CHARS);
  });

  it('returns undefined when nothing survives, so the field is OMITTED not empty', () => {
    // ADR-005 discipline: an absent value is absent, never a plausible-looking
    // empty string standing in for one.
    expect(sanitizeMetadataValue('')).toBeUndefined();
    expect(sanitizeMetadataValue('\r\n\t')).toBeUndefined();
    expect(sanitizeMetadataValue('   ')).toBeUndefined();
    expect(sanitizeMetadataValue('日本語')).toBeUndefined();
  });
});
