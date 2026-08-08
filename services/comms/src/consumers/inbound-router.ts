/**
 * C1 — inbound-router (design T-014 §2.1).
 *
 * Consumes `comms.inbound.received.v1`:
 *   quarantined payload → recordQuarantined, done (operator queue);
 *   parsed → resolve deal by identity (EXACT match over the authoritative
 *   table, AC-13); no match → recordUnrouted{no_identity_match}, done — never a
 *   guessed deal, never a drop. Then resolve the sender to a KNOWN
 *   `dealership_id` inside that deal (account-private index, AC-9); no match →
 *   recordUnrouted{no_thread_match, deal_id}, done — never a minted
 *   `Dealership` (D9/D10). Then thread → append the @core Message verbatim →
 *   fan out follow-up events.
 *
 * The two v0.5 flows (specs/00 "Comms aggregation layer"):
 *   sms/email → thread onto DealerThread → extract offer
 *   call      → log call metadata (time, direction, party) → notify owner.
 *               NO extraction (there is no text) and NO audio of any kind —
 *               the owner's note is the extraction input, and it arrives
 *               through `notes.submitNote`, not through a provider webhook.
 *
 * Idempotency: ledger peek first (belt); every write is a keyed no-op (braces);
 * markProcessed only after all writes AND publishes succeed — a retry never marks.
 */

import type {
  AlertDispatchRequestedV1,
  CallMeta,
  EventEnvelope,
  InboundComms,
  Message,
  OfferExtractionRequestedV1,
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

/**
 * D12: `call_meta` verbatim when the adapter supplied one; otherwise built from
 * the envelope's OWN facts (`received_at`, `from`) — copying a provider-supplied
 * fact is not inference. NEVER a `duration_seconds`: it is not derivable from
 * anything present, and ADR-005's rule is that a missing input stays missing
 * rather than becoming zero.
 */
const callMetaFor = (inbound: InboundComms): CallMeta =>
  inbound.call_meta ?? {
    started_at: inbound.received_at,
    ...(inbound.from.phone !== undefined
      ? { party: inbound.from.phone }
      : inbound.from.email !== undefined
        ? { party: inbound.from.email }
        : {}),
  };

/**
 * The @core Message, built verbatim (AC-14). The spine type carries no audio
 * handle and no captured-speech text field — specs/01 (consent posture,
 * resolved 2026-08-07; Q14) removed them rather than nulling them — so no code
 * path in this service can produce one (AC-3). Calls carry NO body, ever.
 *
 * `author` is the constant `'dealer'` (D6): for a provider-inbound message the
 * counterparty is known from the TRANSPORT, never inferred from body content
 * and never read off a provider field (specs/00: author is "never inferred").
 */
const buildMessage = (inbound: InboundComms): Message => ({
  channel: inbound.channel, // 'call' | 'sms' | 'email' — never 'note' (InboundChannel)
  direction: 'in',
  author: 'dealer',
  timestamp: inbound.received_at,
  ...(inbound.channel === 'call'
    ? { call_meta: callMetaFor(inbound) }
    : inbound.body !== undefined
      ? { body: inbound.body }
      : {}),
});

export function createInboundRouter(deps: InboundRouterDeps): EventHandler {
  return async (event): Promise<ConsumeResult> => {
    if (event.type !== 'comms.inbound.received.v1') {
      return { status: 'poison', reason: 'unexpected_event_type:' + event.type };
    }
    // Belt: a marked key means a prior delivery fully succeeded.
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

    // 1. Identity routing — provider-agnostic, exact-match-only (AC-13).
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

    // 2. Sender → a KNOWN dealership, inside this deal only (AC-9). A miss is
    //    HELD, not guessed: minting a Dealership from an unrecognised phone
    //    number would inject account-guessed rows into a globally shared
    //    namespace (D9/D10).
    const dealership_id = deps.store.resolveDealershipByContact(deal_id, inbound.from);
    if (dealership_id === undefined) {
      deps.store.recordUnrouted({
        source: payload.source,
        inbound,
        reason: 'no_thread_match',
        deal_id,
        recorded_at: deps.now(),
      });
      deps.store.markProcessed(INBOUND_ROUTER, event.idempotency_key);
      return { status: 'done' };
    }

    // 3. Thread (created at process_step 'information_gather' on first contact,
    //    never advanced by a message arriving) + append (keyed — a duplicate is
    //    a safe no-op).
    deps.store.resolveOrCreateThread(deal_id, dealership_id);
    deps.store.appendMessage(deal_id, dealership_id, {
      message: buildMessage(inbound),
      message_ref: ref,
      origin: { kind: 'provider', source: payload.source },
    });

    // 4. Fan-out (producer-derived keys per T-001 §5.3). A failed publish →
    //    retry WITHOUT marking: redelivery re-runs the handler, keyed writes
    //    no-op, only the publish is re-attempted.
    if (inbound.channel === 'call') {
      // "notify owner" — the 'you had a call, write your note' prompt (D11).
      const alert: EventEnvelope<'alert.dispatch.requested.v1', AlertDispatchRequestedV1> = {
        event_id: deps.new_event_id(),
        type: 'alert.dispatch.requested.v1',
        occurred_at: deps.now(),
        deal_id,
        idempotency_key: `${deal_id}:call_logged:${ref}`,
        payload: {
          deal_id,
          kind: 'call_logged',
          summary: 'Inbound call logged — write your note', // PII-free
        },
      };
      const published = await deps.queue.publish(alert);
      if (!published.ok) return { status: 'retry', reason: 'publish_failed:' + published.reason };

      // Per-product OBSERVATION seam (D2), invoked AFTER the durable append
      // (D3): it returns void, so it cannot authorise, gate, or suppress
      // anything, and a throwing hook costs bounded retries — never a dealer
      // record. There is nothing to consent to (specs/01; Q14).
      try {
        deps.consent.onInboundCall(deal_id, inbound);
      } catch (err) {
        return {
          status: 'retry',
          reason: 'consent_hook_threw:' + (err instanceof Error ? err.message : 'unknown'),
        };
      }

      // No extraction request: a call record carries no text.
    } else {
      const extractionRequested: EventEnvelope<'offer.extraction.requested.v1', OfferExtractionRequestedV1> = {
        event_id: deps.new_event_id(),
        type: 'offer.extraction.requested.v1',
        occurred_at: deps.now(),
        deal_id,
        idempotency_key: `${deal_id}:${ref}:extraction-request`,
        payload: { deal_id, dealership_id, message_ref: ref, channel: inbound.channel, text: inbound.body ?? '' },
      };
      const published = await deps.queue.publish(extractionRequested);
      if (!published.ok) return { status: 'retry', reason: 'publish_failed:' + published.reason };

      // message_received alert (no consumer in this service — dispatch is a
      // later epic; the durable enqueue is the fact this service owes).
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
    }

    deps.store.markProcessed(INBOUND_ROUTER, event.idempotency_key);
    return { status: 'done' };
  };
}
