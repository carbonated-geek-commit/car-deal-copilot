/**
 * Adapter interface contracts — the anti-corruption layer (shared).
 *
 * specs/00: "Every external feed sits behind one internal interface. Core
 * services never see a provider's shape." Every contract here speaks ONLY in
 * domain types plus the neutral request/receipt types below. No provider SDK
 * type, header, URL, or credential appears anywhere in core.
 *
 * Behavioral contract (error paths, retries, idempotency) is fixed in
 * docs/design/T-001.md §5 — implementations (T-003…T-006, T-009) are designed
 * against it.
 */

import type {
  CallMeta,
  IdentityRef,
  IsoTimestamp,
  MessageChannel,
  MoneyCents,
  RecallRecord,
  ValuationSnapshot,
  VehicleHistorySummary,
  VehicleInstance,
  VehicleTarget,
  Vin,
  VinDecode,
} from './domain.js';

// ---- uniform result & error shape -------------------------------------
// Adapters never throw across the boundary; every operation returns AdapterResult.

export type AdapterErrorCode =
  | 'invalid_input' // caller bug — not retryable
  | 'not_found' // provider has no data — not retryable
  | 'auth' // credential problem — not retryable, alert operator
  | 'rate_limited' // retryable with backoff
  | 'provider_unavailable' // timeout / 5xx — retryable with backoff
  | 'malformed_response'; // provider shape drifted — not retryable, alert operator

export interface AdapterError {
  code: AdapterErrorCode;
  /** Whether the SAME call may succeed on retry. Derived from code; stated explicitly so callers never guess. */
  retryable: boolean;
  /** Adapter id, e.g. "mock-manheim", "nhtsa-vpic". */
  source: string;
  /** Log-safe, PII-free, provider-payload-free description. */
  message: string;
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdapterError };

// ---- outbound-feed adapters (T-003…T-006 implement these) --------------

/**
 * A valuation is ALWAYS of one specific car. `target` supplies the anchor the
 * instance deliberately lacks; `instance` supplies the priceable attributes
 * (year, trim, mileage, condition) specs/00 says no source can price without.
 * There is no overload accepting a bare make/model.
 */
export interface ValuationRequest {
  target: VehicleTarget;
  instance: VehicleInstance;
}

/** specs/00 "Valuation" — retail/trade-in/wholesale/private-party feeds. */
export interface ValuationAdapter {
  readonly source: string;
  /** Implementations stamp `vehicle_instance_id = req.instance.id` on the result. */
  getValuation(req: ValuationRequest): Promise<AdapterResult<ValuationSnapshot>>;
}

/** specs/00 "Vehicle data" — VIN decode + recalls (NHTSA vPIC + Recall API, T-004). */
export interface VehicleDataAdapter {
  readonly source: string;
  decodeVin(vin: Vin): Promise<AdapterResult<VinDecode>>;
  getRecalls(vin: Vin): Promise<AdapterResult<RecallRecord[]>>;
}

/** specs/00 "Vehicle data" — accident/title (Carfax/AutoCheck, mock-only, T-005). */
export interface VehicleHistoryAdapter {
  readonly source: string;
  getHistory(vin: Vin): Promise<AdapterResult<VehicleHistorySummary>>;
}

/**
 * specs/01 "Credit data residency" — pass-through only. The contract makes the
 * forbidden thing inexpressible: there is no method returning raw credit data,
 * and PrequalResult holds a provider token + derived results ONLY.
 */
export interface PrequalResult {
  /** Opaque reference into the provider's hosted flow. */
  provider_token: string;
  qualified_apr: number;
  approved_amount_max: MoneyCents;
  fetched_at: IsoTimestamp;
}

export interface CreditPrequalAdapter {
  readonly source: string;
  getPrequal(provider_token: string): Promise<AdapterResult<PrequalResult>>;
}

// ---- comms adapters (telephony, email — T-009 consumes) ----------------
// Two directions, one rule: inbound parsing is synchronous and cheap (it runs
// inside a webhook handler that must ack immediately); everything slow is an
// event consumer's job.

export interface OutboundSms {
  /** Sends FROM this identity — dealer never sees a real personal line (specs/00 "Outbound"). */
  from: IdentityRef;
  to_phone: string;
  body: string;
  /** Caller-supplied idempotency key; adapters must dedupe on it. */
  client_ref: string;
}

export interface OutboundEmail {
  from: IdentityRef;
  to_email: string;
  subject: string;
  body: string;
  client_ref: string;
}

export interface ProviderSendReceipt {
  /** Provider's opaque message id — provenance only, never interpreted by core. */
  provider_message_ref: string;
  accepted_at: IsoTimestamp;
}

/**
 * A note is authored in-app and can never arrive from a provider webhook, so a
 * provider-sourced note is unrepresentable (protects the author-honesty
 * guarantee — specs/00 "Receipt layer": author "never inferred").
 */
export type InboundChannel = Exclude<MessageChannel, 'note'>;

/**
 * Normalized inbound item — the ONLY shape a webhook payload may become.
 * This is what gets wrapped into a `comms.inbound.received.v1` event.
 */
export interface InboundComms {
  channel: InboundChannel;
  /** Which of OUR identities the dealer contacted — routes to the Deal. */
  to_identity: { phone_number?: string; email_alias?: string };
  from: { phone?: string; email?: string };
  /** SMS/email body; absent for calls. */
  body?: string;
  /**
   * For calls: the metadata that gets logged on the thread (specs/00 "log call
   * metadata (time, direction, party)"). No audio handle exists — Q14/specs/01
   * removed audio entirely, so there is nothing for such a field to point at.
   */
  call_meta?: CallMeta;
  /** Provider's message id — idempotency anchor. */
  provider_message_ref: string;
  received_at: IsoTimestamp;
}

export interface TelephonyAdapter {
  readonly source: string;
  sendSms(msg: OutboundSms): Promise<AdapterResult<ProviderSendReceipt>>;
  /**
   * SYNCHRONOUS, pure, no I/O: verify + normalize a raw webhook payload.
   * Must be safe to call before the handler acks.
   */
  parseInboundWebhook(payload: unknown): AdapterResult<InboundComms>;
}

export interface EmailAdapter {
  readonly source: string;
  sendEmail(msg: OutboundEmail): Promise<AdapterResult<ProviderSendReceipt>>;
  parseInboundWebhook(payload: unknown): AdapterResult<InboundComms>;
}
