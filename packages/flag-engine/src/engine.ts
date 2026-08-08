/**
 * THE flag engine — specs/00-shared-core-architecture.md "Flag engine (shared)".
 *
 * Pure, provider-agnostic, synchronous, total function of
 * `Offer` + qualified-rate + walk-away + — v0.5 — the instance's market value
 * (docs/design/T-002.md §2; docs/design/T-011.md §2).
 * No I/O, no clock, no randomness, no logging, no mutation of any argument,
 * no exceptions on well-typed input.
 *
 * All spine vocabulary comes from `@core` (ADR-001 no-parallel-types,
 * ADR-002 `payment_packing` canonical). This module defines ONLY the engine's
 * own input types (`FlagContext`, `FlagEngineConfig`, `FeeFairCap`).
 */

import { OFFER_FLAGS } from '@core';
import type { MoneyCents, Offer, OfferFlag, ValuationSnapshot } from '@core';

/**
 * The evaluation's non-Offer inputs — the "qualified-rate + walk-away + the
 * instance's market value" of specs/00 "Flag engine (shared)". Field names
 * mirror the spine sources they are read from; this type is a projection,
 * not a parallel model.
 */
export interface FlagContext {
  /**
   * Buyer's qualified APR, same units as Offer.apr (e.g. 6.9).
   * Sourced from PrequalResult.qualified_apr (@core, specs/01 credit residency:
   * derived number only — no credit payload can pass through this field).
   * Absent when the buyer has no prequal → rate_markup is not assessed (design D3).
   */
  qualified_apr?: number;
  /**
   * Deal.walk_away_number (@core), integer USD cents — the deal-level BUDGET
   * CEILING and nothing else. Q20 / ADR-007: it is NOT a fair-price judgement
   * and is NOT re-pointed at valuation; `over_walkaway` semantics are unchanged.
   */
  walk_away_number: MoneyCents;

  /**
   * T-011 — the market-value input, carried PER VehicleInstance: the
   * ValuationSnapshot of the car THIS offer is for, read from
   * DealerThread.vehicle_instance (specs/00 "Budget ceiling vs. fair price":
   * "The flag engine gains a market-value input per instance"; Q20).
   *
   * The whole snapshot travels, not a pre-picked number (T-011 D8) — ADR-007's
   * band selection happens inside this engine, once, where it is tested and
   * citable. Absent (no valuation yet for this instance) → above_market is
   * UNEVALUABLE, never "fine" (ADR-005; specs/00 "never as 'fine'").
   */
  valuation?: ValuationSnapshot;

  /**
   * T-011 — VehicleInstance.id (@core) of the car this offer came from, i.e.
   * DealerThread.vehicle_instance.id. Supplied so the engine can verify that
   * `valuation` really is THIS car's snapshot (ADR-007: "for THAT
   * VehicleInstance"). Mismatch → above_market is unevaluable, never a verdict
   * computed against another dealership's car (T-011 D12). Absent → no check is
   * possible and the binding is taken on the caller's word.
   */
  vehicle_instance_id?: string;
}

/**
 * Injectable thresholds (design D1 — required, no defaults; business constants
 * are the caller's to cite, not this engine's to invent).
 */
export interface FlagEngineConfig {
  /** Term at/above which the term counts as stretched (>=, design D4). Spec example: 72. */
  stretched_term_min_months: number;
  /**
   * APR points of excess over qualified_apr tolerated before rate_markup
   * fires (strict >, design D4). 0 = any excess flags.
   */
  rate_markup_tolerance_points: number;
  /** Fair-value caps per fee (design D6). A fee whose amount strictly exceeds its cap is junk. */
  fee_fair_caps: readonly FeeFairCap[];
  /**
   * Cap applied to fees matching no entry in fee_fair_caps.
   * Omitted = unmatched fees never flag (design D6).
   */
  unmatched_fee_cap?: MoneyCents;

  /**
   * T-011 — basis points of `ValuationSnapshot.retail` tolerated before
   * above_market fires (ADR-007: "tolerance is a config threshold … not
   * hard-coded"; T-011 D10). Integer bps of the retail band, so the knob is
   * scale-invariant and the arithmetic stays integer-exact:
   *
   *     threshold = retail + Math.trunc(retail * above_market_tolerance_bps / 10_000)
   *     fires when offer.sale_price > threshold        (strict — design D4)
   *
   * 0 = any price above retail flags. 300 = 3% over retail tolerated.
   * There is deliberately NO band selector here: ADR-007 fixes the band to
   * `retail`, and overturning it requires a superseding ADR, not a config
   * value (T-011 D11).
   */
  above_market_tolerance_bps: number;
}

export interface FeeFairCap {
  /** Matched against OfferFee.name after normalization: trim + lowercase, exact match. */
  name: string;
  max_amount: MoneyCents;
}

/**
 * Evaluation result (ADR-005). A flag whose required inputs are absent is NOT
 * emitted and is surfaced in `unevaluable` — distinguishable from
 * "evaluated, not triggered" (present in neither list). Missing inputs are
 * never defaulted to zero.
 *
 * Required inputs per flag:
 *  - payment_packing: `term_months` (evaluable from term alone — ADR-005 §2)
 *  - rate_markup:     `apr` AND `context.qualified_apr`
 *  - junk_fee:        none beyond `fees[]` (always present) — always evaluable
 *  - over_walkaway:   `sale_price` (unevaluable when the dealer stated no price)
 *  - above_market:    `sale_price` AND `context.valuation` AND `valuation.retail`,
 *                     and no VehicleInstance-id mismatch (T-011 D11, D12)
 *
 * Both arrays are duplicate-free, disjoint, and in OFFER_FLAGS order (design D7),
 * so `above_market` always sorts last.
 */
