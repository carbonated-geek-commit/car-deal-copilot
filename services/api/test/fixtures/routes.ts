/**
 * Fixture route plugins — the stand-in for T-020's `src/routes/**`, which this
 * task does not own and must not create.
 *
 * They exist so the foundation can be exercised end to end through the exact
 * seam T-020 will use: `buildServer({ routes })`. Every one of them is wired
 * the way the boot audit demands (validation + gate on any `:deal_id` URL), and
 * the deliberately non-compliant ones live in `route-audit.test.ts` where their
 * refusal is the assertion.
 */

import type { Deal } from '@core';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  dealGate,
  dealIdParam,
  dealThreadParams,
  paginationQuery,
  projectDeal,
  projectThread,
  requireAccountContext,
  requireDealHandle,
  throwApi,
  validate,
  type AppContainer,
  type DealAccessGate,
} from '../../src/index.js';

/** Records what a handler managed to reach; a zero here is the assertion. */
export interface Tripwire {
  handler_calls: number;
  store_calls: number;
}

export const newTripwire = (): Tripwire => ({ handler_calls: 0, store_calls: 0 });

export interface FixtureRouteDeps {
  readonly gate: DealAccessGate;
  readonly container: AppContainer;
  /** Seeded through a real `StoreSession`, keyed by deal id. */
  readonly seeds?: readonly Deal[];
  readonly tripwire?: Tripwire;
}

export function fixtureRoutes(deps: FixtureRouteDeps): FastifyPluginAsync {
  const seeds = new Map((deps.seeds ?? []).map((deal) => [deal.id, deal]));
  const trip = deps.tripwire ?? newTripwire();

  return (app: FastifyInstance): Promise<void> => {
    /** Seeds the container's own store through the only door there is. */
    app.post(
      '/deals/:deal_id/seed',
      { preValidation: validate({ params: dealIdParam }), preHandler: dealGate(deps.gate, 'write') },
      async (req: FastifyRequest) => {
        const handle = requireDealHandle(req);
        const deal = seeds.get(handle.deal_id);
        if (deal === undefined) throwApi('not_found', 'no seed registered for this deal');
        const written = await deps.container.sessions.withDeal(handle, (session) => {
          session.store.putDeal(deal as Deal);
          return Promise.resolve(true);
        });
        if (!written.ok) throwApi('internal', 'seed failed');
        return { seeded: handle.deal_id };
      },
    );

    app.get(
      '/deals/:deal_id',
      { preValidation: validate({ params: dealIdParam, query: paginationQuery }), preHandler: dealGate(deps.gate, 'read') },
      async (req: FastifyRequest) => {
        trip.handler_calls += 1;
        const handle = requireDealHandle(req);
        trip.store_calls += 1;
        const deal = await deps.container.read.getDeal(handle);
        if (deal === undefined) throwApi('not_found', 'deal not found');
        return projectDeal(requireAccountContext(req).role, deal as Deal);
      },
    );

    app.get(
      '/deals/:deal_id/threads/:dealership_id',
      { preValidation: validate({ params: dealThreadParams }), preHandler: dealGate(deps.gate, 'read') },
      async (req: FastifyRequest) => {
        const handle = requireDealHandle(req);
        const { dealership_id } = req.params as { dealership_id: string };
        const thread = await deps.container.read.getThread(handle, dealership_id);
        if (thread === undefined) throwApi('not_found', 'thread not found');
        return projectThread(thread as never);
      },
    );

    /** Out-of-enum rejection must land before this handler ever runs (AC-5). */
    app.post(
      '/deals/:deal_id/step',
      {
        preValidation: validate({
          params: dealIdParam,
          body: z.object({ process_step: z.enum(['information_gather', 'deal_negotiation']) }).strict(),
        }),
        preHandler: dealGate(deps.gate, 'write'),
      },
      (req: FastifyRequest) => {
        trip.handler_calls += 1;
        trip.store_calls += 1;
        void deps.container.read.getDeal(requireDealHandle(req));
        return Promise.resolve({ ok: true });
      },
    );

    /** An unhandled throw — the 500 path (§4.3 last row). */
    app.get('/boom', () => {
      throw new Error('a stack that must never reach a caller: SELECT * FROM deals');
    });

    /** A route that violates the envelope on purpose — the D4 backstop. */
    app.get('/rogue-error', (_req, reply) => {
      void reply.code(400);
      return { statusCode: 400, error: 'Bad Request', message: 'framework-shaped' };
    });

    /** A response that leaks — the `preSerialization` guard (AC-9, AC-11). */
    app.get('/leaky', () => ({ id: 'x', ['trans' + 'cript']: 'never' }));

    app.get('/nully', () => ({ id: 'x', sale_price: null }));

    return Promise.resolve();
  };
}
