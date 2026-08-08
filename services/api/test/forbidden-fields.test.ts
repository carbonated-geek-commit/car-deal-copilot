/**
 * What may never reach a response (docs/design/T-019.md §5.4, §5.5, §5.7, D9,
 * D10; AC-9, AC-11) and what "absent" must look like on the wire (ADR-005).
 *
 * The forbidden names are assembled from fragments here for the same reason
 * `projection/guards.ts` assembles them: a checker that spells the words it is
 * looking for poisons its own corpus.
 */

import type { PrequalResult } from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FORBIDDEN_RESPONSE_KEYS,
  assertResponseSafe,
  createPermissiveDealGate,
  findGuardViolations,
  omitAbsent,
  projectDeal,
  projectMessage,
  projectOffer,
  projectPrequal,
  projectThread,
  type ApiErrorBody,
} from '../src/index.js';
import { asAccount, makeDeal, makeMessage, makeOffer, makeThread, memoryContainer, serve, type Served } from './fixtures/harness.js';
import { fixtureRoutes } from './fixtures/routes.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

const AUDIO_KEYS = ['re' + 'cording_url', 're' + 'cording', 'trans' + 'cript', 'audio_url', 'audio_ref', 'media_url'];
const CREDIT_KEYS = ['provider_token', 'ssn', 'credit_report', 'bureau_response'];

