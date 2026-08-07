/**
 * Webhook intake — the T-001 §5.2 ack-then-queue decision table, nothing
 * else (design T-009 §2.1, §4.1, §5.1 — BINDING).
 *
 * specs/00: "webhooks ack immediately, all heavy work (transcription,
 * extraction) runs on the event bus. Provider timeouts must never drop a
 * dealer message."
 *
 * Transport-neutral (D1): a plain async function returning a typed outcome
 * that ENCODES the HTTP status. The eventual HTTP shell (later epic) maps
 * `WebhookIngestOutcome` 1:1 onto a response; no HTTP framework exists in
 * this repo by constitution (CLAUDE.md invariant 2).
 *
 * The sequence is: sync-pure parse → durable enqueue → outcome. NO store
 * reads/writes, NO routing, NO extraction, NO transcription happens before
 * the ack decision (T-007 §5.2 seam rule: extraction never runs here, even
 * though it is cheap).
 *
 * Observability note (§4.1): what an ingest log line MAY carry is source,
 * channel, provider_message_ref (or raw_payload_ref), and the outcome —
 * NEVER bodies, phone numbers, email addresses, or raw payloads. No logger
 * seam exists in Epic 1, so nothing is logged here; the rule is recorded so
 * the later HTTP shell inherits it.
 */

import type {
  AdapterError,
  AdapterResult,
  CommsInboundPayloadV1,
  EmailAdapter,
  EventEnvelope,
  InboundComms,
  TelephonyAdapter,
} from '@core';
import type { EventQueue, RawPayloadStore } from './ports.js';
import type { EventSeams } from './envelope.js';

/**
 * Which adapter parses the payload. Fixture adapters in Epic 1 (task note);
 * real Twilio/SES translation is a later-epic adapter behind the SAME
 * @core contracts — this type never grows provider names.
 */
export type WebhookChannelKind = 'telephony' | 'email';

/**
 * The T-001 §5.2 decision table as a type. `http_status` is what the eventual
 * HTTP shell returns verbatim (D1):
 *   - 200 ⇔ the comms.inbound.received.v1 envelope (parsed OR quarantined
 *     payload) is durably enqueued — 2xx means exactly that, nothing more.
 *   - 503 ⇔ enqueue failed — the ONE deliberate non-ack; the provider's
 *     retry is then the durability mechanism.
 * Parse failure is NOT representable as a non-200 — by construction.
 */
export type WebhookIngestOutcome =
  | { kind: 'enqueued'; http_status: 200; disposition: 'parsed' | 'quarantined' }
  | { kind: 'enqueue_failed'; http_status: 503 };

export interface WebhookIntake {
  /**
   * Sync-pure parse (adapter contract) → durable enqueue → outcome.
   * Performs NO store reads/writes, NO routing, NO extraction, NO transcription.
   */
  ingest(channel: WebhookChannelKind, raw_payload: unknown): Promise<WebhookIngestOutcome>;
}

export interface WebhookIntakeDeps extends EventSeams {
  telephony: TelephonyAdapter;
  email: EmailAdapter;
  queue: EventQueue;
  raw_payloads: RawPayloadStore;
}

export function createWebhookIntake(deps: WebhookIntakeDeps): WebhookIntake {
  return {
    async ingest(channel: WebhookChannelKind, raw_payload: unknown): Promise<WebhookIngestOutcome> {
      const adapter = channel === 'telephony' ? deps.telephony : deps.email;

      // 1. Synchronous, pure parse (contractually no I/O — @core §3.3).
      //    §5.1 row 4: an adapter that THROWS despite the sync-pure contract
      //    is a defect, not a path — treat as parse failure; the no-drop
      //    rule outranks blame, the payload is preserved either way.
      let parsed: AdapterResult<InboundComms>;
      try {
        parsed = adapter.parseInboundWebhook(raw_payload);
      } catch {
        parsed = {
          ok: false,
          error: {
            code: 'malformed_response',
            retryable: false,
            source: adapter.source,
            message: 'parseInboundWebhook threw despite sync-pure contract; treated as parse failure',
          } satisfies AdapterError,
        };
      }

      // 2. Build the single comms.inbound.received.v1 envelope — parsed or
      //    quarantined payload variant (core CommsInboundPayloadV1), with the
      //    T-001 §5.3 / D2 idempotency key derivation. deal_id is absent —
      //    not yet attributable.
      let payload: CommsInboundPayloadV1;
      let idempotency_key: string;
      let disposition: 'parsed' | 'quarantined';
      if (parsed.ok) {
        payload = { source: adapter.source, inbound: parsed.value };
        idempotency_key = adapter.source + ':' + parsed.value.provider_message_ref;
        disposition = 'parsed';
      } else {
        // §5.1 row 1: still ack 200 — a 5xx makes the provider retry the
        // same unparseable payload forever; giving up drops a dealer
        // message. Quarantine keeps it, operator-visible and replayable.
        const ref = deps.raw_payloads.stash(raw_payload);
        payload = { source: adapter.source, parse_error: parsed.error, raw_payload_ref: ref };
        idempotency_key = adapter.source + ':quarantine:' + ref; // D2 — same raw bytes ⇒ same key
        disposition = 'quarantined';
      }

      const envelope: EventEnvelope<'comms.inbound.received.v1', CommsInboundPayloadV1> = {
        event_id: deps.new_event_id(),
        type: 'comms.inbound.received.v1',
        occurred_at: deps.now(),
        idempotency_key,
        payload,
      };

      // 3. Durable enqueue decides the ack (§5.1 rows 2–3).
      const result = await deps.queue.publish(envelope);
      if (!result.ok) {
        return { kind: 'enqueue_failed', http_status: 503 };
      }
      return { kind: 'enqueued', http_status: 200, disposition };
    },
  };
}
