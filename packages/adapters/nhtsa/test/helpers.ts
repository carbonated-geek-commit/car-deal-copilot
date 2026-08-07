/**
 * T-004 tester — shared hermetic-test helpers (docs/design/T-004.md §5).
 *
 * Every adapter under test receives an injected `fetchFn` (design D1); nothing
 * in this suite touches `globalThis.fetch` or the network. Fixtures are the
 * checked-in recorded NHTSA payload shapes under test/fixtures/.
 */

import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { AdapterError, AdapterErrorCode, AdapterResult } from '@core';

/** Adapter id per design D4 — asserted rather than imported so a drifted implementation fails loudly. */
export const EXPECTED_SOURCE = 'nhtsa-vpic';

/** Load a checked-in recorded fixture (JSON) by file name. */
export function loadFixture<T = unknown>(name: string): T {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

/** Deep clone via JSON round-trip — fixtures are plain JSON, so this is lossless. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A 200 (or given status) response whose body is the JSON serialization of `body`. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A raw-text response (used for non-JSON bodies and bare status codes). */
export function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

export interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/**
 * Fixture-backed fetch stub (design D1/§5): records every request so tests can
 * assert endpoint/query construction and call counts (zero-retry, D6; the D2
 * two-step for getRecalls), and answers via the supplied responder.
 */
export function recordingFetch(
  respond: (url: string, callIndex: number) => Response | Promise<Response>,
): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    return respond(url, calls.length - 1);
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** A fetch stub that fails the test if it is ever invoked (pre-validation short-circuit checks). */
export function forbiddenFetch(): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  return recordingFetch(() => {
    throw new Error('fetchFn must not be called for this input');
  });
}

/**
 * A fetch stub that never resolves on its own but rejects when the abort
 * signal the adapter passes fires (design D8: AbortSignal.timeout) — used to
 * drive the timeout path exactly like the real fetch would.
 */
export function hangingFetch(): { fetchFn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn = ((input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        reject(new Error('adapter did not pass an abort signal (design D8)'));
        return;
      }
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/**
 * Unwrap the error arm, asserting the uniform failure contract along the way:
 * `source` is always 'nhtsa-vpic' (D4) and `retryable` is derived from `code`
 * (only rate_limited / provider_unavailable retry — T-001 §5.1).
 */
export function expectFailure(
  res: AdapterResult<unknown>,
  code: AdapterErrorCode,
): AdapterError {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('expected a failure result');
  expect(res.error.code).toBe(code);
  expect(res.error.source).toBe(EXPECTED_SOURCE);
  expect(res.error.retryable).toBe(
    code === 'rate_limited' || code === 'provider_unavailable',
  );
  expect(typeof res.error.message).toBe('string');
  expect(res.error.message.length).toBeGreaterThan(0);
  return res.error;
}

/** Unwrap the ok arm or fail loudly with the error code. */
export function expectOk<T>(res: AdapterResult<T>): T {
  if (!res.ok) {
    throw new Error(`expected ok, got ${res.error.code}: ${res.error.message}`);
  }
  return res.value;
}
