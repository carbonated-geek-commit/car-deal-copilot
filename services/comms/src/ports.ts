/**
 * Ports — the swap seams (design T-014 §1.1, superseding T-009 §3 inside this
 * service): swapping an implementation is wiring, not redesign.
 *
 * Seam map (all targets on the CLAUDE.md approved list; only the in-memory
 * implementations exist in this epic):
 *   EventQueue      → managed queue (SQS/SNS or equivalent), specs/00 "Async backbone"
 *   CommsStore      → Postgres relational core (T-017), specs/00 "Store"
 *   RawPayloadStore → S3-compatible object store (T-018)
 *
 * Every domain/event/adapter shape is an import from `@core` — referenced,
 * never redefined (ADR-001; AC-14). This module adds only orchestration and
 * infrastructure types.
 *
 * v0.5 (T-014 D1): there is no speech-capture seam here. specs/01 (consent
 * posture, resolved 2026-08-07) states that no such provider is required, so
 * none is approved or wired, and Q14 removed the stage entirely — the port, its
 * consumers, and the fill-once store method were DELETED rather than stubbed.
 * `@core` has no such event contract, so publishing one is a compile error, and
 * `Message` has no audio field and no text-of-a-call field for one to land in.
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

// ---- queue port — seam: managed queue (SQS/SNS or equivalent) ------------

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

// ---- store port — seam: Postgres relational core (T-017) -----------------

/**
 * Where a stored message came from (D8). A note is authored in-app and has no
 * adapter and no provider id, so a fabricated one is UNREPRESENTABLE rather
 * than merely discouraged.
 */
export type MessageOrigin =
  | { kind: 'provider'; source: string } // adapter id that parsed it
  | { kind: 'in_app' }; // authored in the product

/**
 * Spine Message + correlation columns. Postgres seam: the messages table,
 * where these are ordinary columns and the message fields are the row.
 * `message_ref` is envelope- or caller-derived persistence metadata, NOT a
 * spine field — no field is added to any spine type (ADR-001).
 */
export interface StoredMessage {
  message: Message; // the ONLY message shape stored — @core, verbatim
  /** Provider message id, or `note:<client_note_ref>` for an in-app note (D8). */
  message_ref: string;
  origin: MessageOrigin;
}

/** Seam: quarantine table. No-drop holding area for unparseable payloads. */
export interface QuarantinedRecord {
  source: string;
  parse_error: AdapterError; // @core shape, from CommsInboundQuarantinedV1
  raw_payload_ref: string; // → RawPayloadStore
  recorded_at: IsoTimestamp;
}

/**
 * Why an inbound item could not be placed. Both are HELD, never dropped,
 * never guessed onto a thread, never turned into a new `Dealership` (D9/D10).
 */
export type UnroutedReason =
  | 'no_identity_match' // no deal owns the identity that was contacted
  | 'no_thread_match'; // deal found, but the sender maps to no known Dealership

/** Seam: unrouted-inbound table. Held whole, replayable. */
export interface UnroutedRecord {
  source: string;
  inbound: InboundComms; // @core shape — held whole
  reason: UnroutedReason;
  /** Present only for 'no_thread_match' — the deal is known, the dealership is not. */
  deal_id?: string;
  recorded_at: IsoTimestamp;
}

/** Read side. Returns are store-internal references; the read model deep-clones. */
export interface CommsStoreReader {
  /** Assembled @core aggregate: deal + dealer_threads[] + messages[] + current_offer. */
  getDeal(deal_id: string): Deal | undefined;
  getThread(deal_id: string, dealership_id: string): DealerThread | undefined;
  /** Correlation-index lookup — the rollup reads the contributing Message.timestamp here. */
  getMessageByRef(deal_id: string, message_ref: string): StoredMessage | undefined;
  listQuarantined(): readonly QuarantinedRecord[];
  listUnrouted(): readonly UnroutedRecord[];
}

export interface CommsStore extends CommsStoreReader {
  // -- seeding + identity routing (the AUTHORITATIVE mapping) --------------
  putDeal(deal: Deal): void;
  /**
   * Seed/replace a thread row for a KNOWN dealership. Also binds
   * `working_with`'s phone/email into the account-private contact index.
   */
  putThread(deal_id: string, thread: DealerThread): void;
  /**
   * Binds identity → deal in the routing table. Normalization at bind and at
   * resolve is identical (E.164-shaped for phones, lowercased for email aliases).
   */
  bindIdentity(deal_id: string, identity: IdentityRef): void;
  /** EXACT match only over normalized values — never fuzzy (AC-13). */
  resolveDealByIdentity(to: { phone_number?: string; email_alias?: string }): string | undefined;

