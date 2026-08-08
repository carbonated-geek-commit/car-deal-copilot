/**
 * Rejection marks on the receipt trail (docs/design/T-020.md D7, D8, §3.4,
 * §4.4; AC-4).
 *
 * specs/00 "Cardinality invariants": when the app rejects a vehicle that
 * contradicts the deal's anchor, "The rejection is a receipt-trail event." Q11's
 * rationale is that a dealership's substitution attempt must leave a mark rather
 * than vanishing — so the mark is the durable half of AC-3, and it is where the
 * VIN lives (D6: T-019's `toEnvelope` strips `details` for every code except
 * `invalid_request`, so no 4xx body in this service can carry a rejected value).
 *
 * D7 — why the entry is a `note`/`internal` authored by the account side.
 * `packages/receipt/src/contract.ts` fixes `ReceiptEntryKind` to
 * `note | sms | email | call_meta` and `NoteEntryInput.author` to
 * `Exclude<MessageAuthor,'dealer'>`. There is no `system` kind and no `system`
 * author, and adding one is an edit to a package this task does not own. A
 * `note` is the honest slot: the receipt layer's one hard rule is that
 * self-authored evidence never acquires a `dealer` label, and this entry is
 * account-side by construction. The `[system]` body prefix keeps it from reading
 * as buyer prose. §8.5 recommends the lead consider a typed `system` author.
 *
 * D8 — why the append happens in its OWN unit of work.
 * `packages/db/migrations/0014_target_vehicle_write_once.sql` says it outright:
 * the violation raises `DC002` and the rejection is recorded "as a receipt
 * event, which is a SEPARATE insert outside the aborted transaction". An append
 * inside the failing transaction is rolled back with it, and the substitution
 * attempt vanishes — the exact outcome Q11 exists to prevent. Callers therefore
 * detect the violation on the read, roll the session back with nothing written,
 * and only then call `appendRejectionMark`.
 */

import type { IsoTimestamp } from '@core';
import type { NoteEntryInput, ReceiptStore } from '@receipt';

import type { ActorRole } from '../context/account-context.js';

/** The minimal log surface this module needs. Satisfied by Fastify's request logger. */
export interface RouteLogger {
  info(payload: object): void;
  warn(payload: object): void;
  error(payload: object): void;
}

export type RejectionKind = 'target_vehicle_write_once' | 'instance_mismatch';

export interface RejectionFacts {
  readonly deal_id: string;
  /** Present for a vehicle-instance rejection; absent for a deal-level one. */
  readonly dealership_id?: string;
  /** User-entered and unvalidated (Q16). The trail is its durable home (D6). */
  readonly vin?: string;
  readonly submitted_make: string;
  readonly submitted_model: string;
  readonly anchor_make: string;
  readonly anchor_model: string;
  /** Optional caller anchor. Its ONLY effect is the entry's `dedupe_key` (§3.4). */
  readonly client_attempt_ref?: string;
  readonly occurred_at: IsoTimestamp;
}

/**
 * The account-side author for a mark, from the session's role.
 *
 * `dealer` is unrepresentable on a `NoteEntryInput`, which is the point: a
 * product-generated mark can never acquire dealer provenance.
 */
export const receiptAuthorFor = (role: ActorRole): 'buyer' | 'concierge' =>
  role === 'concierge_agent' ? 'concierge' : 'buyer';

const MARK_PREFIX = '[system]';

function bodyFor(kind: RejectionKind, facts: RejectionFacts): string {
  const parts: string[] = [MARK_PREFIX];
  parts.push(
    kind === 'instance_mismatch'
      ? "vehicle rejected: make/model does not match this deal's anchor."
      : 'target vehicle rejected: make and model are write-once and are fixed once any offer is attached.',
  );
  if (facts.dealership_id !== undefined) parts.push(`dealership_id=${facts.dealership_id}`);
  if (facts.vin !== undefined) parts.push(`vin=${facts.vin}`);
  parts.push(`submitted=${facts.submitted_make}/${facts.submitted_model}`);
  parts.push(`anchor=${facts.anchor_make}/${facts.anchor_model}`);
  return parts.join(' ');
}

/**
 * §3.4 — `dedupe_key` is present ONLY when the caller supplied a
 * `client_attempt_ref`.
 *
 * Without one, every attempt appends its own mark: a repeated substitution
 * attempt is itself the evidence Q11 exists to preserve, and `@receipt`'s own
 * contract states that "the safe failure direction for a trail whose value is
 * completeness is a possible duplicate … never a loss".
 */
export function rejectionEntry(
  kind: RejectionKind,
  facts: RejectionFacts,
  role: ActorRole,
): NoteEntryInput {
  const dedupe_key =
    facts.client_attempt_ref === undefined
      ? undefined
      : `reject:${kind}:${facts.deal_id}:${facts.dealership_id ?? '-'}:${facts.client_attempt_ref}`;

  return {
    kind: 'note',
    direction: 'internal',
    author: receiptAuthorFor(role),
    body: bodyFor(kind, facts),
    occurred_at: facts.occurred_at,
    ...(dedupe_key !== undefined && { dedupe_key }),
  };
}

export interface RejectionMark {
  /** From the deal that was read. Absent deals cannot be rejected against. */
  readonly receipt_bundle_id?: string;
  readonly entry: NoteEntryInput;
  /** Log event name for the rejection itself (§4.6's allow list). */
  readonly event: string;
  /** Ids and WHICH field mismatched — never a VIN, a value, or a money amount. */
  readonly detail: Readonly<Record<string, string>>;
}

/**
 * Appends the mark in its own unit of work and NEVER changes the caller's
 * outcome (§4.4).
 *
 * A failed mark does not become a retryable response: the rejection stays
 * `409`/`422` and the failure is logged at `error`. Returning `503` would tell
 * the client to retry a write that can never succeed, and swapping the code
 * would hide a correct rejection behind an infrastructure problem. The lost
 * mark is an operational alert; a durable outbox for receipt appends belongs to
 * the epic that owns the queue (§8.5).
 */
export async function appendRejectionMark(
  receipts: ReceiptStore,
  mark: RejectionMark,
  log: RouteLogger,
): Promise<void> {
  log.warn({ event: mark.event, ...mark.detail });

  const bundle = mark.receipt_bundle_id;
  if (bundle === undefined || bundle.trim() === '') {
    // Deals created through `PUT /deals/:deal_id` always carry one (D2), so
    // this is a seeded-data anomaly rather than a normal state — reported, not
    // silently skipped.
    log.error({ event: 'receipt_bundle_missing', ...mark.detail });
    return;
  }

  try {
    const appended = await receipts.append(bundle, mark.entry);
    if (!appended.ok) {
      log.error({ event: 'receipt_append_failed', code: appended.error.code, ...mark.detail });
    }
  } catch {
    // `@receipt` contracts failures as values; a throw here is a defect in an
    // implementation, and it must still not change the caller's outcome.
    log.error({ event: 'receipt_append_failed', code: 'threw', ...mark.detail });
  }
}
