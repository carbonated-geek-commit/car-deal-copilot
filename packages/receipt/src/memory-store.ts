/**
 * In-memory reference implementation of the append-only ReceiptStore
 * (docs/design/T-012.md §2.4). A Postgres/S3 implementation (T-017) must
 * satisfy the identical interface and inherit every rule below unchanged.
 *
 * Behavioral contract (binding):
 * - `append` validates input (§4.2), derives `channel` from `kind`, assigns
 *   `seq` (per-bundle counter starting at 1) and `appended_at` (from the
 *   clock), defensively copies, deep-freezes, stores.
 * - Dedupe is per-bundle on `dedupe_key`; a hit returns the EXISTING frozen
 *   entry with `deduplicated: true` — no new entry, no mutation, first write
 *   wins even when the redelivered payload differs (D10). Dedupe never
 *   becomes upsert; the interface deliberately offers no overwrite.
 * - `read` returns a fresh array each call (the array is the caller's; the
 *   entries are frozen singletons), sorted occurred_at asc, seq tiebreak.
 *   Unknown bundle → `{ ok: true, value: [] }`.
 * - Nothing here ever reassigns or removes a stored entry — the internal map
 *   only ever gains entries, matching the interface's promise (AC-8).
 *
 * Authorship (AC-6, D5–D7): `author` is required, is never defaulted and is
 * never derived. The TypeScript types already make a dealer-authored note or
 * internal record unrepresentable; the runtime checks below exist for the
 * JS/JSON boundaries the type system does not reach.
 *
 * PII discipline (§4.5): ReceiptError.message is log-safe by contract — it
 * never contains bodies, email subjects, `call_meta.party`, phone numbers, or
 * email addresses. Only codes, kinds, author labels, and field names appear.
 */
import type { MessageAuthor, MessageChannel, MessageDirection } from '@core';
import { MESSAGE_AUTHORS, MESSAGE_DIRECTIONS } from '@core';
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

/**
 * Derivation table: kind fully determines channel. Under v0.5 this is a
 * BIJECTION (v0.4's two audio/verbatim-call-text kinds both mapped onto
 * `call`; both are gone), so a mismatched kind/channel pair is inexpressible.
 * Exhaustive over `ReceiptEntryKind`: a future kind cannot be added without
 * deciding its channel.
 */
const CHANNEL_BY_KIND: Readonly<Record<ReceiptEntryKind, MessageChannel>> = Object.freeze({
  note: 'note',
  sms: 'sms',
  email: 'email',
  call_meta: 'call',
});

/** ISO-8601 with date, time, and explicit UTC offset (Z or ±hh:mm). */
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const AUTHOR_LABELS = MESSAGE_AUTHORS.join('|');

