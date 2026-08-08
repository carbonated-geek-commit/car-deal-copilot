/**
 * Composite response types (docs/design/T-020.md §2.3).
 *
 * NO SPINE TYPE IS DEFINED, WIDENED, OR MIRRORED HERE (ADR-001). Every shape
 * below is assembled BY COMPOSITION from T-019's `projection/views.ts` — which
 * is itself derived from `@core` by `Pick`/`Omit` — plus this task's own
 * evaluability vocabulary. A hand-written `Offer`, `Deal`, `Message`, or
 * `VehicleInstance` view would be the parallel definition ADR-001 forbids, and
 * a static test in `test/routes/**` asserts none exists here.
 *
 * D10 — the state vocabulary is deliberately missing a member. There is no
 * `clear`, `passing`, `fine`, or `fair` status, because nothing in this epic
 * runs the flag engine: `services/comms/src/rollup.ts` and
 * `packages/offer-extraction/src/extract.ts` both hard-code `flags: []`, so
 * every stored `Offer` carries an empty flag list. Reading that emptiness as
 * "evaluated, nothing fired" would report EVERY offer as fine — precisely what
 * specs/00 "Budget ceiling vs. fair price" forbids ("never as 'fine'") and what
 * ADR-005 §2 calls the distinction that must be preserved. `Offer` has no
 * evaluation-provenance field, so "evaluated and did not fire" is
 * unrepresentable in the spine and the API says `not_evaluated` instead of
 * pretending.
 */

import type { OfferFlag, ProcessStep, YearRange } from '@core';
import type { ReceiptEntry } from '@receipt';

import type {
  DealView,
  DealerThreadView,
  DealershipContactView,
  DealershipPublicView,
  MessageView,
  OfferView,
  VehicleInstanceView,
} from '../projection/views.js';

/** ADR-005 made renderable. NEVER a "clear"/"passing" member (D10). */
export type FlagStatus = 'flagged' | 'unevaluable' | 'not_evaluated';

/**
 * Closed vocabulary: WHICH INPUT the API could not supply. Not a judgement of
 * the offer — a statement about this service's own inputs, which is the only
 * thing it is entitled to say (T-019 D10: "the API computes nothing the domain
 * already owns").
 */
export type UnevaluableReason =
  | 'no_offer'
  | 'no_stated_price'
  | 'no_term'
  | 'no_offer_apr'
  | 'no_qualified_apr'
  | 'no_vehicle_instance'
  | 'no_valuation'
  | 'no_retail_band'
  | 'valuation_instance_mismatch';

export interface FlagStatusView {
  readonly flag: OfferFlag;
  readonly status: FlagStatus;
  /** Present only when `status === 'unevaluable'`. */
  readonly reason?: UnevaluableReason;
}

export interface OfferAssessmentView {
  /** T-019's projection, verbatim. `sale_price` absent stays ABSENT (ADR-005). */
  readonly offer: OfferView;
  /** Copied from the domain, never recomputed (ADR-006/ADR-007, T-019 D10). */
  readonly flags: readonly OfferFlag[];
  /** ADR-005's set. Derived from input presence; parity-tested against @flag-engine. */
  readonly unevaluable: readonly OfferFlag[];
  /**
   * All five flags, in `OFFER_FLAGS` order, so a client cannot mistake an
   * absence from `flags[]` for "fine" (D10).
   */
  readonly statuses: readonly FlagStatusView[];
}

/**
 * "Can I afford it?" — DEAL-level (specs/00 "Budget ceiling vs. fair price").
 * The ceiling itself is `DealView.walk_away_number`; this is only the signal.
 */
export interface BudgetSignalView {
  readonly over_walkaway: FlagStatus;
  readonly reason?: UnevaluableReason;
}

/**
 * "Is this a good price?" — PER `VehicleInstance` (ADR-007). Never fused with
 * the budget signal above: specs/00 states them as two different questions, and
 * a single merged answer is exactly the fusion that table exists to prevent.
 */
export interface FairPriceSignalView {
  readonly above_market: FlagStatus;
  readonly reason?: UnevaluableReason;
  readonly vehicle_instance_id?: string;
  /** Provenance only — an adapter id and a timestamp, never a provider payload. */
  readonly valuation_source?: string;
  readonly valuation_captured_at?: string;
}

/**
 * Year drift is a SOFT GUIDE surfaced as advice (specs/00 "Cardinality
 * invariants": "a soft guide, not a hard rejection"; Q16). There is no code
 * path anywhere in this suite from a populated `YearDriftView` to a non-2xx
 * response.
 */
export interface YearDriftView {
  readonly instance_year: number;
  readonly year_range: YearRange;
}

export interface ThreadAssessmentView {
  readonly dealership_id: string;
  /**
   * The GLOBAL header for this war-room column. Structurally cannot hold a
   * contact (T-019's `Pick` has no field for one). Absent when the directory
   * holds no record for this thread's `dealership_id` — the API never
   * fabricates a global row to fill a gap.
   */
  readonly dealership?: DealershipPublicView;
  readonly process_step: ProcessStep;
  /** Account-PRIVATE, and reachable only inside this gated deal response. */
  readonly working_with?: DealershipContactView;
  readonly vehicle_instance?: VehicleInstanceView;
  /** ADR-006's rollup, assessed. Absent when the thread has no offer yet. */
  readonly current_offer?: OfferAssessmentView;
  readonly budget: BudgetSignalView;
  readonly fair_price: FairPriceSignalView;
  readonly year_drift?: YearDriftView;
}

/**
 * The war room (specs/01 "Web surface (war-room-first)" W2): one make/model,
 * many dealerships side by side, in ONE request.
 *
 * Deliberately carries NO ordering. specs/00 requires cross-dealership
 * comparison to be value-adjusted rather than raw-price, and every fair-price
 * answer in this epic is `unevaluable` (D10) — so an ordering emitted here
 * would be an invented judgement. The API supplies the inputs; the client
 * orders.
 */
export interface WarRoomView {
  readonly deal: DealView;
  readonly threads: readonly ThreadAssessmentView[];
}

/** The append-only trail, including the rejection marks this suite writes. */
export interface ReceiptTrailView {
  readonly receipt_bundle_id: string;
  /** `@receipt`'s `ReceiptEntry`, verbatim — never re-shaped here. */
  readonly entries: readonly ReceiptEntry[];
  readonly next_cursor?: string;
}

/** `GET /deals/:deal_id/offers` — the flattened history, each assessed. */
export interface DealOffersView {
  readonly deal_id: string;
  readonly offers: readonly OfferAssessmentView[];
}

/** `GET /deals/:deal_id/threads/:dealership_id/messages` — a chronological page. */
export interface MessagePageView {
  readonly dealership_id: string;
  readonly messages: readonly MessageView[];
  readonly next_cursor?: string;
}

/** `POST …/messages` — `@comms`'s outcome, surfaced without reinterpretation. */
export interface NoteAcceptedView {
  readonly message_ref: string;
  readonly disposition: 'appended' | 'duplicate';
}

/** `GET /dealerships` — the GLOBAL directory. Contact-free by shape. */
export interface DealershipPageView {
  readonly dealerships: readonly DealershipPublicView[];
  readonly next_cursor?: string;
}

/** Re-exported so a route module has one import site for response shapes. */
export type {
  DealView,
  DealerThreadView,
  DealershipContactView,
  DealershipPublicView,
  MessageView,
  OfferView,
  VehicleInstanceView,
};
