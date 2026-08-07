/**
 * Event contracts — the async backbone (shared).
 *
 * specs/00 "Async backbone": the bus drives inbound-comms processing,
 * transcription, offer extraction, valuation refresh, alert dispatch.
 * Contracts are versioned (`.v1` suffix) so payloads can evolve without
 * breaking consumers.
 *
 * specs/00 "Comms aggregation layer": webhooks ack immediately, all heavy
 * work (transcription, extraction) runs on the event bus — heavy work exists
 * ONLY as event types here; there is no synchronous adapter method for it.
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
import type { InboundComms, ValuationRequest } from './adapters.js';

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
  | 'comms.transcription.requested.v1'
  | 'comms.transcription.completed.v1'
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

// -- transcription (calls; consumer policy = transcribe-only, no audio retention)
export interface TranscriptionRequestedV1 {
  deal_id: string;
  dealer_id: string;
  call_ref: string;
  provider_message_ref: string;
}

export interface TranscriptionCompletedV1 {
  deal_id: string;
  dealer_id: string;
  provider_message_ref: string;
  transcript: string;
}

// -- offer extraction (transcript/text/email → parsed Offer, specs/00)
export interface OfferExtractionRequestedV1 {
  deal_id: string;
  dealer_id: string;
  provider_message_ref: string;
  channel: MessageChannel;
  /** Body or transcript. */
  text: string;
}

export interface OfferExtractionCompletedV1 {
  deal_id: string;
  dealer_id: string;
  provider_message_ref: string;
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
  kind: 'flag_raised' | 'offer_received' | 'message_received';
  flags?: OfferFlag[];
  /** Human-readable, PII-free. */
  summary: string;
}

// Convenience union for typed consumers:
export type SpineEvent =
  | EventEnvelope<'comms.inbound.received.v1', CommsInboundReceivedV1>
  | EventEnvelope<'comms.transcription.requested.v1', TranscriptionRequestedV1>
  | EventEnvelope<'comms.transcription.completed.v1', TranscriptionCompletedV1>
  | EventEnvelope<'offer.extraction.requested.v1', OfferExtractionRequestedV1>
  | EventEnvelope<'offer.extraction.completed.v1', OfferExtractionCompletedV1>
  | EventEnvelope<'valuation.refresh.requested.v1', ValuationRefreshRequestedV1>
  | EventEnvelope<'valuation.refresh.completed.v1', ValuationRefreshCompletedV1>
  | EventEnvelope<'alert.dispatch.requested.v1', AlertDispatchRequestedV1>;
