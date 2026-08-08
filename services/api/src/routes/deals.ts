/**
 * Deal routes (docs/design/T-020.md §3.1, D1; AC-1, AC-14, AC-16).
 *
 * D1 — why a deal is created by `PUT /deals/:deal_id` and not `POST /deals`.
 * T-019's write seam is `StoreSessionFactory.forDeal(handle)`, and a
 * `DealHandle` is minted ONLY by the `dealGate` `preHandler`, which reads
 * `:deal_id` out of validated params. A `POST /deals` has no `:deal_id`,
 * therefore no handle, therefore NO REACHABLE STORE — creation is literally
 * inexpressible through the foundation's only door. `PUT` on a caller-chosen id
 * restores it, satisfies the boot audit (validation + gate both present), and
 * makes creation idempotent by its natural key at zero cost. `owner_id` is
 * taken from the handle's scope and NEVER from the body, so a created deal
 * always belongs to the caller.
 *
 * §8.2 records the consequence for E3: the real gate must permit `write` on an
 * id that does not exist yet, or T-019 must gain a `create` action.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { Deal, Dealership, ValuationSnapshot } from '@core';

import { dealGate, requireDealHandle } from '../auth/deal-gate.js';
import { requireAccountContext } from '../context/account-context.js';
import { ApiErrorException } from '../errors/envelope.js';
import { fromReceiptError } from '../errors/mapping.js';
import { projectDeal } from '../projection/views.js';
import { dealIdParam, paginationQuery } from '../validation/schemas.js';
import { validate, validated } from '../validation/plugin.js';
import { patchDeal } from './aggregate.js';
import { assessDealOffers, buildWarRoom } from './assessment.js';
import {
  conflict,
  notFound,
  requireOwnedDeal,
  runWrite,
  runtimeFor,
  type ResolvedRouteDeps,
  type RouteRuntime,
} from './context.js';
import { patchDealBody, putDealBody, type PatchDealBody, type PutDealBody } from './schemas.js';
import type { DealOffersView, DealView, ReceiptTrailView, WarRoomView } from './views.js';

const DEFAULT_PAGE = 50;

/** True when a replayed `PUT` describes exactly the state already stored. */
function isIdenticalCreate(deal: Deal, body: PutDealBody): boolean {
  const stored_range = deal.target_vehicle.year_range;
  const sent_range = body.target_vehicle.year_range;
  const same_range =
    stored_range === undefined || sent_range === undefined
      ? stored_range === undefined && sent_range === undefined
      : stored_range.from === sent_range.from && stored_range.to === sent_range.to;

  return (
    deal.path === body.path &&
    deal.budget === body.budget &&
    deal.walk_away_number === body.walk_away_number &&
    deal.target_vehicle.make === body.target_vehicle.make &&
    deal.target_vehicle.model === body.target_vehicle.model &&
    same_range
  );
}

/** The GLOBAL headers plus each car's own snapshot, for one deal's threads. */
async function warRoomInputs(
  rt: RouteRuntime,
  deal: Deal,
): Promise<{ dealerships: Map<string, Dealership>; valuations: Map<string, ValuationSnapshot> }> {
  const dealerships = new Map<string, Dealership>();
  const valuations = new Map<string, ValuationSnapshot>();

  for (const thread of deal.dealer_threads) {
    const dealership = await rt.directory.get(thread.dealership_id);
    if (dealership !== undefined) dealerships.set(thread.dealership_id, dealership);

    const instance_id = thread.vehicle_instance?.id;
    if (instance_id === undefined) continue;
    // ADR-007 — keyed by `VehicleInstance.id`, never by make/model.
    const snapshot = await rt.valuations.snapshotFor(instance_id);
    if (snapshot !== undefined) valuations.set(instance_id, snapshot);
  }

  return { dealerships, valuations };
}

