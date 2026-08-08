/**
 * In-memory comms store (design T-014 §1.1). Seam: Postgres relational core
 * (specs/00 "Store") — rows here mirror the eventual tables, so the swap
 * (T-017) is an implementation change, not a redesign.
 *
 * The `@core` `Message` is stored VERBATIM inside its row (AC-14 — no parallel
 * message shape); `message_ref` sits beside it as a store-internal correlation
 * column, never a spine field.
 *
 * Append-only posture: the write surface is append + fill-once only — no update
 * or delete of message content exists on the port.
 *
 * Two routing tables, two different tenancy rules (specs/00 "Dealership data
 * tenancy"; Q12 AMENDED):
 *   1. identity → deal        — the AUTHORITATIVE inbound mapping, exact match
 *                               only, over values normalized identically at
 *                               bind and at resolve. Provider-agnostic by
 *                               construction: no provider name appears here.
 *   2. (deal, contact) → dealership_id — ACCOUNT-PRIVATE. Keyed by deal_id
 *                               first, so a cross-account contact lookup is
 *                               not expressible (AC-9).
 *
 * This module NEVER creates or edits a `Dealership`: that table is globally
 * shared, and minting a row from an unrecognised phone number would inject
 * account-guessed junk into the shared namespace the tenancy split exists to
 * protect (D9). An unmatched sender goes to the unrouted holding area (D10).
 */

import type {
  Deal,
  DealerThread,
  DealershipContact,
  IdentityRef,
  Offer,
  ProcessStep,
  VehicleInstance,
} from '@core';
import type {
  CommsStore,
  QuarantinedRecord,
  StoredMessage,
  UnroutedRecord,
} from '../ports.js';
import { mergeCurrentOffer, type RollupContribution, type RollupState } from '../rollup.js';

/**
 * Normalization — identical at bind and at resolve, conservative on purpose:
 * strip formatting only, never guess country codes or alias variants. A
 * near-miss identity is a NON-match (AC-13).
 */
const normalizePhone = (phone: string): string => {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^0-9]/g, '');
  return trimmed.startsWith('+') ? '+' + digits : digits;
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** The process step a relationship whose first message just arrived is at (Q12). */
const FIRST_CONTACT_PROCESS_STEP: ProcessStep = 'information_gather';

interface ThreadRecord {
  dealership_id: string;
  vehicle_instance?: VehicleInstance;
  working_with?: DealershipContact;
  process_step: ProcessStep;
  rows: StoredMessage[];
  current_offer?: Offer;
  rollup: RollupState;
}

interface DealRecord {
  deal: Deal;
  threads: Map<string, ThreadRecord>;
  /** Correlation index: message_ref → row location. */
  refIndex: Map<string, { dealership_id: string; row_index: number }>;
  /**
   * ACCOUNT-PRIVATE contact index, scoped to THIS deal:
   * 'phone:<normalized>' | 'email:<normalized>' → dealership_id.
   */
  contactIndex: Map<string, string>;
}

export class InMemoryCommsStore implements CommsStore {
  private readonly deals = new Map<string, DealRecord>();
  /** Routing table: 'phone:<normalized>' | 'email:<normalized>' → deal_id. */
  private readonly identityIndex = new Map<string, string>();
  private readonly quarantined: QuarantinedRecord[] = [];
  private readonly unrouted: UnroutedRecord[] = [];
  /** Consumer idempotency ledger: '<consumer>\u0000<key>' (NUL-separated). */
  private readonly processed = new Set<string>();

  // -- seeding + identity routing ----------------------------------------

  putDeal(deal: Deal): void {
    const clone = structuredClone(deal);
    const rec: DealRecord = {
      deal: clone,
      threads: new Map<string, ThreadRecord>(),
      refIndex: new Map(),
      contactIndex: new Map(),
    };
    this.deals.set(clone.id, rec);
    // Seeded threads (if any) become records via the same path a caller would
    // use, so contact binding and message indexing cannot drift apart.
    for (const t of clone.dealer_threads) {
      this.putThread(clone.id, t);
    }
    if (clone.identity_ref !== undefined) {
      this.bindIdentity(clone.id, clone.identity_ref);
    }
  }

