/**
 * Term rule (design §4.2).
 *
 * Populated for an integer with months/years term context, normalized to
 * months (D6: "6 years" → 72), plausibility-bounded 12–120 months (design
 * table). Bare integers (mileage, stock numbers, model years) never match:
 * the unit word IS the required context, and warranty/age phrasings are
 * excluded (D5).
 */

interface TermCandidate {
  readonly index: number;
  readonly months: number;
}

const MONTHS_RE = /(?<![\w.$])(?<n>\d{1,3})\s{0,2}(?:-\s{0,2})?(?:months?|mos?)\b/gi;
const YEARS_RE = /(?<![\w.$])(?<n>\d{1,2})\s{0,2}(?:-\s{0,2})?(?:years?|yrs?)\b/gi;
const TERM_OF_RE = /\bterm\b\s{0,2}(?:of|is|at|:|=)?\s{0,2}(?<n>\d{2,3})\b(?!\s{0,2}%)/gi;

/** Preceding phrasing that means elapsed/ordinal time, not a loan term. */
const BEFORE_EXCLUDE = /\b(?:past|last|first|next|model)\s{0,2}$/i;
/** Following phrasing that means warranty/age, not a loan term. */
const AFTER_EXCLUDE = /^\s{0,2}(?:warranty|ago|old)\b/i;

function collect(re: RegExp, text: string, yearsToMonths: boolean, out: TermCandidate[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++;
    const n = m.groups?.['n'];
    if (n === undefined) continue;
    const raw = Number.parseInt(n, 10);
    if (!Number.isFinite(raw)) continue;
    const months = yearsToMonths ? raw * 12 : raw;
    if (months < 12 || months > 120) continue; // design bound 12–120
    const before = text.slice(Math.max(0, m.index - 12), m.index);
    if (BEFORE_EXCLUDE.test(before)) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (AFTER_EXCLUDE.test(after)) continue;
    out.push({ index: m.index, months });
  }
  re.lastIndex = 0;
}

export function findTermMonths(text: string): number | undefined {
  const candidates: TermCandidate[] = [];
  collect(MONTHS_RE, text, false, candidates);
  collect(YEARS_RE, text, true, candidates);
  collect(TERM_OF_RE, text, false, candidates);
  if (candidates.length === 0) return undefined;
  // first qualifying mention in text order wins (determinism, §4.3)
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]!.months;
}
