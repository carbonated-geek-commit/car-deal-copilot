/**
 * Evaluability derivation and the two-question split (docs/design/T-020.md
 * §2.4, D9, D10, D11; ADR-005, ADR-007; AC-11, AC-12, AC-13, AC-15).
 *
 * Pure — no I/O, no clock, no mutation of any argument.
 *
 * D9 — why `unevaluable` is derived HERE and not imported from `@flag-engine`.
 * T-019's static suite forbids `@flag-engine` in `services/api/src/**`, and that
 * rule is right about VERDICTS: the API must not answer "is this offer bad?".
 * But `unevaluable` is not a verdict. ADR-005 §2 defines it as the statement of
 * WHICH REQUIRED INPUTS ARE ABSENT, and which inputs this service could supply
 * is a fact this service owns. Deriving it here keeps the production path
 * verdict-free; a parity test in `test/routes/**` — the one place `@flag-engine`
 * is imported — pins this function's answer to `evaluateOffer(...).unevaluable`
 * over the whole presence matrix, so drift is a TEST FAILURE rather than a
 * silent divergence.
 *
 * D10 — three states, and never a fourth. `flagged | unevaluable |
 * not_evaluated`. `services/comms/src/rollup.ts` and
 * `packages/offer-extraction/src/extract.ts` both hard-code `flags: []`, so no
 * stored `Offer` in this epic carries a flag; reading that empty list as
 * "evaluated, nothing fired" would report every offer as fine, which specs/00
 * forbids outright.
 *
 * D11 — `over_walkaway` and `above_market` leave this module in SEPARATE
 * objects with separate reasons. specs/00 "Budget ceiling vs. fair price" is a
 * two-question table: "Can I afford it?" is deal-level against
 * `walk_away_number`; "Is this a good price?" is per-`VehicleInstance` against
 * that car's own snapshot. No function here returns a fused answer, and no
 * response type has a field one could occupy.
 */

import { OFFER_FLAGS } from '@core';
import type { Deal, DealerThread, Dealership, Offer, OfferFlag, ValuationSnapshot } from '@core';

import { projectDeal, projectDealership, projectOffer } from '../projection/views.js';
import { omitAbsent } from '../projection/guards.js';
import type { ActorRole } from '../context/account-context.js';
import { yearDrift } from './anchor.js';
import type {
  BudgetSignalView,
  DealOffersView,
  FairPriceSignalView,
  FlagStatusView,
  OfferAssessmentView,
  ThreadAssessmentView,
  UnevaluableReason,
  WarRoomView,
} from './views.js';

export interface EvaluabilityInput {
  readonly offer?: Offer;
  /** `PrequalResult.qualified_apr`. Never reachable in E2 — see §8.8. */
  readonly qualified_apr?: number;
  readonly valuation?: ValuationSnapshot;
  readonly vehicle_instance_id?: string;
}

export interface Evaluability {
  /** In `OFFER_FLAGS` order, duplicate-free — the same ordering the engine emits. */
  readonly unevaluable: readonly OfferFlag[];
  readonly reasons: ReadonlyMap<OfferFlag, UnevaluableReason>;
}

/**
 * ADR-005's set, from INPUT PRESENCE alone.
 *
 * The required-input rules are `@flag-engine`'s, restated as presence checks and
 * pinned by the parity test:
 *   payment_packing — `term_months`
 *   rate_markup     — `apr` AND `qualified_apr`
 *   junk_fee        — none (`fees[]` is a required spine field ⇒ always evaluable)
 *   over_walkaway   — `sale_price`
 *   above_market    — `sale_price` AND a snapshot with a `retail` band, for THIS
 *                     instance (ADR-007; a snapshot belonging to another car is
 *                     unevaluable, never a comparison against the wrong car)
 *
 * The `reasons` map adds what the engine does not carry: WHICH input was
 * missing, so the war room can say "no valuation yet" instead of an
 * undifferentiated shrug. For `above_market` the valuation-side reasons are
 * reported ahead of the price, because a missing valuation is the actionable
 * one — a buyer can go get a valuation.
 */
