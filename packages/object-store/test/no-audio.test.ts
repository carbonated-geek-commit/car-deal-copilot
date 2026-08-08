/**
 * T-018 tester — AC-3: THERE IS NO AUDIO PATH.
 *
 * Stated as its own file so a reviewer finds it by name (design §1.2).
 *
 * specs/00 "Core domain model" (**Store**): "No audio is stored."
 * specs/01 "Consent & recording posture": "no audio is ever captured or
 * stored."
 *
 * Four layers, three of them structural (design §5.1):
 *   (a) `ArtifactKind` is a three-literal union with no audio member, so
 *       `put({ kind: 'recording', … })` does not COMPILE.
 *   (b) a declared `audio/*` or `video/*` type is denied before the allowlist.
 *   (c) neither allowlist contains an audio or video type, and both are literals.
 *   (d) a magic-byte deny list catches a MISLABELED upload — the only way the
 *       label-based gates could actually fail.
 *
 * NEVER SKIPPED, under any environment: this is a property of our own rules.
 * No test in this file, and no fixture it uses, contains a recording — the
 * "audio" fixtures are the leading magic bytes of each container format, which
 * is all the deny gate ever reads.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactKind, ObjectStore } from '../src/contract.js';
import { ARTIFACT_KINDS } from '../src/contract.js';
import { ALLOWED_CONTENT_TYPES, DENIED_SIGNATURES } from '../src/content-policy.js';
import { createInMemoryObjectStore } from '../src/artifact-store.js';
import * as barrel from '../src/index.js';
import { DENIED_MEDIA_FIXTURES, expectErr, PDF_BYTES, TEXT_BYTES } from './helpers.js';

const ACCOUNT = 'acct_no_audio';
const DEAL = 'deal_1';

function store(): ObjectStore & { readonly size: () => number } {
  return createInMemoryObjectStore();
}

describe('(a) the kind union has no audio member', () => {
  it('is exactly the three classes specs/00 assigns to the object store', () => {
    expect([...ARTIFACT_KINDS]).toEqual(['email_attachment', 'document', 'dossier']);
  });

  it('contains no member whose name suggests a recording', () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(kind).not.toMatch(/audio|record|transcri|speech|voice|call/i);
    }
  });
});

describe('(b)+(c) a declared audio or video type is refused for every kind', () => {
  const AUDIO_TYPES = [
    'audio/mpeg',
    'audio/mp4',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/webm',
    'audio/flac',
    'audio/3gpp',
    'audio/amr',
    'video/mp4',
    'video/webm',
    'video/quicktime',
  ] as const;

  for (const kind of ARTIFACT_KINDS) {
    it.each(AUDIO_TYPES)(`refuses ${kind} declared as %s`, async (content_type) => {
      const s = store();
      const result = await s.put({ account_id: ACCOUNT, deal_id: DEAL, kind, content_type, bytes: PDF_BYTES });
      const error = expectErr(result, 'invalid_input');
      // A surfaced, recorded refusal naming the offending type (D11) — never a
      // silent drop, so the receipt trail can show the gap.
      expect(error.message).toContain('audio and video are never stored');
      expect(error.message).toContain(content_type);
      expect(error.retryable).toBe(false);
      // Nothing was stored, and nothing reached a backend.
      expect(s.size()).toBe(0);
    });
  }
});

describe('(d) a MISLABELED media upload is refused by its magic bytes', () => {
  it('covers every signature on the deny list', () => {
    // If a signature is added to the implementation, this fails until a fixture
    // exercising it is added here — the deny list cannot grow untested.
    const implemented = DENIED_SIGNATURES.map((s) => s.label).sort();
    const covered = [...new Set(DENIED_MEDIA_FIXTURES.map((f) => f.label))]
      .map((label) => (label === 'MPEG audio frame sync (0xFFE_)' ? 'MPEG audio frame sync' : label))
      .sort();
    expect([...new Set(covered)]).toEqual(implemented);
  });

  it.each(DENIED_MEDIA_FIXTURES.map((f) => [f.label, f.bytes] as const))(
    'refuses %s bytes announced as application/pdf',
    async (_label, bytes) => {
      const s = store();
      const result = await s.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'dossier',
        content_type: 'application/pdf',
        bytes,
      });
      const error = expectErr(result, 'invalid_input');
      expect(error.message).toContain('rejected media signature');
      expect(s.size()).toBe(0);
    },
  );

  it.each(DENIED_MEDIA_FIXTURES.map((f) => [f.label, f.bytes] as const))(
    'refuses %s bytes announced as text/plain on an email attachment',
    async (_label, bytes) => {
      const s = store();
      const result = await s.put({
        account_id: ACCOUNT,
        deal_id: DEAL,
        kind: 'email_attachment',
        content_type: 'text/plain',
        bytes,
      });
      expectErr(result, 'invalid_input');
      expect(s.size()).toBe(0);
    },
  );
});

describe('an unknown kind is refused as a value, never thrown across the boundary', () => {
  // AC-1/ADR-001: adapters never throw across the boundary — every failure is
  // an `AdapterResult` value. The T-019 HTTP edge parses JSON, so an untyped
  // caller can hand `put` any string in `kind`; `buildArtifactRef` already
  // knows how to refuse one ("kind is not an artifact kind"), so the refusal
  // must be reachable rather than pre-empted by a crash.
  it('returns invalid_input for kind "recording" rather than rejecting the promise', async () => {
    const s = store();
    const put = s.put({
      account_id: ACCOUNT,
      deal_id: DEAL,
      kind: 'recording' as ArtifactKind,
      content_type: 'application/pdf',
      bytes: PDF_BYTES,
    });
    await expect(put).resolves.toBeDefined();
    expectErr(await put, 'invalid_input');
    expect(s.size()).toBe(0);
  });

  it('returns invalid_input for an empty kind rather than rejecting the promise', async () => {
    const s = store();
    const put = s.put({
      account_id: ACCOUNT,
      deal_id: DEAL,
      kind: '' as ArtifactKind,
      content_type: 'text/plain',
      bytes: TEXT_BYTES,
    });
    await expect(put).resolves.toBeDefined();
    expectErr(await put, 'invalid_input');
  });
});

describe('the public surface offers nothing through which a recording could enter', () => {
  it('exposes no export whose name is audio-shaped', () => {
    for (const name of Object.keys(barrel)) {
      expect(name).not.toMatch(/audio|record|transcri|speech|voice|dictat|whisper/i);
    }
  });

  it('exposes no store method whose name is audio-shaped', () => {
    for (const name of Object.keys(store())) {
      expect(name).not.toMatch(/audio|record|transcri|speech|voice/i);
    }
  });

  it('publishes an allowlist a caller can pre-check against, and it has no media entry', () => {
    expect(barrel.ALLOWED_CONTENT_TYPES).toBe(ALLOWED_CONTENT_TYPES);
    const everyType = ARTIFACT_KINDS.flatMap((kind) => [...ALLOWED_CONTENT_TYPES[kind]]);
    expect(everyType.some((t) => t.startsWith('audio/') || t.startsWith('video/'))).toBe(false);
  });
});
