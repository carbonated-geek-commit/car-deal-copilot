/**
 * Money/number token parsing → integer MoneyCents (design D6).
 *
 * Conventions (docs/design/T-007.md D6):
 *   "$23,500"  → 2350000 cents
 *   "23.5k"    → 2350000 cents
 *   "$450"     → 45000 cents (whether it is monthly or price is the RULES'
 *                job — money-ness comes from context, never from this file)
 *
 * Every pattern here is linear-time (no nested ambiguous quantifiers,
 * bounded whitespace runs) per design §4.3 — this code runs on the bus
 * consumer path and must never be a ReDoS surface.
 */

/**
 * Source fragment for a money/number token, composable into rule regexes.
 * Named groups: `amt` (digit string, may contain commas/decimal), `k`
 * (thousands suffix).
 *
 * Boundary discipline (precision, design D5):
 * - lookbehind rejects tokens glued to word chars / '.' / '#' / '-' so digit
 *   runs inside VINs ("...82633A..."), stock numbers ("#28450"), and phone
 *   fragments ("555-0134") never read as money;
 * - trailing (?!\w) rejects "450km", "450a" while allowing "450.", "450/mo".
 */
export const MONEY_SRC: string = String.raw`(?<![\w.#-])(?:\$\s{0,3})?(?<amt>\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?<k>[kK])?(?!\w)`;

/** Hard ceiling on any parsed amount — nothing in a car deal is >$10M. */
const MAX_DOLLARS = 10_000_000;

/**
 * Parse a matched `amt` (+ optional `k` suffix) into integer cents.
 * Returns undefined for zero, non-finite, implausibly huge, or
 * leading-zero artifacts (phone/id fragments like "0134"). Never throws.
 */
export function parseAmountCents(amt: string, k: boolean): number | undefined {
  if (/^0\d/.test(amt)) return undefined;
  const n = Number.parseFloat(amt.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const dollars = k ? n * 1000 : n;
  if (dollars > MAX_DOLLARS) return undefined;
  const cents = Math.round(dollars * 100);
  return cents > 0 ? cents : undefined;
}

/** A claimed [start, end) character range in the normalized text. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** True when [start, end) overlaps any already-claimed span. */
export function overlapsAny(start: number, end: number, claimed: readonly Span[]): boolean {
  return claimed.some((s) => start < s.end && end > s.start);
}

/** Sentence-terminator set used to bound context windows. */
const BOUNDARY = /[.!?\n]/;

/**
 * Context window around a token: text before/after the span, cut at the
 * nearest sentence boundary and capped at `radius` chars each side.
 * Used by rules to measure proximity of context tokens (design §4.2).
 */
export function contextWindow(
  text: string,
  start: number,
  end: number,
  radius = 80,
): { before: string; after: string } {
  let b = Math.max(0, start - radius);
  for (let i = start - 1; i >= b; i--) {
    if (BOUNDARY.test(text.charAt(i))) {
      b = i + 1;
      break;
    }
  }
  let a = Math.min(text.length, end + radius);
  for (let i = end; i < a; i++) {
    if (BOUNDARY.test(text.charAt(i))) {
      a = i;
      break;
    }
  }
  return { before: text.slice(b, start), after: text.slice(end, a) };
}

/**
 * Distance (in chars) from the token to the nearest match of `re` in the
 * window, or undefined when absent. `re` must be a global regex; it is
 * re-anchored per call (lastIndex reset) so rules stay stateless.
 */
export function nearestDistance(
  re: RegExp,
  window: { before: string; after: string },
): number | undefined {
  let best: number | undefined;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window.before)) !== null) {
    const d = window.before.length - (m.index + m[0].length);
    if (best === undefined || d < best) best = d;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  re.lastIndex = 0;
  m = re.exec(window.after);
  if (m !== null) {
    const d = m.index;
    if (best === undefined || d < best) best = d;
  }
  re.lastIndex = 0;
  return best;
}
