/**
 * Fee line-item rule (design §4.2, D6).
 *
 * Only LABELED fee line items become OfferFee entries ("doc fee $899",
 * "destination: $1,395"). Unlabeled amounts never match; bundled totals
 * compete for sale_price instead (D6 — v1 does not decompose totals).
 * `name` is captured as written (trimmed, inner whitespace collapsed).
 * Fee amounts claim their text spans so the price rule cannot re-read them.
 */

import type { OfferFee } from '@core';
import type { Span } from '../money.js';
import { overlapsAny, parseAmountCents } from '../money.js';

const AMT_SRC = String.raw`(?<amt>\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?<k>[kK])?(?!\w)`;

/** label ending in fee/charge, THEN amount: "doc fee of $899", "dealer prep charge: 400" */
const LABEL_THEN_AMOUNT = new RegExp(
  String.raw`\b(?<name>(?:[A-Za-z][A-Za-z&/-]*\s){0,3}(?:fee|charge)s?)\s{0,2}(?:of|is|at|:|=|-|–|—)?\s{0,2}\$?\s{0,2}` +
    AMT_SRC,
  'gi',
);

/** $amount THEN label: "$899 doc fee" ($ required — precision, D5) */
const AMOUNT_THEN_LABEL = new RegExp(
  String.raw`(?<![\w.#-])\$\s{0,2}` +
    AMT_SRC +
    String.raw`\s{0,2}(?<name>(?:[A-Za-z][A-Za-z&/-]*\s){0,2}(?:fee|charge)s?)\b`,
  'gi',
);

/** known fee noun THEN $amount: "destination $1,395" ($ required — precision) */
const NOUN_THEN_AMOUNT = new RegExp(
  String.raw`\b(?<name>destination|dest|freight|delivery|dealer\sprep|prep|doc(?:umentation)?|title(?:\s(?:and|&|/)\s(?:reg(?:istration)?|license))?|reg(?:istration)?|processing|reconditioning|advertising)\b\s{0,2}[:=–—-]?\s{0,2}\$\s{0,2}` +
    AMT_SRC,
  'gi',
);

/** Leading stopwords stripped from captured labels. */
const LEADING_STOP =
  /^(?:the|a|an|our|your|this|that|plus|and|with|includes|including|only|just)\s+/i;
/** Waived/negated fees are not charged fees. */
const NEGATED_RE = /\b(?:no|waived?|waiving|without|zero|minus|less)\s{0,2}$/i;

interface FeeCandidate {
  readonly index: number;
  readonly fee: OfferFee;
  readonly span: Span;
}

function cleanName(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = name.replace(LEADING_STOP, '');
    if (next === name) break;
    name = next;
  }
  return name;
}

/** A label of just "fee(s)"/"charge(s)" is unlabeled — rejected (D5). */
function hasQualifier(name: string): boolean {
  return !/^(?:fee|charge)s?$/i.test(name);
}

export interface FeesResult {
  readonly fees: OfferFee[];
  readonly spans: Span[];
}

export function findFees(text: string): FeesResult {
  const candidates: FeeCandidate[] = [];
  const taken: Span[] = [];

  for (const re of [LABEL_THEN_AMOUNT, AMOUNT_THEN_LABEL, NOUN_THEN_AMOUNT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
      if (overlapsAny(start, end, taken)) continue;
      const groups = m.groups ?? {};
      const rawName = groups['name'];
      const amt = groups['amt'];
      if (rawName === undefined || amt === undefined) continue;
      const name = cleanName(rawName);
      if (name.length === 0 || !hasQualifier(name)) continue;
      const cents = parseAmountCents(amt, groups['k'] !== undefined);
      if (cents === undefined || cents > 10_000_00) continue; // fee plausibility cap $10k
      const before = text.slice(Math.max(0, start - 12), start);
      if (NEGATED_RE.test(before)) continue;
      taken.push({ start, end });
      candidates.push({ index: start, fee: { name, amount: cents }, span: { start, end } });
    }
    re.lastIndex = 0;
  }

  candidates.sort((a, b) => a.index - b.index);
  return {
    fees: candidates.map((c) => c.fee),
    spans: candidates.map((c) => c.span),
  };
}
