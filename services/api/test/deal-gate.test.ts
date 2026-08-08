/**
 * The one deal-scoped authorization choke point (docs/design/T-019.md §2.5,
 * D2, D3; AC-3).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  PERMISSIVE_GATE,
  STATUS_CODE_BY_DENY_REASON,
  createPermissiveDealGate,
  dealGate,
  dealIdParam,
  requireDealHandle,
  validate,
  type AccountContext,
  type ApiErrorBody,
  type AuthzDecision,
  type AuthzDenyReason,
  type DealAccessGate,
  type DealAction,
  type DealHandle,
} from '../src/index.js';
import { asAccount, memoryContainer, serve, type Served } from './fixtures/harness.js';
import { fixtureRoutes, newTripwire } from './fixtures/routes.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

interface RecordingGate extends DealAccessGate {
  readonly calls: { ctx: AccountContext; deal_id: string; action: DealAction }[];
  readonly handles: DealHandle[];
}

const recordingGate = (decision: AuthzDecision = { outcome: 'permit', reason: 'account_owns_deal' }): RecordingGate => {
  const calls: { ctx: AccountContext; deal_id: string; action: DealAction }[] = [];
  return {
    name: 'recording',
    calls,
    handles: [],
    authorize(ctx: AccountContext, deal_id: string, action: DealAction): Promise<AuthzDecision> {
      calls.push({ ctx, deal_id, action });
      return Promise.resolve(decision);
    },
  };
};

const boot = async (gate: DealAccessGate, tripwire = newTripwire()): Promise<{ s: Served; trip: typeof tripwire }> => {
  const container = await memoryContainer();
  const s = await serve({ container, gate, routes: [fixtureRoutes({ gate, container, tripwire })] });
  served = s;
  return { s, trip: tripwire };
};

describe('the E2 gate', () => {
  it('names itself and permits every action for a resolved context', async () => {
    const gate = createPermissiveDealGate();
    expect(gate.name).toBe(PERMISSIVE_GATE);
    const decision = await gate.authorize(
      { scope: { account_id: 'a' }, role: 'owner', source: 'test', request_id: 'r' },
      'deal-1',
      'export',
    );
    expect(decision).toEqual({ outcome: 'permit', reason: 'account_owns_deal' });
  });

  it('does not read the store — it is a pure policy function E3 replaces alone', () => {
    // `createPermissiveDealGate()` takes no dependencies at all: there is
    // nothing for a store to be injected through, so the gate cannot become a
    // way to probe for a deal's existence.
    expect(createPermissiveDealGate.length).toBe(0);
    expect(Object.keys(createPermissiveDealGate()).sort()).toEqual(['authorize', 'name']);
  });
});

describe('the hook', () => {
  it('hands the gate the resolved context, the deal id and the route’s action', async () => {
    const gate = recordingGate();
    const { s } = await boot(gate);
    await s.app.inject({ method: 'GET', url: '/deals/deal-77', headers: asAccount('account-a') });
    await s.app.inject({
      method: 'POST',
      url: '/deals/deal-77/step',
      headers: asAccount('account-a'),
      payload: { process_step: 'deal_negotiation' },
    });
    expect(gate.calls.map((c) => [c.deal_id, c.action, c.ctx.scope.account_id])).toEqual([
      ['deal-77', 'read', 'account-a'],
      ['deal-77', 'write', 'account-a'],
    ]);
  });

  it('mints a handle whose scope is the resolved account’s', async () => {
    const gate = recordingGate();
    const container = await memoryContainer();
    let seen: DealHandle | undefined;
    const s = await serve({
      container,
      gate,
      routes: [
        (app) => {
          app.get(
            '/probe/:deal_id',
            { preValidation: validate({ params: dealIdParam }), preHandler: dealGate(gate, 'read') },
            (req) => {
              seen = requireDealHandle(req);
              return { ok: true };
            },
          );
          return Promise.resolve();
        },
      ],
    });
    served = s;
    const res = await s.app.inject({ method: 'GET', url: '/probe/deal-9', headers: asAccount('account-z') });
    expect(res.statusCode).toBe(200);
    expect(seen?.deal_id).toBe('deal-9');
    expect(seen?.action).toBe('read');
    expect(seen?.scope).toEqual({ account_id: 'account-z' });
    expect(seen?.scope).toEqual(seen?.account.scope);
  });

  it('runs AFTER validation, so a malformed :deal_id never reaches an authorization decision', async () => {
    const gate = recordingGate();
    const { s, trip } = await boot(gate);
    const res = await s.app.inject({ method: 'GET', url: '/deals/%20%20', headers: asAccount('account-a') });
    expect(res.statusCode).toBe(400);
    expect(gate.calls).toHaveLength(0);
    expect(trip.handler_calls).toBe(0);
    expect(trip.store_calls).toBe(0);
  });
});

describe('denial (D3 — a deal id is never an existence oracle)', () => {
  const denyBodies: Partial<Record<AuthzDenyReason, string>> = {};

  it('maps every deny reason to its status, once', async () => {
    expect(STATUS_CODE_BY_DENY_REASON).toEqual({
      not_owned: 'not_found',
      deal_not_found: 'not_found',
      grant_expired: 'forbidden',
      role_not_permitted: 'forbidden',
    });

    for (const reason of ['not_owned', 'deal_not_found', 'grant_expired', 'role_not_permitted'] as const) {
      const gate = recordingGate({ outcome: 'deny', reason });
      const { s, trip } = await boot(gate);
      const res = await s.app.inject({ method: 'GET', url: '/deals/deal-1', headers: asAccount('account-b') });
      const expected = STATUS_CODE_BY_DENY_REASON[reason] === 'not_found' ? 404 : 403;
      expect(res.statusCode, reason).toBe(expected);
      const body = JSON.parse(res.body) as ApiErrorBody;
      expect(body.error.code).toBe(STATUS_CODE_BY_DENY_REASON[reason]);
      // A denial never reaches the handler, so it never reaches the store.
      expect(trip.handler_calls, reason).toBe(0);
      denyBodies[reason] = JSON.stringify({ ...body.error, request_id: '<id>' });
      await served?.close();
      served = undefined;
    }

    // Byte-identical: "not yours" and "does not exist" are indistinguishable.
    expect(denyBodies.not_owned).toBe(denyBodies.deal_not_found);
    // And a 403 says only that, never which grant or role failed.
    expect(denyBodies.grant_expired).toBe(denyBodies.role_not_permitted);
    expect(denyBodies.grant_expired).not.toContain('grant');
    expect(denyBodies.grant_expired).not.toContain('role');
  });
});

describe('requireDealHandle', () => {
  it('throws a caught internal when the gate never ran', () => {
    try {
      requireDealHandle({} as never);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { api_error: { code: string } }).api_error.code).toBe('internal');
    }
  });
});
