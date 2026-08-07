/**
 * In-memory reference implementation of the append-only ReceiptStore
 * (docs/design/T-008.md §3). Epic 1 only — a Postgres/S3 implementation
 * must satisfy the identical interface (R7).
 *
 * Behavioral contract (binding; the durable implementation inherits every rule):
 * - `append` validates input (§5.1), derives `channel` (R4), assigns `seq`
 *   (per-bundle counter starting at 1) and `appended_at` (from the clock),
 *   defensively copies, deep-freezes, stores.
 * - Dedupe is per-bundle on `dedupe_key`; a hit returns the EXISTING frozen
 *   entry with `deduplicated: true` — no new entry, no mutation (R6).
 * - `read` returns a fresh array each call (the array is the caller's; the
 *   entries are frozen singletons), sorted occurred_at asc, seq tiebreak (R5).
 *   Unknown bundle → `{ ok: true, value: [] }` (R3).
 * - Nothing here ever reassigns or removes a stored entry — the internal map
 *   only ever gains entries, matching the interface's promise.
 *
 * PII discipline (§5.1): ReceiptError.message is log-safe by contract — it
 * never contains bodies, transcripts, subjects, phone numbers, email
 * addresses, or recording refs. Only codes, kinds, and field names appear.
 */
import type { MessageChannel } from '@core';
import type {
  AppendOutcome,
  ReceiptClock,
  ReceiptEntry,
  ReceiptEntryInput,
  ReceiptEntryKind,
  ReceiptError,
  ReceiptResult,
  ReceiptStore,
} from './contract.js';

/** Derivation table (R4): kind fully determines channel; inconsistency is inexpressible. */
const CHANNEL_BY_KIND: Readonly<Record<ReceiptEntryKind, MessageChannel>> = Object.freeze({
  recording_ref: 'call',
  transcript: 'call',
  sms: 'sms',
  email: 'email',
});

/** ISO-8601 with date, time, and explicit UTC offset (Z or ±hh:mm). */
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

interface BundleState {
  /** Append-order log. Entries are only ever pushed — never reassigned or removed. */
  entries: ReceiptEntry[];
  /** Per-bundle idempotency index (R6). */
  byDedupeKey: Map<string, ReceiptEntry>;
  /** Next seq to assign; starts at 1. */
  nextSeq: number;
}

function invalidInput(message: string): ReceiptResult<never> {
  const error: ReceiptError = { code: 'invalid_input', retryable: false, message };
  return { ok: false, error };
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Validates caller input (§5.1). Returns a log-safe error message or null.
 * Messages name fields and kinds only — never payload content.
 */
function validateInput(input: ReceiptEntryInput): string | null {
  if (input === null || typeof input !== 'object') {
    return 'entry input must be an object';
  }
  if (!(input.kind in CHANNEL_BY_KIND)) {
    return 'unknown entry kind';
  }
  if (input.direction !== 'in' && input.direction !== 'out') {
    return `direction must be 'in' or 'out' (kind: ${input.kind})`;
  }
  if (
    isBlank(input.occurred_at) ||
    !ISO_8601_PATTERN.test(input.occurred_at) ||
    Number.isNaN(Date.parse(input.occurred_at))
  ) {
    return `occurred_at must be an ISO-8601 timestamp (kind: ${input.kind})`;
  }
  switch (input.kind) {
    case 'recording_ref':
      if (isBlank(input.recording_ref)) return 'recording_ref must be non-empty (kind: recording_ref)';
      break;
    case 'transcript':
      if (isBlank(input.transcript)) return 'transcript must be non-empty (kind: transcript)';
      break;
    case 'sms':
      if (isBlank(input.body)) return 'body must be non-empty (kind: sms)';
      break;
    case 'email':
      if (isBlank(input.body)) return 'body must be non-empty (kind: email)';
      break;
  }
  return null;
}

/**
 * Defensive copy (§3): the stored entry shares no object identity with the
 * caller's input, so later caller mutation cannot alter the trail. Optional
 * fields are copied only when present (exactOptionalPropertyTypes).
 */
function copyInput(input: ReceiptEntryInput): ReceiptEntryInput {
  const base = {
    direction: input.direction,
    occurred_at: input.occurred_at,
    ...(input.provider_message_ref !== undefined
      ? { provider_message_ref: input.provider_message_ref }
      : {}),
    ...(input.dedupe_key !== undefined ? { dedupe_key: input.dedupe_key } : {}),
  };
  switch (input.kind) {
    case 'recording_ref':
      return { ...base, kind: 'recording_ref', recording_ref: input.recording_ref };
    case 'transcript':
      return { ...base, kind: 'transcript', transcript: input.transcript };
    case 'sms':
      return { ...base, kind: 'sms', body: input.body };
    case 'email':
      return {
        ...base,
        kind: 'email',
        body: input.body,
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
      };
  }
}

/** Recursively freezes an object graph. Entry fields are primitive today; recursion future-proofs the invariant. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Chronological order (R5): occurred_at ascending, ties broken by per-bundle seq. */
function chronological(a: ReceiptEntry, b: ReceiptEntry): number {
  return Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.seq - b.seq;
}

const defaultClock: ReceiptClock = () => new Date().toISOString();

/**
 * Creates the Epic 1 in-memory reference ReceiptStore.
 * Injectable clock for deterministic tests; defaults to system UTC now.
 */
export function createInMemoryReceiptStore(clock: ReceiptClock = defaultClock): ReceiptStore {
  const bundles = new Map<string, BundleState>();

  return {
    async append(
      receipt_bundle_id: string,
      input: ReceiptEntryInput,
    ): Promise<ReceiptResult<AppendOutcome>> {
      if (isBlank(receipt_bundle_id)) {
        return invalidInput('receipt_bundle_id must be a non-empty string');
      }
      const validationMessage = validateInput(input);
      if (validationMessage !== null) {
        return invalidInput(validationMessage);
      }

      let bundle = bundles.get(receipt_bundle_id);
      if (bundle === undefined) {
        bundle = { entries: [], byDedupeKey: new Map(), nextSeq: 1 };
        bundles.set(receipt_bundle_id, bundle);
      }

      // Idempotent append (R6): a dedupe hit returns the existing frozen entry
      // untouched — dedupe never becomes upsert.
      if (input.dedupe_key !== undefined) {
        const existing = bundle.byDedupeKey.get(input.dedupe_key);
        if (existing !== undefined) {
          return { ok: true, value: { entry: existing, deduplicated: true } };
        }
      }

      const entry = deepFreeze({
        ...copyInput(input),
        seq: bundle.nextSeq,
        appended_at: clock(),
        channel: CHANNEL_BY_KIND[input.kind],
      }) as ReceiptEntry;

      bundle.nextSeq += 1;
      bundle.entries.push(entry);
      if (entry.dedupe_key !== undefined) {
        bundle.byDedupeKey.set(entry.dedupe_key, entry);
      }

      return { ok: true, value: { entry, deduplicated: false } };
    },

    async read(receipt_bundle_id: string): Promise<ReceiptResult<readonly ReceiptEntry[]>> {
      if (isBlank(receipt_bundle_id)) {
        return invalidInput('receipt_bundle_id must be a non-empty string');
      }
      const bundle = bundles.get(receipt_bundle_id);
      if (bundle === undefined) {
        // Unknown / never-appended bundle is a valid empty bundle (R3).
        return { ok: true, value: [] };
      }
      // Fresh array each call: the array belongs to the caller; the entries
      // remain frozen singletons.
      return { ok: true, value: [...bundle.entries].sort(chronological) };
    },
  };
}