export interface FlagEvaluation {
  /** Flags that were evaluated and fired. */
  flags: OfferFlag[];
  /** Flags that could not be assessed because a required input is absent (ADR-005). */
  unevaluable: OfferFlag[];
}

/** Normalization applied to both sides of the fee-name match (design D6). */
function normalizeFeeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve the fair-value cap for a fee name: first exact match in
 * fee_fair_caps (after normalization), else the catch-all unmatched_fee_cap,
 * else undefined (fee never flags — design D6).
 */
function capFor(feeName: string, config: FlagEngineConfig): MoneyCents | undefined {
  const normalized = normalizeFeeName(feeName);
  for (const cap of config.fee_fair_caps) {
    if (normalizeFeeName(cap.name) === normalized) {
      return cap.max_amount;
    }
  }
  return config.unmatched_fee_cap;
}

/**
 * Evaluate an offer against the buyer's context and injected thresholds,
 * returning the full recomputed flag set plus the unevaluable set (ADR-005).
 *
 * Rules (specs/00 "Flag engine (shared)", boundary semantics per design D4):
 *  - payment_packing: term_months >= config.stretched_term_min_months
 *  - rate_markup:     apr > qualified_apr + tolerance
 *  - junk_fee:        any fee.amount > its matched cap (fee_fair_caps, else unmatched_fee_cap)
 *  - over_walkaway:   sale_price + Σ fees[].amount > walk_away_number  (design D2 — UNCHANGED)
 *  - above_market:    sale_price > retail + trunc(retail * bps / 10_000)
 *                     (ADR-007; T-011 D9 numerator, D10 threshold)
 *
 * `over_walkaway` and `above_market` read DIFFERENT numerators (out-the-door
 * total vs. bare sale price) against DIFFERENT denominators (the deal's budget
 * ceiling vs. this instance's retail band) and neither gates the other — so all
 * four budget × market combinations are emittable (specs/00 "Budget ceiling vs.
 * fair price": "A cheap car can be a bad deal and an expensive one a fair deal
 * — both must be sayable").
 *
 * Missing required inputs make the affected flag *unevaluable* — it is not
 * emitted and is reported in `unevaluable`, never treated as zero (ADR-005,
 * refining design D3's "not assessed, never throw, never fire").
 * `offer.flags` on input is ignored; callers replace, never merge (design D5).
 * Both result arrays are duplicate-free and in OFFER_FLAGS order (design D7).
 */
export function evaluateOffer(
  offer: Offer,
  context: FlagContext,
  config: FlagEngineConfig,
): FlagEvaluation {
  const fired = new Set<OfferFlag>();
  const unevaluable = new Set<OfferFlag>();

  // payment_packing — term stretched to shrink the monthly (AC-2).
  // Evaluable from the term alone (ADR-005 §2).
  if (offer.term_months === undefined) {
    unevaluable.add('payment_packing');
  } else if (offer.term_months >= config.stretched_term_min_months) {
    fired.add('payment_packing');
  }

  // rate_markup — APR above what the buyer qualifies for (AC-3).
  // Requires both the offer's APR and the buyer's qualified APR.
  if (offer.apr === undefined || context.qualified_apr === undefined) {
    unevaluable.add('rate_markup');
  } else if (offer.apr > context.qualified_apr + config.rate_markup_tolerance_points) {
    fired.add('rate_markup');
  }

  // junk_fee — any add-on/fee above fair value (AC-4). `fees[]` is a required
  // spine field, so this flag is always evaluable (an empty list evaluates to
  // "not triggered", not "unevaluable").
  for (const fee of offer.fees) {
    const cap = capFor(fee.name, config);
    if (cap !== undefined && fee.amount > cap) {
      fired.add('junk_fee');
      break;
    }
  }

  // over_walkaway — out-the-door total crosses the walk-away number (AC-5,
  // design D2). Requires a stated price: a missing sale_price is NEVER
  // defaulted to zero (ADR-005) — the flag is unevaluable instead.
  if (offer.sale_price === undefined) {
    unevaluable.add('over_walkaway');
  } else {
    let total: MoneyCents = offer.sale_price;
    for (const fee of offer.fees) {
      total += fee.amount;
    }
    if (total > context.walk_away_number) {
      fired.add('over_walkaway');
    }
  }

  // above_market — the offer is priced above THIS specific car's own valuation
  // (specs/00 "Flag engine (shared)"; ADR-007). Requires a stated price AND
  // this instance's `retail` band. The bare sale price is the numerator — fees
  // are deliberately excluded, since a retail book value is a vehicle price and
  // not a transaction total (T-011 D9); `junk_fee` already judges the fees.
  // Never falls back to another band (D11) and never evaluates against another
  // car's snapshot (D12) — both states are unevaluable, never a verdict.
  const valuation = context.valuation;
  const retail = valuation?.retail;
  const instanceMismatch =
    valuation !== undefined &&
    context.vehicle_instance_id !== undefined &&
    valuation.vehicle_instance_id !== context.vehicle_instance_id;

  if (offer.sale_price === undefined || retail === undefined || instanceMismatch) {
    unevaluable.add('above_market');
  } else {
    // Integer bps of retail: no floats enter the money path (T-011 D10).
    const allowance = Math.trunc((retail * config.above_market_tolerance_bps) / 10_000);
    if (offer.sale_price > retail + allowance) {
      fired.add('above_market');
    }
  }

  // Fixed OFFER_FLAGS ordering, duplicate-free and disjoint by construction (design D7).
  return {
    flags: OFFER_FLAGS.filter((flag) => fired.has(flag)),
    unevaluable: OFFER_FLAGS.filter((flag) => unevaluable.has(flag)),
  };
}
