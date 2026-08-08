/**
 * Receipt-layer contract (docs/design/T-012.md §2; supersedes T-008 §2–§3).
 *
 * specs/00-shared-core-architecture.md "Receipt layer (trust engine)": every
 * buyer note, SMS, email, and call-metadata record is append-only, timestamped,
 * exportable — and "each entry carries its author — buyer, concierge operator,
 * or dealer — so self-authored evidence is never presented as if it came from
 * the dealer". No audio and no verbatim call text exist anywhere in the v0.5
 * product (specs/01 consent posture, resolved 2026-08-07; Q14), so the kinds
 * that pointed at them were deleted rather than deprecated (D4).
 *
 * The store interface below is STRUCTURALLY append-only — it exposes append
 * and read only; no update, delete, overwrite, or truncate operation exists on
 * any exported type (AC-8).
 *
 * All shared types are imported from `@core` (ADR-001); this module defines
 * only receipt-package-local projections and never redefines `Deal`,
 * `Message`, `CallMeta`, or any core scalar/enum. Narrowings use
 * `Exclude<…>` over the spine type rather than new literal unions.
 */
import type {
  CallMeta,
  IsoTimestamp,
  MessageAuthor,
  MessageChannel,
  MessageDirection,
} from '@core';

/**
 * specs/00 "Receipt layer": buyer note, SMS, email, call-metadata record —
 * closed set (D4). The two v0.4 kinds that pointed at captured audio and at
 * verbatim call text are DELETED: not deprecated, not aliased. T-010 deleted
 * the corresponding spine fields with no shim; a shim here would re-open what
 * core closed.
 */
export type ReceiptEntryKind = 'note' | 'sms' | 'email' | 'call_meta';

interface ReceiptEntryInputBase {
  kind: ReceiptEntryKind;
  /**
   * Who produced this entry. REQUIRED — never inferred, never defaulted,
   * never derived from `kind`, `direction`, or provider metadata (D5).
   * specs/00 "Receipt layer"; `@core` `Message.author` (Q22). A default would
   * be an inference wearing a different hat, and the one failure mode this
   * field exists to prevent is self-authored evidence acquiring a `dealer`
   * label by omission.
   */
  author: MessageAuthor;
  direction: MessageDirection;
  /** When the underlying communication happened (maps to Message.timestamp). */
  occurred_at: IsoTimestamp;
  /** Idempotency anchor for at-least-once writers. Convention: event idempotency_key. */
  dedupe_key?: string;
}

/**
 * Arrived through a provider — so it has a provider correlation id and a real
 * direction. `internal` is excluded: an internal record is the account side's
 * own, and it never came off a provider wire (D9).
 */
interface ProviderOriginatedEntryInputBase extends ReceiptEntryInputBase {
  direction: Exclude<MessageDirection, 'internal'>;
  provider_message_ref?: string;
}

/**
 * The buyer's or operator's own written record (`@core`: "`note` = text the
 * buyer/operator authored"; "`internal` = the buyer's/operator's own record").
 * A dealer-authored note contradicts that gloss, so it is unrepresentable
 * rather than merely rejected (D6). No `provider_message_ref`: a note has no
 * provider id, and offering the field would invite fabricated provenance in
 * the one structure whose value is that it is not fabricated (D9).
 */
export interface NoteEntryInput extends ReceiptEntryInputBase {
  kind: 'note';
  direction: 'internal';
  author: Exclude<MessageAuthor, 'dealer'>;
  body: string;
}

export interface SmsEntryInput extends ProviderOriginatedEntryInputBase {
  kind: 'sms';
  body: string;
}

export interface EmailEntryInput extends ProviderOriginatedEntryInputBase {
  kind: 'email';
  subject?: string;
  body: string;
}

/**
 * Call METADATA only — time, direction, party (specs/00 "Comms aggregation
 * layer": "log call metadata (time, direction, party) on DealerThread").
 * `CallMeta` is the `@core` type reused verbatim (ADR-001, D8), and it has no
 * field where an audio pointer or a verbatim call text could sit — AC-7 is a
 * property of the TYPE, not a rule someone has to remember. There is
 * deliberately no `body` here either.
 *
 * `author` = who logged this call on the account side, not who spoke (D7);
 * `direction` already carries who called whom. A dealer never writes into this
 * trail, so `dealer` is unrepresentable.
 */
export interface CallMetaEntryInput extends ProviderOriginatedEntryInputBase {
  kind: 'call_meta';
  author: Exclude<MessageAuthor, 'dealer'>;
  call_meta: CallMeta;
}

export type ReceiptEntryInput =
  | NoteEntryInput
  | SmsEntryInput
  | EmailEntryInput
  | CallMetaEntryInput;

/** Store-assigned at append time; never caller-supplied. */
export interface ReceiptEntryStamp {
  /** Per-bundle monotonic sequence — append order, total and gap-tolerant. */
  seq: number;
  /** When the store accepted the entry (distinct from occurred_at). */
  appended_at: IsoTimestamp;
  /** Derived from kind — a bijection under v0.5 (see memory-store CHANNEL_BY_KIND). */
  channel: MessageChannel;
}

/**
 * A stored entry: caller input + store stamp, DEEPLY READONLY.
 * The reference implementation defensively copies the input and deep-freezes
 * the stored object, so neither later caller mutation of the input nor
 * mutation of a read-back result can alter the trail.
 */
export type ReceiptEntry = Readonly<ReceiptEntryInput & ReceiptEntryStamp>;

export type ReceiptErrorCode =
  | 'invalid_input' // caller bug (blank bundle id, missing author, empty payload) — not retryable
  | 'store_unavailable' // durable-backend outage — retryable; in-memory impl never emits it
  | 'not_implemented'; // dossier render/publish stubs — not retryable

export interface ReceiptError {
  code: ReceiptErrorCode;
  /** True only for store_unavailable. Stated explicitly so callers never guess. */
  retryable: boolean;
  /**
   * Log-safe by contract: never contains note/sms/email bodies, email
   * subjects, `call_meta.party`, phone numbers, or email addresses. Codes,
   * entry kinds, author labels (an enum), and field names only.
   */
  message: string;
}

export type ReceiptResult<T> = { ok: true; value: T } | { ok: false; error: ReceiptError };

export interface AppendOutcome {
  entry: ReceiptEntry;
  /** True when dedupe_key matched an existing entry and nothing new was written (D10). */
  deduplicated: boolean;
}

/**
 * Append-only, timestamped store for receipt entries, keyed by the Deal's
 * receipt_bundle_id (specs/00 "Core domain model"; AC-10). These TWO methods
 * are the entire surface: no update, delete, overwrite, truncate, upsert, or
 * patch operation exists on this or any exported type — and none may be added.
 * A Postgres/S3 implementation (T-017) must satisfy THIS interface unchanged.
 */
export interface ReceiptStore {
  append(receipt_bundle_id: string, input: ReceiptEntryInput): Promise<ReceiptResult<AppendOutcome>>;
  /** Chronological read-back: occurred_at ascending, ties broken by seq. */
  read(receipt_bundle_id: string): Promise<ReceiptResult<readonly ReceiptEntry[]>>;
}

/** Injectable clock for deterministic tests; defaults to system UTC now. */
export type ReceiptClock = () => IsoTimestamp;
