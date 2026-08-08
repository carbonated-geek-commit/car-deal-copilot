/**
 * The write-once anchor (docs/design/T-020.md §3.1, §5.1, D5, D8; AC-2, AC-4).
 *
 * specs/00 "Cardinality invariants": "`target_vehicle.make`/`model` are
 * write-once — settable while the deal is `draft`, immutable once any offer is
 * attached." Q11 (AMENDED) adds the reason: a deal anchored to two different
 * vehicles has nothing to compare against, so "is this a good price?" stops
 * having an answer.
 *
 * The predicate is `@core.isTargetVehicleLocked`, IMPORTED and never
 * reimplemented. `packages/core/src/domain.ts` names this task as its consumer
 * ("T-020 rejects the write and records the rejection as a receipt-trail
 * event") and migration `0014` mirrors the same three disjuncts in the same
 * order. Two enforcement sites, one predicate — and a static test in
 * `test/routes/**` asserts no rival predicate exists here.
 *
 * D5 — the rejection is `409 conflict`, not `422`. `errors/envelope.ts` fixes
 * the vocabulary: `conflict // 409 — write-once / uniqueness violated`. (T-019's
 * §5.6 prose said `422`; its shipped code table says `409`, and the shipped
 * artifact wins. §8.3 records the discrepancy for the lead.)
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { isTargetVehicleLocked } from '@core';
import type { Deal } from '@core';

import { dealGate, requireDealHandle } from '../auth/deal-gate.js';
import { requireAccountContext } from '../context/account-context.js';
import { projectDeal } from '../projection/views.js';
import { dealIdParam } from '../validation/schemas.js';
import { validate, validated } from '../validation/plugin.js';
import { patchDeal } from './aggregate.js';
import {
  conflict,
  requireOwnedDeal,
  runGuarded,
  runtimeFor,
  type Guarded,
  type ResolvedRouteDeps,
} from './context.js';
import { rejectionEntry } from './receipt-events.js';
import { targetVehicleBody, type TargetVehicleBody } from './schemas.js';
import type { DealView } from './views.js';

const LOCKED_MESSAGE =
  "the deal's make and model are write-once and are fixed once any offer is attached; open a new deal for a different vehicle";

export function targetVehicleRoutes(deps: ResolvedRouteDeps): FastifyPluginAsync {
  return (app: FastifyInstance): Promise<void> => {
    const rt = runtimeFor(app, deps);

    app.put(
      '/deals/:deal_id/target-vehicle',
      {
        preValidation: validate({ params: dealIdParam, body: targetVehicleBody }),
        preHandler: dealGate(rt.gate, 'write'),
      },
      async (req: FastifyRequest): Promise<DealView> => {
        const handle = requireDealHandle(req);
        const body = validated<TargetVehicleBody>(req, 'body');
        const role = requireAccountContext(req).role;

        const updated = await runGuarded<Deal>(rt, req, handle, async (session) => {
          const deal = await requireOwnedDeal(rt, handle);

          if (isTargetVehicleLocked(deal)) {
            // NOTHING is written on this path. The mark is appended by
            // `runGuarded` after the session is rolled back (D8), because an
            // append inside the doomed transaction would roll back with it and
            // the substitution attempt would vanish.
            const mark = {
              ...(deal.receipt_bundle_id !== undefined && { receipt_bundle_id: deal.receipt_bundle_id }),
              entry: rejectionEntry(
                'target_vehicle_write_once',
                {
                  deal_id: deal.id,
                  submitted_make: body.make,
                  submitted_model: body.model,
                  anchor_make: deal.target_vehicle.make,
                  anchor_model: deal.target_vehicle.model,
                  ...(body.client_attempt_ref !== undefined && {
                    client_attempt_ref: body.client_attempt_ref,
                  }),
                  occurred_at: rt.now(),
                },
                role,
              ),
              event: 'target_vehicle_write_once_reject',
              // Ids only — never the submitted values (§4.6).
              //
              // Design §4.2 also wanted a "locked-by" label here. It is
              // DELIBERATELY absent: naming which disjunct fired means
              // restating part of `isTargetVehicleLocked` at a second site, and
              // `test/cardinality.test.ts` ("has no rival implementation in
              // this service") is right to refuse that. One predicate, one
              // place. The deal's `status` and `offers` are already on the
              // `GET /deals/:deal_id` response, so an operator can see which
              // disjunct held without this service duplicating the rule.
              detail: { deal_id: deal.id },
            };
            const rejection: Guarded<Deal> = {
              kind: 'reject',
              error: conflict(LOCKED_MESSAGE).api_error,
              mark,
            };
            return rejection;
          }

          const next = patchDeal(deal, {
            target_vehicle: {
              make: body.make,
              model: body.model,
              ...(body.year_range !== undefined && { year_range: body.year_range }),
            },
          });
          session.store.putDeal(next);
          return { kind: 'ok', value: next };
        });

        return projectDeal(role, updated);
      },
    );

    return Promise.resolve();
  };
}
