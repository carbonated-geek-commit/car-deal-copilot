/**
 * Spine domain types — the SINGLE definition of the shared spine.
 *
 * ADR-001: "defined once as TypeScript types in a shared package and imported
 * everywhere — no parallel type definitions." The authoritative field list is
 * specs/00-shared-core-architecture.md "Core domain model"; this file is that
 * model transcribed, not a second model. Downstream packages import these via
 * `@core` and never re-declare them.
 */

// ---- scalars ----------------------------------------------------------

/** ISO-8601 UTC timestamp string. */
export type IsoTimestamp = string;

/** Integer USD cents. All money in the spine is integer cents — no floats. */
export type MoneyCents = number;

/** 17-char VIN, uppercased. Validation is downstream's job; the type is nominal-ish documentation. */
export type Vin = string;

// ---- enums (spec-fixed) ----------------------------------------------

export type DealPath = 'online' | 'hybrid' | 'in_person';
export type DealStatus = 'draft' | 'active' | 'negotiating' | 'closed' | 'burned';
export type MessageChannel = 'call' | 'sms' | 'email';
export type MessageDirection = 'in' | 'out';

/** ADR-002: canonical name is `payment_packing`; specs/00's `packing` is shorthand for it. */
export type OfferFlag = 'payment_packing' | 'rate_markup' | 'junk_fee' | 'over_walkaway';
export const OFFER_FLAGS: readonly OfferFlag[] = [
  'payment_packing',
  'rate_markup',
  'junk_fee',
  'over_walkaway',
];

// ---- identity (provider-agnostic by construction) --------------------

/**
 * Points at *an* identity — a number + inbox — without encoding who
 * provisioned it (specs/00: "`identity_ref` is deliberately provider-agnostic").
 * There is intentionally NO provider/provisioner/vendor field on this type.
 */
export interface IdentityRef {
  /** Opaque handle into whichever identity store the product wired up. */
  identity_id: string;
  /** E.164 phone number, when the identity has one. */
  phone_number?: string;
  /** Email alias/inbox address, when the identity has one. */
  email_alias?: string;
}

// ---- vehicle ----------------------------------------------------------

/** Buyer's target spec, pre-VIN. */
export interface VehicleSpec {
  make: string;
  model: string;
  year?: number;
  trim?: string;
}

// ---- aggregate root ---------------------------------------------------

export interface Deal {
  id: string;
  /** User in consumer, Org/Seat in B2B — core does not distinguish. */
  owner_id: string;
  path: DealPath;
  status: DealStatus;
  target_vehicle: VehicleSpec;
  /** VIN, once identified. */
  resolved_vehicle?: Vin;
  budget: MoneyCents;
  walk_away_number: MoneyCents;
  /** Absent until first dealer contact (lazy provisioning, specs/01). */
  identity_ref?: IdentityRef;
  dealer_threads: DealerThread[];
  offers: Offer[];
  receipt_bundle_id?: string;
  created_at: IsoTimestamp;
  burned_at?: IsoTimestamp;
}

export interface DealerThread {
  dealer_id: string;
  dealer_name: string;
  contact: DealerContact;
  messages: Message[];
  current_offer?: Offer;
}

export interface DealerContact {
  phone?: string;
  email?: string;
  address?: string;
}

export interface Message {
  channel: MessageChannel;
  direction: MessageDirection;
  /** SMS/email body. */
  body?: string;
  /**
   * Call recording pointer. Consumer policy (specs/01 consent posture) keeps
   * this null forever — the field exists because the spine is shared, the
   * policy lives in the product, not the type.
   */
  recording_url?: string | null;
  /** Call transcript (transcribe-only posture on consumer). */
  transcript?: string;
  timestamp: IsoTimestamp;
  extracted_offer?: Offer;
}

export interface OfferFee {
  name: string;
  amount: MoneyCents;
}

export interface Offer {
  sale_price: MoneyCents;
  fees: OfferFee[];
  /** Annual percentage rate, e.g. 6.9 — absent on cash deals. */
  apr?: number;
  term_months?: number;
  monthly?: MoneyCents;
  flags: OfferFlag[];
}

// ---- cached, timestamped (specs/00: "ValuationSnapshot · VehicleData") ----

export interface ValuationSnapshot {
  vehicle: VehicleSpec | { vin: Vin };
  mileage?: number;
  /** Blend per specs/00 Valuation: wholesale vs trade-in vs retail (+ private-party). */
  values: {
    wholesale?: MoneyCents;
    trade_in?: MoneyCents;
    retail?: MoneyCents;
    private_party?: MoneyCents;
  };
  /** Adapter id (e.g. "mock-kbb") — provenance, never a provider payload. */
  source: string;
  fetched_at: IsoTimestamp;
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

export interface VehicleData {
  vin: Vin;
  decode: VinDecode;
  recalls: RecallRecord[];
  history?: VehicleHistorySummary;
  fetched_at: IsoTimestamp;
}
