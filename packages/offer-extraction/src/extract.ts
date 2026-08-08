/**
 * Pipeline assembly (design §2, §4): normalize → match rules → gate →
 * build offer.
 *
 * Pure, synchronous, deterministic, TOTAL (never throws — D4): the caller
 * is an at-least-once bus consumer, and a throwing extractor would turn one
 * weird dealer SMS into a poison message (T-001 §5.3). No I/O, no provider
 * knowledge, no LLM calls, no logging (message text is PII-laden; a
 * no-logging library cannot violate T-001 §5.3).
 */

import type { MessageChannel, Offer } from '@core';
import type { Span } from './money.js';
import type { NormalizationProfile } from './normalize.js';
import { PROFILE_BY_CHANNEL, normalizeText } from './normalize.js';
import { findFees } from './rules/fees.js';
import { findMonthly } from './rules/monthly.js';
import { findApr } from './rules/apr.js';
import { findTermMonths } from './rules/term.js';
import { findSalePrice } from './rules/price.js';

/**
 * Partial-offer shape (design §0 D1, resolved by ADR-005).
 *
 * ADR-005 made `@core` `Offer.sale_price` optional (absent = the dealer did
 * not state a price), so the partial projection is representable in the spine
 * directly and the design's documented fallback (`Omit`-derived alias)
 * collapses to the canonical type — the one-type-name isolation the design
 * promised (§0 D1). Kept as a named alias so the public API reads as the
 * design specifies; it IS the `@core` `Offer` (ADR-001: no parallel type).
 */
export type ExtractedOffer = Offer;

/**
 * Channel-agnostic extraction input (T-012 AC-1). ONE entry point for all four
 * v0.5 channels of `Message.channel`; `text` is whatever the Message carries:
 *   note  → Message.body (buyer- or concierge-authored)
 *   sms   → Message.body (verbatim)
 *   email → Message.body (verbatim)
 *   call  → normally ABSENT — a call message carries call_meta, not text
 * `channel` selects a text-cleanup profile only (normalize.ts §1.3). It never
 * routes to a different extractor, never gates which fields are extractable,
 * and never carries provider knowledge.
 */
export interface ExtractionInput {
  channel: MessageChannel;
  text: string;
}

/**
 * Discriminated outcome (design D2). `found: false` is a valid terminal
 * result — the text contained no offer — not an error (mirrors
 * OfferExtractionCompletedV1.offer being absent, T-001 §4).
 */
export type ExtractionResult =
  | { readonly found: true; readonly offer: ExtractedOffer }
  | { readonly found: false };

/**
 * Rule-based v1 extractor.
 * Pure, synchronous, deterministic, total (never throws — D4).
 * No I/O, no provider knowledge, no LLM calls, no logging.
 * `offer` carries only confidently-extracted fields (partial offers per
 * AC-4, precision gate per D5) and always `flags: []` — flag emission is
 * the flag engine's job (D3), this package never populates or interprets
 * flag names.
 */
export function extractOffer(input: ExtractionInput): ExtractionResult {
  // Totality guard (D4): hostile callers may hand us anything at runtime.
  const rawText = typeof input?.text === 'string' ? input.text : '';

  // Channel → cleanup profile, and no further (T-012 D1). An unrecognized
  // runtime channel degrades to the least-transformative profile; it is NEVER
  // rewritten to some other channel's value (D3 — the old `: 'sms'` fallback
  // silently asserted a channel the caller did not send, which is how the v0.5
  // `note` channel was being processed as a mislabelled SMS).
  const rawChannel: unknown = input?.channel;
  const profile: NormalizationProfile =
    typeof rawChannel === 'string' && Object.hasOwn(PROFILE_BY_CHANNEL, rawChannel)
      ? PROFILE_BY_CHANNEL[rawChannel as MessageChannel]
      : 'plain';

  const text = normalizeText(rawText, profile);
  if (text.length === 0) return { found: false };

  // Rule order matters for span claiming: labeled fees first (most
  // specific), then monthly, then price over the remaining amounts. APR and
  // term operate on %-/unit-tagged tokens and never compete for money spans.
  const claimed: Span[] = [];
  const { fees, spans: feeSpans } = findFees(text);
  claimed.push(...feeSpans);

  const monthly = findMonthly(text, claimed);
  if (monthly !== undefined) claimed.push(monthly.span);

  const apr = findApr(text);
  const termMonths = findTermMonths(text);
  const salePrice = findSalePrice(text, claimed);

  // Gate (design §4.2): at least one extracted field, else no offer.
  const found =
    salePrice !== undefined ||
    monthly !== undefined ||
    apr !== undefined ||
    termMonths !== undefined ||
    fees.length > 0;
  if (!found) return { found: false };

  // Fresh object every call (§4.3 non-mutating); absent fields stay ABSENT
  // (not undefined-valued) so partial offers assert omission cleanly.
  const offer: ExtractedOffer = {
    fees,
    flags: [], // D3: always empty — flag vocabulary belongs to the flag engine
    ...(salePrice !== undefined ? { sale_price: salePrice } : {}),
    ...(apr !== undefined ? { apr } : {}),
    ...(termMonths !== undefined ? { term_months: termMonths } : {}),
    ...(monthly !== undefined ? { monthly: monthly.value } : {}),
  };
  return { found: true, offer };
}
