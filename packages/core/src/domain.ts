/**
 * Spine domain types — the SINGLE definition of the shared spine (v0.5).
 *
 * ADR-001: "defined once as TypeScript types in a shared package and imported
 * everywhere — no parallel type definitions." The authoritative field list is
 * specs/00-shared-core-architecture.md "Core domain model"; this file is that
 * model transcribed, not a second model. Downstream packages import these via
 * `@core` and never re-declare them.
 *
 * v0.5 migration (T-010, docs/design/T-010.md): the deal's shopping anchor
 * (`VehicleTarget`) and one dealership's specific car (`VehicleInstance`) are
 * separate types; `Dealership` (global) and `DealershipContact`
 * (account-private) are first-class; `Message` is the ratified shape.
 */

// ---- scalars ----------------------------------------------------------

/** ISO-8601 UTC timestamp string. */
export type IsoTimestamp = string;

/** Integer USD cents. All money in the spine is integer cents — no floats. */
export type MoneyCents = number;

/**
 * VIN as the buyer typed it. Q16: user-entered and UNVALIDATED at launch — the
 * buyer's own record, not a lookup key. No decode-derived validation belongs
 * anywhere in this package (specs/01 backlog item 4).
 */
export type Vin = string;

// ---- enums (spec-fixed) ----------------------------------------------

export type DealPath = 'online' | 'hybrid' | 'in_person';
export type DealStatus = 'draft' | 'active' | 'negotiating' | 'closed' | 'burned';

/** specs/00 Message (ratified Q22): `note` = text the buyer/operator authored. */
export type MessageChannel = 'call' | 'sms' | 'email' | 'note';
/** `internal` = the buyer's/operator's own record, not a dealer exchange. */
export type MessageDirection = 'in' | 'out' | 'internal';
/** Who produced this text — NEVER inferred (specs/00; Q22; Q21 mitigation). */
export type MessageAuthor = 'dealer' | 'buyer' | 'concierge';

export type VehicleCondition = 'new' | 'used' | 'certified';

export type DealershipContactRole =
  | 'general_manager'
  | 'sales_manager'
  | 'finance_manager'
  | 'sales_agent';

/** How far along the negotiation with ONE dealership is (Q12). */
export type ProcessStep =
  | 'information_gather'
  | 'deal_negotiation'
  | 'deal_approval'
  | 'financing'
  | 'final_sale'
  | 'pickup';

/**
 * ADR-002: canonical name is `payment_packing`.
 * ADR-007: `above_market` compares the offer against THIS instance's own
 * `ValuationSnapshot.retail` band — distinct from `over_walkaway`, which is the
 * deal-level budget ceiling (Q20).
 */
export type OfferFlag =
  | 'payment_packing'
  | 'rate_markup'
  | 'junk_fee'
  | 'over_walkaway'
  | 'above_market';

// ---- shared vocabularies (D13) ---------------------------------------
// One frozen array per enum. ADR-008 puts `zod` at the API route boundary;
// validators import these rather than re-declaring the literals, which would be
// ADR-001's "parallel type definition" in a different syntax.

export const OFFER_FLAGS: readonly OfferFlag[] = [
  'payment_packing',
  'rate_markup',
  'junk_fee',
  'over_walkaway',
  'above_market',
];

export const MESSAGE_CHANNELS: readonly MessageChannel[] = ['call', 'sms', 'email', 'note'];

export const MESSAGE_DIRECTIONS: readonly MessageDirection[] = ['in', 'out', 'internal'];

export const MESSAGE_AUTHORS: readonly MessageAuthor[] = ['dealer', 'buyer', 'concierge'];

export const VEHICLE_CONDITIONS: readonly VehicleCondition[] = ['new', 'used', 'certified'];

export const DEALERSHIP_CONTACT_ROLES: readonly DealershipContactRole[] = [
  'general_manager',
  'sales_manager',
  'finance_manager',
  'sales_agent',
];

export const PROCESS_STEPS: readonly ProcessStep[] = [
  'information_gather',
  'deal_negotiation',
  'deal_approval',
  'financing',
  'final_sale',
  'pickup',
];

// ---- identity (provider-agnostic by construction) --------------------

/**
 * Points at *an* identity — a number + inbox — without encoding who
 * provisioned it (specs/00: "`identity_ref` is deliberately provider-agnostic").
 * There is intentionally NO provider/provisioner/vendor field on this type, and
 * this migration adds none.
 */
