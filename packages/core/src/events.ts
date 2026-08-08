/**
 * Event contracts — the async backbone (shared).
 *
 * specs/00 "Async backbone": the bus drives inbound-comms processing, offer
 * extraction, valuation refresh, alert dispatch. Contracts are versioned
 * (`.v1` suffix) so payloads can evolve without breaking consumers.
 *
 * There are no transcription contracts: specs/01 "Consent & recording posture"
 * and Q14 removed audio and ASR entirely, so no transcription stage exists on
 * the bus to request work from.
 *
 * specs/00 "Comms aggregation layer": webhooks ack immediately, all heavy
 * work (extraction) runs on the event bus — heavy work exists ONLY as event
 * types here; there is no synchronous adapter method for it.
 *
 * Bus-neutral by design: envelopes are plain JSON-serializable objects;
 * SQS/SNS vs Kafka vs managed queue (specs/00 leaves it open) is a downstream
 * wiring choice that cannot leak into these types.
 */

import type {
  IsoTimestamp,
  MessageChannel,
  Offer,
  OfferFlag,
  ValuationSnapshot,
} from './domain.js';
import type { AdapterError, InboundComms, ValuationRequest } from './adapters.js';

export interface EventEnvelope<
  TType extends SpineEventType = SpineEventType,
  TPayload = unknown,
> {
  /** Producer-assigned UUID — unique per publish attempt. */
  event_id: string;
  type: TType;
  occurred_at: IsoTimestamp;
  /** Set when the event is already attributable to a deal. */
  deal_id?: string;
  /**
   * Dedupe anchor under at-least-once delivery. Derivation is fixed per type
   * (docs/design/T-001.md §5.3) — consumers treat two events with equal keys
   * as the same fact.
   */
  idempotency_key: string;
  payload: TPayload;
}

export type SpineEventType =
  | 'comms.inbound.received.v1'
  | 'offer.extraction.requested.v1'
  | 'offer.extraction.completed.v1'
  | 'valuation.refresh.requested.v1'
  | 'valuation.refresh.completed.v1'
  | 'alert.dispatch.requested.v1';

// -- inbound comms (published by webhook handlers AFTER parse, BEFORE any heavy work)
export interface CommsInboundReceivedV1 {
  /** Adapter id that parsed it. */
  source: string;
  inbound: InboundComms;
}

/**
 * Quarantine variant of the inbound payload — docs/design/T-001.md §5.2
 * (binding): when `parseInboundWebhook` fails, the handler STILL acks 2xx and
 * enqueues a `comms.inbound.received.v1` carrying the parse-error marker and a
 * reference to the stashed raw payload for quarantine/replay. specs/00:
 * "Provider timeouts must never drop a dealer message."
 */
export interface CommsInboundQuarantinedV1 {
  /** Adapter id whose parse failed. */
  source: string;
  /** Typically `code: 'malformed_response'` (§5.2 failure table). */
  parse_error: AdapterError;
  /**
   * Reference to where the raw provider payload was stashed for replay —
   * never the payload itself (raw payloads are never logged or bused).
   */
  raw_payload_ref: string;
}

/** What a `comms.inbound.received.v1` envelope carries: parsed or quarantined. */
export type CommsInboundPayloadV1 = CommsInboundReceivedV1 | CommsInboundQuarantinedV1;

/** Pure narrowing guard so consumers (T-009) never need an untyped cast. */
export const isQuarantinedInbound = (
  payload: CommsInboundPayloadV1,
): payload is CommsInboundQuarantinedV1 => 'parse_error' in payload;

// -- offer extraction (specs/00: runs on ANY message text — buyer note, SMS, or
//    email; the extractor is channel-agnostic and never depends on how the text
//    was produced)
export interface OfferExtractionRequestedV1 {
  deal_id: string;
  dealership_id: string;
  /** Provider message id for sms/email/call, caller-generated ref for a note. */
  message_ref: string;
  channel: MessageChannel;
  text: string;
}

export interface OfferExtractionCompletedV1 {
  deal_id: string;
  dealership_id: string;
  message_ref: string;
  /** Absent when the text contained no offer — a valid, terminal outcome. */
  offer?: Offer;
}

// -- valuation refresh (snapshot + cache, specs/00)
export interface ValuationRefreshRequestedV1 {
  deal_id: string;
  request: ValuationRequest;
}

export interface ValuationRefreshCompletedV1 {
  deal_id: string;
  snapshot: ValuationSnapshot;
}

// -- alert dispatch (flags, walk-away crossings → owner notification)
export interface AlertDispatchRequestedV1 {
  deal_id: string;
  /**
   * `call_logged` is the "you had a call — write your note" prompt: specs/00's
   * v0.5 call flow is log metadata → notify owner → owner writes a note →
   * extract on the note.
   */
  kind: 'flag_raised' | 'offer_received' | 'message_received' | 'call_logged';
  flags?: OfferFlag[];
  /** Human-readable, PII-free. */
  summary: string;
}

// Convenience union for typed consumers:
export type SpineEvent =
  | EventEnvelope<'comms.inbound.received.v1', CommsInboundPayloadV1>
  | EventEnvelope<'offer.extraction.requested.v1', OfferExtractionRequestedV1>
  | EventEnvelope<'offer.extraction.completed.v1', OfferExtractionCompletedV1>
  | EventEnvelope<'valuation.refresh.requested.v1', ValuationRefreshRequestedV1>
  | EventEnvelope<'valuation.refresh.completed.v1', ValuationRefreshCompletedV1>
  | EventEnvelope<'alert.dispatch.requested.v1', AlertDispatchRequestedV1>;
