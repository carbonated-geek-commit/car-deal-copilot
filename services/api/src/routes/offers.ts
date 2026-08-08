/**
 * Offer read routes (docs/design/T-020.md §3.1, D11, D14; AC-11 – AC-15).
 *
 * D14 — there is NO `POST /offers` anywhere in this suite. An offer enters the
 * system only by extraction from a message: ADR-006 puts the rollup in
 * `services/comms/src/rollup.ts` ("the blast radius is rollup.ts alone") and
 * specs/01 W2 makes entry notes-first. A direct offer write would be a second
 * producer of `current_offer` that bypasses the newest-wins accumulation — a
 * second answer to ADR-006's question, reachable only through the API, and
 * therefore the one nobody tests. Offers are read-only here.
 *
 * D11 — `over_walkaway` (the deal's budget ceiling) and `above_market` (this
 * car's own valuation) leave in SEPARATE objects with separate reasons, and no
 * response shape here can fuse them. specs/00 states them as two different
 * questions answered against two different things; a single merged answer is the
 * fusion that table exists to prevent. No ordering, no ranking, and no
 * cross-thread comparison is emitted: specs/00 requires such a comparison to be
 * value-adjusted, and every fair-price answer in this epic is `unevaluable`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { dealGate, requireDealHandle } from '../auth/deal-gate.js';
import { dealThreadParams, type DealThreadParams } from '../validation/schemas.js';
import { validate, validated } from '../validation/plugin.js';
import { assessThread } from './assessment.js';
import { requireOwnedDeal, requireThread, runtimeFor, type ResolvedRouteDeps } from './context.js';
import type { ThreadAssessmentView } from './views.js';

export function offerRoutes(deps: ResolvedRouteDeps): FastifyPluginAsync {
  return (app: FastifyInstance): Promise<void> => {
    const rt = runtimeFor(app, deps);

    app.get(
      '/deals/:deal_id/threads/:dealership_id/current-offer',
      {
        preValidation: validate({ params: dealThreadParams }),
        preHandler: dealGate(rt.gate, 'read'),
      },
      async (req: FastifyRequest): Promise<ThreadAssessmentView> => {
        const handle = requireDealHandle(req);
        const { dealership_id } = validated<DealThreadParams>(req, 'params');
        const deal = await requireOwnedDeal(rt, handle);
        const thread = requireThread(deal, dealership_id);

        const dealership = await rt.directory.get(dealership_id);
        const instance_id = thread.vehicle_instance?.id;
        // ADR-007 — THIS car's own snapshot, keyed by instance id.
        const valuation = instance_id === undefined ? undefined : await rt.valuations.snapshotFor(instance_id);

        // `current_offer` is `@comms`'s per-field newest-wins rollup (ADR-006),
        // copied through `projectOffer` and never merged, recomputed, or
        // reordered here. A thread with no offer yet is a legitimate state and
        // answers `200` with the key absent — not a `404`, and never a zero.
        return assessThread({
          deal,
          thread,
          ...(dealership !== undefined && { dealership }),
          ...(valuation !== undefined && { valuation }),
        });
      },
    );

    return Promise.resolve();
  };
}
