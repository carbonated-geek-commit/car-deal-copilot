/**
 * APR rule (design §4.2).
 *
 * Populated only for a percent with rate/APR/financing context,
 * plausibility-bounded 0 < apr < 50 (design table). Percents that read as
 * discounts, down-payment %, or marketing teasers ("as low as 2.9%") are
 * omitted (D5). `apr` stays a percent number (6.9) per @core's doc comment
 * (D6) — never cents, never a fraction.
 */

const PCT_SRC = String.raw`(?<![\w.])(?<pct>\d{1,2}(?:\.\d{1,2})?)\s{0,2}%`;

/** percent THEN rate word: "6.9% APR", "5.5 % interest" */
const PCT_THEN_RATE = new RegExp(
  PCT_SRC + String.raw`\s{0,3}(?:apr\b|interest\b|financing\b|rate\b)`,
  'gi',
);

/** rate word THEN percent: "APR of 6.9%", "rate: 5.25%" */
const RATE_THEN_PCT = new RegExp(
  String.raw`\b(?:apr|interest(?:\srate)?|rate|financing)\b\s{0,2}(?:of|is|at|:|=|around|about)?\s{0,2}` +
    PCT_SRC,
  'gi',
);

/** Preceding-context disqualifiers: marketing teasers. */
const MARKETING_RE = /\b(?:as\slow\sas|starting\s(?:at|from)|from|up\sto)\b\s{0,2}$/i;

export function findApr(text: string): number | undefined {
  for (const re of [PCT_THEN_RATE, RATE_THEN_PCT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      const pct = m.groups?.['pct'];
      if (pct === undefined) continue;
      const v = Number.parseFloat(pct);
      if (!Number.isFinite(v) || v <= 0 || v >= 50) continue; // design bound
      // "10% down" / "15% off" are not rates
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (/^\s{0,2}(?:down|off)\b/i.test(after)) continue;
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      if (MARKETING_RE.test(before)) continue;
      re.lastIndex = 0;
      return v;
    }
    re.lastIndex = 0;
  }
  return undefined;
}
