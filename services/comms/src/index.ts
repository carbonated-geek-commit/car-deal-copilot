/**
 * @deal-copilot/comms public surface — the only import boundary for tests and
 * the later HTTP shell (design T-014 §1.7).
 *
 * Everything domain-shaped is an `@core` import inside these modules —
 * referenced, never redefined (ADR-001, AC-14). This service exports only
 * orchestration, ports, and in-memory infrastructure.
 *
 * The speech-capture stage and its port are gone: specs/01 (consent posture,
 * resolved 2026-08-07) and Q14 removed the stage entirely, so the seam a
 * provider would plug into does not exist (D1) — the absence IS the
 * enforcement.
 */

// webhook intake (transport-neutral; ack-then-queue)
export type { WebhookChannelKind, WebhookIngestOutcome, WebhookIntake, WebhookIntakeDeps } from './intake.js';
export { createWebhookIntake } from './intake.js';

// note intake — the v0.5 primary capture surface
export type {
  NoteAuthor,
  NoteIntake,
  NoteIntakeDeps,
  NoteRejectionReason,
  NoteSubmission,
  NoteSubmitOutcome,
} from './notes.js';
export { createNoteIntake, DEFAULT_MAX_NOTE_CHARS, noteMessageRef } from './notes.js';

// service assembly + read model
export type { CommsReadModel, CommsService, CommsServiceDeps } from './service.js';
export { createCommsService } from './service.js';

// ports (swap seams: EventQueue→managed queue, CommsStore→Postgres, RawPayloadStore→S3)
export type {
  CommsStore,
  CommsStoreReader,
  ConsentHook,
  ConsumeResult,
  DeadLetter,
  EnqueueResult,
  EventHandler,
  EventQueue,
  MessageOrigin,
  OutboundPort,
  QuarantinedRecord,
  RawPayloadStore,
  StoredMessage,
  UnroutedReason,
  UnroutedRecord,
} from './ports.js';
export { passThroughConsent } from './ports.js';

// rollup policy (ADR-006 — the blast radius is rollup.ts alone)
export type { RollupContribution, RollupProvenance, RollupState } from './rollup.js';
export { mergeCurrentOffer } from './rollup.js';

// in-memory implementations (the test double; Half B swaps Postgres/S3 behind
// the same ports without redesign)
export { InMemoryQueue } from './queue/in-memory-queue.js';
export { InMemoryCommsStore } from './store/in-memory-store.js';
export { InMemoryRawPayloadStore, canonicalJson } from './store/in-memory-raw-payloads.js';
