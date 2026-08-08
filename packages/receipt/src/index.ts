/**
 * @receipt public API — the only import surface for the receipt layer
 * (T-001 D3; docs/design/T-008.md §1). Cross-package imports use the bare
 * `@receipt` alias; deep imports are forbidden by construction.
 *
 * The exported store contract is structurally append-only: append and read
 * are the ONLY operations on ReceiptStore — no update, delete, overwrite,
 * or truncate exists anywhere on this surface (T-012 AC-8).
 *
 * Every exported entry type carries a REQUIRED `author` (AC-6), and the entry
 * kinds are exactly note | sms | email | call_meta (AC-5) — the audio- and
 * verbatim-call-text kinds are gone from the surface, not deprecated on it.
 */

export type {
  AppendOutcome,
  CallMetaEntryInput,
  EmailEntryInput,
  NoteEntryInput,
  ReceiptClock,
  ReceiptEntry,
  ReceiptEntryInput,
  ReceiptEntryKind,
  ReceiptEntryStamp,
  ReceiptError,
  ReceiptErrorCode,
  ReceiptResult,
  ReceiptStore,
  SmsEntryInput,
} from './contract.js';

export { createInMemoryReceiptStore } from './memory-store.js';

export type { DealDossier, DossierArtifactRef, DossierExporter } from './dossier.js';
export { createDossierExporter } from './dossier.js';
