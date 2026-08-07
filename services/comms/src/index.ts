/**
 * @deal-copilot/comms public surface — the only import boundary for tests
 * and the later HTTP shell (design T-009 §1, §2).
 *
 * Everything domain-shaped is an `@core` import inside these modules —
 * referenced, never redefined (ADR-001). This service exports only
 * orchestration, ports, and in-memory infrastructure.
 */

// §2.1 webhook intake (transport-neutral — D1)
export type { WebhookChannelKind, WebhookIngestOutcome, WebhookIntake, WebhookIntakeDeps } from './intake.js';
export { createWebhookIntake } from './intake.js';

// §2.2 / §2.3 service assembly + read model
export type { CommsReadModel, CommsService, CommsServiceDeps } from './service.js';
export { createCommsService } from './service.js';

// §3 ports (swap seams: EventQueue→SQS/SNS, CommsStore→Postgres, RawPayloadStore→S3)
export type {
  CommsStore,
  CommsStoreReader,
  ConsentHook,
  ConsumeResult,
  DeadLetter,
  EnqueueResult,
  EventHandler,
  EventQueue,
  OutboundPort,
  QuarantinedRecord,
  RawPayloadStore,
  StoredMessage,
  TranscriptStub,
  UnroutedRecord,
} from './ports.js';
export { passThroughConsent } from './ports.js';

// §6 rollup policy (D4 — the lead-ADR blast radius is rollup.ts alone)
export type { RollupContribution, RollupProvenance, RollupState } from './rollup.js';
export { mergeCurrentOffer } from './rollup.js';

// in-memory implementations (Epic 1 infrastructure)
export { InMemoryQueue } from './queue/in-memory-queue.js';
export { InMemoryCommsStore } from './store/in-memory-store.js';
export { InMemoryRawPayloadStore, canonicalJson } from './store/in-memory-raw-payloads.js';
