/**
 * The deal anchor comparison (docs/design/T-020.md D3, D4; AC-3, AC-5).
 *
 * Pure, total, no clock, no I/O.
 *
 * D3 — why this lives at the API boundary and nowhere else.
 * `packages/core/src/domain.ts` says of `VehicleInstance`: "Deliberately carries
 * NO make/model: those are the deal's anchor, so a thread that contradicts the
 * anchor is unrepresentable. Builders must not add them." A mismatching
 * instance therefore cannot exist downstream — which means the claim can only
 * be checked at the one place it is still expressible: the wire, before the
 * value is narrowed into the spine type. The submitted make/model are compared
 * here and then DISCARDED; nothing stores them.
 *
 * D4 — why the comparison is `trim().toLowerCase()` and nothing more. Q16 keeps
 * VIN "user-entered and unvalidated" and specs/01 keeps decode validation in the
 * backlog, so there is no authority to resolve "Chevy" against "Chevrolet" — a
 * fuzzy match would silently accept a substitution the product has never ruled
 * on. A byte-exact match would reject the buyer re-typing their own anchor.
 * Normalizing case and surrounding whitespace is the only transformation that
 * cannot change WHICH vehicle is meant.
 */

import type { VehicleInstance, VehicleTarget } from '@core';

import type { YearDriftView } from './views.js';

/** D4 — the only normalization applied to an anchor term. */
export const normalizeAnchorTerm = (value: string): string => value.trim().toLowerCase();

export type AnchorMatch =
  | { readonly ok: true }
  | { readonly ok: false; readonly field: 'make' | 'model' };

/**
 * Compares a submitted vehicle's claimed make/model against the deal's anchor.
 *
 * `make` is reported before `model` so the rejection names the coarsest
 * disagreement first — a Toyota submitted against a Honda deal is a make
 * mismatch, not an Accord/Camry model mismatch.
 */
export function matchesAnchor(
  target: VehicleTarget,
  claim: { readonly make: string; readonly model: string },
): AnchorMatch {
  if (normalizeAnchorTerm(target.make) !== normalizeAnchorTerm(claim.make)) {
    return { ok: false, field: 'make' };
  }
  if (normalizeAnchorTerm(target.model) !== normalizeAnchorTerm(claim.model)) {
    return { ok: false, field: 'model' };
  }
  return { ok: true };
}

/**
 * AC-5 — ADVISORY ONLY.
 *
 * specs/00 "Cardinality invariants": year drift is "a **soft guide, not a hard
 * rejection**". This returns a VIEW, never a decision, and its only consumer is
 * the war-room assembler. There is deliberately no caller anywhere in this
 * suite that branches to a 4xx on its result, and `undefined` means either "no
 * range was set" or "the year sits inside it" — both of which render as no
 * advisory at all.
 */
export function yearDrift(
  target: VehicleTarget,
  instance: Pick<VehicleInstance, 'year'>,
): YearDriftView | undefined {
  const range = target.year_range;
  if (range === undefined) return undefined;
  if (instance.year >= range.from && instance.year <= range.to) return undefined;
  return { instance_year: instance.year, year_range: { from: range.from, to: range.to } };
}
