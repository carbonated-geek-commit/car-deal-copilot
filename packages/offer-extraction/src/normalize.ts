/**
 * Text normalization profiles (docs/design/T-012.md §1.3, D1–D3).
 *
 * The rule core below this module is channel-agnostic by CONSTRUCTION, not by
 * convention: `channel` is mapped to a `NormalizationProfile` here and the
 * channel value never travels further, so no rule can branch on it (AC-1).
 * A profile changes text CLEANUP only — never WHAT is extractable.
 *
 * All transforms are deterministic, locale-free (en-US number forms fixed
 * for v1) and linear-time.
 */

import type { MessageChannel } from '@core';

/**
 * How the text was PRODUCED, as far as cleanup is concerned. Deliberately not
 * a channel: the rules see only a profile (D1).
 */
export type NormalizationProfile = 'plain' | 'email' | 'spoken';

/**
 * Channel → cleanup profile. Exhaustive by construction (`Record` over the
 * spine's `MessageChannel`): adding a channel to the spine fails to compile
 * here rather than silently falling back to another channel's cleanup — the
 * exact failure mode that demoted `note` to the old `sms` fallback (D1).
 *
 * `note → spoken`: a note is speech retold in typing ("the buyer types what
 * the dealer said, in their own words" — specs/01 consent posture, resolved
 * 2026-08-07), so the colloquial-number cleanup follows the note channel.
 * `call → plain` (D2): a v0.5 call message carries `call_meta`, not text, so
 * there is no call text to clean; giving `call` a spoken profile would
 * re-create a call-text path in spirit.
 */
export const PROFILE_BY_CHANNEL: Readonly<Record<MessageChannel, NormalizationProfile>> =
  Object.freeze({
    call: 'plain',
    sms: 'plain',
    email: 'email',
    note: 'spoken',
  });

// ---- email: strip quoted reply chains + signatures ---------------------
// A stale offer quoted back by the buyer must not re-extract as the
// dealer's new offer (design §4.1).

const EMAIL_CUT = [
  /^\s*On\b[^\n]{0,300}\bwrote:\s*$/i,
  /^\s*-{2,}\s*(?:original|forwarded)\s+message\s*-{0,10}\s*$/i,
  /^\s*--\s*$/, // RFC 3676 signature delimiter
  /^\s*sent from my /i,
  /^\s*_{5,}\s*$/,
];

function stripEmailArtifacts(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (EMAIL_CUT.some((re) => re.test(line))) break;
    if (/^\s*>/.test(line)) continue; // quoted line
    out.push(line);
  }
  return out.join('\n');
}

// ---- spoken-form prose (typed notes): disfluency cleanup + spoken numbers ----
// A buyer typing what the dealer said keeps the shape of speech: filler words
// and spelled-out / colloquial numbers ("twenty nine grand", "four fifty a
// month", "six point nine percent"). Cleaning those up is what makes the note
// channel parse as well as a digit-form SMS.

const FILLER_RE = /\b(?:um+|uh+|erm+|hmm+|mhm+|ahem)\b[,.]?/gi;

const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

type NumTokenKind = 'ones' | 'teens' | 'tens' | 'hundred' | 'thousand' | 'and' | 'point';

function numKind(word: string): NumTokenKind | undefined {
  const w = word.toLowerCase();
  if (w in ONES) return 'ones';
  if (w in TEENS) return 'teens';
  if (w in TENS) return 'tens';
  if (w === 'hundred') return 'hundred';
  if (w === 'thousand' || w === 'grand') return 'thousand';
  if (w === 'and') return 'and';
  if (w === 'point') return 'point'; // spoken decimal: "six point nine" → 6.9
  return undefined;
}

interface WordToken {
  word: string;
  start: number;
  end: number;
  kind: NumTokenKind;
}

/**
 * Join spelled-out numbers into digits where unambiguous (design §4.1):
 *   "four fifty a month"        → "450 a month"   (colloquial hundreds)
 *   "twenty nine thousand"      → "29000"
 *   "seventy two"               → "72"
 * Runs need >= 2 number words — lone "one"/"ten" in prose are left alone
 * (precision, D5); the field rules' context gates do the rest.
 */
