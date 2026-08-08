/**
 * Dossier export (docs/design/T-008.md §4) — assembler REAL, rendering and
 * hosting STUBBED (task AC-4, R8).
 *
 * specs/00 "Receipt layer (trust engine)": "Generates a shareable deal dossier
 * (PDF + web link)." Epic 1 ships the ordered, timestamped structure only.
 * `renderPdf` / `publishWebLink` keep their final signatures but always return
 * `not_implemented` — no PDF engine, no hosting, no HTTP, no new dependencies.
 * A stub that fabricated a fake URL would leak into product code as if hosting
 * existed (R8), so the stubs fail loudly and callers must branch on `ok`.
 */
import type { IsoTimestamp } from '@core';
import type {
  ReceiptClock,
  ReceiptEntry,
  ReceiptResult,
  ReceiptStore,
} from './contract.js';

export interface DealDossier {
  /** The Deal's receipt_bundle_id — the dossier's address (task AC-3). */
  receipt_bundle_id: string;
  generated_at: IsoTimestamp;
  entry_count: number;
  /** Absent when the bundle is empty. */
  first_entry_at?: IsoTimestamp;
  last_entry_at?: IsoTimestamp;
  /** Ordered per R5 — the shareable timeline, verbatim frozen entries. */
  entries: readonly ReceiptEntry[];
}

/** Future artifact pointer (S3 key / hosted URL). Epic 1: never produced. */
export interface DossierArtifactRef {
  kind: 'pdf' | 'web_link';
  /** Opaque ref — object-store key or URL, per the later durable epic. */
  ref: string;
  generated_at: IsoTimestamp;
}

export interface DossierExporter {
  /** Assembles the bundle's entries into the exportable dossier structure. REAL in Epic 1. */
  assemble(receipt_bundle_id: string): Promise<ReceiptResult<DealDossier>>;
  /** STUB in Epic 1: always { ok: false, code: 'not_implemented' } (R8). Signature is final. */
  renderPdf(dossier: DealDossier): Promise<ReceiptResult<DossierArtifactRef>>;
  /** STUB in Epic 1: always { ok: false, code: 'not_implemented' } (R8). Signature is final. */
  publishWebLink(dossier: DealDossier): Promise<ReceiptResult<DossierArtifactRef>>;
}

const defaultClock: ReceiptClock = () => new Date().toISOString();

/** Log-safe stub failure (§5.3): operation name only, terminal by design. */
function notImplemented(operation: string): ReceiptResult<never> {
  return {
    ok: false,
    error: {
      code: 'not_implemented',
      retryable: false,
      message: `${operation} is stubbed in Epic 1 (not implemented)`,
    },
  };
}

/**
 * Creates the dossier exporter. It reads through the injected ReceiptStore —
 * no private access to storage — so a durable store slots in behind the same
 * interface without touching the exporter (§4).
 */
export function createDossierExporter(
  store: ReceiptStore,
  clock: ReceiptClock = defaultClock,
): DossierExporter {
  return {
    async assemble(receipt_bundle_id: string): Promise<ReceiptResult<DealDossier>> {
      const read = await store.read(receipt_bundle_id);
      if (!read.ok) {
        // Propagate the store's error unchanged (§5.3) — never a partial dossier.
        return read;
      }
      const entries = read.value;
      const first = entries[0];
      const last = entries[entries.length - 1];
      const dossier: DealDossier = {
        receipt_bundle_id,
        generated_at: clock(),
        entry_count: entries.length,
        // Empty bundle → valid empty dossier with no first/last (R3).
        ...(first !== undefined && last !== undefined
          ? { first_entry_at: first.occurred_at, last_entry_at: last.occurred_at }
          : {}),
        entries,
      };
      return { ok: true, value: dossier };
    },

    async renderPdf(_dossier: DealDossier): Promise<ReceiptResult<DossierArtifactRef>> {
      return notImplemented('renderPdf');
    },

    async publishWebLink(_dossier: DealDossier): Promise<ReceiptResult<DossierArtifactRef>> {
      return notImplemented('publishWebLink');
    },
  };
}
