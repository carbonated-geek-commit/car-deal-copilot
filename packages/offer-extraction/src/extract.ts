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
import { normalizeText } from './normalize.js';
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
 * Channel-agnostic extraction input (AC-3). One entry point for all three
 * channels of Message.channel; `text` is whatever the Message carries:
 *   call  → Message.transcript
 *   sms   → Message.body
 *   email → Message.body
 * `channel` is a normalization HINT (design §4.1), never a router to
 * different extractors and never a carrier of provider knowledge.
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
  const channel: MessageChannel =
    input?.channel === 'call' || input?.channel === 'email' || input?.channel === 'sms'
      ? input.channel
      : 'sms'; // minimal normalization when the hint is unusable

  const text = normalizeText(rawText, channel);
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
