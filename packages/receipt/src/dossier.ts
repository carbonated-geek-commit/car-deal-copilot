/**
 * Dossier export (docs/design/T-012.md §2.5) — assembler REAL, rendering and
 * hosting STUBBED.
 *
 * specs/00 "Receipt layer (trust engine)": "Generates a shareable deal dossier
 * (PDF + web link)." This epic ships the ordered, timestamped structure only.
 * `renderPdf` / `publishWebLink` keep their final signatures but always return
 * `not_implemented` — no PDF engine, no hosting, no HTTP, no new dependencies.
 * A stub that fabricated a fake URL would leak into product code as if hosting
 * existed, so the stubs fail loudly and callers must branch on `ok`.
 *
 * FORWARD CONSTRAINT, binding on whoever implements rendering (AC-9, D11):
 * the rendered dossier MUST print each entry's `author` label beside its
 * content, and MUST NOT render a concierge- or buyer-authored entry in a way a
 * reader could take for a dealer statement. specs/01 accepts a known risk on
 * the concierge tier explicitly BECAUSE the author label is in force as the
 * mitigation; a renderer that drops the label voids the mitigation the risk
 * acceptance depends on. Stated in the epic that owns the type so the epic
 * that owns the renderer inherits it rather than re-deciding it.
 */
import type { IsoTimestamp } from '@core';
import type {
  ReceiptClock,
  ReceiptEntry,
  ReceiptResult,
  ReceiptStore,
} from './contract.js';

export interface DealDossier {
  /** The Deal's receipt_bundle_id — the dossier's address (AC-10). */
  receipt_bundle_id: string;
  generated_at: IsoTimestamp;
  entry_count: number;
  /** Absent when the bundle is empty. */
  first_entry_at?: IsoTimestamp;
  last_entry_at?: IsoTimestamp;
  /**
   * Ordered, verbatim, frozen entries — the shareable timeline. Every element
   * carries its REQUIRED `author`, so the export structure distinguishes
   * dealer-authored from concierge- or buyer-authored evidence by construction
   * (AC-9, D11). No summary field is added: author carry-through is a property
   * of the entry type, and a presentation field with no spec line would be
   * silent interpretive drift.
   */
  entries: readonly ReceiptEntry[];
}

/** Future artifact pointer (S3 key / hosted URL). This epic: never produced. */
export interface DossierArtifactRef {
  kind: 'pdf' | 'web_link';
  /** Opaque ref — object-store key or URL, per the later durable epic. */
  ref: string;
  generated_at: IsoTimestamp;
}

export interface DossierExporter {
  /** Assembles the bundle's entries into the exportable dossier structure. REAL. */
  assemble(receipt_bundle_id: string): Promise<ReceiptResult<DealDossier>>;
  /** STUB: always { ok: false, code: 'not_implemented' }. Signature is final; T-018 owns durable storage. */
  renderPdf(dossier: DealDossier): Promise<ReceiptResult<DossierArtifactRef>>;
  /** STUB: always { ok: false, code: 'not_implemented' }. Signature is final; T-018 owns durable storage. */
  publishWebLink(dossier: DealDossier): Promise<ReceiptResult<DossierArtifactRef>>;
}

const defaultClock: ReceiptClock = () => new Date().toISOString();

/** Log-safe stub failure (§4.5): operation name only, terminal by design. */
function notImplemented(operation: string): ReceiptResult<never> {
  return {
    ok: false,
    error: {
      code: 'not_implemented',
      retryable: false,
      message: `${operation} is not implemented in this epic`,
    },
  };
}

/**
 * Creates the dossier exporter. It reads through the injected ReceiptStore —
 * no private access to storage — so a durable store slots in behind the same
 * interface without touching the exporter (§2.5).
 */
export function createDossierExporter(
  store: ReceiptStore,
  clock: ReceiptClock = defaultClock,
): DossierExporter {
  return {
    async assemble(receipt_bundle_id: string): Promise<ReceiptResult<DealDossier>> {
      const read = await store.read(receipt_bundle_id);
      if (!read.ok) {
        // Propagate the store's error unchanged (§4.4) — never a partial dossier.
        return read;
      }
      const entries = read.value;
      const first = entries[0];
      const last = entries[entries.length - 1];
      const dossier: DealDossier = {
        receipt_bundle_id,
        generated_at: clock(),
        entry_count: entries.length,
        // Empty bundle → valid empty dossier with no first/last.
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
