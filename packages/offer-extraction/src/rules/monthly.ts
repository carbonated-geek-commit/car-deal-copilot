/**
 * Monthly-payment rule (design §4.2).
 *
 * Populated only when a money amount carries per-month context ("/mo",
 * "per month", "a month", "monthly payment of ..."). A bare "$450" is
 * NEVER read as monthly (D5 precision gate). First qualifying match in
 * text order wins (determinism, §4.3).
 */

import type { Span } from '../money.js';
import { MONEY_SRC, contextWindow, overlapsAny, parseAmountCents } from '../money.js';

/** amount THEN periodicity: "$450/mo", "450 a month", "$389 monthly" */
const AMOUNT_THEN_PERIOD = new RegExp(
  MONEY_SRC +
    String.raw`\s{0,2}(?:/\s{0,2}(?:mo(?:nth)?s?|mths?)\b|(?:a|per|each|every)\s(?:month|mo)\b|monthly\b|p/m\b)`,
  'gi',
);

/** periodicity THEN amount: "monthly payment of $450", "payments of $450" */
const PERIOD_THEN_AMOUNT = new RegExp(
  String.raw`\b(?<!down\s)(?:monthly\spayments?|payments?|monthly)\b\s{0,2}(?:of|is|at|around|about|:|=|~)?\s{0,2}` +
    MONEY_SRC,
  'gi',
);

/** Marketing teaser context disqualifies (precision stance, §6 hard case). */
const MARKETING_RE = /\b(?:as\slow\sas|starting\s(?:at|from)|from)\b/gi;

/** Plausibility bounds for a vehicle monthly payment (D5): $50–$10,000. */
const MIN_CENTS = 50_00;
const MAX_CENTS = 10_000_00;

export interface MonthlyMatch {
  readonly value: number;
  readonly span: Span;
}

export function findMonthly(text: string, claimed: readonly Span[]): MonthlyMatch | undefined {
  for (const re of [AMOUNT_THEN_PERIOD, PERIOD_THEN_AMOUNT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
      if (overlapsAny(start, end, claimed)) continue;
      const groups = m.groups ?? {};
      const amt = groups['amt'];
      if (amt === undefined) continue;
      const cents = parseAmountCents(amt, groups['k'] !== undefined);
      if (cents === undefined || cents < MIN_CENTS || cents > MAX_CENTS) continue;
      const win = contextWindow(text, start, end, 40);
      MARKETING_RE.lastIndex = 0;
      if (MARKETING_RE.test(win.before)) continue;
      re.lastIndex = 0;
      return { value: cents, span: { start, end } };
    }
    re.lastIndex = 0;
  }
  return undefined;
}
