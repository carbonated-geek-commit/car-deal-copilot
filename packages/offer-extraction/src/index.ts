/**
 * @offer-extraction public API — the only import surface (design §1, §2).
 *
 * The entire contract is one pure function plus its input/result types.
 * No class, no config object, no async: configuration would imply
 * per-caller behavior drift (two callers extracting different offers from
 * the same text breaks determinism-as-idempotency, T-001 §5.3), and async
 * would invite I/O into a package whose value is that it cannot do any.
 *
 * The spine is referenced, never redefined: every domain shape is an
 * import from `@core` (`ExtractedOffer` IS the canonical `Offer` — design
 * §0 D1 resolved by ADR-005; see extract.ts).
 */

export type { ExtractedOffer, ExtractionInput, ExtractionResult } from './extract.js';
export { extractOffer } from './extract.js';
