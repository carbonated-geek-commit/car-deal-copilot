/**
 * Service assembly (design T-014 §1.4): `createCommsService` wires the webhook
 * intake and the note intake, registers the THREE consumers on the queue, and
 * exposes the read model.
 *
 * Three consumers, down from five: the speech-capture stage — its consumers,
 * its events, and its port — is gone (D1; specs/01 consent posture, resolved
 * 2026-08-07; Q14). `alert.dispatch.requested.v1` has no consumer in this service:
 * dispatch is a later epic, and the durable enqueue is the fact this service
 * owes.
 *
 * Deterministic seams: `now` (clock) and `new_event_id` (UUID source) are
 * injectable; defaults use the real clock and node:crypto randomUUID.
 */

import { randomUUID } from 'node:crypto';
import type { Deal, DealerThread, EmailAdapter, IsoTimestamp, TelephonyAdapter } from '@core';
import type {
  CommsStore,
  ConsentHook,
  EventQueue,
  QuarantinedRecord,
  RawPayloadStore,
  UnroutedRecord,
} from './ports.js';
import { passThroughConsent } from './ports.js';
import { createWebhookIntake, type WebhookIntake } from './intake.js';
import { createNoteIntake, type NoteIntake } from './notes.js';
import { createInboundRouter, INBOUND_ROUTER } from './consumers/inbound-router.js';
import { createExtractionWorker, EXTRACTION_WORKER } from './consumers/extraction-worker.js';
import { createExtractionApply, EXTRACTION_APPLY } from './consumers/extraction-apply.js';

/** Operator/read surface over the store. */
export interface CommsReadModel {
  /**
   * Assembled @core aggregate (deal + dealer_threads[] + messages[] +
   * current_offer), returned as a deep snapshot (structuredClone) so no caller
   * holds mutable references into stored state (append-only posture).
   */
  getDeal(deal_id: string): Deal | undefined;
  getThread(deal_id: string, dealership_id: string): DealerThread | undefined;
  /** The no-drop holding areas. */
  listQuarantined(): readonly QuarantinedRecord[];
  listUnrouted(): readonly UnroutedRecord[];
}

export interface CommsServiceDeps {
  telephony: TelephonyAdapter; // fixture adapter in tests
  email: EmailAdapter; // fixture adapter in tests
  queue: EventQueue; // InMemoryQueue now, managed queue later
  store: CommsStore; // InMemoryCommsStore now, Postgres later (T-017)
  raw_payloads: RawPayloadStore; // in-memory now, S3 later (T-018)
  consent?: ConsentHook; // default: passThroughConsent (D2)
  max_note_chars?: number; // D13 — in-app input bound; provider text is never capped
  now?: () => IsoTimestamp; // injectable clock (test determinism)
  new_event_id?: () => string; // injectable UUID source (test determinism)
}

export interface CommsService {
  readonly intake: WebhookIntake;
  readonly notes: NoteIntake;
  readonly read: CommsReadModel;
}

/** Registers the three consumers on the queue and returns the surface. */
export function createCommsService(deps: CommsServiceDeps): CommsService {
  const now = deps.now ?? ((): IsoTimestamp => new Date().toISOString());
  const new_event_id = deps.new_event_id ?? randomUUID;
  const consent = deps.consent ?? passThroughConsent;
  const seams = { now, new_event_id };
  const { queue, store } = deps;

  const intake = createWebhookIntake({
    telephony: deps.telephony,
    email: deps.email,
    queue,
    raw_payloads: deps.raw_payloads,
    ...seams,
  });

  const notes = createNoteIntake({
    store,
    queue,
    ...(deps.max_note_chars !== undefined ? { max_note_chars: deps.max_note_chars } : {}),
    ...seams,
  });

  queue.subscribe(
    INBOUND_ROUTER,
    'comms.inbound.received.v1',
    createInboundRouter({ store, queue, consent, ...seams }),
  );
  queue.subscribe(
    EXTRACTION_WORKER,
    'offer.extraction.requested.v1',
    createExtractionWorker({ store, queue, ...seams }),
  );
  queue.subscribe(
    EXTRACTION_APPLY,
    'offer.extraction.completed.v1',
    createExtractionApply({ store, queue, ...seams }),
  );

  const read: CommsReadModel = {
    getDeal: (deal_id) => {
      const deal = store.getDeal(deal_id);
      return deal === undefined ? undefined : structuredClone(deal);
    },
    getThread: (deal_id, dealership_id) => {
      const thread = store.getThread(deal_id, dealership_id);
      return thread === undefined ? undefined : structuredClone(thread);
    },
    listQuarantined: () => structuredClone([...store.listQuarantined()]),
    listUnrouted: () => structuredClone([...store.listUnrouted()]),
  };

  return { intake, notes, read };
}
