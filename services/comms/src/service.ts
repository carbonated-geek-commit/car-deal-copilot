/**
 * Service assembly (design T-009 §2.3): `createCommsService` wires the
 * webhook intake, registers all five consumers (§4.2) on the queue, and
 * exposes the read model.
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
  TranscriptStub,
  UnroutedRecord,
} from './ports.js';
import { passThroughConsent } from './ports.js';
import { createWebhookIntake, type WebhookIntake } from './intake.js';
import { createInboundRouter, INBOUND_ROUTER } from './consumers/inbound-router.js';
import {
  createTranscriptionStubWorker,
  TRANSCRIPTION_STUB_WORKER,
} from './consumers/transcription-stub-worker.js';
import { createTranscriptionApply, TRANSCRIPTION_APPLY } from './consumers/transcription-apply.js';
import { createExtractionWorker, EXTRACTION_WORKER } from './consumers/extraction-worker.js';
import { createExtractionApply, EXTRACTION_APPLY } from './consumers/extraction-apply.js';

/** §2.2 — operator/read surface over the store. */
export interface CommsReadModel {
  /**
   * Assembled @core aggregate (deal + dealer_threads[] + messages[] +
   * current_offer), returned as a deep snapshot (structuredClone) so no
   * caller holds mutable references into stored state (append-only posture).
   */
  getDeal(deal_id: string): Deal | undefined;
  getThread(deal_id: string, dealer_id: string): DealerThread | undefined;
  /** Operator surfaces — the no-drop holding areas (§5.3, D5). */
  listQuarantined(): readonly QuarantinedRecord[];
  listUnrouted(): readonly UnroutedRecord[];
}

export interface CommsServiceDeps {
  telephony: TelephonyAdapter; // fixture adapter in Epic 1 tests
  email: EmailAdapter; // fixture adapter in Epic 1 tests
  queue: EventQueue; // §3.1 — InMemoryQueue now, SQS/SNS later
  store: CommsStore; // §3.2 — InMemoryCommsStore now, Postgres later
  raw_payloads: RawPayloadStore; // §3.3 — in-memory now, S3 later
  transcribe: TranscriptStub; // §3.4 (D9)
  consent?: ConsentHook; // §3.4 (D8) — default: pass-through
  now?: () => IsoTimestamp; // injectable clock (test determinism)
  new_event_id?: () => string; // injectable UUID source (test determinism)
}

export interface CommsService {
  readonly intake: WebhookIntake;
  readonly read: CommsReadModel;
}

/** Registers all five consumers (§4.2) on the queue and returns the surface. */
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

  queue.subscribe(
    INBOUND_ROUTER,
    'comms.inbound.received.v1',
    createInboundRouter({ store, queue, consent, ...seams }),
  );
  queue.subscribe(
    TRANSCRIPTION_STUB_WORKER,
    'comms.transcription.requested.v1',
    createTranscriptionStubWorker({ store, queue, transcribe: deps.transcribe, ...seams }),
  );
  queue.subscribe(
    TRANSCRIPTION_APPLY,
    'comms.transcription.completed.v1',
    createTranscriptionApply({ store, queue, ...seams }),
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
    getThread: (deal_id, dealer_id) => {
      const thread = store.getThread(deal_id, dealer_id);
      return thread === undefined ? undefined : structuredClone(thread);
    },
    listQuarantined: () => structuredClone([...store.listQuarantined()]),
    listUnrouted: () => structuredClone([...store.listUnrouted()]),
  };

  return { intake, read };
}
