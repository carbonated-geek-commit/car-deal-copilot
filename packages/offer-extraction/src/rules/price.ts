/**
 * Sale-price rule (design §4.2, D5, D6).
 *
 * Populated when a money amount carries price context (price/OTD/sale/
 * cost/offer tokens) — measured by proximity: the nearest price token must
 * be strictly closer than the nearest disqualifier (trade-in, payoff,
 * MSRP, down, rebate, per-month...). An OTD total quoted without a
 * breakdown maps to sale_price with fees: [] (D6 — v1 never decomposes
 * bundled totals).
 *
 * Secondary path (design §4.2 "sole large money amount in an unambiguous
 * offer sentence"): exactly one unclaimed amount >= $5,000 in the whole
 * text plus an explicit offer cue.
 *
 * Amounts already claimed by the fee/monthly rules are never re-read.
 */

import type { Span } from '../money.js';
import {
  MONEY_SRC,
  contextWindow,
  nearestDistance,
  overlapsAny,
  parseAmountCents,
} from '../money.js';

const MONEY_RE = new RegExp(MONEY_SRC, 'gi');

/** Price-context tokens (include list). */
const INCLUDE_RE =
  /\b(?:price[ds]?|otd|out[\s-]the[\s-]door|sale|selling|sell|sold|asking|total|cost|offer(?:ing|ed)?|quoted?|do\sit\sfor|can\sdo|have\sit\sfor|let\sit\sgo\sfor)\b/gi;

/** Disqualifying context tokens (exclude list). */
const EXCLUDE_RE =
  /\b(?:trade[\s-]?in|trade|payoff|pay[\s-]?off|msrp|sticker|invoice|down(?:\spayment)?|deposit|rebate|discount|off|savings?|save|lease|month(?:ly)?|starting\s(?:at|from)|as\slow\sas|from|financ(?:e|ing)\samount|loan\samount)\b|\/\s{0,2}mo\b/gi;

/** Offer cues for the sole-large-amount path. */
const CUE_RE =
  /\b(?:offer|quoted?|can\sdo|do\sit\sfor|have\sit\sfor|let\sit\sgo\sfor|willing\sto|best\s(?:i|we)\scan\sdo|get\syou)\b/i;

/** Plausibility bounds for a vehicle sale price (D5): $1,000–$500,000. */
const MIN_CENTS = 1_000_00;
const MAX_CENTS = 500_000_00;
/** Sole-amount path is stricter: $5,000 floor. */
const SOLE_MIN_CENTS = 5_000_00;

interface MoneyCandidate {
  readonly start: number;
  readonly end: number;
  readonly cents: number;
}

function moneyCandidates(text: string, claimed: readonly Span[]): MoneyCandidate[] {
  const out: MoneyCandidate[] = [];
  MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY_RE.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (m.index === MONEY_RE.lastIndex) MONEY_RE.lastIndex++;
    if (overlapsAny(start, end, claimed)) continue;
    const groups = m.groups ?? {};
    const amt = groups['amt'];
    if (amt === undefined) continue;
    const cents = parseAmountCents(amt, groups['k'] !== undefined);
    if (cents === undefined) continue;
    out.push({ start, end, cents });
  }
  MONEY_RE.lastIndex = 0;
  return out;
}

export function findSalePrice(text: string, claimed: readonly Span[]): number | undefined {
  const candidates = moneyCandidates(text, claimed);

  // Primary: labeled price context, nearest-token disambiguation (D5).
  for (const c of candidates) {
    if (c.cents < MIN_CENTS || c.cents > MAX_CENTS) continue;
    const win = contextWindow(text, c.start, c.end, 80);
    const inc = nearestDistance(INCLUDE_RE, win);
    if (inc === undefined) continue;
    const exc = nearestDistance(EXCLUDE_RE, win);
    if (exc !== undefined && exc <= inc) continue; // ambiguous → omit (D5)
    return c.cents;
  }

  // Secondary: the sole large amount in an explicit offer sentence.
  const large = candidates.filter((c) => c.cents >= SOLE_MIN_CENTS && c.cents <= MAX_CENTS);
  if (large.length === 1 && CUE_RE.test(text)) {
    const c = large[0]!;
    const win = contextWindow(text, c.start, c.end, 80);
    if (nearestDistance(EXCLUDE_RE, win) === undefined) return c.cents;
  }

  return undefined;
}