export function deriveEvaluability(input: EvaluabilityInput): Evaluability {
  const reasons = new Map<OfferFlag, UnevaluableReason>();
  const offer = input.offer;

  if (offer === undefined) {
    for (const flag of OFFER_FLAGS) reasons.set(flag, 'no_offer');
    return { unevaluable: [...OFFER_FLAGS], reasons };
  }

  if (offer.term_months === undefined) reasons.set('payment_packing', 'no_term');

  if (offer.apr === undefined) reasons.set('rate_markup', 'no_offer_apr');
  else if (input.qualified_apr === undefined) reasons.set('rate_markup', 'no_qualified_apr');

  // junk_fee is deliberately absent: `fees[]` is always present, so an empty
  // list means "evaluated, nothing fired" for that flag alone — and this epic
  // never evaluates, which is why it surfaces as `not_evaluated`, not as clear.

  if (offer.sale_price === undefined) reasons.set('over_walkaway', 'no_stated_price');

  const valuation = input.valuation;
  const instance_id = input.vehicle_instance_id;
  if (valuation === undefined) {
    reasons.set('above_market', instance_id === undefined ? 'no_vehicle_instance' : 'no_valuation');
  } else if (instance_id !== undefined && valuation.vehicle_instance_id !== instance_id) {
    reasons.set('above_market', 'valuation_instance_mismatch');
  } else if (valuation.retail === undefined) {
    reasons.set('above_market', 'no_retail_band');
  } else if (offer.sale_price === undefined) {
    reasons.set('above_market', 'no_stated_price');
  }

  return { unevaluable: OFFER_FLAGS.filter((flag) => reasons.has(flag)), reasons };
}

const statusFor = (
  flag: OfferFlag,
  flagged: ReadonlySet<OfferFlag>,
  reasons: ReadonlyMap<OfferFlag, UnevaluableReason>,
): FlagStatusView => {
  if (flagged.has(flag)) return { flag, status: 'flagged' };
  const reason = reasons.get(flag);
  if (reason !== undefined) return { flag, status: 'unevaluable', reason };
  return { flag, status: 'not_evaluated' };
};

/** AC-11 — the five-flag set including `above_market`, plus ADR-005's unevaluable set. */
export function assessOffer(input: EvaluabilityInput & { readonly offer: Offer }): OfferAssessmentView {
  const { unevaluable, reasons } = deriveEvaluability(input);
  const flagged = new Set(input.offer.flags);
  return {
    offer: projectOffer(input.offer),
    // Copied from the domain, never recomputed (T-019 D10, ADR-006, ADR-007).
    flags: [...input.offer.flags],
    unevaluable,
    statuses: OFFER_FLAGS.map((flag) => statusFor(flag, flagged, reasons)),
  };
}

/** "Can I afford it?" — DEAL-level, against `walk_away_number` only (D11). */
export function budgetSignal(input: EvaluabilityInput): BudgetSignalView {
  const { reasons } = deriveEvaluability(input);
  const flagged = new Set(input.offer?.flags ?? []);
  const status = statusFor('over_walkaway', flagged, reasons);
  return omitAbsent({ over_walkaway: status.status, reason: status.reason }) as BudgetSignalView;
}

/** "Is this a good price?" — PER `VehicleInstance`, against its own snapshot (D11, ADR-007). */
export function fairPriceSignal(input: EvaluabilityInput): FairPriceSignalView {
  const { reasons } = deriveEvaluability(input);
  const flagged = new Set(input.offer?.flags ?? []);
  const status = statusFor('above_market', flagged, reasons);
  return omitAbsent({
    above_market: status.status,
    reason: status.reason,
    vehicle_instance_id: input.vehicle_instance_id,
    // Provenance only — an adapter id and a timestamp, never a provider payload.
    valuation_source: input.valuation?.source,
    valuation_captured_at: input.valuation?.captured_at,
  }) as FairPriceSignalView;
}

