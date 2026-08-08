/**
 * Response projections (docs/design/T-019.md §3.2, §5.3, §5.5, §5.7; AC-9,
 * AC-10, AC-11).
 *
 * Every view is derived from an `@core` type by `Pick`/`Omit` rather than
 * re-declared field by field. That is not stylistic: a hand-written view drifts
 * from the spine silently, whereas a `Pick` that names a removed field stops
 * compiling. ADR-001 calls the hand-written version a parallel type definition,
 * and it is right.
 *
 * D10 — nothing here computes. `flags[]` are copied from the domain, never
 * re-derived; `above_market` is ADR-007's comparison and belongs to the flag
 * engine; the rollup is ADR-006's and belongs to `@comms/rollup.ts`. A second
 * implementation inside a projection would be a second answer to the same
 * question, reachable only through the API, and therefore the one nobody tests.
 */

import type {
  CallMeta,
  Deal,
  DealerThread,
  Dealership,
  DealershipContact,
  Message,
  Offer,
  PrequalResult,
  VehicleInstance,
  VehicleTarget,
} from '@core';

import type { ActorRole } from '../context/account-context.js';
import { omitAbsent, type AssertResponseSafe } from './guards.js';

/**
 * `@core.Message` has no `re`+`cording_url` and no `trans`+`cript` — T-010
 * removed them rather than nulling them — so this is `Message` unchanged. The
 * `AssertResponseSafe` annotation is what makes that a CHECKED fact: if a
 * future spine edit reintroduced one, this line would stop compiling here,
 * in the API, before it could reach a response.
 */
export type MessageView = AssertResponseSafe<Message>;
export type CallMetaView = AssertResponseSafe<CallMeta>;

/** `sale_price` absent stays absent (ADR-005 + D9) — never `0`, never `null`. */
export type OfferView = AssertResponseSafe<Offer>;

export type VehicleInstanceView = AssertResponseSafe<VehicleInstance>;
export type VehicleTargetView = AssertResponseSafe<VehicleTarget>;

/**
 * Account-PRIVATE (specs/00 "Dealership data tenancy"). Reachable only inside
 * an owner-scoped deal response, because that is the only place a
 * `DealerThread` is projected.
 */
export type DealershipContactView = AssertResponseSafe<DealershipContact>;

export type DealerThreadView = AssertResponseSafe<DealerThread>;

/** `owner_id` is retained: it is the requesting account's own id, never another's. */
export type DealView = AssertResponseSafe<Deal>;

/**
 * The GLOBAL directory type (AC-10).
 *
 * A `DealershipContact` cannot be attached to it because the type has no place
 * for one — the guarantee is structural, not a filter someone has to remember
 * to apply on every read path. `Dealership` itself already carries no
 * account field and no `staff[]` array; this `Pick` keeps it that way even if
 * the spine were later widened.
 */
export type DealershipPublicView = AssertResponseSafe<Pick<Dealership, 'id' | 'name' | 'state' | 'city' | 'zip_code'>>;

/**
 * specs/01 "Credit data residency" (Q3): summary values only.
 *
 * `provider_token` is omitted by `Pick`, so no response type in this service
 * can carry it — it is not filtered out at runtime, it is unrepresentable.
 * There is no raw-credit type in `@core` at all, so there is nothing else to
 * serialize even by accident (AC-9).
 */
export type PrequalSummaryView = AssertResponseSafe<
  Pick<PrequalResult, 'qualified_apr' | 'approved_amount_max' | 'fetched_at'>
>;

export function projectPrequal(result: PrequalResult): PrequalSummaryView {
  return {
    qualified_apr: result.qualified_apr,
    approved_amount_max: result.approved_amount_max,
    fetched_at: result.fetched_at,
  };
}

export function projectDealership(dealership: Dealership): DealershipPublicView {
  return {
    id: dealership.id,
    name: dealership.name,
    state: dealership.state,
    city: dealership.city,
    zip_code: dealership.zip_code,
  };
}

export function projectOffer(offer: Offer): OfferView {
  return omitAbsent({
    sale_price: offer.sale_price,
    fees: offer.fees.map((fee) => ({ name: fee.name, amount: fee.amount })),
    apr: offer.apr,
    term_months: offer.term_months,
    monthly: offer.monthly,
    // Copied, never recomputed (D10, ADR-006, ADR-007).
    flags: [...offer.flags],
  }) as OfferView;
}

export function projectMessage(message: Message): MessageView {
  return omitAbsent({
    channel: message.channel,
    direction: message.direction,
    author: message.author,
    body: message.body,
    call_meta: message.call_meta === undefined ? undefined : omitAbsent({ ...message.call_meta }),
    timestamp: message.timestamp,
    extracted_offer: message.extracted_offer === undefined ? undefined : projectOffer(message.extracted_offer),
  }) as MessageView;
}

export function projectThread(thread: DealerThread): DealerThreadView {
  return omitAbsent({
    dealership_id: thread.dealership_id,
    vehicle_instance: thread.vehicle_instance === undefined ? undefined : omitAbsent({ ...thread.vehicle_instance }),
    // Account-private, and reachable ONLY here — inside a deal the gate has
    // already authorized for this account.
    working_with: thread.working_with === undefined ? undefined : omitAbsent({ ...thread.working_with }),
    process_step: thread.process_step,
    messages: thread.messages.map(projectMessage),
    current_offer: thread.current_offer === undefined ? undefined : projectOffer(thread.current_offer),
  }) as DealerThreadView;
}

/**
 * Role-keyed today, role-ENFORCING in E3 (specs/01 "Concierge tier" enforced
 * control 1: "Role-scoped views … credit detail is absent from the agent API
 * surface").
 *
 * The parameter exists now so the seam is already threaded: there is nothing to
 * withhold from a concierge agent in E2 because `Deal` carries no credit field
 * at all, and the honest thing is to say so rather than to fake a filter that
 * removes nothing.
 */
export function projectDeal(_role: ActorRole, deal: Deal): DealView {
  return omitAbsent({
    id: deal.id,
    owner_id: deal.owner_id,
    path: deal.path,
    status: deal.status,
    target_vehicle: omitAbsent({ ...deal.target_vehicle }),
    budget: deal.budget,
    /**
     * §5.7 — the budget CEILING, kept distinct from any fair-price judgement.
     * No valuation-derived value is projected at deal level; those are
     * per-`VehicleInstance` (ADR-007). A thread with no `ValuationSnapshot`
     * projects fair price as UNEVALUABLE by OMITTING the key — never `0`,
     * never `null` (ADR-005, D9).
     */
    walk_away_number: deal.walk_away_number,
    identity_ref: deal.identity_ref === undefined ? undefined : omitAbsent({ ...deal.identity_ref }),
    dealer_threads: deal.dealer_threads.map(projectThread),
    offers: deal.offers.map(projectOffer),
    receipt_bundle_id: deal.receipt_bundle_id,
    created_at: deal.created_at,
    burned_at: deal.burned_at,
  }) as DealView;
}