  // -- account-private dealership contact routing (Q12 AMENDED, D9) --------
  /**
   * Binds a dealership contact point → dealership_id WITHIN ONE DEAL. The
   * `deal_id` parameter is first and mandatory: a contact lookup that is not
   * scoped to one account-owned deal is inexpressible on this port (AC-9).
   */
  bindThreadContact(
    deal_id: string,
    dealership_id: string,
    contact: { phone?: string; email?: string },
  ): void;
  /**
   * EXACT match only, within this deal. `undefined` ⇒ unrouted (D10) — never
   * a guess, and never a newly minted `Dealership` (that table is global).
   */
  resolveDealershipByContact(
    deal_id: string,
    from: { phone?: string; email?: string },
  ): string | undefined;

  // -- threading (append-only; idempotent by construction) -----------------
  /**
   * Returns the thread for a KNOWN dealership_id, creating the row on first
   * contact with `process_step: 'information_gather'`, no `vehicle_instance`
   * and no `working_with` (D9). Deterministic key ⇒ idempotent under
   * redelivery, and a second message never resets an existing row.
   */
  resolveOrCreateThread(deal_id: string, dealership_id: string): { dealership_id: string };
  /**
   * No-op when (deal_id, message_ref) already appended — the keyed write that
   * makes redelivery safe even without the processed-ledger.
   */
  appendMessage(deal_id: string, dealership_id: string, row: StoredMessage): 'appended' | 'duplicate';

  // -- fill-once enrichment (never overwrites, never deletes) --------------
  attachExtractedOffer(deal_id: string, message_ref: string, offer: Offer): 'set' | 'already_set' | 'not_found';
  /** Applies mergeCurrentOffer to the thread; stores offer + RollupState (ADR-006). */
  rollupCurrentOffer(deal_id: string, dealership_id: string, contribution: RollupContribution): void;

  // -- no-drop holding areas (operator surfaces via read model) ------------
  recordQuarantined(rec: QuarantinedRecord): void;
  recordUnrouted(rec: UnroutedRecord): void;

  // -- consumer idempotency ledger (belt; the keyed writes above are braces)
  /** Read-only ledger peek — the belt check without marking (a retry must never mark). */
  hasProcessed(consumer: string, idempotency_key: string): boolean;
  /** Seam: Postgres processed_events table w/ unique (consumer, key) index.
   *  Called only AFTER a handler's writes and publishes succeed. */
  markProcessed(consumer: string, idempotency_key: string): 'first' | 'duplicate';
}

/*
 * Never on this port, by construction: any method that mutates `process_step`,
 * `working_with`, `vehicle_instance`, `target_vehicle`, `walk_away_number`, or
 * a `Dealership` record. This service threads messages and rolls up offers;
 * negotiation state and vehicle identity belong to the buyer through the API
 * (T-019/T-020). A message arriving cannot advance a negotiation step.
 */

// ---- raw payload store — seam: S3-compatible object store (T-018) --------

export interface RawPayloadStore {
  /**
   * Stash a raw (unparseable) provider payload; returns the deterministic ref
   * (sha-256 hex of canonical JSON). Seam: S3 object key. The payload NEVER
   * rides the bus or the logs — only this ref does (core
   * CommsInboundQuarantinedV1 contract).
   */
  stash(raw_payload: unknown): string;
  get(ref: string): unknown | undefined; // operator replay path
}

// ---- per-product hook and outbound seam ---------------------------------

/**
 * Per-product OBSERVATION seam for an inbound call (D2). specs/00's call flow
 * still carries per-product consent handling for products that owe a
 * DISCLOSURE — but there is nothing to consent to (specs/01: "Legal exposure
 * from two-party-consent states is avoided entirely rather than managed —
 * there is nothing to consent to"; Q14).
 *
 * Returns `void` ON PURPOSE (AC-4): with no return channel the hook cannot
 * authorise, gate, suppress, or veto anything, and it is invoked AFTER the call
 * message is durably appended (D3), so no per-product policy can drop a dealer
 * record. A hook that throws yields bounded retries → dead-letter with the
 * envelope intact and the call still threaded exactly once.
 */
export interface ConsentHook {
  onInboundCall(deal_id: string, inbound: InboundComms): void;
}

/** Default hook: does nothing. */
export const passThroughConsent: ConsentHook = {
  onInboundCall: () => {},
};

/**
 * Outbound seam — still TYPE ONLY this epic. Nothing implements or calls it;
 * origination/relay is a later epic (task Notes).
 */
export interface OutboundPort {
  sendSms(deal_id: string, dealership_id: string, msg: OutboundSms): Promise<AdapterResult<ProviderSendReceipt>>;
  sendEmail(deal_id: string, dealership_id: string, msg: OutboundEmail): Promise<AdapterResult<ProviderSendReceipt>>;
}