  putThread(deal_id: string, thread: DealerThread): void {
    const rec = this.mustDeal(deal_id);
    const clone = structuredClone(thread);
    const record: ThreadRecord = {
      dealership_id: clone.dealership_id,
      process_step: clone.process_step,
      // Seeded messages carry no correlation ref (they arrived with the
      // aggregate, not through a webhook or a note submission). Origin is read
      // off the message's own channel — a structural fact, never inferred from
      // content — and no adapter id is fabricated for either kind (D8).
      rows: clone.messages.map((m) => ({
        message: m,
        message_ref: '',
        origin: m.channel === 'note' ? { kind: 'in_app' as const } : { kind: 'provider' as const, source: '' },
      })),
      rollup: {},
      ...(clone.vehicle_instance !== undefined ? { vehicle_instance: clone.vehicle_instance } : {}),
      ...(clone.working_with !== undefined ? { working_with: clone.working_with } : {}),
      ...(clone.current_offer !== undefined ? { current_offer: clone.current_offer } : {}),
    };
    rec.threads.set(record.dealership_id, record);
    // The account-private contact index is how inbound reaches this thread.
    if (clone.working_with !== undefined) {
      this.bindThreadContact(deal_id, record.dealership_id, {
        ...(clone.working_with.phone !== undefined ? { phone: clone.working_with.phone } : {}),
        ...(clone.working_with.email !== undefined ? { email: clone.working_with.email } : {}),
      });
    }
  }

  bindIdentity(deal_id: string, identity: IdentityRef): void {
    if (identity.phone_number !== undefined) {
      this.identityIndex.set('phone:' + normalizePhone(identity.phone_number), deal_id);
    }
    if (identity.email_alias !== undefined) {
      this.identityIndex.set('email:' + normalizeEmail(identity.email_alias), deal_id);
    }
  }

  resolveDealByIdentity(to: { phone_number?: string; email_alias?: string }): string | undefined {
    if (to.phone_number !== undefined) {
      const hit = this.identityIndex.get('phone:' + normalizePhone(to.phone_number));
      if (hit !== undefined) return hit;
    }
    if (to.email_alias !== undefined) {
      const hit = this.identityIndex.get('email:' + normalizeEmail(to.email_alias));
      if (hit !== undefined) return hit;
    }
    return undefined; // exact match only — never fuzzy (AC-13)
  }

  // -- account-private dealership contact routing (D9) --------------------

  bindThreadContact(
    deal_id: string,
    dealership_id: string,
    contact: { phone?: string; email?: string },
  ): void {
    const rec = this.mustDeal(deal_id);
    if (contact.phone !== undefined && contact.phone !== '') {
      rec.contactIndex.set('phone:' + normalizePhone(contact.phone), dealership_id);
    }
    if (contact.email !== undefined && contact.email !== '') {
      rec.contactIndex.set('email:' + normalizeEmail(contact.email), dealership_id);
    }
  }

  resolveDealershipByContact(
    deal_id: string,
    from: { phone?: string; email?: string },
  ): string | undefined {
    const rec = this.deals.get(deal_id);
    if (rec === undefined) return undefined;
    if (from.phone !== undefined && from.phone !== '') {
      const hit = rec.contactIndex.get('phone:' + normalizePhone(from.phone));
      if (hit !== undefined) return hit;
    }
    if (from.email !== undefined && from.email !== '') {
      const hit = rec.contactIndex.get('email:' + normalizeEmail(from.email));
      if (hit !== undefined) return hit;
    }
    return undefined; // → unrouted (D10). Never a guess, never a new Dealership.
  }

  // -- threading ----------------------------------------------------------

  resolveOrCreateThread(deal_id: string, dealership_id: string): { dealership_id: string } {
    const rec = this.mustDeal(deal_id);
    const existing = rec.threads.get(dealership_id);
    // Deterministic key ⇒ idempotent under redelivery, and a second message
    // NEVER resets process_step, working_with, or vehicle_instance.
    if (existing !== undefined) return { dealership_id };
    rec.threads.set(dealership_id, {
      dealership_id,
      process_step: FIRST_CONTACT_PROCESS_STEP,
      rows: [],
      rollup: {},
    });
    return { dealership_id };
  }

  appendMessage(deal_id: string, dealership_id: string, row: StoredMessage): 'appended' | 'duplicate' {
    const rec = this.mustDeal(deal_id);
    if (rec.refIndex.has(row.message_ref)) return 'duplicate';
    const thread = rec.threads.get(dealership_id);
    if (thread === undefined) {
      throw new Error('appendMessage: unknown dealership_id (resolveOrCreateThread must run first)');
    }
    thread.rows.push(structuredClone(row));
    rec.refIndex.set(row.message_ref, { dealership_id, row_index: thread.rows.length - 1 });
    return 'appended';
  }

  // -- fill-once enrichment (never overwrites, never deletes) -------------

  attachExtractedOffer(deal_id: string, message_ref: string, offer: Offer): 'set' | 'already_set' | 'not_found' {
    const row = this.findRow(deal_id, message_ref);
    if (row === undefined) return 'not_found';
    if (row.message.extracted_offer !== undefined) return 'already_set';
    row.message.extracted_offer = structuredClone(offer); // extractor output, verbatim (possibly partial — ADR-005)
    return 'set';
  }

