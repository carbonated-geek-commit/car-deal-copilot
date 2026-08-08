/**
 * Dealer-thread routes (docs/design/T-020.md §3.1, D12, D15; AC-9, AC-10).
 *
 * specs/01 W2 asks for one make/model with many dealerships side by side, each
 * column carrying "who you're working with" and a "process step". Those two,
 * plus the thread's `vehicle_instance` (its own route) and its `dealership_id`,
 * are the whole mutable surface of a `DealerThread`.
 *
 * D12 — `dealership_id` is SET at creation and is not mutable afterwards.
 * AC-9's "allow updating" is satisfied by the create/bind route that sets it.
 * The store key is `(deal_id, dealership_id)` (`@comms` `resolveOrCreateThread`,
 * `@store-pg` `thread_per_dealership`, migration `0007`); there is no delete on
 * any port and the boot audit refuses `DELETE` outright. A mutable
 * `dealership_id` would move a thread's messages — evidence — under a different
 * dealership's name, which is the one thing an append-only trail must not
 * permit. Correcting a mis-entered dealership is a new thread.
 *
 * §5.4 — the account-private half lives HERE and only here. `working_with` is
 * written and read through a `DealHandle` the gate minted, and
 * `@core.DealershipContact` has no id and no account field, so a free-standing,
 * globally addressable contact route is not merely forbidden: it is
 * unrepresentable.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { DealerThread, DealershipContact } from '@core';

import { dealGate, requireDealHandle } from '../auth/deal-gate.js';
import { projectThread } from '../projection/views.js';
import { dealThreadParams, processStepBody, type DealThreadParams } from '../validation/schemas.js';
import { validate, validated } from '../validation/plugin.js';
import { findThread, patchThread } from './aggregate.js';
import {
  notFound,
  requireOwnedDeal,
  requireThread,
  runWrite,
  runtimeFor,
  type ResolvedRouteDeps,
} from './context.js';
import { putThreadBody, workingWithBody, type PutThreadBody, type WorkingWithBody } from './schemas.js';
import type { DealerThreadView } from './views.js';

const contactFrom = (body: WorkingWithBody): DealershipContact => ({
  name: body.name,
  role: body.role,
  ...(body.phone !== undefined && { phone: body.phone }),
  ...(body.email !== undefined && { email: body.email }),
});

export function threadRoutes(deps: ResolvedRouteDeps): FastifyPluginAsync {
  return (app: FastifyInstance): Promise<void> => {
    const rt = runtimeFor(app, deps);

    // ---- create / ensure --------------------------------------------------
    app.put(
      '/deals/:deal_id/threads/:dealership_id',
      {
        preValidation: validate({ params: dealThreadParams, body: putThreadBody }),
        preHandler: dealGate(rt.gate, 'write'),
      },
      async (req: FastifyRequest, reply: FastifyReply): Promise<DealerThreadView> => {
        const handle = requireDealHandle(req);
        const { dealership_id } = validated<DealThreadParams>(req, 'params');
        // The body is optional on a create-or-ensure: a bare `PUT` binds the
        // thread with the first-contact defaults `@comms` itself uses.
        const body: NonNullable<PutThreadBody> = validated<PutThreadBody>(req, 'body') ?? {};

        const outcome = await runWrite(rt, handle, async (session) => {
          const deal = await requireOwnedDeal(rt, handle);

          // The dealership must already exist in the GLOBAL directory. This
          // service never mints one as a side effect of threading — the same
          // rule `@comms` states for inbound routing ("never a newly minted
          // `Dealership`; that table is global").
          const dealership = await rt.directory.get(dealership_id);
          if (dealership === undefined) {
            req.log.warn({ event: 'unknown_dealership', deal_id: deal.id, dealership_id });
            throw notFound();
          }

          const existing = findThread(deal, dealership_id);
          const thread: DealerThread =
            existing === undefined
              ? {
                  dealership_id,
                  process_step: body.process_step ?? 'information_gather',
                  messages: [],
                  ...(body.working_with !== undefined && { working_with: contactFrom(body.working_with) }),
                }
              : patchThread(existing, {
                  ...(body.process_step !== undefined && { process_step: body.process_step }),
                  ...(body.working_with !== undefined && { working_with: contactFrom(body.working_with) }),
                });

          session.store.putThread(deal.id, thread);
          return { created: existing === undefined, thread };
        });

        void reply.code(outcome.created ? 201 : 200);
        return projectThread(outcome.thread);
      },
    );

    app.get(
      '/deals/:deal_id/threads/:dealership_id',
      {
        preValidation: validate({ params: dealThreadParams }),
        preHandler: dealGate(rt.gate, 'read'),
      },
      async (req: FastifyRequest): Promise<DealerThreadView> => {
        const handle = requireDealHandle(req);
        const { dealership_id } = validated<DealThreadParams>(req, 'params');
        const deal = await requireOwnedDeal(rt, handle);
        return projectThread(requireThread(deal, dealership_id));
      },
    );

    // ---- process step, across the six-step sequence (Q12) -----------------
    app.patch(
      '/deals/:deal_id/threads/:dealership_id',
      {
        preValidation: validate({ params: dealThreadParams, body: processStepBody }),
        preHandler: dealGate(rt.gate, 'write'),
      },
      async (req: FastifyRequest): Promise<DealerThreadView> => {
        const handle = requireDealHandle(req);
        const { dealership_id } = validated<DealThreadParams>(req, 'params');
        const body = validated<{ process_step: DealerThread['process_step'] }>(req, 'body');

        const updated = await runWrite(rt, handle, async (session) => {
          const deal = await requireOwnedDeal(rt, handle);
          // Re-read INSIDE the session and write back the narrowest change,
          // carrying `messages`, `current_offer`, and `vehicle_instance`
          // through unchanged (§4.5).
          const thread = patchThread(requireThread(deal, dealership_id), {
            process_step: body.process_step,
          });
          session.store.putThread(deal.id, thread);
          return thread;
        });

        return projectThread(updated);
      },
    );

    // ---- the account-private contact (specs/00 "Dealership data tenancy") --
    app.put(
      '/deals/:deal_id/threads/:dealership_id/working-with',
      {
        preValidation: validate({ params: dealThreadParams, body: workingWithBody }),
        preHandler: dealGate(rt.gate, 'write'),
      },
      async (req: FastifyRequest): Promise<DealerThreadView> => {
        const handle = requireDealHandle(req);
        const { dealership_id } = validated<DealThreadParams>(req, 'params');
        const body = validated<WorkingWithBody>(req, 'body');

        const updated = await runWrite(rt, handle, async (session) => {
          const deal = await requireOwnedDeal(rt, handle);
          const thread = patchThread(requireThread(deal, dealership_id), {
            working_with: contactFrom(body),
          });
          session.store.putThread(deal.id, thread);
          return thread;
        });

        return projectThread(updated);
      },
    );

    return Promise.resolve();
  };
}
