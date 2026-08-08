/**
 * Ports — the swap seams the task demands (design T-009 §3): swapping an
 * implementation is wiring, not redesign.
 *
 * Seam map (design §3, all targets on the CLAUDE.md approved list; none
 * wired in Epic 1):
 *   EventQueue      → managed queue (SQS/SNS or equivalent), specs/00 "Async backbone"
 *   CommsStore      → Postgres relational core, specs/00 "Store"
 *   RawPayloadStore → S3-compatible object store
 *
 * Every domain/event/adapter shape is an import from `@core` — referenced,
 * never redefined (ADR-001; T-001 D2/D3). This module adds only
 * orchestration and infrastructure types.
 *
 * Build-time port completions (deviations from the §3.2 listing, resolved at
 * build within the design's own invariants — flagged to the lead):
 *   - `CommsStore.hasProcessed`: §5.4 requires the ledger check to happen
 *     FIRST ("'duplicate' → done immediately") while marking happens ONLY
 *     after the handler's writes/publishes succeed ("a retry never marks").
 *     A single check-and-set `markProcessed` cannot satisfy both; the
 *     read-only peek is the missing half. Postgres seam: SELECT on the
 *     unique (consumer, key) index.
 *   - `CommsStoreReader` (getDeal / getThread / getMessageByRef /
 *     listQuarantined / listUnrouted): §2.2's read model must assemble
 *     aggregates and §4.2 C5 needs the contributing Message.timestamp for
 *     the §6 rollup contribution; the §3.2 listing exposed no read path.
 *     Postgres seam: ordinary SELECTs.
 */

import type {
  AdapterError,
  AdapterResult,
  Deal,
  DealerThread,
  IdentityRef,
  InboundComms,
  IsoTimestamp,
  Message,
  Offer,
  OutboundEmail,
  OutboundSms,
  ProviderSendReceipt,
  SpineEvent,
  SpineEventType,
} from '@core';
import type { RollupContribution } from './rollup.js';

// ---- queue port (§3.1) — seam: managed queue (SQS/SNS or equivalent) ----

export type EnqueueResult = { ok: true } | { ok: false; reason: string };

/** Consumer verdicts — T-001 §5.3 made operational. */
export type ConsumeResult =
  | { status: 'done' } // success OR idempotent duplicate — never redeliver
  | { status: 'retry'; reason: string } // transient — redeliver, bounded attempts
  | { status: 'poison'; reason: string }; // non-retryable — dead-letter immediately, envelope intact

export type EventHandler = (event: SpineEvent) => Promise<ConsumeResult>;

export interface EventQueue {
  /**
   * Durable enqueue. Resolving { ok: true } IS the webhook 2xx precondition.
   * Never throws — failure is a value (house style, @core AdapterResult).
   */
  publish(event: SpineEvent): Promise<EnqueueResult>;
  /** At-least-once, UNORDERED delivery to each (consumer, type) subscription. */
  subscribe(consumer_name: string, type: SpineEventType, handler: EventHandler): void;
}

/** Dead-lettered delivery — envelope intact (T-001 §5.3). */
export interface DeadLetter {
  event: SpineEvent;
  consumer: string;
  attempts: number;
  last_reason: string;
}

// ---- store port (§3.2) — seam: Postgres relational core -----------------

/**
 * D3: spine Message + correlation columns. Postgres seam: the messages table,
 * where these are ordinary columns and message fields are the row. The
 * correlation ref is envelope-derived persistence metadata, NOT a spine field
 * (T-001 D2 preserved — no field added to any spine type).
 */
export interface StoredMessage {
  message: Message; // the ONLY message shape stored — @core, verbatim
  provider_message_ref: string; // envelope-derived correlation column
  source: string; // adapter id that parsed it
}

/** Seam: quarantine table. No-drop holding area for unparseable payloads. */
export interface QuarantinedRecord {
  source: string;
  parse_error: AdapterError; // @core shape, from CommsInboundQuarantinedV1
  raw_payload_ref: string; // → RawPayloadStore
  recorded_at: IsoTimestamp;
}

/** Seam: unrouted-inbound table (D5). Held whole, replayable — never guessed, never dropped. */
export interface UnroutedRecord {
  source: string;
  inbound: InboundComms; // @core shape — held whole
  reason: 'no_identity_match';
  recorded_at: IsoTimestamp;
}

/** Read side (build-time completion — see module header). Returns are
 *  store-internal references; the read model (§2.2) deep-clones. */
