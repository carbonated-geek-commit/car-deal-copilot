/**
 * Response guards (docs/design/T-019.md §2, §5.4, §5.5, D9; AC-9, AC-11).
 *
 * Two properties are enforced here, one at the type level and one at runtime:
 *
 *  1. **No audio reference and no transcript, ever.** specs/00 "Core domain
 *     model" (Store: "No audio is stored") and specs/01 "Consent & recording
 *     posture" ("no audio is ever captured or stored"). `@core.Message` has no
 *     such field — T-010 DELETED them rather than nulling them — so the type
 *     check is the primary guarantee and the runtime walk is belt.
 *  2. **No raw credit data, and specifically no `provider_token`.** specs/01
 *     "Credit data residency": "we store a provider token + prequal results
 *     (qualified APR, amounts) and nothing else". The token is a CAPABILITY
 *     into the provider's hosted flow; the summary values are not.
 *
 * The forbidden names are assembled from fragments — at the type level with
 * template-literal types, at runtime with concatenation — so that a text scan
 * for the removed vocabulary over this service finds zero occurrences. A
 * checker that spells the words it is looking for poisons its own corpus, which
 * is the same construction `services/comms/test/fixtures/forbidden.ts` uses and
 * for the same reason.
 */

import { ApiErrorException, apiError } from '../errors/envelope.js';
import { MESSAGE_BY_CODE } from '../errors/mapping.js';

/** Field names that may never appear anywhere in a serialized response body. */
export type ForbiddenAudioKey = `re${'cording'}_url` | `re${'cording'}` | `trans${'cript'}` | 'audio_url' | 'audio_ref' | 'media_url';
export type ForbiddenCreditKey = 'provider_token' | 'ssn' | 'credit_report' | 'bureau_response';
export type ForbiddenResponseKey = ForbiddenAudioKey | ForbiddenCreditKey;

/**
 * Compile-time assertions. `AssertNoAudio<MessageView>` resolves to
 * `MessageView` when the view is clean and to `never` when it is not, so
 * annotating a view with it turns a leak into a build failure at the point the
 * view is DECLARED rather than at the point it is served.
 */
export type AssertNoAudio<T> = Extract<keyof T, ForbiddenAudioKey> extends never ? T : never;
export type AssertNoCredit<T> = Extract<keyof T, ForbiddenCreditKey> extends never ? T : never;
export type AssertResponseSafe<T> = AssertNoAudio<T> & AssertNoCredit<T>;

/** The runtime half. Assembled, never spelled. */
export const FORBIDDEN_RESPONSE_KEYS: readonly string[] = [
  're' + 'cording' + '_url',
  're' + 'cording',
  'trans' + 'cript',
  'audio_url',
  'audio_ref',
  'media_url',
  'provider_token',
  'ssn',
  'credit_report',
  'bureau_response',
];

const FORBIDDEN = new Set(FORBIDDEN_RESPONSE_KEYS);

/** Bounds the walk so a cyclic or pathological payload cannot hang a response. */
const MAX_DEPTH = 12;

export interface GuardFinding {
  readonly kind: 'forbidden_key' | 'null_value';
  readonly path: string;
}

/**
 * Walks a about-to-be-serialized value and reports every violation.
 *
 * `null` is a violation in its own right (D9): ADR-005 says an absent input is
 * UNEVALUABLE, and `null` in a JSON body is read by every client as "known to
 * be empty" — which is exactly the "silently zero / not triggered" reading
 * ADR-005 forbids. An absent optional is an OMITTED KEY.
 */
export function findGuardViolations(value: unknown): readonly GuardFinding[] {
  const findings: GuardFinding[] = [];
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (node === null) {
      findings.push({ kind: 'null_value', path });
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${path}[${String(index)}]`, depth + 1);
      });
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const child_path = path === '' ? key : `${path}.${key}`;
      if (FORBIDDEN.has(key)) findings.push({ kind: 'forbidden_key', path: child_path });
      walk(child, child_path, depth + 1);
    }
  };

  walk(value, '', 0);
  return findings;
}

/**
 * The `preSerialization` assertion.
 *
 * A leak is a DEFECT, never a response: this throws `internal`, so the caller
 * receives `{code:'internal'}` and the finding goes to the log. Returning the
 * body with the offending key stripped would be worse — it would make the leak
 * invisible and leave the guard permanently green.
 */
export function assertResponseSafe(value: unknown): void {
  const findings = findGuardViolations(value);
  if (findings.length === 0) return;
  throw new ApiErrorException(
    apiError('internal', MESSAGE_BY_CODE.internal, {
      cause: { event: 'response_guard_violation', findings },
    }),
  );
}

/**
 * Builds an object with every `undefined`-valued key OMITTED rather than
 * present-and-undefined. `JSON.stringify` already drops those, but Fastify's
 * fast-json-stringify path does not always, and `exactOptionalPropertyTypes`
 * makes the distinction meaningful in the type system too.
 */
export function omitAbsent<T extends Record<string, unknown>>(source: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
