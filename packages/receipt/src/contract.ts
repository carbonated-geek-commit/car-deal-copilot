/**
 * Receipt-layer contract (docs/design/T-008.md §2–§3).
 *
 * specs/00-shared-core-architecture.md "Receipt layer (trust engine)":
 * every recording, transcript, SMS, email is append-only, timestamped,
 * exportable. The store interface below is STRUCTURALLY append-only —
 * it exposes append and read only; no update, delete, overwrite, or
 * truncate operation exists on any exported type (task AC-2).
 *
 * All shared types are imported from `@core` (T-001 D3); this module
 * defines only receipt-package-local projections (design R1) and never
 * redefines `Deal`, `Message`, or any core scalar/enum.
 */
import type { IsoTimestamp, MessageChannel, MessageDirection } from '@core';

/** specs/00 "Receipt layer": recording, transcript, SMS, email — closed set (R2). */
export type ReceiptEntryKind = 'recording_ref' | 'transcript' | 'sms' | 'email';

interface ReceiptEntryInputBase {
  kind: ReceiptEntryKind;
  direction: MessageDirection;
  /** When the underlying communication happened (maps to Message.timestamp). */
  occurred_at: IsoTimestamp;
  /** Correlation to the originating message/event — the spine's existing anchor (R1). */
  provider_message_ref?: string;
  /** Idempotency anchor for at-least-once writers (R6). Convention: event idempotency_key. */
  dedupe_key?: string;
}

/**
 * A POINTER to a recording (provider handle or future object-store key) —
 * never audio bytes. Consumer product policy (specs/01 transcribe-only)
 * simply never appends this kind; the kind exists because the layer is shared.
 */
export interface RecordingRefEntryInput extends ReceiptEntryInputBase {
  kind: 'recording_ref';
  recording_ref: string;
}

export interface TranscriptEntryInput extends ReceiptEntryInputBase {
  kind: 'transcript';
  transcript: string;
}

export interface SmsEntryInput extends ReceiptEntryInputBase {
  kind: 'sms';
  body: string;
}

export interface EmailEntryInput extends ReceiptEntryInputBase {
  kind: 'email';
  subject?: string;
  body: string;
}

export type ReceiptEntryInput =
  | RecordingRefEntryInput
  | TranscriptEntryInput
  | SmsEntryInput
  | EmailEntryInput;

/** Store-assigned at append time; never caller-supplied. */
export interface ReceiptEntryStamp {
  /** Per-bundle monotonic sequence — append order, total and gap-tolerant. */
  seq: number;
  /** When the store accepted the entry (distinct from occurred_at). */
  appended_at: IsoTimestamp;
  /** Derived from kind (R4): recording_ref/transcript → 'call', sms → 'sms', email → 'email'. */
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
  | 'invalid_input' // caller bug (empty bundle id, empty payload) — not retryable
  | 'store_unavailable' // durable-backend outage — retryable; in-memory impl never emits it
  | 'not_implemented'; // Epic 1 stubs (renderPdf, publishWebLink) — not retryable

export interface ReceiptError {
  code: ReceiptErrorCode;
  /** True only for store_unavailable. Stated explicitly so callers never guess. */
  retryable: boolean;
  /** Log-safe: never contains bodies, transcripts, phone numbers, or email addresses. */
  message: string;
}

export type ReceiptResult<T> = { ok: true; value: T } | { ok: false; error: ReceiptError };

export interface AppendOutcome {
  entry: ReceiptEntry;
  /** True when dedupe_key matched an existing entry and no new entry was written (R6). */
  deduplicated: boolean;
}

/**
 * Append-only, timestamped store for receipt entries, keyed by the Deal's
 * receipt_bundle_id (specs/00 "Core domain model"). specs/00 "Receipt layer":
 * append-only, timestamped, exportable. Epic 1 ships the in-memory reference;
 * a Postgres/S3 implementation must satisfy THIS interface unchanged (R7).
 */
export interface ReceiptStore {
  append(receipt_bundle_id: string, input: ReceiptEntryInput): Promise<ReceiptResult<AppendOutcome>>;
  /** Chronological read-back: occurred_at ascending, ties broken by seq (R5). */
  read(receipt_bundle_id: string): Promise<ReceiptResult<readonly ReceiptEntry[]>>;
}

/** Injectable clock for deterministic tests; defaults to system UTC now. */
export type ReceiptClock = () => IsoTimestamp;