export interface CommsStoreReader {
  /** Assembled @core aggregate: deal + dealer_threads[] + messages[] + current_offer. */
  getDeal(deal_id: string): Deal | undefined;
  getThread(deal_id: string, dealer_id: string): DealerThread | undefined;
  /** D3 correlation index lookup — C5 reads the contributing Message.timestamp here. */
  getMessageByRef(deal_id: string, provider_message_ref: string): StoredMessage | undefined;
  listQuarantined(): readonly QuarantinedRecord[];
  listUnrouted(): readonly UnroutedRecord[];
}

export interface CommsStore extends CommsStoreReader {
  // -- seeding + identity routing (the AUTHORITATIVE mapping — §8 invariant 1)
  putDeal(deal: Deal): void;
  /**
   * Binds identity → deal in the routing table. Normalization at bind and at
   * resolve is identical (E.164-shaped for phones, lowercased for email aliases).
   */
  bindIdentity(deal_id: string, identity: IdentityRef): void;
  /** EXACT match only over normalized values — never fuzzy (D5). */
  resolveDealByIdentity(to: { phone_number?: string; email_alias?: string }): string | undefined;

  // -- threading (append-only; idempotent by construction)
  /** Match `from` against existing thread contacts, else create (D6). */
  resolveOrCreateThread(deal_id: string, from: { phone?: string; email?: string }): { dealer_id: string };
  /**
   * No-op when (deal_id, provider_message_ref) already appended — the keyed
   * write that makes redelivery safe even without the processed-ledger.
   */
  appendMessage(deal_id: string, dealer_id: string, row: StoredMessage): 'appended' | 'duplicate';

  // -- fill-once enrichment via the D3 correlation index (D7: never overwrites, never deletes)
  setTranscript(deal_id: string, provider_message_ref: string, transcript: string): 'set' | 'already_set' | 'not_found';
  attachExtractedOffer(deal_id: string, provider_message_ref: string, offer: Offer): 'set' | 'already_set' | 'not_found';
  /** Applies §6 mergeCurrentOffer to the thread; stores offer + RollupState. */
  rollupCurrentOffer(deal_id: string, dealer_id: string, contribution: RollupContribution): void;

  // -- no-drop holding areas (operator surfaces via read model)
  recordQuarantined(rec: QuarantinedRecord): void;
  recordUnrouted(rec: UnroutedRecord): void;

  // -- consumer idempotency ledger (belt; the keyed writes above are braces)
  /** Read-only ledger peek — §5.4 belt check without marking (a retry must never mark). */
  hasProcessed(consumer: string, idempotency_key: string): boolean;
  /** Seam: Postgres processed_events table w/ unique (consumer, key) index.
   *  Called only AFTER a handler's writes and publishes succeed (§5.4). */
  markProcessed(consumer: string, idempotency_key: string): 'first' | 'duplicate';
}

// ---- raw payload store (§3.3) — seam: S3-compatible object store --------

export interface RawPayloadStore {
  /**
   * Stash a raw (unparseable) provider payload; returns the deterministic ref
   * (sha-256 hex of canonical JSON — D2). Seam: S3 object key. The payload
   * NEVER rides the bus or the logs — only this ref does (core
   * CommsInboundQuarantinedV1 contract).
   */
  stash(raw_payload: unknown): string;
  get(ref: string): unknown | undefined; // operator replay path (later epic)
}

// ---- hooks (per-product seams) and outbound seam (§3.4) -----------------

/**
 * D8 — specs/00 inbound-call flow "(consent handling per product)".
 * Pure decision; called by the inbound router for calls BEFORE
 * comms.transcription.requested.v1 is published. No consumer/B2B consent
 * POLICY is implemented in this shared service.
 */
export interface ConsentHook {
  onInboundCall(deal_id: string, inbound: InboundComms): { transcribe: boolean };
}

/** Default hook: always transcribe (pass-through). */
export const passThroughConsent: ConsentHook = {
  onInboundCall: () => ({ transcribe: true }),
};

/** D9 — stubbed transcription stage. undefined ⇒ transcript unavailable ⇒ retry. */
export interface TranscriptStub {
  transcriptFor(call_ref: string): string | undefined;
}

/**
 * D10 — outbound seam, Epic 1: TYPE ONLY. Nothing implements or calls this.
 * Typed against the @core adapter contracts; origination is a later epic.
 */
export interface OutboundPort {
  sendSms(deal_id: string, dealer_id: string, msg: OutboundSms): Promise<AdapterResult<ProviderSendReceipt>>;
  sendEmail(deal_id: string, dealer_id: string, msg: OutboundEmail): Promise<AdapterResult<ProviderSendReceipt>>;
}