describe('the guard list', () => {
  it('names every audio reference and every raw-credit field', () => {
    for (const key of [...AUDIO_KEYS, ...CREDIT_KEYS]) {
      expect(FORBIDDEN_RESPONSE_KEYS, key).toContain(key);
    }
  });

  it('finds a forbidden key wherever it hides', () => {
    for (const key of [...AUDIO_KEYS, ...CREDIT_KEYS]) {
      expect(findGuardViolations({ [key]: 'x' }).map((f) => f.kind)).toEqual(['forbidden_key']);
      expect(findGuardViolations({ deal: { threads: [{ messages: [{ [key]: 'x' }] }] } })[0]).toEqual({
        kind: 'forbidden_key',
        path: `deal.threads[0].messages[0].${key}`,
      });
    }
  });

  it('treats `null` as a violation — ADR-005 says absent is UNEVALUABLE, not empty', () => {
    expect(findGuardViolations({ sale_price: null })).toEqual([{ kind: 'null_value', path: 'sale_price' }]);
    expect(findGuardViolations({ flags: [null] })).toEqual([{ kind: 'null_value', path: 'flags[0]' }]);
    expect(findGuardViolations({ sale_price: undefined })).toEqual([]);
    expect(findGuardViolations({ sale_price: 0 })).toEqual([]);
  });

  it('terminates on a cyclic payload instead of hanging a response', () => {
    const cyclic: Record<string, unknown> = { id: 'x' };
    cyclic['self'] = cyclic;
    expect(findGuardViolations(cyclic)).toEqual([]);

    let deep: Record<string, unknown> = { ['trans' + 'cript']: 'x' };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(() => findGuardViolations(deep)).not.toThrow();
  });

  it('reports a leak as a defect carried on `cause`, never as a response body', () => {
    try {
      assertResponseSafe({ ['provider_token']: 'tok_live_1' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const api = (error as { api_error: { code: string; message: string; cause: unknown } }).api_error;
      expect(api.code).toBe('internal');
      expect(api.message).toBe('internal error');
      expect(JSON.stringify(api.cause)).toContain('response_guard_violation');
    }
    expect(() => assertResponseSafe({ id: 'x', flags: ['above_market'] })).not.toThrow();
  });
});

describe('projections', () => {
  it('gives a prequal summary and no capability into the provider (AC-9)', () => {
    const result: PrequalResult = {
      provider_token: 'tok_live_shouldnever_leave',
      qualified_apr: 6.9,
      approved_amount_max: 4_000_000,
      fetched_at: '2026-08-07T12:00:00.000Z',
    };
    const view = projectPrequal(result);
    expect(Object.keys(view).sort()).toEqual(['approved_amount_max', 'fetched_at', 'qualified_apr']);
    expect(JSON.stringify(view)).not.toContain('tok_live');
    expect(findGuardViolations(view)).toEqual([]);
  });

  it('keeps an unstated price ABSENT — never 0, never null (ADR-005)', () => {
    const view = projectOffer(makeOffer({ fees: [{ name: 'doc', amount: 59_900 }] }));
    expect('sale_price' in view).toBe(false);
    expect('apr' in view).toBe(false);
    expect('monthly' in view).toBe(false);
    expect(JSON.parse(JSON.stringify(view))).toEqual({ fees: [{ name: 'doc', amount: 59_900 }], flags: [] });
    expect(findGuardViolations(view)).toEqual([]);

    const priced = projectOffer(makeOffer({ sale_price: 3_100_000 }));
    expect(priced.sale_price).toBe(3_100_000);
  });

  it('copies flags from the domain and computes none of its own (D10, ADR-006, ADR-007)', () => {
    const flags = projectOffer(makeOffer({ sale_price: 9_900_000, flags: ['above_market'] })).flags;
    expect(flags).toEqual(['above_market']);

    // A wildly over-priced offer with an EMPTY flag list stays empty: the API
    // never re-derives `above_market` (which is the RETAIL band of that
    // instance's ValuationSnapshot, ADR-007) or any other flag.
    expect(projectOffer(makeOffer({ sale_price: 99_000_000, flags: [] })).flags).toEqual([]);
  });

  it('projects a message with no audio reference and no transcript, because the spine has none', () => {
    const bare_call = makeMessage({ channel: 'call', call_meta: { started_at: '2026-08-07T12:00:00Z', duration_seconds: 42 } });
    // A bare call record has no body at all — the key is absent, not empty.
    delete (bare_call as { body?: string }).body;
    const view = projectMessage(bare_call);
    expect('body' in view).toBe(false);
    expect(view.call_meta?.duration_seconds).toBe(42);
    expect(findGuardViolations(view)).toEqual([]);
    for (const key of AUDIO_KEYS) expect(Object.keys(view), key).not.toContain(key);
  });

  it('drops nothing and invents nothing when projecting a whole deal', () => {
    const deal = makeDeal({
      dealer_threads: [makeThread({ messages: [makeMessage(), makeMessage({ channel: 'note', direction: 'internal', author: 'buyer' })] })],
      offers: [makeOffer({ sale_price: 3_100_000, flags: ['over_walkaway'] })],
    });
    // Absent from the aggregate, not present-and-empty (ADR-005).
    expect('identity_ref' in deal).toBe(false);
    expect('burned_at' in deal).toBe(false);
    const view = projectDeal('owner', deal);
    expect(findGuardViolations(view)).toEqual([]);
    expect('identity_ref' in view).toBe(false);
    expect('burned_at' in view).toBe(false);
    expect(view.owner_id).toBe('account-a');
    expect(view.walk_away_number).toBe(3_200_000);
    expect(view.budget).toBe(3_500_000);
    expect(view.offers[0]?.flags).toEqual(['over_walkaway']);
    expect(view.dealer_threads[0]?.messages).toHaveLength(2);
  });

  it('projects a thread with no valuation-derived value at all (§5.7)', () => {
    const view = projectThread(makeThread());
    // Budget ceiling and fair price stay two questions: nothing fair-price
    // shaped is projected here, and an absent one is an omitted key.
    expect(Object.keys(view).sort()).toEqual(['dealership_id', 'messages', 'process_step']);
    expect(findGuardViolations(view)).toEqual([]);
  });

  it('omits an undefined key rather than serializing it', () => {
    expect(omitAbsent({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect('b' in omitAbsent({ a: 1, b: undefined })).toBe(false);
  });
});

describe('on the wire', () => {
  const boot = async (): Promise<Served> => {
    const gate = createPermissiveDealGate();
    const container = await memoryContainer();
    const s = await serve({ container, gate, routes: [fixtureRoutes({ gate, container })] });
    served = s;
    return s;
  };

  it('turns a leaking response into a bare internal, and the key never ships', async () => {
    const s = await boot();
    const res = await s.app.inject({ method: 'GET', url: '/leaky', headers: asAccount('account-a') });
    expect(res.statusCode).toBe(500);
    expect((JSON.parse(res.body) as ApiErrorBody).error.code).toBe('internal');
    expect(res.body).not.toContain('trans' + 'cript');
    expect(res.body).not.toContain('never');
  });

  it('refuses a response that says `null` where the spine says absent', async () => {
    const s = await boot();
    const res = await s.app.inject({ method: 'GET', url: '/nully', headers: asAccount('account-a') });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('null');
  });
});
