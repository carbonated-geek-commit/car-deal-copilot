/**
 * Note intake — the v0.5 primary capture surface (design T-014 §1.3, D4–D7).
 *
 * specs/01 (consent posture, resolved 2026-08-07): "The buyer types what the
 * dealer said, in their own words, and the offer extractor parses the terms out
 * of that text — the extractor is channel-agnostic, so a typed note works
 * exactly like any other message."
 *
 * A note is NOT an `InboundComms` and never rides `comms.inbound.received.v1`:
 * `@core`'s `InboundChannel = Exclude<MessageChannel, 'note'>` makes a
 * provider-sourced note unrepresentable (D4). Its heavy work rides the existing
 * `offer.extraction.requested.v1`, whose `message_ref` the spine already
 * documents as "caller-generated ref for a note" — no event type is invented.
 *
 * Ordering (D5, BINDING): validate → resolve deal + thread → append → publish.
 * This is deliberately NOT ack-then-queue. specs/00's ack-then-queue rule is
 * scoped to WEBHOOKS — its purpose is that a provider's timeout cannot lose a
 * message we have not yet stored. A note has no provider and no retrying
 * counterparty; the failure mode here is telling the buyer "saved" about
 * something not yet durable. The HEAVY half still runs on the bus (AC-11).
 */

import type { EventEnvelope, IsoTimestamp, MessageAuthor, OfferExtractionRequestedV1 } from '@core';
import { MESSAGE_AUTHORS } from '@core';
import type { CommsStore, EventQueue } from './ports.js';
import type { EventSeams } from './envelope.js';

/**
 * Who may author a note. Derived from the `@core` vocabulary rather than
 * re-declared (ADR-001): `dealer` is excluded because a dealer-authored
 * internal record is a contradiction of the spec's own gloss ("`note` = text
 * the buyer/operator authored"; "`internal` = the buyer's/operator's own
 * record").
 */
export type NoteAuthor = Exclude<MessageAuthor, 'dealer'>;

/** The runtime half of the same rule — for the JSON boundary an HTTP shell creates. */
const NOTE_AUTHORS: readonly MessageAuthor[] = MESSAGE_AUTHORS.filter((a) => a !== 'dealer');

const isNoteAuthor = (value: unknown): value is NoteAuthor =>
  typeof value === 'string' && (NOTE_AUTHORS as readonly string[]).includes(value);

/** ISO-8601 instant with an explicit offset. Conservative: no guessing a zone. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isIsoTimestamp = (value: unknown): value is IsoTimestamp =>
  typeof value === 'string' && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));

/** D13 — in-app input bound. Provider-inbound text is NEVER capped or truncated. */
export const DEFAULT_MAX_NOTE_CHARS = 20_000;

/**
 * The buyer's or operator's own written record.
 *
 * `direction` is NOT accepted from the caller — the service fixes it to
 * `'internal'`; `author` is required and cannot be `'dealer'` (D7; AC-7;
 * specs/00 `Message`: author is "never inferred").
 */
export interface NoteSubmission {
  deal_id: string;
  /** Which dealership relationship this note is about. The thread must already exist. */
  dealership_id: string;
  /** Caller-generated idempotency anchor. Required — it is what makes a retry safe. */
  client_note_ref: string;
  /** Who typed it. From the authenticated session on the write path, NEVER from a request body. */
  author: NoteAuthor;
  body: string;
  /** When the buyer/operator wrote it. Defaults to the injected clock when absent. */
  occurred_at?: IsoTimestamp;
}

export type NoteRejectionReason =
  | 'blank_deal_id'
  | 'blank_dealership_id'
  | 'blank_client_note_ref'
  | 'blank_body'
  | 'body_too_long'
  | 'invalid_author'
  | 'invalid_occurred_at';

/**
 * Transport-neutral outcome that ENCODES the HTTP status, exactly as
 * `WebhookIngestOutcome` does — the T-019 shell maps it 1:1 and decides nothing.
 */
