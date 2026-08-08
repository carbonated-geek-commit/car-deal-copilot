/**
 * Content policy — the AC-3 gate (docs/design/T-018.md §3.4, D7).
 *
 * specs/00 "Core domain model" (**Store**): "No audio is stored." specs/01
 * "Consent & recording posture": "no audio is ever captured or stored."
 *
 * Four layers protect that, three of them structural:
 *
 *   (a) `ArtifactKind` is a three-literal union with no audio member, so
 *       `put({ kind: 'recording', … })` does not COMPILE (contract.ts).
 *   (b) A declared `audio/*` or `video/*` type is rejected by an explicit
 *       prefix deny, BEFORE the allowlist is even consulted. Redundant today
 *       on purpose: if someone ever widens an allowlist, this gate still
 *       holds and the intent stays legible in the diff.
 *   (c) Neither allowlist contains an audio or video type, and the lists are
 *       literals.
 *   (d) A magic-byte deny list catches a MISLABELED upload — an `.mp3`
 *       announced as `application/pdf` — which is the only way the
 *       label-based gates could actually fail.
 *
 * No dependency is added for any of this: the signature checks read the first
 * 16 bytes directly.
 */

import type { AdapterError } from '@core';
import type { ArtifactKind } from './contract.js';
import { isRetryable } from './contract.js';

/**
 * Per-kind allowlist. `audio/*` and `video/*` are not listed and cannot be,
 * because the list is a literal. specs/00 "Receipt layer": the dossier is a
 * PDF, so `dossier` admits nothing else.
 */
export const ALLOWED_CONTENT_TYPES: Readonly<Record<ArtifactKind, readonly string[]>> = {
  email_attachment: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'text/csv',
  ],
  document: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv'],
  dossier: ['application/pdf'],
};

/** Per-object byte cap. There is NO multipart path; a single PUT is the only write. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Display metadata cap (§3.3). */
export const MAX_METADATA_VALUE_CHARS = 255;

const DENIED_TYPE_PREFIXES = ['audio/', 'video/'] as const;

function ascii(value: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 1) out.push(value.charCodeAt(i));
  return out;
}

