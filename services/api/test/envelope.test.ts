/**
 * One shape for every failure — including the ones the framework generates
 * (docs/design/T-019.md §2.7, §3.1, D4; AC-6).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  MESSAGE_BY_CODE,
  STATUS_BY_CODE,
  apiError,
  defaultRetryable,
  fromAdapterError,
  fromDbError,
  fromFrameworkError,
  fromReceiptError,
  fromUnknown,
  fromZodError,
  isApiErrorBody,
  statusFor,
  toEnvelope,
  type ApiErrorBody,
  type ApiErrorCode,
} from '../src/index.js';
import { asAccount, serve, type Served } from './fixtures/harness.js';
import { fixtureRoutes } from './fixtures/routes.js';
import { createPermissiveDealGate } from '../src/index.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

const ALL_CODES: readonly ApiErrorCode[] = [
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'unprocessable',
  'internal',
  'unavailable',
];

describe('the envelope, in process', () => {
  it('derives a status from the code and never from a call site', () => {
    expect(Object.keys(STATUS_BY_CODE).sort()).toEqual([...ALL_CODES].sort());
    expect(STATUS_BY_CODE).toEqual({
      invalid_request: 400,
      unauthenticated: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      payload_too_large: 413,
      unsupported_media_type: 415,
      unprocessable: 422,
      internal: 500,
      unavailable: 503,
    });
  });

  it('makes only `unavailable` retryable by default', () => {
    for (const code of ALL_CODES) {
      expect(defaultRetryable(code)).toBe(code === 'unavailable');
      expect(apiError(code, 'x').retryable).toBe(code === 'unavailable');
    }
    expect(apiError('conflict', 'x', { retryable: true }).retryable).toBe(true);
  });

  it('never serializes `cause`', () => {
    const error = apiError('internal', 'internal error', { cause: new Error('password=hunter2') });
    const body = toEnvelope(error, 'req-1');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect('cause' in body.error).toBe(false);
  });

  it('emits `details` only for invalid_request, and only when non-empty', () => {
    const details = [{ path: 'body.x', message: 'expected string' }];
    expect(toEnvelope(apiError('invalid_request', 'm', { details }), 'r').error.details).toEqual(details);
    expect(toEnvelope(apiError('not_found', 'm', { details }), 'r').error.details).toBeUndefined();
    expect(toEnvelope(apiError('invalid_request', 'm', { details: [] }), 'r').error.details).toBeUndefined();
  });

  it('recognises its own shape and rejects the framework shape', () => {
    expect(isApiErrorBody(toEnvelope(apiError('not_found', 'm'), 'r'))).toBe(true);
    expect(isApiErrorBody({ statusCode: 404, error: 'Not Found', message: 'x' })).toBe(false);
    expect(isApiErrorBody({ error: { code: 'nope', message: 'm', request_id: 'r', retryable: false } })).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody('not an object')).toBe(false);
  });

  it('maps every @db code, and reports a foreign message only through `cause`', () => {
    const codes = [
      ['not_configured', 'internal'],
      ['connection_failed', 'unavailable'],
      ['server_too_old', 'internal'],
      ['permission_denied', 'internal'],
      ['unique_violation', 'conflict'],
      ['foreign_key_violation', 'not_found'],
      ['not_null_violation', 'unprocessable'],
      ['check_violation', 'unprocessable'],
      ['append_only_violation', 'conflict'],
      ['write_once_violation', 'conflict'],
      ['tenancy_violation', 'not_found'],
      ['serialization_failure', 'unavailable'],
      ['statement_timeout', 'unavailable'],
      ['migration_conflict', 'internal'],
      ['unavailable', 'unavailable'],
      ['unknown', 'internal'],
    ] as const;
    for (const [db_code, api_code] of codes) {
      const mapped = fromDbError({
        code: db_code,
        retryable: true,
        message: 'relation "deals" violates constraint deals_owner_fk',
      } as never);
      expect(mapped.code, db_code).toBe(api_code);
      expect(mapped.message).toBe(MESSAGE_BY_CODE[api_code]);
      // A non-`unavailable` mapping is never retryable, whatever @db claimed.
      expect(mapped.retryable).toBe(api_code === 'unavailable');
      expect(toEnvelope(mapped, 'r').error.message).not.toContain('deals_owner_fk');
    }
  });

  it('maps every @core AdapterError code', () => {
    const codes = [
      ['invalid_input', 'unprocessable'],
      ['not_found', 'not_found'],
      ['auth', 'unavailable'],
      ['rate_limited', 'unavailable'],
      ['provider_unavailable', 'unavailable'],
      ['malformed_response', 'unavailable'],
    ] as const;
    for (const [adapter_code, api_code] of codes) {
      const mapped = fromAdapterError({
        code: adapter_code,
        retryable: false,
        source: 'mock-kbb',
        message: 'provider said no',
      } as never);
      expect(mapped.code, adapter_code).toBe(api_code);
      expect(toEnvelope(mapped, 'r').error.message).not.toContain('mock-kbb');
    }
  });

  it('maps every @receipt error code', () => {
    const codes = [
      ['invalid_input', 'unprocessable'],
      ['store_unavailable', 'unavailable'],
      ['not_implemented', 'internal'],
    ] as const;
    for (const [receipt_code, api_code] of codes) {
      const mapped = fromReceiptError({ code: receipt_code, retryable: true, message: 'x' } as never);
      expect(mapped.code, receipt_code).toBe(api_code);
      expect(mapped.retryable).toBe(api_code === 'unavailable');
    }
  });

  it('maps framework failures by code and by status band', () => {
    expect(fromFrameworkError({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' }).code).toBe('payload_too_large');
    expect(fromFrameworkError({ statusCode: 413 }).code).toBe('payload_too_large');
    expect(fromFrameworkError({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' }).code).toBe('unsupported_media_type');
    expect(fromFrameworkError({ statusCode: 415 }).code).toBe('unsupported_media_type');
    expect(fromFrameworkError({ statusCode: 404 }).code).toBe('not_found');
    expect(fromFrameworkError({ statusCode: 400 }).code).toBe('invalid_request');
    expect(fromFrameworkError({ statusCode: 500 }).code).toBe('internal');
    expect(fromFrameworkError(new Error('boom')).code).toBe('internal');
    expect(fromUnknown('a string').code).toBe('internal');
    expect(statusFor(fromUnknown(undefined))).toBe(500);
  });

  it('describes WHY a value was rejected and never WHAT was sent', () => {
    const error = fromZodError(
      [
        { code: 'invalid_value', path: ['process_step'], values: ['information_gather', 'pickup'] },
        { code: 'unrecognized_keys', path: [], keys: ['walkaway_number'] },
      ] as never,
      'body',
    );
    expect(error.code).toBe('invalid_request');
    expect(error.details?.[0]?.path).toBe('body.process_step');
    expect(error.details?.[0]?.message).toContain('expected one of: information_gather, pickup');
    expect(error.details?.[1]?.message).toContain('walkaway_number');
  });
});

describe('the envelope, on the wire', () => {
  const boot = async (config_env: Record<string, string | undefined> = {}): Promise<Served> => {
    const gate = createPermissiveDealGate();
    const { configFor, memoryContainer } = await import('./fixtures/harness.js');
    const container = await memoryContainer();
    return serve({
      config: configFor(config_env),
      container,
      gate,
      routes: [fixtureRoutes({ gate, container })],
    });
  };

  const expectEnvelope = (raw: string, code: ApiErrorCode): ApiErrorBody => {
    const body = JSON.parse(raw) as ApiErrorBody;
    expect(isApiErrorBody(body)).toBe(true);
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.request_id).toBe('string');
    expect(body.error.request_id.length).toBeGreaterThan(0);
    expect(Object.keys(body.error).every((k) => ['code', 'message', 'request_id', 'retryable', 'details'].includes(k))).toBe(
      true,
    );
    return body;
  };

  it('renders an unmatched URL through the envelope, not through Fastify', async () => {
    served = await boot();
    const res = await served.app.inject({ method: 'GET', url: '/no-such-route', headers: asAccount('account-a') });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-request-id']).toBeDefined();
    expectEnvelope(res.body, 'not_found');
  });

  it('renders an unsupported content type through the envelope (D12: JSON only)', async () => {
    served = await boot();
    const res = await served.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'text/plain' },
      payload: 'From=%2B15550001111',
    });
    expect(res.statusCode).toBe(415);
    expectEnvelope(res.body, 'unsupported_media_type');
  });

  it('renders a form-encoded provider webhook as 415, per §8.3', async () => {
    served = await boot();
    const res = await served.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'From=%2B15550001111&Body=hi',
    });
    expect(res.statusCode).toBe(415);
    expectEnvelope(res.body, 'unsupported_media_type');
  });

  it('renders an oversized body through the envelope', async () => {
    served = await boot({ API_BODY_LIMIT_BYTES: '64' });
    const res = await served.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ body: 'x'.repeat(500) }),
    });
    expect(res.statusCode).toBe(413);
    expectEnvelope(res.body, 'payload_too_large');
  });

  it('renders unparseable JSON through the envelope', async () => {
    served = await boot();
    const res = await served.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/json' },
      payload: '{"unterminated":',
    });
    expect(res.statusCode).toBe(400);
    expectEnvelope(res.body, 'invalid_request');
  });

  it('renders an unhandled throw as a bare internal — no stack, no SQL, no message', async () => {
    served = await boot();
    const res = await served.app.inject({ method: 'GET', url: '/boom', headers: asAccount('account-a') });
    expect(res.statusCode).toBe(500);
    const body = expectEnvelope(res.body, 'internal');
    expect(body.error.message).toBe(MESSAGE_BY_CODE.internal);
    expect(res.body).not.toContain('SELECT');
    expect(res.body).not.toContain('stack');
    expect(body.error.retryable).toBe(false);
  });

  it('replaces a non-envelope error body rather than passing it through (D4 backstop)', async () => {
    served = await boot();
    const res = await served.app.inject({ method: 'GET', url: '/rogue-error', headers: asAccount('account-a') });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body['statusCode']).toBeUndefined();
    expect(isApiErrorBody(body)).toBe(true);
  });

  it('stamps x-request-id on success as well as failure', async () => {
    served = await boot();
    const ok = await served.app.inject({ method: 'GET', url: '/healthz' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-request-id']).toBeDefined();
  });
});
