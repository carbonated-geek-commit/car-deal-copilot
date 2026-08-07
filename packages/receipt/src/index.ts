/**
 * @receipt public API — the only import surface for the receipt layer
 * (T-001 D3; docs/design/T-008.md §1). Cross-package imports use the bare
 * `@receipt` alias; deep imports are forbidden by construction.
 *
 * The exported store contract is structurally append-only: append and read
 * are the ONLY operations on ReceiptStore — no update, delete, overwrite,
 * or truncate exists anywhere on this surface (task AC-2).
 */

export type {
  AppendOutcome,
  EmailEntryInput,
  ReceiptClock,
  ReceiptEntry,
  ReceiptEntryInput,
  ReceiptEntryKind,
  ReceiptEntryStamp,
  ReceiptError,
  ReceiptErrorCode,
  ReceiptResult,
  ReceiptStore,
  RecordingRefEntryInput,
  SmsEntryInput,
  TranscriptEntryInput,
} from './contract.js';

export { createInMemoryReceiptStore } from './memory-store.js';

export type { DealDossier, DossierArtifactRef, DossierExporter } from './dossier.js';
export { createDossierExporter } from './dossier.js';