function matchesAt(bytes: Uint8Array, offset: number, pattern: readonly number[]): boolean {
  if (bytes.byteLength < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

interface Signature {
  readonly label: string;
  readonly test: (bytes: Uint8Array) => boolean;
}

/**
 * Media signatures denied REGARDLESS of the declared content type (D7).
 *
 * BUILDER TRAP, stated because it is the one that gets missed: WebP and WAVE
 * are BOTH RIFF containers. The deny rule tests bytes 8–11 for `WAVE`
 * specifically — a bare `RIFF` deny would reject every legitimate WebP image,
 * and a bare `RIFF` allow would admit audio.
 */
export const DENIED_SIGNATURES: readonly Signature[] = [
  { label: 'ID3 (MP3 tag)', test: (b) => matchesAt(b, 0, ascii('ID3')) },
  {
    label: 'MPEG audio frame sync',
    test: (b) => b.byteLength >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0,
  },
  { label: 'Ogg container', test: (b) => matchesAt(b, 0, ascii('OggS')) },
  { label: 'FLAC', test: (b) => matchesAt(b, 0, ascii('fLaC')) },
  {
    label: 'RIFF/WAVE audio',
    test: (b) => matchesAt(b, 0, ascii('RIFF')) && matchesAt(b, 8, ascii('WAVE')),
  },
  { label: 'ISO base media (MP4/M4A/MOV)', test: (b) => matchesAt(b, 4, ascii('ftyp')) },
  {
    label: 'AIFF',
    test: (b) => matchesAt(b, 0, ascii('FORM')) && matchesAt(b, 8, ascii('AIFF')),
  },
  { label: 'NeXT/Sun audio', test: (b) => matchesAt(b, 0, ascii('.snd')) },
  { label: 'AMR', test: (b) => matchesAt(b, 0, ascii('#!AMR')) },
  { label: 'MIDI', test: (b) => matchesAt(b, 0, ascii('MThd')) },
  { label: 'Matroska/WebM', test: (b) => matchesAt(b, 0, [0x1a, 0x45, 0xdf, 0xa3]) },
];

const NUL_SCAN_BYTES = 512;

/** Signature a declared type MUST exhibit. Absent entry ⇒ no requirement. */
const REQUIRED_SIGNATURES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  'application/pdf': (b) => matchesAt(b, 0, ascii('%PDF-')),
  'image/png': (b) => matchesAt(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => matchesAt(b, 0, [0xff, 0xd8, 0xff]),
  'image/webp': (b) => matchesAt(b, 0, ascii('RIFF')) && matchesAt(b, 8, ascii('WEBP')),
  'text/plain': (b) => !hasNulByte(b),
  'text/csv': (b) => !hasNulByte(b),
};

function hasNulByte(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, NUL_SCAN_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** `true` for any declared `audio/*` or `video/*` type. Case-insensitive. */
export function isDeniedMediaType(content_type: string): boolean {
  const normalized = normalizeContentType(content_type);
  return DENIED_TYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** The matching deny label, or `undefined` when no denied signature matches. */
export function deniedSignatureLabel(bytes: Uint8Array): string | undefined {
  for (const signature of DENIED_SIGNATURES) {
    if (signature.test(bytes)) return signature.label;
  }
  return undefined;
}

export function matchesDeclaredType(content_type: string, bytes: Uint8Array): boolean {
  const required = REQUIRED_SIGNATURES[normalizeContentType(content_type)];
  return required === undefined ? true : required(bytes);
}

/** Lowercased, parameters (`; charset=…`) stripped, trimmed. */
export function normalizeContentType(content_type: string): string {
  const base = content_type.split(';')[0] ?? '';
  return base.trim().toLowerCase();
}

export function isAllowedForKind(kind: ArtifactKind, content_type: string): boolean {
  return ALLOWED_CONTENT_TYPES[kind].includes(normalizeContentType(content_type));
}

export interface ContentPolicyInput {
  kind: ArtifactKind;
  content_type: string;
  bytes: Uint8Array;
  max_bytes: number;
  source: string;
}

/**
 * The ordered gate (§4.3 steps 2–6). Returns the failure, or `undefined` when
 * every gate passes. All checks are LOCAL, so a hostile or malformed request
 * never reaches the network.
 *
 * A rejection is a surfaced, recorded refusal naming the offending type — never
 * a silent drop (D11).
 */
export function checkContentPolicy(input: ContentPolicyInput): AdapterError | undefined {
  const { kind, bytes, max_bytes, source } = input;
  const content_type = normalizeContentType(input.content_type);

  if (isDeniedMediaType(content_type)) {
    return fail(source, `audio and video are never stored; rejected content type "${content_type}"`);
  }
  if (!isAllowedForKind(kind, content_type)) {
    return fail(source, `content type "${content_type}" is not allowed for kind "${kind}"`);
  }
  if (bytes.byteLength > max_bytes) {
    return fail(source, `object exceeds the ${max_bytes}-byte cap`);
  }
  const denied = deniedSignatureLabel(bytes);
  if (denied !== undefined) {
    return fail(source, `rejected media signature (${denied})`);
  }
  if (!matchesDeclaredType(content_type, bytes)) {
    return fail(source, `content does not match declared type "${content_type}"`);
  }
  return undefined;
}

function fail(source: string, message: string): AdapterError {
  return { code: 'invalid_input', retryable: isRetryable('invalid_input'), source, message };
}

/**
 * ASCII-sanitized, length-capped metadata value (§3.3). No user-supplied
 * header passes through: a raw filename in a header is a response-splitting
 * surface and is treated as one. Returns `undefined` when nothing survives, so
 * the field is OMITTED rather than set to an empty string.
 */
export function sanitizeMetadataValue(value: string): string | undefined {
  let out = '';
  for (let i = 0; i < value.length && out.length < MAX_METADATA_VALUE_CHARS; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) out += value[i];
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