  rollupCurrentOffer(deal_id: string, dealership_id: string, contribution: RollupContribution): void {
    const rec = this.mustDeal(deal_id);
    const thread = rec.threads.get(dealership_id);
    if (thread === undefined) {
      throw new Error('rollupCurrentOffer: unknown dealership_id');
    }
    const merged = mergeCurrentOffer(
      { ...(thread.current_offer !== undefined ? { offer: thread.current_offer } : {}), state: thread.rollup },
      contribution,
    );
    thread.current_offer = merged.offer;
    thread.rollup = merged.state;
  }

  // -- no-drop holding areas (keyed no-ops — the braces) ------------------

  recordQuarantined(rec: QuarantinedRecord): void {
    const dupe = this.quarantined.some(
      (q) => q.source === rec.source && q.raw_payload_ref === rec.raw_payload_ref,
    );
    if (dupe) return;
    this.quarantined.push(structuredClone(rec));
  }

  /**
   * Keyed on `(source, provider_message_ref)` — the write that makes a plain
   * provider redelivery a no-op (design §3.2 rows 4-5), and, since the router
   * no longer marks the ledger on these branches, the ONLY dedupe they have.
   *
   * On a keyed hit the held item is UPDATED IN PLACE rather than dropped: the
   * inbound payload is identical by construction (same source, same provider
   * ref), but `reason` and `deal_id` are the operator-facing fields and they
   * can legitimately improve on replay — an item first held as
   * `no_identity_match` and replayed after the buyer binds the identity, but
   * before the dealership contact is known, resolves the deal and comes back
   * as `{no_thread_match, deal_id}`. Returning early there would leave the
   * operator reading a stale `no_identity_match` with no `deal_id` on it,
   * trading one silent gap for another. The record stays exactly one row and
   * `recorded_at` keeps the FIRST hold time — when it was held, not when it
   * was last re-examined.
   */
  recordUnrouted(rec: UnroutedRecord): void {
    const existing = this.unrouted.find(
      (u) => u.source === rec.source && u.inbound.provider_message_ref === rec.inbound.provider_message_ref,
    );
    if (existing !== undefined) {
      existing.reason = rec.reason;
      if (rec.deal_id !== undefined) existing.deal_id = rec.deal_id;
      else delete existing.deal_id;
      return;
    }
    this.unrouted.push(structuredClone(rec));
  }

  // -- consumer idempotency ledger ---------------------------------------

  hasProcessed(consumer: string, idempotency_key: string): boolean {
    return this.processed.has(consumer + '\u0000' + idempotency_key);
  }

  markProcessed(consumer: string, idempotency_key: string): 'first' | 'duplicate' {
    const key = consumer + '\u0000' + idempotency_key;
    if (this.processed.has(key)) return 'duplicate';
    this.processed.add(key);
    return 'first';
  }

  // -- read side (assembly; the read model deep-clones) -------------------

  getDeal(deal_id: string): Deal | undefined {
    const rec = this.deals.get(deal_id);
    if (rec === undefined) return undefined;
    return {
      ...rec.deal,
      dealer_threads: [...rec.threads.values()].map((t) => this.assembleThread(t)),
    };
  }

  getThread(deal_id: string, dealership_id: string): DealerThread | undefined {
    const thread = this.deals.get(deal_id)?.threads.get(dealership_id);
    if (thread === undefined) return undefined;
    return this.assembleThread(thread);
  }

  getMessageByRef(deal_id: string, message_ref: string): StoredMessage | undefined {
    return this.findRow(deal_id, message_ref);
  }

  listQuarantined(): readonly QuarantinedRecord[] {
    return this.quarantined;
  }

  listUnrouted(deal_id?: string): readonly UnroutedRecord[] {
    if (deal_id === undefined) return this.unrouted;
    return this.unrouted.filter((u) => u.deal_id === deal_id);
  }

  // -- internals ----------------------------------------------------------

  private assembleThread(t: ThreadRecord): DealerThread {
    return {
      dealership_id: t.dealership_id,
      process_step: t.process_step,
      messages: t.rows.map((r) => r.message),
      ...(t.vehicle_instance !== undefined ? { vehicle_instance: t.vehicle_instance } : {}),
      ...(t.working_with !== undefined ? { working_with: t.working_with } : {}),
      ...(t.current_offer !== undefined ? { current_offer: t.current_offer } : {}),
    };
  }

  private findRow(deal_id: string, message_ref: string): StoredMessage | undefined {
    const rec = this.deals.get(deal_id);
    if (rec === undefined) return undefined;
    const loc = rec.refIndex.get(message_ref);
    if (loc === undefined) return undefined;
    return rec.threads.get(loc.dealership_id)?.rows[loc.row_index];
  }

  private mustDeal(deal_id: string): DealRecord {
    const rec = this.deals.get(deal_id);
    if (rec === undefined) {
      throw new Error('unknown deal_id'); // consumer classifies as retry (store class)
    }
    return rec;
  }
}