export interface ThreadAssessmentInput {
  readonly deal: Deal;
  readonly thread: DealerThread;
  /** The GLOBAL row. Absent when the directory holds none — never fabricated. */
  readonly dealership?: Dealership;
  readonly valuation?: ValuationSnapshot;
  readonly qualified_apr?: number;
}

/** Assembles one war-room column. Pure. */
export function assessThread(input: ThreadAssessmentInput): ThreadAssessmentView {
  const { deal, thread } = input;
  const instance = thread.vehicle_instance;
  const offer = thread.current_offer;

  const evaluability: EvaluabilityInput = {
    ...(offer !== undefined && { offer }),
    ...(input.qualified_apr !== undefined && { qualified_apr: input.qualified_apr }),
    ...(input.valuation !== undefined && { valuation: input.valuation }),
    ...(instance !== undefined && { vehicle_instance_id: instance.id }),
  };

  return omitAbsent({
    dealership_id: thread.dealership_id,
    dealership: input.dealership === undefined ? undefined : projectDealership(input.dealership),
    process_step: thread.process_step,
    // Account-PRIVATE and reachable only here — inside a deal the gate has
    // already authorized for this account (specs/00 "Dealership data tenancy").
    working_with: thread.working_with === undefined ? undefined : omitAbsent({ ...thread.working_with }),
    vehicle_instance: instance === undefined ? undefined : omitAbsent({ ...instance }),
    current_offer: offer === undefined ? undefined : assessOffer({ ...evaluability, offer }),
    budget: budgetSignal(evaluability),
    fair_price: fairPriceSignal(evaluability),
    // Soft guide, never a rejection (AC-5).
    year_drift: instance === undefined ? undefined : yearDrift(deal.target_vehicle, instance),
  }) as ThreadAssessmentView;
}

export interface WarRoomInput {
  readonly role: ActorRole;
  readonly deal: Deal;
  /** `dealership_id` → the GLOBAL row, for the threads the directory knows. */
  readonly dealerships: ReadonlyMap<string, Dealership>;
  /** `VehicleInstance.id` → that car's own snapshot (ADR-007). */
  readonly valuations: ReadonlyMap<string, ValuationSnapshot>;
  readonly qualified_apr?: number;
}

/**
 * specs/01 W2 — one make/model, many dealerships side by side, in one request.
 * No ordering is emitted (D11).
 */
export function buildWarRoom(input: WarRoomInput): WarRoomView {
  const { deal } = input;
  return {
    deal: projectDeal(input.role, deal),
    threads: deal.dealer_threads.map((thread) => {
      const dealership = input.dealerships.get(thread.dealership_id);
      const instance_id = thread.vehicle_instance?.id;
      const valuation = instance_id === undefined ? undefined : input.valuations.get(instance_id);
      return assessThread({
        deal,
        thread,
        ...(dealership !== undefined && { dealership }),
        ...(valuation !== undefined && { valuation }),
        ...(input.qualified_apr !== undefined && { qualified_apr: input.qualified_apr }),
      });
    }),
  };
}

/**
 * The flattened offer history (`Deal.offers`), each assessed.
 *
 * `Deal.offers` carries no thread reference in the spine, so there is no car to
 * value a historical offer against — every entry's `above_market` is therefore
 * `unevaluable / no_vehicle_instance`, which is ADR-005 applied to an input the
 * data model genuinely does not hold. The per-thread, per-car assessment is the
 * war room's; this list is history.
 */
export function assessDealOffers(deal: Deal, qualified_apr?: number): DealOffersView {
  return {
    deal_id: deal.id,
    offers: deal.offers.map((offer) =>
      assessOffer({ offer, ...(qualified_apr !== undefined && { qualified_apr }) }),
    ),
  };
}
