/**
 * Read-modify-write helpers (docs/design/T-020.md §4.5, §8.7).
 *
 * `@comms`'s `CommsStore` offers NO partial update: deal-level state is written
 * with `putDeal(deal)` and thread state with `putThread(deal_id, thread)`, both
 * of which are "seed/replace". So every mutating handler in this suite opens one
 * `StoreSession` (one transaction in Postgres mode), re-reads inside it, applies
 * the narrowest possible change through one of the pure functions below, and
 * writes the aggregate back with `dealer_threads`, `offers`, `messages`, and
 * `current_offer` carried through UNCHANGED. A handler never writes a thread it
 * did not just read.
 *
 * §8.7, stated here because this is where the cost is paid: that is correct at
 * the AGGREGATE level and lossy at the STORE-INTERNAL level.
 * `InMemoryCommsStore.putThread` rebuilds a thread's rows with `message_ref: ''`
 * and resets its `RollupState`, so a `PATCH process_step` on a live thread
 * preserves everything this API can read while discarding the store's
 * correlation index — after which a later `attachExtractedOffer(deal_id,
 * message_ref, …)` for an already-stored message reports `not_found` and that
 * extraction result is dropped, and ADR-006's newest-wins loses its provenance.
 * No route can avoid this: there is no partial-update method to call and
 * `services/comms` is not this task's to edit. The fix is a `@comms`-owned
 * in-place update; until it lands the behaviour is pinned by a test rather than
 * believed.
 */

import type {
  Deal,
  DealPath,
  DealStatus,
  DealerThread,
  DealershipContact,
  MoneyCents,
  ProcessStep,
  VehicleInstance,
  VehicleTarget,
  YearRange,
} from '@core';

export interface DealFieldPatch {
  readonly path?: DealPath;
  readonly status?: DealStatus;
  readonly budget?: MoneyCents;
  readonly walk_away_number?: MoneyCents;
  /**
   * The soft guide. `@core`: "`year_range` is NOT readonly — it is a soft guide
   * the buyer may widen or narrow", so it is freely editable on the ordinary
   * PATCH path while make/model are not expressible there at all.
   */
  readonly year_range?: YearRange;
  /**
   * The write-once anchor, whole. Supplied ONLY by the target-vehicle route,
   * which is the single place `isTargetVehicleLocked` is consulted.
   */
  readonly target_vehicle?: VehicleTarget;
}

/**
 * Applies a deal-level patch, carrying `dealer_threads`, `offers`,
 * `identity_ref`, `receipt_bundle_id`, `created_at`, and `owner_id` through
 * unchanged. Pure — the input deal is never mutated.
 *
 * `owner_id` is deliberately not patchable from anywhere: it comes from the
 * `DealHandle`'s scope at creation and nothing in this suite can rewrite it.
 */
export function patchDeal(deal: Deal, patch: DealFieldPatch): Deal {
  const target_vehicle: VehicleTarget =
    patch.target_vehicle ??
    (patch.year_range === undefined
      ? deal.target_vehicle
      : { make: deal.target_vehicle.make, model: deal.target_vehicle.model, year_range: patch.year_range });

  return {
    ...deal,
    path: patch.path ?? deal.path,
    status: patch.status ?? deal.status,
    budget: patch.budget ?? deal.budget,
    walk_away_number: patch.walk_away_number ?? deal.walk_away_number,
    target_vehicle,
    dealer_threads: deal.dealer_threads,
    offers: deal.offers,
  };
}

export interface ThreadFieldPatch {
  readonly process_step?: ProcessStep;
  /** Account-PRIVATE (specs/00 "Dealership data tenancy"), embedded in the thread. */
  readonly working_with?: DealershipContact;
  readonly vehicle_instance?: VehicleInstance;
}

/**
 * Applies a thread patch, carrying `messages` and `current_offer` through
 * unchanged. `dealership_id` is NOT patchable (D12): it is the thread's natural
 * key inside the deal (`@comms` `resolveOrCreateThread`, `@store-pg`
 * `thread_per_dealership`, migration `0007`), and a mutable one would move a
 * thread's messages — evidence — under a different dealership's name, which is
 * the one thing an append-only trail must not permit. Correcting a mis-entered
 * dealership is a new thread.
 */
export function patchThread(thread: DealerThread, patch: ThreadFieldPatch): DealerThread {
  return {
    dealership_id: thread.dealership_id,
    process_step: patch.process_step ?? thread.process_step,
    messages: thread.messages,
    ...(patch.vehicle_instance !== undefined
      ? { vehicle_instance: patch.vehicle_instance }
      : thread.vehicle_instance !== undefined
        ? { vehicle_instance: thread.vehicle_instance }
        : {}),
    ...(patch.working_with !== undefined
      ? { working_with: patch.working_with }
      : thread.working_with !== undefined
        ? { working_with: thread.working_with }
        : {}),
    ...(thread.current_offer !== undefined ? { current_offer: thread.current_offer } : {}),
  };
}

/** Replaces one thread inside a deal's `dealer_threads`, preserving order. */
export function withThread(deal: Deal, thread: DealerThread): Deal {
  const index = deal.dealer_threads.findIndex((t) => t.dealership_id === thread.dealership_id);
  const dealer_threads =
    index === -1
      ? [...deal.dealer_threads, thread]
      : deal.dealer_threads.map((t, i) => (i === index ? thread : t));
  return { ...deal, dealer_threads };
}

/** The thread for one dealership, or `undefined`. */
export function findThread(deal: Deal, dealership_id: string): DealerThread | undefined {
  return deal.dealer_threads.find((thread) => thread.dealership_id === dealership_id);
}
