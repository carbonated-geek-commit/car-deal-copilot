/**
 * The GLOBAL dealership directory routes (docs/design/T-020.md §3.1, §5.4, D15;
 * AC-10).
 *
 * specs/00 "Dealership data tenancy" (Q12 AMENDED): names and locations are
 * global — one row per real dealership, shared across accounts so a directory
 * can be batch-loaded later — while the PEOPLE are account-private. Both halves
 * are enforced by SHAPE rather than by a filter someone has to remember:
 *
 *  - `DealershipDirectory` has no method that takes an account, so an
 *    account-scoped dealership read is inexpressible;
 *  - `DealershipPublicView` is T-019's `Pick` over `@core.Dealership`, which has
 *    no account field, no `staff[]`, and no place a contact could sit;
 *  - there is no `/dealerships/:id/contacts` route and there cannot be one:
 *    `@core.DealershipContact` has no id and no account field, existing only as
 *    `DealerThread.working_with` — reachable exclusively through a `DealHandle`.
 *
 * D15 — create-or-find only. No update, no delete. The global table is writable
 * by every account, so an update path is a cross-account mutation surface: one
 * account renaming a row another account's deals depend on. Find-or-create by
 * the natural key is additive and idempotent, and never mutates an existing row.
 *
 * These URLs carry no `:deal_id`, so the boot audit requires no gate — but they
 * are registered INSIDE the api scope, so T-019's account-context hook still
 * runs and an unauthenticated caller gets `401` before validation.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { projectDealership } from '../projection/views.js';
import { dealershipIdParam } from '../validation/schemas.js';
import { validate, validated } from '../validation/plugin.js';
import { conflict, notFound, runtimeFor, type ResolvedRouteDeps } from './context.js';
import { dealershipBody, dealershipSearchQuery, type DealershipBody, type DealershipSearchQuery } from './schemas.js';
import type { DealershipPageView, DealershipPublicView } from './views.js';

const DEFAULT_PAGE = 50;

export function dealershipRoutes(deps: ResolvedRouteDeps): FastifyPluginAsync {
  return (app: FastifyInstance): Promise<void> => {
    const rt = runtimeFor(app, deps);

    app.post(
      '/dealerships',
      { preValidation: validate({ body: dealershipBody }) },
      async (req: FastifyRequest, reply: FastifyReply): Promise<DealershipPublicView> => {
        const body = validated<DealershipBody>(req, 'body');

        const outcome = await rt.directory.ensure({
          name: body.name,
          state: body.state,
          city: body.city,
          zip_code: body.zip_code,
        });

        if (outcome.outcome === 'id_collision') {
          req.log.error({ event: 'dealership_id_collision' });
          throw conflict('a different dealership already holds the identifier this entry would mint');
        }

        // Idempotent by the natural key — two accounts entering the same real
        // dealership converge on ONE global row, which is the point of a shared
        // directory. An existing row is returned, never rewritten (D15).
        void reply.code(outcome.outcome === 'created' ? 201 : 200);
        return projectDealership(outcome.dealership);
      },
    );

    app.get(
      '/dealerships',
      { preValidation: validate({ query: dealershipSearchQuery }) },
      async (req: FastifyRequest): Promise<DealershipPageView> => {
        const query = validated<DealershipSearchQuery>(req, 'query');
        const page = await rt.directory.search(query.q, query.limit ?? DEFAULT_PAGE, query.cursor);
        return {
          dealerships: page.items.map(projectDealership),
          ...(page.next_cursor !== undefined && { next_cursor: page.next_cursor }),
        };
      },
    );

    app.get(
      '/dealerships/:dealership_id',
      { preValidation: validate({ params: dealershipIdParam }) },
      async (req: FastifyRequest): Promise<DealershipPublicView> => {
        const { dealership_id } = validated<{ dealership_id: string }>(req, 'params');
        const dealership = await rt.directory.get(dealership_id);
        if (dealership === undefined) throw notFound();
        return projectDealership(dealership);
      },
    );

    return Promise.resolve();
  };
}