interface BundleState {
  /** Append-order log. Entries are only ever pushed — never reassigned or removed. */
  entries: ReceiptEntry[];
  /** Per-bundle idempotency index (D10). */
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

function isAuthor(value: unknown): value is MessageAuthor {
  return MESSAGE_AUTHORS.includes(value as MessageAuthor);
}

function isDirection(value: unknown): value is MessageDirection {
  return MESSAGE_DIRECTIONS.includes(value as MessageDirection);
}

function isIsoTimestamp(value: unknown): boolean {
  return (
    !isBlank(value) &&
    ISO_8601_PATTERN.test(value as string) &&
    !Number.isNaN(Date.parse(value as string))
  );
}

/**
 * Validates caller input (§4.2). Returns a log-safe error message or null.
 * Messages name fields, kinds, and author labels only — never payload content.
 */
function validateInput(input: ReceiptEntryInput): string | null {
  if (input === null || typeof input !== 'object') {
    return 'entry input must be an object';
  }
  if (typeof input.kind !== 'string' || !Object.hasOwn(CHANNEL_BY_KIND, input.kind)) {
    return 'unknown entry kind';
  }
  // AC-6: an authorless entry can never enter the trail. No default, no
  // derivation — a missing or unknown author is a rejected write, not a
  // guessed one.
  if (!isAuthor(input.author)) {
    return `author must be one of ${AUTHOR_LABELS} (kind: ${input.kind})`;
  }
  if (!isDirection(input.direction)) {
    return `direction must be one of ${MESSAGE_DIRECTIONS.join('|')} (kind: ${input.kind})`;
  }
  // Authorship coherence (D6, D7). Every case below is UNREACHABLE from a
  // TypeScript caller — the types forbid it, which is the primary enforcement —
  // so these checks exist for JS/JSON boundaries only. Compare through widened
  // locals: against the narrowed union members TypeScript rejects the
  // comparisons as provably impossible, which is exactly what the types
  // guarantee and exactly why the runtime guard is still needed at the edge.
  const kind: ReceiptEntryKind = input.kind;
  const author: MessageAuthor = input.author;
  const direction: MessageDirection = input.direction;
  if (direction === 'internal' && author === 'dealer') {
    return `an internal record is the account side's own; author 'dealer' is incoherent (kind: ${kind})`;
  }
  if (kind === 'note' && direction !== 'internal') {
    return "a note is the buyer's/operator's own record; direction must be 'internal' (kind: note)";
  }
  if (kind !== 'note' && direction === 'internal') {
    return `only a note may be 'internal' (kind: ${kind})`;
  }
  if (kind === 'call_meta' && author === 'dealer') {
    return "author on a call-metadata record is who logged the call account-side; 'dealer' is incoherent (kind: call_meta)";
  }
  if (!isIsoTimestamp(input.occurred_at)) {
    return `occurred_at must be an ISO-8601 timestamp (kind: ${input.kind})`;
  }
  switch (input.kind) {
    case 'note':
      if (isBlank(input.body)) return 'body must be non-empty (kind: note)';
      break;
    case 'sms':
      if (isBlank(input.body)) return 'body must be non-empty (kind: sms)';
      break;
    case 'email':
      if (isBlank(input.body)) return 'body must be non-empty (kind: email)';
      break;
    case 'call_meta': {
      const meta: unknown = input.call_meta;
      if (meta === null || typeof meta !== 'object') {
        return 'call_meta must be an object (kind: call_meta)';
      }
      if (!isIsoTimestamp((meta as { started_at?: unknown }).started_at)) {
        return 'call_meta.started_at must be an ISO-8601 timestamp (kind: call_meta)';
      }
      break;
    }
  }
  return null;
}

/**
 * Defensive copy: the stored entry shares no object identity with the caller's
 * input (nested `call_meta` included), so later caller mutation cannot alter
 * the trail. Optional fields are copied only when present
 * (exactOptionalPropertyTypes).
 */
function copyInput(input: ReceiptEntryInput): ReceiptEntryInput {
  const base = {
    author: input.author,
    occurred_at: input.occurred_at,
    ...(input.dedupe_key !== undefined ? { dedupe_key: input.dedupe_key } : {}),
  };
  switch (input.kind) {
    case 'note':
      return {
        ...base,
        kind: 'note',
        direction: input.direction,
        author: input.author,
        body: input.body,
      };
    case 'sms':
      return {
        ...base,
        kind: 'sms',
        direction: input.direction,
        body: input.body,
        ...(input.provider_message_ref !== undefined
          ? { provider_message_ref: input.provider_message_ref }
          : {}),
      };
    case 'email':
      return {
        ...base,
        kind: 'email',
        direction: input.direction,
        body: input.body,
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.provider_message_ref !== undefined
          ? { provider_message_ref: input.provider_message_ref }
          : {}),
      };
    case 'call_meta':
      return {
        ...base,
        kind: 'call_meta',
        direction: input.direction,
        author: input.author,
        call_meta: {
          started_at: input.call_meta.started_at,
          ...(input.call_meta.duration_seconds !== undefined
            ? { duration_seconds: input.call_meta.duration_seconds }
            : {}),
          ...(input.call_meta.party !== undefined ? { party: input.call_meta.party } : {}),
        },
        ...(input.provider_message_ref !== undefined
          ? { provider_message_ref: input.provider_message_ref }
          : {}),
      };
  }
}

/** Recursively freezes an object graph — `call_meta` is nested, so recursion is load-bearing. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Chronological order: occurred_at ascending, ties broken by per-bundle seq. */
function chronological(a: ReceiptEntry, b: ReceiptEntry): number {
  return Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.seq - b.seq;
}

const defaultClock: ReceiptClock = () => new Date().toISOString();

/**
 * Creates the in-memory reference ReceiptStore.
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

      // Idempotent append (D10): a dedupe hit returns the existing frozen entry
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
        // Unknown / never-appended bundle is a valid empty bundle.
        return { ok: true, value: [] };
      }
      // Fresh array each call: the array belongs to the caller; the entries
      // remain frozen singletons.
      return { ok: true, value: [...bundle.entries].sort(chronological) };
    },
  };
}
