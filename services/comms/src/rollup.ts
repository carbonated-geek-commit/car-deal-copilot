/**
 * `current_offer` rollup policy — design T-009 §6 (D4).
 *
 * PRIMARY POLICY (implemented here): per-field newest-message-wins
 * accumulation with provenance. "Newest" is the contributing
 * `Message.timestamp` (tie-break: `provider_message_ref` lexicographic),
 * NOT processing order — so the merge is commutative, associative, and
 * idempotent under at-least-once unordered delivery: any interleaving or
 * redelivery of the same contribution set yields the same `current_offer`.
 *
 * ADR gate (design §6, task note): reading spec text "rolled into the
 * thread's `current_offer`" as accumulate-not-replace is an interpretive
 * call beyond the literal spec — the lead must resolve-and-log an ADR
 * before T-009's build merges. The documented fallback (wholesale
 * newest-offer-wins under the same `(at, ref)` ordering) is contained to
 * this file; no other module changes under either resolution.
 *
 * ADR-005: absence is a first-class state. Fields absent on a contribution
 * are never touched and never defaulted — missing values are NEVER zero.
 */

import type { IsoTimestamp, Offer } from '@core';

/** Contributing Message.timestamp + provider_message_ref. */
export interface RollupProvenance {
  at: IsoTimestamp;
  ref: string;
}

/** Store-internal (NOT a spine type): which contribution last set each field. */
export interface RollupState {
  sale_price?: RollupProvenance;
  apr?: RollupProvenance;
  term_months?: RollupProvenance;
  monthly?: RollupProvenance;
  fees?: RollupProvenance;
}

export interface RollupContribution {
  offer: Offer;
  /** The contributing Message.timestamp (= InboundComms.received_at). */
  at: IsoTimestamp;
  /** The contributing message's provider_message_ref (tie-break). */
  ref: string;
}

/**
 * Strict "newer than" over (timestamp, ref). ISO-8601 UTC timestamps compare
 * lexicographically ⇔ chronologically. Equal (at, ref) is NOT newer — a
 * redelivered contribution is an exact no-op (idempotency, §6.4).
 */
const isNewer = (next: RollupProvenance, prev: RollupProvenance | undefined): boolean => {
  if (prev === undefined) return true;
  if (next.at !== prev.at) return next.at > prev.at;
  return next.ref > prev.ref;
};

/**
 * Pure, deterministic, commutative, idempotent (design §6).
 *
 * Rules:
 * 1. Per-field newest-wins for sale_price / apr / term_months / monthly —
 *    a field PRESENT on next.offer replaces the current value iff
 *    (next.at, next.ref) is strictly newer than the field's provenance.
 *    Absent fields are not touched (ADR-005: absence, never zero).
 * 2. fees[] contends as a unit: a non-empty fees replaces wholesale under
 *    the same ordering; an empty fees: [] never erases known fees
 *    (extractor emits [] for "no fee lines found", not "fees are zero").
 * 3. flags is always [] here — flag evaluation is the flag engine's (T-002),
 *    downstream; this service never populates or interprets flag vocabulary
 *    (ADR-002 untouched).
 * 4. Message.extracted_offer is never derived from this rollup — only
 *    current_offer is composite.
 */
export function mergeCurrentOffer(
  prev: { offer?: Offer; state: RollupState },
  next: RollupContribution,
): { offer: Offer; state: RollupState } {
  const state: RollupState = { ...prev.state };
  const base: Offer = prev.offer ?? { fees: [], flags: [] };
  const offer: Offer = {
    fees: base.fees.map((f) => ({ ...f })),
    flags: [], // rule 3 — always empty in this service
    ...(base.sale_price !== undefined ? { sale_price: base.sale_price } : {}),
    ...(base.apr !== undefined ? { apr: base.apr } : {}),
    ...(base.term_months !== undefined ? { term_months: base.term_months } : {}),
    ...(base.monthly !== undefined ? { monthly: base.monthly } : {}),
  };
  const p: RollupProvenance = { at: next.at, ref: next.ref };

  if (next.offer.sale_price !== undefined && isNewer(p, state.sale_price)) {
    offer.sale_price = next.offer.sale_price;
    state.sale_price = p;
  }
  if (next.offer.apr !== undefined && isNewer(p, state.apr)) {
    offer.apr = next.offer.apr;
    state.apr = p;
  }
  if (next.offer.term_months !== undefined && isNewer(p, state.term_months)) {
    offer.term_months = next.offer.term_months;
    state.term_months = p;
  }
  if (next.offer.monthly !== undefined && isNewer(p, state.monthly)) {
    offer.monthly = next.offer.monthly;
    state.monthly = p;
  }
  if (next.offer.fees.length > 0 && isNewer(p, state.fees)) {
    offer.fees = next.offer.fees.map((f) => ({ ...f }));
    state.fees = p;
  }

  return { offer, state };
}
