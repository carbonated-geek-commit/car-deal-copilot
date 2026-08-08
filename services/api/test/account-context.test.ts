/**
 * The account context, resolved once at the edge (docs/design/T-019.md §2.4,
 * §4.2 steps 3–4, D1; AC-2, AC-4).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_HEADER,
  FIXED_ACCOUNT_SOURCE,
  POC_HEADER_SOURCE,
  createFixedAccountResolver,
  createPermissiveDealGate,
  createPocHeaderResolver,
  requireAccountContext,
  type AccountContext,
  type ApiErrorBody,
} from '../src/index.js';
import { asAccount, memoryContainer, serve, type Served } from './fixtures/harness.js';
import { fixtureRoutes, newTripwire } from './fixtures/routes.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

const bootWith = async (resolver = createPocHeaderResolver()): Promise<{ served: Served; trip: ReturnType<typeof newTripwire> }> => {
  const gate = createPermissiveDealGate();
  const container = await memoryContainer();
  const trip = newTripwire();
  const s = await serve({ container, gate, resolver, routes: [fixtureRoutes({ gate, container, tripwire: trip })] });
  served = s;
  return { served: s, trip };
};

const asHeader = (value: unknown): Record<string, unknown> => ({ [ACCOUNT_HEADER]: value });

describe('the poc-header resolver names its own weakness', () => {
  it('is called poc-header, in code and in /readyz', async () => {
    expect(createPocHeaderResolver().source).toBe(POC_HEADER_SOURCE);
    expect(POC_HEADER_SOURCE).toBe('poc-header');
    const { served: s } = await bootWith();
    const res = await s.app.inject({ method: 'GET', url: '/readyz' });
    const body = JSON.parse(res.body) as { auth: { resolver: string; provider: string } };
    expect(body.auth).toEqual({ resolver: 'poc-header', provider: 'none' });
  });

  it('resolves an account id, a role, a source and a request id', async () => {
    const resolver = createPocHeaderResolver();
    const result = await resolver.resolve({ headers: asHeader(' account-a '), id: 'req-9' } as never);
    expect(result.outcome).toBe('resolved');
    const context = (result as { context: AccountContext }).context;
    expect(context.scope.account_id).toBe('account-a');
    expect(context.role).toBe('owner');
    expect(context.source).toBe(POC_HEADER_SOURCE);
    expect(context.request_id).toBe('req-9');
  });

  it('treats absent, blank, repeated and malformed headers as unresolved', async () => {
    const resolver = createPocHeaderResolver();
    const cases: readonly [unknown, 'absent' | 'malformed'][] = [
      [undefined, 'absent'],
      ['', 'absent'],
      ['   ', 'absent'],
      [['account-a', 'account-b'], 'malformed'],
      ['account a', 'malformed'],
      ['../../etc/passwd', 'malformed'],
      ['-leading-dash', 'malformed'],
      ['a'.repeat(200), 'malformed'],
    ];
    for (const [raw, reason] of cases) {
      const result = await resolver.resolve({ headers: asHeader(raw), id: 'r' } as never);
      expect(result.outcome, JSON.stringify(raw)).toBe('unresolved');
      expect((result as { reason: string }).reason).toBe(reason);
    }
  });
});

describe('the edge hook', () => {
  it('rejects a request with no context as 401', async () => {
    const { served: s } = await bootWith();
    const res = await s.app.inject({ method: 'GET', url: '/deals/deal-1' });
    expect(res.statusCode).toBe(401);
    expect((JSON.parse(res.body) as ApiErrorBody).error.code).toBe('unauthenticated');
  });

  it('runs BEFORE validation, so an unauthenticated caller learns nothing about the schema', async () => {
    const { served: s, trip } = await bootWith();
    // A request that is malformed in every possible way: bad param charset,
    // unknown query key, unknown body key, out-of-enum value.
    const res = await s.app.inject({
      method: 'POST',
      url: '/deals/not a legal id/step?bogus=1',
      headers: { 'content-type': 'application/json' },
      payload: { process_step: 'not_a_step', walkaway_number: 1 },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as ApiErrorBody;
    expect(body.error.code).toBe('unauthenticated');
    expect(body.error.details).toBeUndefined();
    expect(res.body).not.toContain('process_step');
    expect(res.body).not.toContain('walkaway_number');
    expect(trip.handler_calls).toBe(0);
    expect(trip.store_calls).toBe(0);
  });

  it('reports absent and malformed identically on the wire', async () => {
    const { served: s } = await bootWith();
    const absent = await s.app.inject({ method: 'GET', url: '/deals/deal-1' });
    const malformed = await s.app.inject({ method: 'GET', url: '/deals/deal-1', headers: asAccount('bad id') });
    const strip = (raw: string): unknown => {
      const body = JSON.parse(raw) as ApiErrorBody;
      return { ...body.error, request_id: '<id>' };
    };
    expect(strip(absent.body)).toEqual(strip(malformed.body));
  });

  it('is registered on the api scope only — the health and webhook planes have none', async () => {
    const { served: s } = await bootWith();
    for (const url of ['/healthz', '/readyz']) {
      expect((await s.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
    const hook = await s.app.inject({
      method: 'POST',
      url: '/webhooks/telephony',
      headers: { 'content-type': 'application/json' },
      payload: { anything: true },
    });
    expect(hook.statusCode).toBe(200);
  });

  it('is swappable without touching a route — E3 registers a different resolver', async () => {
    const resolver = createFixedAccountResolver('account-fixed');
    expect(resolver.source).toBe(FIXED_ACCOUNT_SOURCE);
    const { served: s } = await bootWith(resolver);
    // No header at all, and yet the request is scoped.
    const res = await s.app.inject({ method: 'POST', url: '/deals/deal-1/step', payload: { process_step: 'deal_negotiation' } });
    expect(res.statusCode).toBe(200);
    const ready = await s.app.inject({ method: 'GET', url: '/readyz' });
    expect((JSON.parse(ready.body) as { auth: { resolver: string } }).auth.resolver).toBe(FIXED_ACCOUNT_SOURCE);
  });
});

describe('requireAccountContext', () => {
  it('throws a caught internal rather than returning undefined on a context-less plane', () => {
    expect(() => requireAccountContext({} as never)).toThrowError();
    try {
      requireAccountContext({} as never);
    } catch (error) {
      expect((error as { api_error: { code: string } }).api_error.code).toBe('internal');
    }
  });
});