export interface IdentityRef {
  /** Opaque handle into whichever identity store the product wired up. */
  identity_id: string;
  /** E.164 phone number, when the identity has one. */
  phone_number?: string;
  /** Email alias/inbox address, when the identity has one. */
  email_alias?: string;
}

// ---- vehicle — the v0.5 split ----------------------------------------

/** Inclusive span. SOFT GUIDE only (Q16, specs/00 "Year drift"). */
export interface YearRange {
  from: number;
  to: number;
}

/**
 * What the buyer is shopping — the deal's comparison anchor.
 * `make`/`model` are `readonly`: write-once, settable while the deal is `draft`,
 * immutable once any offer is attached (specs/00 "Cardinality invariants").
 * `year_range` is NOT readonly — it is a soft guide the buyer may widen or
 * narrow, and nothing rejects an instance whose year falls outside it.
 */
export interface VehicleTarget {
  readonly make: string;
  readonly model: string;
  year_range?: YearRange;
}

/** The ONLY shape whose make/model are settable — used at deal creation. */
export type VehicleTargetDraft = {
  -readonly [K in keyof VehicleTarget]: VehicleTarget[K];
};

/**
 * The SPECIFIC car one dealership is offering — varies per thread.
 * Deliberately carries NO make/model: those are the deal's anchor, so a thread
 * that contradicts the anchor is unrepresentable. Builders must not add them.
 * `id` is what `ValuationSnapshot.vehicle_instance_id` and
 * `VehicleData.vehicle_instance_id` point at.
 */
export interface VehicleInstance {
  id: string;
  /** User-entered, unvalidated (Q16). Absent is normal and not an error. */
  vin?: Vin;
  year: number;
  /** Trim may differ freely between dealerships. */
  trim?: string;
  /** Odometer miles; absent for new. */
  mileage?: number;
  condition: VehicleCondition;
  /** Options, packages, dealer add-ons, accessories — free-text labels. */
  additions: string[];
}

// ---- dealership — the tenancy split ----------------------------------

/**
 * GLOBAL. One shared row per real dealership, referenced by any account's deals,
 * batch-loadable later (specs/00 "Dealership data tenancy"; Q12 AMENDED).
 * There is intentionally NO account/owner field and NO `staff[]` array — the
 * people were moved out of this record precisely so they cannot be redistributed.
 */
export interface Dealership {
  id: string;
  name: string;
  state: string;
  city: string;
  /** String, not number — leading zeros are real ZIPs. */
  zip_code: string;
}

/**
 * PRIVATE to the account that entered it; never global, never shared
 * (specs/00 "Dealership data tenancy"; Q12 AMENDED). It carries no account field
 * because it is embedded in the account-owned `DealerThread` — there is no
 * free-standing, globally addressable contact record in the spine to leak.
 */
export interface DealershipContact {
  name: string;
  role: DealershipContactRole;
  phone?: string;
  email?: string;
}

// ---- aggregate root ---------------------------------------------------

export interface Deal {
  id: string;
  /** User in consumer, Org/Seat in B2B — core does not distinguish. */
  owner_id: string;
  path: DealPath;
  status: DealStatus;
  /** IMMUTABLE make/model once any offer attaches (see `isTargetVehicleLocked`). */
  target_vehicle: VehicleTarget;
  budget: MoneyCents;
  /**
   * Q20: the buyer's BUDGET CEILING for the whole deal — the "can I afford it?"
   * number, compared against a thread offer's out-the-door total (`over_walkaway`).
   * It is NOT a fair-price judgement: that is per-instance, against that car's own
   * `ValuationSnapshot` (`above_market`, ADR-007).
   */
  walk_away_number: MoneyCents;
  /** Absent until first dealer contact (lazy provisioning, specs/01). */
  identity_ref?: IdentityRef;
  /** MANY dealerships, each offering its own specific car. */
  dealer_threads: DealerThread[];
  /** Flattened offer history across threads. */
  offers: Offer[];
  receipt_bundle_id?: string;
  created_at: IsoTimestamp;
  burned_at?: IsoTimestamp;
}

/** The per-deal relationship with ONE dealership. */
export interface DealerThread {
  /** → Dealership (GLOBAL). Also the thread's natural key within a deal. */
  dealership_id: string;
  /** This dealership's specific car. Optional — absent during information_gather. */
  vehicle_instance?: VehicleInstance;
  /** Account-PRIVATE contact, embedded. Optional — absent until handed to a person. */
  working_with?: DealershipContact;
  process_step: ProcessStep;
  messages: Message[];
  /** ADR-006: per-field newest-message-wins accumulation. */
  current_offer?: Offer;
}