function joinSpelledNumbers(text: string): string {
  const tokens: WordToken[] = [];
  const wordRe = /[a-zA-Z]+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    const kind = numKind(m[0]);
    if (kind !== undefined) {
      tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length, kind });
    }
  }
  if (tokens.length === 0) return text;

  // Group into runs: consecutive number tokens separated only by short
  // whitespace/comma/hyphen gaps.
  const runs: WordToken[][] = [];
  let run: WordToken[] = [];
  for (const tok of tokens) {
    const prev = run[run.length - 1];
    if (prev !== undefined && tok.start - prev.end <= 3 && /^[\s,–—-]*$/.test(text.slice(prev.end, tok.start))) {
      run.push(tok);
    } else {
      if (run.length > 0) runs.push(run);
      run = [tok];
    }
  }
  if (run.length > 0) runs.push(run);

  let result = '';
  let cursor = 0;
  for (const r of runs) {
    // trim leading/trailing 'and'/'point' — they only glue, never start or
    // end a number
    let lo = 0;
    let hi = r.length;
    while (lo < hi && (r[lo]!.kind === 'and' || r[lo]!.kind === 'point')) lo++;
    while (hi > lo && (r[hi - 1]!.kind === 'and' || r[hi - 1]!.kind === 'point')) hi--;
    const words = r.slice(lo, hi);
    const counted = words.filter((t) => t.kind !== 'and' && t.kind !== 'point').length;
    if (counted < 2) continue;

    let value = 0;
    let current = 0;
    let sawHundred = false;
    let decimals: string | undefined;
    for (const t of words) {
      const w = t.word.toLowerCase();
      if (decimals !== undefined) {
        // spoken decimal digits: append each numeric word's digits
        if (t.kind === 'ones') decimals += String(ONES[w]!);
        else if (t.kind === 'teens') decimals += String(TEENS[w]!);
        else if (t.kind === 'tens') decimals += String(TENS[w]!);
        continue; // hundred/thousand/and after "point" are ignored
      }
      switch (t.kind) {
        case 'and':
          break;
        case 'point':
          decimals = '';
          break;
        case 'ones':
          current = current === 0 ? ONES[w]! : current + ONES[w]!;
          break;
        case 'teens':
        case 'tens': {
          const v = t.kind === 'teens' ? TEENS[w]! : TENS[w]!;
          if (current >= 1 && current <= 9 && !sawHundred) {
            current = current * 100 + v; // colloquial: "four fifty" → 450
          } else if (current === 0) {
            current = v;
          } else {
            current += v;
          }
          break;
        }
        case 'hundred':
          current = (current === 0 ? 1 : current) * 100;
          sawHundred = true;
          break;
        case 'thousand':
          value += (current === 0 ? 1 : current) * 1000;
          current = 0;
          sawHundred = false;
          break;
      }
    }
    value += current;
    if (value <= 0) continue;
    const rendered =
      decimals !== undefined && decimals.length > 0 ? `${value}.${decimals}` : String(value);

    const first = words[0]!;
    const last = words[words.length - 1]!;
    result += text.slice(cursor, first.start) + rendered;
    cursor = last.end;
  }
  result += text.slice(cursor);
  return result;
}

function normalizeSpokenForm(text: string): string {
  let t = text.replace(FILLER_RE, ' ');
  t = joinSpelledNumbers(t);
  // "29 thousand" / "29 grand" → 29000 (mixed digit + magnitude word)
  t = t.replace(/\b(\d{1,4}(?:\.\d{1,2})?)[\s-]{1,3}(?:thousand|grand)\b/gi, (_m, n: string) =>
    String(Math.round(Number.parseFloat(n) * 1000)),
  );
  // "6 point 9" → "6.9"; "percent" → "%"
  t = t.replace(/\b(\d{1,3})\s{1,3}point\s{1,3}(\d{1,3})\b/gi, '$1.$2');
  t = t.replace(/\bpercent\b/gi, '%');
  return t;
}

// ---- entry point -------------------------------------------------------

/**
 * Profile-driven normalization. Deterministic, total: any string in, a
 * (possibly empty) string out — never throws. No channel value reaches this
 * function or anything below it (D1).
 */
export function normalizeText(raw: string, profile: NormalizationProfile): string {
  let t = raw.replace(/\r\n?/g, '\n');
  if (profile === 'email') t = stripEmailArtifacts(t);
  if (profile === 'spoken') t = normalizeSpokenForm(t);
  // shared cleanup (every profile): entity/whitespace collapse, keep \n as a
  // sentence boundary for the rules' context windows
  t = t.replace(/&nbsp;/gi, ' ');
  t = t.replace(/[ \t\u00A0\u2007\u202F]+/g, ' ');
  t = t.replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n');
  return t.trim();
}
