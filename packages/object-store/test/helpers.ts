/**
 * Shared fixtures and seams for the T-018 suite.
 *
 * Two deliberate properties:
 *
 *  - Every byte fixture is BUILT HERE, in code, from its documented magic
 *    bytes. There is no binary fixture file, and in particular there is no
 *    audio file anywhere in this repo — the audio "fixtures" below are the
 *    first handful of bytes of each container format, which is all the
 *    magic-byte deny gate ever reads (design T-018 §3.4, D7).
 *  - No test needs a network, an endpoint, or a credential. The invariant
 *    suites run against the in-process backend because AC-3 (no audio) and
 *    AC-4 (tenancy) are properties of OUR rules, not of a remote service
 *    (design §1.2). Only `s3-live.test.ts` is environment-gated, and it SKIPS
 *    rather than passing when unconfigured (ADR-008).
 */

import { expect } from 'vitest';
import type { AdapterError, AdapterErrorCode } from '@core';
import type {
  BackendHead,
  BackendListOptions,
  BackendListPage,
  BackendObject,
  BackendPutInput,
  ObjectBackend,
} from '../src/backend.js';
import type { ObjectStoreLogEvent, ObjectStoreResult } from '../src/contract.js';

// ---- result helpers -----------------------------------------------------

export function expectOk<T>(result: ObjectStoreResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

export function expectErr<T>(result: ObjectStoreResult<T>, code?: AdapterErrorCode): AdapterError {
  if (result.ok) {
    throw new Error(`expected a failure, got ok: ${JSON.stringify(result.value)}`);
  }
  if (code !== undefined) expect(result.error.code).toBe(code);
  return result.error;
}

// ---- byte building ------------------------------------------------------

export function bytesFrom(...parts: readonly (string | readonly number[])[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i += 1) out.push(part.charCodeAt(i) & 0xff);
    } else {
      for (const byte of part) out.push(byte & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// ---- allowed content fixtures ------------------------------------------

export const PDF_BYTES = bytesFrom('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
export const PDF_BYTES_ALT = bytesFrom('%PDF-1.7\n1 0 obj\n<< /Type /Pages >>\nendobj\n%%EOF\n');
export const PNG_BYTES = bytesFrom(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0x00, 0x00, 0x00, 0x0d],
  'IHDR',
  [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00],
);
export const JPEG_BYTES = bytesFrom([0xff, 0xd8, 0xff, 0xe0], [0x00, 0x10], 'JFIF', [0x00, 0x01, 0x01]);
/** RIFF container whose bytes 8–11 are `WEBP` — the legitimate half of the RIFF trap. */
export const WEBP_BYTES = bytesFrom('RIFF', [0x1a, 0x00, 0x00, 0x00], 'WEBP', 'VP8 ', [0x0e, 0x00, 0x00, 0x00]);
export const TEXT_BYTES = bytesFrom('a quote from the dealer, verbatim\n');
export const CSV_BYTES = bytesFrom('field,value\nsale_price,28995\n');
export const TEXT_WITH_NUL = bytesFrom('plain looking', [0x00], 'but binary');

// ---- denied media signatures (first bytes only — never a real recording) --

export interface MediaSignatureFixture {
  readonly label: string;
  readonly bytes: Uint8Array;
}

export const DENIED_MEDIA_FIXTURES: readonly MediaSignatureFixture[] = [
  { label: 'ID3 (MP3 tag)', bytes: bytesFrom('ID3', [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x21], 'TIT2') },
  { label: 'MPEG audio frame sync', bytes: bytesFrom([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]) },
  { label: 'MPEG audio frame sync (0xFFE_)', bytes: bytesFrom([0xff, 0xe3, 0x18, 0xc4, 0x00, 0x00]) },
  { label: 'Ogg container', bytes: bytesFrom('OggS', [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
  { label: 'FLAC', bytes: bytesFrom('fLaC', [0x00, 0x00, 0x00, 0x22], 'fmt') },
  { label: 'RIFF/WAVE audio', bytes: bytesFrom('RIFF', [0x24, 0x00, 0x00, 0x00], 'WAVE', 'fmt ') },
  { label: 'ISO base media (MP4/M4A/MOV)', bytes: bytesFrom([0x00, 0x00, 0x00, 0x18], 'ftyp', 'M4A ') },
  { label: 'AIFF', bytes: bytesFrom('FORM', [0x00, 0x00, 0x00, 0x20], 'AIFF', 'COMM') },
  { label: 'NeXT/Sun audio', bytes: bytesFrom('.snd', [0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x08]) },
  { label: 'AMR', bytes: bytesFrom('#!AMR', [0x0a, 0x3c, 0x00, 0x00]) },
  { label: 'MIDI', bytes: bytesFrom('MThd', [0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01]) },
  { label: 'Matroska/WebM', bytes: bytesFrom([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]) },
];

// ---- deterministic clock ------------------------------------------------

/** Monotonic, injectable clock — the deterministic seam every timestamp test needs. */
export function fixedClock(startMs = Date.parse('2026-08-07T12:00:00.000Z'), stepMs = 1000): () => string {
  let tick = 0;
  return () => {
    const at = new Date(startMs + tick * stepMs).toISOString();
    tick += 1;
    return at;
  };
}

// ---- log capture --------------------------------------------------------

export interface LogCapture {
  readonly events: ObjectStoreLogEvent[];
  readonly log: (event: ObjectStoreLogEvent) => void;
}

export function captureLog(): LogCapture {
  const events: ObjectStoreLogEvent[] = [];
  return { events, log: (event) => void events.push(event) };
}

// ---- stub backend (error-path seam) -------------------------------------

export interface StubBackendOverrides {
  source?: string;
  put?: (input: BackendPutInput) => Promise<ObjectStoreResult<void>>;
  get?: (key: string) => Promise<ObjectStoreResult<BackendObject>>;
  head?: (key: string) => Promise<ObjectStoreResult<BackendHead>>;
  list?: (prefix: string, options: BackendListOptions) => Promise<ObjectStoreResult<BackendListPage>>;
}

export interface StubBackend extends ObjectBackend {
  /** Every call, in order, as `"<op>:<key-or-prefix>"`. */
  readonly calls: string[];
  readonly listOptions: BackendListOptions[];
}

export function backendError(code: AdapterErrorCode, message = 'stub failure'): AdapterError {
  return {
    code,
    retryable: code === 'rate_limited' || code === 'provider_unavailable',
    source: 'stub-backend',
    message,
  };
}

/**
 * A backend whose every operation is overridable, so each row of design §4.1
 * and §4.4 can be exercised without a network. Defaults: `put` succeeds,
 * `get`/`head` miss, `list` returns an empty page.
 */
export function stubBackend(overrides: StubBackendOverrides = {}): StubBackend {
  const calls: string[] = [];
  const listOptions: BackendListOptions[] = [];
  const source = overrides.source ?? 'stub-backend';
  const miss = (op: string): ObjectStoreResult<never> => ({
    ok: false,
    error: { code: 'not_found', retryable: false, source, message: `${op} failed: no such key` },
  });

  return {
    source,
    calls,
    listOptions,
    async put(input: BackendPutInput): Promise<ObjectStoreResult<void>> {
      calls.push(`put:${input.key}`);
      return overrides.put === undefined ? { ok: true, value: undefined } : overrides.put(input);
    },
    async get(key: string): Promise<ObjectStoreResult<BackendObject>> {
      calls.push(`get:${key}`);
      return overrides.get === undefined ? miss('get') : overrides.get(key);
    },
    async head(key: string): Promise<ObjectStoreResult<BackendHead>> {
      calls.push(`head:${key}`);
      return overrides.head === undefined ? miss('head') : overrides.head(key);
    },
    async list(prefix: string, options: BackendListOptions): Promise<ObjectStoreResult<BackendListPage>> {
      calls.push(`list:${prefix}`);
      listOptions.push(options);
      return overrides.list === undefined
        ? { ok: true, value: { items: [], truncated: false } }
        : overrides.list(prefix, options);
    },
  };
}

/** A backend that fails the test if it is reached at all — the "never touched the network" assertion. */
export function unreachableBackend(): ObjectBackend {
  const boom = (op: string): never => {
    throw new Error(`backend.${op} must not be reached: the check is local and runs before any network call`);
  };
  return {
    source: 'unreachable-backend',
    put: () => boom('put'),
    get: () => boom('get'),
    head: () => boom('head'),
    list: () => boom('list'),
  };
}

// ---- source-tree access (standing surface scans) ------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SourceFile {
  readonly name: string;
  /** Verbatim file contents — prose included. */
  readonly text: string;
  /** Contents with comments removed, so a scan tests CODE, not documentation. */
  readonly code: string;
}

/**
 * Comments removed so a standing scan asserts what the package DOES, not what
 * it says. Every src file documents the operations it deliberately omits
 * ("no presigned URL", "`@aws-sdk/s3-request-presigner` would be an
 * escalation"), and a naive text scan would read those refusals as evidence of
 * the thing being refused.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

export function readSrcFiles(): readonly SourceFile[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => {
      const text = readFileSync(join(SRC_DIR, name), 'utf8');
      return { name, text, code: stripComments(text) };
    });
}

export const SHA256_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