export type NoteSubmitOutcome =
  | {
      kind: 'recorded';
      http_status: 201;
      message_ref: string;
      disposition: 'appended' | 'duplicate';
    }
  | {
      /**
       * The note IS durably stored; only the extraction enqueue failed. The
       * caller retries the SAME `client_note_ref`: the keyed append no-ops and
       * only the publish is re-attempted. Never reported as a failure, because
       * it did not fail.
       */
      kind: 'recorded_extraction_deferred';
      http_status: 503;
      message_ref: string;
      disposition: 'appended' | 'duplicate';
    }
  | { kind: 'rejected'; http_status: 400; reason: NoteRejectionReason }
  | { kind: 'unknown_deal'; http_status: 404 }
  | { kind: 'unknown_thread'; http_status: 404 };

export interface NoteIntake {
  submitNote(input: NoteSubmission): Promise<NoteSubmitOutcome>;
}

export interface NoteIntakeDeps extends EventSeams {
  store: CommsStore;
  queue: EventQueue;
  /** D13 — in-app input bound. Default 20 000. Provider-inbound text is never capped. */
  max_note_chars?: number;
}

/** In-app refs are namespaced so a client-chosen ref can never collide with a
 *  provider message id in the per-deal correlation index (D8). */
export const noteMessageRef = (client_note_ref: string): string => 'note:' + client_note_ref;

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

const rejected = (reason: NoteRejectionReason): NoteSubmitOutcome => ({
  kind: 'rejected',
  http_status: 400,
  reason,
});

/** Pure, no I/O — nothing is written unless every check passes. */
const validate = (input: NoteSubmission, max_note_chars: number): NoteRejectionReason | undefined => {
  if (isBlank(input.deal_id)) return 'blank_deal_id';
  if (isBlank(input.dealership_id)) return 'blank_dealership_id';
  if (isBlank(input.client_note_ref)) return 'blank_client_note_ref';
  if (!isNoteAuthor(input.author)) return 'invalid_author';
  if (isBlank(input.body)) return 'blank_body';
  // Never truncated — a truncated note is silently altered evidence (D13).
  if (input.body.length > max_note_chars) return 'body_too_long';
  if (input.occurred_at !== undefined && !isIsoTimestamp(input.occurred_at)) return 'invalid_occurred_at';
  return undefined;
};

export function createNoteIntake(deps: NoteIntakeDeps): NoteIntake {
  const max_note_chars = deps.max_note_chars ?? DEFAULT_MAX_NOTE_CHARS;

  return {
    async submitNote(input: NoteSubmission): Promise<NoteSubmitOutcome> {
      const reason = validate(input, max_note_chars);
      if (reason !== undefined) return rejected(reason);

      const { deal_id, dealership_id } = input;

      // Both must already exist. This service NEVER creates a Dealership and
      // never parks a note on a deal that does not exist (D9).
      if (deps.store.getDeal(deal_id) === undefined) {
        return { kind: 'unknown_deal', http_status: 404 };
      }
      if (deps.store.getThread(deal_id, dealership_id) === undefined) {
        return { kind: 'unknown_thread', http_status: 404 };
      }

      const message_ref = noteMessageRef(input.client_note_ref);

      // Append FIRST (D5): an extraction request must never name a row that
      // will never exist, and the buyer's own record must be durable at the
      // moment the UI says it is. The write is keyed, so a retry is a no-op.
      const disposition = deps.store.appendMessage(deal_id, dealership_id, {
        message: {
          channel: 'note',
          direction: 'internal', // fixed by the service — never caller-supplied (D7)
          author: input.author, // caller-supplied, required, never inferred (AC-7)
          body: input.body,
          timestamp: input.occurred_at ?? deps.now(),
        },
        message_ref,
        origin: { kind: 'in_app' }, // no adapter parsed this — D8
      });

      // Heavy work on the bus (AC-11) — the SAME event type, consumer, and
      // extractor entry point as sms/email (AC-6). Same idempotency-key
      // derivation, so a client retry is absorbed by the ledger.
      const extractionRequested: EventEnvelope<'offer.extraction.requested.v1', OfferExtractionRequestedV1> = {
        event_id: deps.new_event_id(),
        type: 'offer.extraction.requested.v1',
        occurred_at: deps.now(),
        deal_id,
        idempotency_key: `${deal_id}:${message_ref}:extraction-request`,
        payload: { deal_id, dealership_id, message_ref, channel: 'note', text: input.body },
      };
      const published = await deps.queue.publish(extractionRequested);
      if (!published.ok) {
        return { kind: 'recorded_extraction_deferred', http_status: 503, message_ref, disposition };
      }

      return { kind: 'recorded', http_status: 201, message_ref, disposition };
    },
  };
}
