/**
 * C1 — inbound-router (design T-009 §4.2).
 *
 * Consumes `comms.inbound.received.v1`:
 *   quarantined payload → recordQuarantined, done (operator queue — §5.3);
 *   parsed → resolve deal by identity (EXACT match over the authoritative
 *   table — §8 invariant 1); no match → recordUnrouted, done (D5 — never a
 *   guessed deal, never a drop); match → thread (D6) → append the @core
 *   Message (§4.3, verbatim spine shape) → fan out follow-up events.
 *
 * Idempotency (§5.4): ledger peek first (belt); every write is a keyed
 * no-op (braces); markProcessed only after all writes AND publishes succeed
 * — a retry never marks.
 */

import type {
  AlertDispatchRequestedV1,
  EventEnvelope,
  InboundComms,
  Message,
  OfferExtractionRequestedV1,
  TranscriptionRequestedV1,
} from '@core';
import { isQuarantinedInbound } from '@core';
import type { CommsStore, ConsentHook, ConsumeResult, EventHandler, EventQueue } from '../ports.js';
import type { EventSeams } from '../envelope.js';

export const INBOUND_ROUTER = 'inbound-router';

export interface InboundRouterDeps extends EventSeams {
  store: CommsStore;
  queue: EventQueue;
  consent: ConsentHook;
}

/** §4.3 — the @core Message, built verbatim. Calls carry NO body and NO
 *  recording_url — no code path in this service ever writes recording_url
 *  (§8, specs/01 transcribe-only posture); transcript is a later fill-once
 *  enrichment (D7). */
const buildMessage = (inbound: InboundComms): Message => ({
  channel: inbound.channel,
  direction: 'in',
  timestamp: inbound.received_at,
  ...(inbound.channel !== 'call' && inbound.body !== undefined ? { body: inbound.body } : {}),
});

export function createInboundRouter(deps: InboundRouterDeps): EventHandler {
  return async (event): Promise<ConsumeResult> => {
    if (event.type !== 'comms.inbound.received.v1') {
      return { status: 'poison', reason: 'unexpected_event_type:' + event.type };
    }
    // Belt (§5.4): a marked key means a prior delivery fully succeeded.
    if (deps.store.hasProcessed(INBOUND_ROUTER, event.idempotency_key)) {
      return { status: 'done' };
    }

    const payload = event.payload;

    if (isQuarantinedInbound(payload)) {
      deps.store.recordQuarantined({
        source: payload.source,
        parse_error: payload.parse_error,
        raw_payload_ref: payload.raw_payload_ref,
        recorded_at: deps.now(),
      });
      deps.store.markProcessed(INBOUND_ROUTER, event.idempotency_key);
      return { status: 'done' };
    }

    const inbound = payload.inbound;
    const ref = inbound.provider_message_ref;

    // Identity routing — provider-agnostic, exact-match-only (AC-3, D5).
    const deal_id = deps.store.resolveDealByIdentity(inbound.to_identity);
    if (deal_id === undefined) {
      deps.store.recordUnrouted({
        source: payload.source,
        inbound,
        reason: 'no_identity_match',
        recorded_at: deps.now(),
      });
      deps.store.markProcessed(INBOUND_ROUTER, event.idempotency_key);
      return { status: 'done' };
    }

    // Threading (D6) + append (keyed — duplicate is a safe no-op).
    const { dealer_id } = deps.store.resolveOrCreateThread(deal_id, inbound.from);
    deps.store.appendMessage(deal_id, dealer_id, {
      message: buildMessage(inbound),
      provider_message_ref: ref,
      source: payload.source,
    });

    // Fan-out (§4.2 C1 row; producer-derived keys per T-001 §5.3). A failed
    // publish → retry WITHOUT marking (§5.2): redelivery re-runs the handler,
    // keyed writes no-op, only the publish is re-attempted.
    if (inbound.channel === 'sms' || inbound.channel === 'email') {
      const extractionRequested: EventEnvelope<'offer.extraction.requested.v1', OfferExtractionRequestedV1> = {
        event_id: deps.new_event_id(),
        type: 'offer.extraction.requested.v1',
        occurred_at: deps.now(),
        deal_id,
        idempotency_key: `${deal_id}:${ref}:extraction-request`,
        payload: { deal_id, dealer_id, provider_message_ref: ref, channel: inbound.channel, text: inbound.body ?? '' },
      };
      const published = await deps.queue.publish(extractionRequested);
      if (!published.ok) return { status: 'retry', reason: 'publish_failed:' + published.reason };
    } else {
      // Inbound call: consent hook first (D8 — per-product policy seam);
      // transcription is a stubbed event stage (D9). The call message is
      // ALREADY threaded either way (D7 — no-drop).
      const decision = deps.consent.onInboundCall(deal_id, inbound);
      if (decision.transcribe && inbound.call_ref !== undefined) {
        const transcriptionRequested: EventEnvelope<'comms.transcription.requested.v1', TranscriptionRequestedV1> = {
          event_id: deps.new_event_id(),
          type: 'comms.transcription.requested.v1',
          occurred_at: deps.now(),
          deal_id,
          idempotency_key: `${deal_id}:${ref}:transcription-request`,
          payload: { deal_id, dealer_id, call_ref: inbound.call_ref, provider_message_ref: ref },
        };
        const published = await deps.queue.publish(transcriptionRequested);
        if (!published.ok) return { status: 'retry', reason: 'publish_failed:' + published.reason };
      }
    }

    // Always: message_received alert (no consumer in this service — dispatch
    // is a later epic; the enqueue is still the durable fact).
    const alert: EventEnvelope<'alert.dispatch.requested.v1', AlertDispatchRequestedV1> = {
      event_id: deps.new_event_id(),
      type: 'alert.dispatch.requested.v1',
      occurred_at: deps.now(),
      deal_id,
      idempotency_key: `${deal_id}:message_received:${ref}`,
      payload: {
        deal_id,
        kind: 'message_received',
        summary: `Inbound ${inbound.channel} message received`, // PII-free
      },
    };
    const alertPublished = await deps.queue.publish(alert);
    if (!alertPublished.ok) return { status: 'retry', reason: 'publish_failed:' + alertPublished.reason };

    deps.store.markProcessed(INBOUND_ROUTER, event.idempotency_key);
    return { status: 'done' };
  };
}
