/**
 * T-018 tester — the provider-signal → `AdapterErrorCode` mapping (design §4.1,
 * binding) and the log-safety of the error it produces.
 *
 * `AdapterErrorCode` is FROZEN in `packages/core` (T-010), so this file also
 * pins the two mappings that are interpretive rather than obvious:
 *   D2  a missing bucket / incoherent config ⇒ 'auth' — the identical handling
 *       class (never retry, alert an operator, do not degrade).
 *   §4.1 an UNRECOGNIZED signal ⇒ 'provider_unavailable' / retryable — assuming
 *       transient is more conservative than declaring a permanent failure we
 *       cannot substantiate.
 */

import { describe, expect, it } from 'vitest';
import type { AdapterErrorCode } from '@core';
import { classifyProviderError, toAdapterError } from '../src/backend.js';
import { isRetryable, storeError } from '../src/contract.js';

function named(name: string, extra: Record<string, unknown> = {}): unknown {
  return { name, message: `${name} happened`, ...extra };
}

describe('classifyProviderError — by error name (§4.1)', () => {
  const BY_NAME: readonly (readonly [string, AdapterErrorCode])[] = [
    ['NoSuchKey', 'not_found'],
    ['NotFound', 'not_found'],
    ['NoSuchUpload', 'not_found'],
    ['AccessDenied', 'auth'],
    ['InvalidAccessKeyId', 'auth'],
    ['SignatureDoesNotMatch', 'auth'],
    ['ExpiredToken', 'auth'],
    ['ExpiredTokenException', 'auth'],
    ['CredentialsProviderError', 'auth'],
    ['NoSuchBucket', 'auth'],
    ['SlowDown', 'rate_limited'],
    ['TooManyRequests', 'rate_limited'],
    ['ThrottlingException', 'rate_limited'],
    ['InternalError', 'provider_unavailable'],
    ['ServiceUnavailable', 'provider_unavailable'],
    ['RequestTimeout', 'provider_unavailable'],
    ['RequestTimeTooSkewed', 'provider_unavailable'],
    ['TimeoutError', 'provider_unavailable'],
    ['AbortError', 'provider_unavailable'],
    ['NetworkingError', 'provider_unavailable'],
  ];

  it.each(BY_NAME)('maps %s to %s', (name, code) => {
    expect(classifyProviderError(named(name))).toBe(code);
  });

  it('never retries a credential problem, and always retries a throttle or an outage', () => {
    expect(toAdapterError(named('AccessDenied'), 's3-object-store', 'get').retryable).toBe(false);
    expect(toAdapterError(named('NoSuchBucket'), 's3-object-store', 'put').retryable).toBe(false);
    expect(toAdapterError(named('SlowDown'), 's3-object-store', 'put').retryable).toBe(true);
    expect(toAdapterError(named('ServiceUnavailable'), 's3-object-store', 'put').retryable).toBe(true);
  });
});

describe('classifyProviderError — by transport signal', () => {
  it.each([
    ['ECONNREFUSED', 'provider_unavailable'],
    ['ETIMEDOUT', 'provider_unavailable'],
    ['EAI_AGAIN', 'provider_unavailable'],
    ['ECONNRESET', 'provider_unavailable'],
  ] as const)('maps a %s syscall failure to %s', (code, expected) => {
    expect(classifyProviderError({ name: 'Error', code })).toBe(expected);
  });

  it.each([
    [404, 'not_found'],
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
    [503, 'provider_unavailable'],
  ] as const)('maps HTTP %d in $metadata to %s', (status, expected) => {
    expect(classifyProviderError({ name: 'Unknown', $metadata: { httpStatusCode: status } })).toBe(expected);
  });

  it('falls back to a bare statusCode when $metadata is absent', () => {
    expect(classifyProviderError({ name: 'Unknown', statusCode: 404 })).toBe('not_found');
    expect(classifyProviderError({ name: 'Unknown', statusCode: 429 })).toBe('rate_limited');
  });

  it('prefers a recognized error name over the status code', () => {
    expect(classifyProviderError({ name: 'AccessDenied', $metadata: { httpStatusCode: 500 } })).toBe('auth');
  });
});

describe('classifyProviderError — the unrecognized case is conservative', () => {
  const UNRECOGNIZED: readonly (readonly [string, unknown])[] = [
    ['an unknown name', named('SomethingNew')],
    ['a plain Error', { name: 'Error', message: 'boom' }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
    ['a number', 42],
    ['an empty object', {}],
    ['a 302 status', { name: 'Unknown', $metadata: { httpStatusCode: 302 } }],
  ];

  it.each(UNRECOGNIZED)(
    'classifies %s as a retryable provider_unavailable rather than a permanent failure',
    (_label, err) => {
      expect(classifyProviderError(err)).toBe('provider_unavailable');
      expect(isRetryable(classifyProviderError(err))).toBe(true);
    },
  );

  it('does not trust the shape of a provider throw', () => {
    // A drifted SDK could hand us fields of the wrong type; classification
    // must still produce a value rather than crash the caller.
    expect(classifyProviderError({ name: 42, code: 7, $metadata: { httpStatusCode: 'x' } })).toBe(
      'provider_unavailable',
    );
    expect(classifyProviderError({ $metadata: null })).toBe('provider_unavailable');
  });
});

describe('toAdapterError — a log-safe value, never a provider payload', () => {
  it('names the operation and the provider error, and nothing else', () => {
    const error = toAdapterError(named('NoSuchKey'), 's3-object-store', 'get');
    expect(error).toEqual({
      code: 'not_found',
      retryable: false,
      source: 's3-object-store',
      message: 'get failed: NoSuchKey',
    });
  });

  it('never copies the provider message body through, which can echo request content', () => {
    const hostile = {
      name: 'AccessDenied',
      message: 'Access Denied for key acct/other/deal_9/dossier/deadbeef; token AKIAIOSFODNN7EXAMPLE',
      Body: 'the buyer said their walk-away number is 27000',
    };
    const error = toAdapterError(hostile, 's3-object-store', 'get');
    expect(error.message).toBe('get failed: AccessDenied');
    expect(error.message).not.toContain('AKIA');
    expect(error.message).not.toContain('acct/other');
    expect(error.message).not.toContain('walk-away');
  });

  it('degrades to a stated unknown rather than inventing a cause', () => {
    expect(toAdapterError(undefined, 's3-object-store', 'list').message).toBe(
      'list failed: unknown provider error',
    );
  });
});

describe('isRetryable / storeError — retryable is derived, never guessed', () => {
  it.each([
    ['invalid_input', false],
    ['not_found', false],
    ['auth', false],
    ['malformed_response', false],
    ['rate_limited', true],
    ['provider_unavailable', true],
  ] as const)('marks %s retryable=%s', (code, expected) => {
    expect(isRetryable(code)).toBe(expected);
    expect(storeError(code, 'src', 'msg').error.retryable).toBe(expected);
  });

  it('builds a failure as a value, never a throw', () => {
    const result = storeError('not_found', 'src', 'missing');
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: 'not_found', retryable: false, source: 'src', message: 'missing' });
  });
});
