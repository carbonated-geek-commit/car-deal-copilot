/**
 * T-014 tester — second implementations of two ports (design §5 test 14, AC-12).
 *
 * The claim under test is that the ports are SWAP SEAMS: T-017 substitutes
 * Postgres for `CommsStore`, T-018 substitutes S3 for `RawPayloadStore`, and a
 * managed queue eventually substitutes for `EventQueue`, all without redesign.
 * The mechanical proof of a seam is that a second, structurally unrelated
 * implementation satisfies the interface and is accepted by
 * `createCommsService` WITHOUT A CAST — which is exactly what these two are
 * for. Neither is a mock of behavior; both are faithful, just differently
 * built.
 *
 * `CapturingQueue` additionally makes the consumers' wiring-bug guard
 * reachable: the in-memory queue only ever delivers an event to a handler
 * subscribed to that event's type, so the `poison` branch every consumer
 * carries is unreachable through it. A queue that can deliver an off-type
 * envelope is what a real mis-wired subscription looks like.
 */

import type { SpineEvent, SpineEventType } from '@core';
import type {
  CommsStore,
  ConsumeResult,
  EnqueueResult,
  EventHandler,
  EventQueue,
  QuarantinedRecord,
  RawPayloadStore,
  StoredMessage,
  UnroutedRecord,
} from '../../src/index.js';
import type { Deal, DealerThread, IdentityRef, Offer } from '@core';
import type { RollupContribution } from '../../src/index.js';

/** An `EventQueue` that records publishes and lets a test drive one handler directly. */
export class CapturingQueue implements EventQueue {
  readonly published: SpineEvent[] = [];
  private readonly handlers: Array<{ consumer: string; type: SpineEventType; handler: EventHandler }> =
    [];

  async publish(event: SpineEvent): Promise<EnqueueResult> {
    this.published.push(event);
    return { ok: true };
  }

  subscribe(consumer_name: string, type: SpineEventType, handler: EventHandler): void {
    this.handlers.push({ consumer: consumer_name, type, handler });
  }

  /** The types this consumer legitimately subscribed to. */
  typesFor(consumer: string): SpineEventType[] {
    return this.handlers.filter((h) => h.consumer === consumer).map((h) => h.type);
  }

  /** Deliver ANY envelope to a named consumer — i.e. simulate a mis-wired subscription. */
  async deliverTo(consumer: string, event: SpineEvent): Promise<ConsumeResult> {
    const entry = this.handlers.find((h) => h.consumer === consumer);
    if (entry === undefined) throw new Error(`no consumer named ${consumer} is subscribed`);
    return entry.handler(event);
  }

  get consumers(): string[] {
    return [...new Set(this.handlers.map((h) => h.consumer))];
  }
}

/** A `RawPayloadStore` built on a plain array rather than a hash index. */
export class ArrayRawPayloadStore implements RawPayloadStore {
  private readonly rows: Array<{ ref: string; payload: unknown }> = [];
  private seq = 0;

  stash(raw_payload: unknown): string {
    const serialized = JSON.stringify(raw_payload) ?? 'undefined';
    const existing = this.rows.find((r) => JSON.stringify(r.payload) === serialized);
    if (existing !== undefined) return existing.ref;
    const ref = `array-ref-${++this.seq}`;
    this.rows.push({ ref, payload: raw_payload });
    return ref;
  }

  get(ref: string): unknown | undefined {
    return this.rows.find((r) => r.ref === ref)?.payload;
  }
}

/**
 * A `CommsStore` that delegates to another one and records which port methods
 * the service actually calls. Structurally it is a different implementation:
 * it holds no state of its own, which is what a thin Postgres repository over
 * a connection pool looks like from the service's side.
 */
export class DelegatingStore implements CommsStore {
  readonly calls: string[] = [];

  constructor(private readonly inner: CommsStore) {}

  private note<T>(name: string, run: () => T): T {
    this.calls.push(name);
    return run();
  }

  putDeal(deal: Deal): void {
    this.note('putDeal', () => this.inner.putDeal(deal));
  }
  putThread(deal_id: string, thread: DealerThread): void {
    this.note('putThread', () => this.inner.putThread(deal_id, thread));
  }
  bindIdentity(deal_id: string, identity: IdentityRef): void {
    this.note('bindIdentity', () => this.inner.bindIdentity(deal_id, identity));
  }
  resolveDealByIdentity(to: { phone_number?: string; email_alias?: string }): string | undefined {
    return this.note('resolveDealByIdentity', () => this.inner.resolveDealByIdentity(to));
  }
  bindThreadContact(
    deal_id: string,
    dealership_id: string,
    contact: { phone?: string; email?: string },
  ): void {
    this.note('bindThreadContact', () => this.inner.bindThreadContact(deal_id, dealership_id, contact));
  }
  resolveDealershipByContact(
    deal_id: string,
    from: { phone?: string; email?: string },
  ): string | undefined {
    return this.note('resolveDealershipByContact', () =>
      this.inner.resolveDealershipByContact(deal_id, from),
    );
  }
  resolveOrCreateThread(deal_id: string, dealership_id: string): { dealership_id: string } {
    return this.note('resolveOrCreateThread', () =>
      this.inner.resolveOrCreateThread(deal_id, dealership_id),
    );
  }
  appendMessage(
    deal_id: string,
    dealership_id: string,
    row: StoredMessage,
  ): 'appended' | 'duplicate' {
    return this.note('appendMessage', () => this.inner.appendMessage(deal_id, dealership_id, row));
  }
  attachExtractedOffer(
    deal_id: string,
    message_ref: string,
    offer: Offer,
  ): 'set' | 'already_set' | 'not_found' {
    return this.note('attachExtractedOffer', () =>
      this.inner.attachExtractedOffer(deal_id, message_ref, offer),
    );
  }
  rollupCurrentOffer(
    deal_id: string,
    dealership_id: string,
    contribution: RollupContribution,
  ): void {
    this.note('rollupCurrentOffer', () =>
      this.inner.rollupCurrentOffer(deal_id, dealership_id, contribution),
    );
  }
  recordQuarantined(rec: QuarantinedRecord): void {
    this.note('recordQuarantined', () => this.inner.recordQuarantined(rec));
  }
  recordUnrouted(rec: UnroutedRecord): void {
    this.note('recordUnrouted', () => this.inner.recordUnrouted(rec));
  }
  hasProcessed(consumer: string, idempotency_key: string): boolean {
    return this.note('hasProcessed', () => this.inner.hasProcessed(consumer, idempotency_key));
  }
  markProcessed(consumer: string, idempotency_key: string): 'first' | 'duplicate' {
    return this.note('markProcessed', () => this.inner.markProcessed(consumer, idempotency_key));
  }
  getDeal(deal_id: string): Deal | undefined {
    return this.note('getDeal', () => this.inner.getDeal(deal_id));
  }
  getThread(deal_id: string, dealership_id: string): DealerThread | undefined {
    return this.note('getThread', () => this.inner.getThread(deal_id, dealership_id));
  }
  getMessageByRef(deal_id: string, message_ref: string): StoredMessage | undefined {
    return this.note('getMessageByRef', () => this.inner.getMessageByRef(deal_id, message_ref));
  }
  listQuarantined(): readonly QuarantinedRecord[] {
    return this.note('listQuarantined', () => this.inner.listQuarantined());
  }
  listUnrouted(deal_id?: string): readonly UnroutedRecord[] {
    return this.note('listUnrouted', () => this.inner.listUnrouted(deal_id));
  }
}