export function dealRoutes(deps: ResolvedRouteDeps): FastifyPluginAsync {
  return (app: FastifyInstance): Promise<void> => {
    const rt = runtimeFor(app, deps);

    // ---- create / replace (D1) -------------------------------------------
    app.put(
      '/deals/:deal_id',
      {
        preValidation: validate({ params: dealIdParam, body: putDealBody }),
        preHandler: dealGate(rt.gate, 'write'),
      },
      async (req: FastifyRequest, reply: FastifyReply): Promise<DealView> => {
        const handle = requireDealHandle(req);
        const body = validated<PutDealBody>(req, 'body');
        const role = requireAccountContext(req).role;

        const outcome = await runWrite(rt, handle, async (session) => {
          // Deliberately the UNSCOPED read: `ScopedReadModel` reports a foreign
          // account's deal as `undefined`, and treating that as "absent" here
          // would let a `PUT` overwrite another account's deal. Existence is
          // checked first, ownership second, and a foreign row answers `404` —
          // the same answer an absent one gives (T-019 D3).
          const stored = session.store.getDeal(handle.deal_id);
          if (stored !== undefined) {
            if (stored.owner_id !== handle.scope.account_id) throw notFound();
            if (!isIdenticalCreate(stored, body)) {
              req.log.warn({ event: 'deal_create_conflict', deal_id: handle.deal_id });
              throw conflict('a different deal already exists at this id; PATCH it instead of replacing it');
            }
            req.log.info({ event: 'deal_create_replay', deal_id: handle.deal_id });
            return Promise.resolve({ created: false, deal: stored });
          }

          const deal: Deal = {
            id: handle.deal_id,
            // From the handle's scope, never from the body (§5.9).
            owner_id: handle.scope.account_id,
            path: body.path,
            // `draft` is the only status in which `target_vehicle` is settable.
            status: 'draft',
            target_vehicle: {
              make: body.target_vehicle.make,
              model: body.target_vehicle.model,
              ...(body.target_vehicle.year_range !== undefined && {
                year_range: body.target_vehicle.year_range,
              }),
            },
            budget: body.budget,
            walk_away_number: body.walk_away_number,
            dealer_threads: [],
            offers: [],
            receipt_bundle_id: rt.ids.receiptBundleId(handle.deal_id),
            created_at: rt.now(),
          };
          session.store.putDeal(deal);
          return Promise.resolve({ created: true, deal });
        });

        void reply.code(outcome.created ? 201 : 200);
        return projectDeal(role, outcome.deal);
      },
    );

    app.get(
      '/deals/:deal_id',
      {
        preValidation: validate({ params: dealIdParam }),
        preHandler: dealGate(rt.gate, 'read'),
      },
      async (req: FastifyRequest): Promise<DealView> => {
        const handle = requireDealHandle(req);
        const deal = await requireOwnedDeal(rt, handle);
        return projectDeal(requireAccountContext(req).role, deal);
      },
    );

    app.patch(
      '/deals/:deal_id',
      {
        preValidation: validate({ params: dealIdParam, body: patchDealBody }),
        preHandler: dealGate(rt.gate, 'write'),
      },
      async (req: FastifyRequest): Promise<DealView> => {
        const handle = requireDealHandle(req);
        const body = validated<PatchDealBody>(req, 'body');
        const role = requireAccountContext(req).role;

        const updated = await runWrite(rt, handle, async (session) => {
          const deal = await requireOwnedDeal(rt, handle);
          // `make`/`model` are unrepresentable in this schema (§5.1 layer 2), so
          // the common edit path cannot reach the write-once invariant at all.
          const next = patchDeal(deal, {
            ...(body.path !== undefined && { path: body.path }),
            ...(body.status !== undefined && { status: body.status }),
            ...(body.budget !== undefined && { budget: body.budget }),
            ...(body.walk_away_number !== undefined && { walk_away_number: body.walk_away_number }),
            ...(body.target_vehicle?.year_range !== undefined && {
              year_range: body.target_vehicle.year_range,
            }),
          });
          session.store.putDeal(next);
          return next;
        });

        return projectDeal(role, updated);
      },
    );

    // ---- the war-room read surface (specs/01 W2) --------------------------
    app.get(
      '/deals/:deal_id/war-room',
      {
        preValidation: validate({ params: dealIdParam }),
        preHandler: dealGate(rt.gate, 'read'),
      },
      async (req: FastifyRequest): Promise<WarRoomView> => {
        const handle = requireDealHandle(req);
        const deal = await requireOwnedDeal(rt, handle);
        const { dealerships, valuations } = await warRoomInputs(rt, deal);
        // `qualified_apr` is deliberately never supplied: specs/01 "Credit data
        // residency" allows only the prequal summary and no prequal store is
        // reachable in this epic, so `rate_markup` reports
        // `unevaluable / no_qualified_apr` rather than defaulting the input.
        return buildWarRoom({
          role: requireAccountContext(req).role,
          deal,
          dealerships,
          valuations,
        });
      },
    );

    // ---- the append-only trail -------------------------------------------
    app.get(
      '/deals/:deal_id/receipt',
      {
        preValidation: validate({ params: dealIdParam, query: paginationQuery }),
        preHandler: dealGate(rt.gate, 'read'),
      },
      async (req: FastifyRequest): Promise<ReceiptTrailView> => {
        const handle = requireDealHandle(req);
        const deal = await requireOwnedDeal(rt, handle);
        const query = validated<{ limit?: number; cursor?: string }>(req, 'query');
        const limit = query.limit ?? DEFAULT_PAGE;

        const bundle = deal.receipt_bundle_id ?? rt.ids.receiptBundleId(deal.id);
        if (deal.receipt_bundle_id === undefined) {
          req.log.error({ event: 'receipt_bundle_missing', deal_id: deal.id });
        }

        const read = await rt.container.receiptsFor(handle.scope).read(bundle);
        // A trail that cannot be read is not an empty trail. `@receipt` reports
        // failures as values, and `errors/mapping.ts` is the only permitted
        // translator of one — an unreadable store is `unavailable`, never `[]`.
        if (!read.ok) throw new ApiErrorException(fromReceiptError(read.error));

        const parsed = query.cursor === undefined ? -1 : Number.parseInt(query.cursor, 10);
        const after = Number.isNaN(parsed) ? -1 : parsed;
        const remaining = read.value.filter((entry) => entry.seq > after);
        const page = remaining.slice(0, limit);
        const next = remaining.length > limit ? page[page.length - 1]?.seq : undefined;

        return {
          receipt_bundle_id: bundle,
          entries: page,
          ...(next !== undefined && { next_cursor: String(next) }),
        };
      },
    );

    // ---- the flattened offer history -------------------------------------
    app.get(
      '/deals/:deal_id/offers',
      {
        preValidation: validate({ params: dealIdParam }),
        preHandler: dealGate(rt.gate, 'read'),
      },
      async (req: FastifyRequest): Promise<DealOffersView> => {
        const handle = requireDealHandle(req);
        const deal = await requireOwnedDeal(rt, handle);
        return assessDealOffers(deal);
      },
    );

    return Promise.resolve();
  };
}
