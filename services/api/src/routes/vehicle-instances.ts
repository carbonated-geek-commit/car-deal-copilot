/**
 * The per-thread vehicle (docs/design/T-020.md §3.1, D3, D4, D5, D6, D8;
 * AC-3, AC-4, AC-5, AC-6).
 *
 * specs/00 "Cardinality invariants": if the buyer enters a `VehicleInstance`
 * whose make/model does not match the deal's anchor, "the app **rejects the
 * entry, highlights that vehicle in red against its VIN, and offers to open a
 * new Deal**. The rejection is a receipt-trail event." specs/01 W2 says the same
 * from the UI side.
 *
 * Three things that look like details and are not:
 *
 *  - **D3** — `make`/`model` are carried at the WIRE ONLY. They are compared to
 *    the anchor and then DISCARDED, because `@core.VehicleInstance` has no field
 *    for them ("Builders must not add them"). A mismatching instance cannot
 *    exist downstream, which is precisely why the check has exactly one correct
 *    home: this boundary, before the value is narrowed into the spine type.
 *
 *  - **D6** — the rejection response does NOT echo the VIN. T-019's
 *    `toEnvelope` strips `details` for every code except `invalid_request`, and
 *    its `ApiFieldIssue` contract is "WHY, never WHAT … never the rejected
 *    value". So the client highlights the vehicle it just submitted (it holds
 *    the VIN), the message names the remedy, and the VIN's DURABLE home is the
 *    receipt entry — where a reload or a second operator can still see which
 *    vehicle was refused. §8.3 records the envelope change that would put it on
 *    the wire, as a T-019-owned, ADR-sized decision.
 *
 *  - **AC-5 / AC-6** — a year outside `year_range` is ACCEPTED (`200`) and a VIN
 *    is accepted exactly as typed. There is no code path in this file from
 *    `yearDrift(...)` or from a VIN's shape to a non-2xx response, and no decode
 *    lookup of any kind is performed or importable here.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import type { DealerThread, VehicleInstance } from '@core';

import { dealGate, requireDealHandle } from '../auth/deal-gate.js';
import { requireAccountContext } from '../context/account-context.js';
import { projectThread } from '../projection/views.js';
import { dealThreadParams, type DealThreadParams } from '../validation/schemas.js';
import { validate, validated } from '../validation/plugin.js';
import { patchThread } from './aggregate.js';
import { matchesAnchor } from './anchor.js';
import {
  requireOwnedDeal,
  requireThread,
  runGuarded,
  runtimeFor,
  unprocessable,
  type Guarded,
  type ResolvedRouteDeps,
} from './context.js';
import { rejectionEntry } from './receipt-events.js';
import { vehicleInstanceBody, type VehicleInstanceBody } from './schemas.js';
import type { DealerThreadView } from './views.js';

const MISMATCH_MESSAGE =
  "this vehicle's make/model does not match the deal's vehicle; it cannot join this deal — open a new deal to pursue it";

export function vehicleInstanceRoutes(deps: ResolvedRouteDeps): FastifyPluginAsync {
  return (app: FastifyInstance): Promise<void> => {
    const rt = runtimeFor(app, deps);

    app.put(
      '/deals/:deal_id/threads/:dealership_id/vehicle-instance',
      {
        preValidation: validate({ params: dealThreadParams, body: vehicleInstanceBody }),
        preHandler: dealGate(rt.gate, 'write'),
      },
      async (req: FastifyRequest): Promise<DealerThreadView> => {
        const handle = requireDealHandle(req);
        const { dealership_id } = validated<DealThreadParams>(req, 'params');
        const body = validated<VehicleInstanceBody>(req, 'body');
        const role = requireAccountContext(req).role;

        const updated = await runGuarded<DealerThread>(rt, req, handle, async (session) => {
          const deal = await requireOwnedDeal(rt, handle);
          const thread = requireThread(deal, dealership_id);

          const match = matchesAnchor(deal.target_vehicle, { make: body.make, model: body.model });
          if (!match.ok) {
            // Nothing is written. `runGuarded` rolls the session back and only
            // then appends the mark, in its own unit of work (D8).
            const rejection: Guarded<DealerThread> = {
              kind: 'reject',
              error: unprocessable(MISMATCH_MESSAGE).api_error,
              mark: {
                ...(deal.receipt_bundle_id !== undefined && {
                  receipt_bundle_id: deal.receipt_bundle_id,
                }),
                entry: rejectionEntry(
                  'instance_mismatch',
                  {
                    deal_id: deal.id,
                    dealership_id,
                    // The VIN's durable home (D6). Absent VINs are normal (Q16).
                    ...(body.vin !== undefined && { vin: body.vin }),
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
                event: 'vehicle_anchor_reject',
                // WHICH FIELD mismatched, and the ids. Never the VIN, never a
                // submitted value — §4.6 forbids both in a log line, and the
                // trail is account-scoped storage while a log aggregator is not.
                detail: { deal_id: deal.id, dealership_id, field: match.field },
              },
            };
            return rejection;
          }

          // The matching case stores the spine shape UNCHANGED: `make` and
          // `model` are dropped here and exist nowhere downstream (D3).
          const instance: VehicleInstance = {
            id: rt.ids.vehicleInstanceId(deal.id, dealership_id),
            // User-entered and unvalidated (Q16). No decode, no checksum.
            ...(body.vin !== undefined && { vin: body.vin }),
            year: body.year,
            ...(body.trim !== undefined && { trim: body.trim }),
            ...(body.mileage !== undefined && { mileage: body.mileage }),
            condition: body.condition,
            additions: [...(body.additions ?? [])],
          };

          const next = patchThread(thread, { vehicle_instance: instance });
          session.store.putThread(deal.id, next);

          // Year drift is a SOFT GUIDE: noted, never a rejection (AC-5). The
          // advisory itself is surfaced on the war-room view.
          if (deal.target_vehicle.year_range !== undefined) {
            const range = deal.target_vehicle.year_range;
            if (instance.year < range.from || instance.year > range.to) {
              req.log.info({ event: 'year_drift', deal_id: deal.id, dealership_id });
            }
          }

          return { kind: 'ok', value: next };
        });

        return projectThread(updated);
      },
    );

    return Promise.resolve();
  };
}