// ---- message (ratified shape, Q22) and offer -------------------------

/** Call metadata only. No audio exists to point at (specs/01; Q14). */
export interface CallMeta {
  started_at: IsoTimestamp;
  /** Unit-explicit. Absent for a missed or still-running call. */
  duration_seconds?: number;
  /** The other end of the call, as known — number or name. Absent if withheld. */
  party?: string;
}

export interface Message {
  channel: MessageChannel;
  direction: MessageDirection;
  /** Who produced this text. Required — never inferred, never defaulted. */
  author: MessageAuthor;
  /** Verbatim for sms/email, authored for note. Absent for a bare call record. */
  body?: string;
  /** Present when `channel === 'call'`. */
  call_meta?: CallMeta;
  timestamp: IsoTimestamp;
  /** ADR-005: may be partial. */
  extracted_offer?: Offer;
  // NOTE: there is no `recording_url` and no `transcript`. Not nullable — absent.
  // specs/01 "Consent & recording posture"; Q14: no audio is ever captured or
  // stored, so the fields were removed rather than left null.
}

export interface OfferFee {
  name: string;
  amount: MoneyCents;
}

export interface Offer {
  /**
   * ADR-005: optional — absent means *the dealer did not state a price*
   * (a first-class, common state, not an error). Consumers must treat flags whose
   * inputs are missing as UNEVALUABLE, never default them to zero.
   */
  sale_price?: MoneyCents;
  fees: OfferFee[];
  /** Annual percentage rate, e.g. 6.9 — absent on cash deals. */
  apr?: number;
  term_months?: number;
  monthly?: MoneyCents;
  flags: OfferFlag[];
}

// ---- write-once enforcement surface ----------------------------------

/**
 * True once the deal's make/model are locked: the deal has left `draft`, or any
 * offer is attached anywhere (specs/00 "Cardinality invariants":
 * "settable while the deal is `draft`, immutable once any offer is attached").
 *
 * The single predicate every write path consults — T-020 rejects the write and
 * records the rejection as a receipt-trail event; T-016 mirrors the rule as a
 * schema constraint. Neither invents its own condition.
 *
 * Pure and total — never throws, never reads a clock.
 */
export const isTargetVehicleLocked = (
  deal: Pick<Deal, 'status' | 'offers' | 'dealer_threads'>,
): boolean =>
  deal.status !== 'draft' ||
  deal.offers.length > 0 ||
  deal.dealer_threads.some((t) => t.current_offer !== undefined);

// ---- cached, instance-bound records ----------------------------------
// specs/00 "Core domain model": ValuationSnapshot · VehicleData.

/**
 * ALWAYS of one specific car — never of a bare make/model (specs/00).
 * Bands are flat because ADR-007 names `ValuationSnapshot.retail` as the
 * `above_market` comparison basis.
 */
export interface ValuationSnapshot {
  vehicle_instance_id: string;
  wholesale?: MoneyCents;
  trade_in?: MoneyCents;
  /** ADR-007: the `above_market` reference band. */
  retail?: MoneyCents;
  private_party?: MoneyCents;
  /** Adapter id (e.g. "mock-kbb") — provenance, never a provider payload. */
  source: string;
  captured_at: IsoTimestamp;
}

export interface VinDecode {
  vin: Vin;
  make: string;
  model: string;
  year: number;
  trim?: string;
  body_class?: string;
  engine?: string;
}

export interface RecallRecord {
  campaign_id: string;
  component: string;
  summary: string;
  issued_at: IsoTimestamp;
}

export interface VehicleHistorySummary {
  vin: Vin;
  accident_count: number;
  /** e.g. ["salvage", "flood"] — empty = clean. */
  title_brands: string[];
  owner_count?: number;
  /** Adapter id. */
  source: string;
  fetched_at: IsoTimestamp;
}

/**
 * Decode, recalls, history for one specific car.
 * `reliability` is deliberately NOT modelled: specs/00 lists it, but no spec
 * line, ADR, or adapter defines its shape, and inventing one would be drift.
 * It is additive and non-breaking whenever a shape is specified.
 */
export interface VehicleData {
  vehicle_instance_id: string;
  /** Absent when the instance has no VIN — the normal launch case (Q16). */
  decode?: VinDecode;
  recalls: RecallRecord[];
  history?: VehicleHistorySummary;
  captured_at: IsoTimestamp;
}
