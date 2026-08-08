/**
 * `deriveEvaluability` must never drift from `@flag-engine` (docs/design/T-020.md
 * D9; ADR-005).
 *
 * T-019's static suite forbids `@flag-engine` in `services/api/src/**`, and that
 * rule is right about VERDICTS. `unevaluable` is not a verdict — ADR-005 §2
 * defines it as the statement of WHICH REQUIRED INPUTS ARE ABSENT, which is a
 * fact this service owns. So the derivation lives in `src/routes/` and its
 * equality with the engine's answer is pinned HERE, the one file in the service
 * that imports the engine. Drift becomes a test failure instead of a silent
 * divergence between the war room and the flag pipeline.
 *
 * The whole presence matrix is exercised under several `FlagEngineConfig`
 * values, because ADR-005's evaluability must be a function of the INPUTS alone
 * — a config that changed which flags are evaluable would mean the war room's
 * answer depended on a threshold it never sees.
 */

import type { MoneyCents, Offer, OfferFlag, ValuationSnapshot } from '@core';
import { OFFER_FLAGS } from '@core';
import { evaluateOffer, type FlagEngineConfig } from '@flag-engine';
import { describe, expect, it } from 'vitest';

import { deriveEvaluability } from '../../src/routes/index.js';

const INSTANCE = 'vi:deal-1:dl-northside';
const OTHER_INSTANCE = 'vi:deal-2:dl-southside';

const CONFIGS: readonly FlagEngineConfig[] = [
  {
    stretched_term_min_months: 72,
    rate_markup_tolerance_points: 0,
    fee_fair_caps: [{ name: 'doc fee', max_amount: 50_000 }],
    above_market_tolerance_bps: 0,
  },
  {
    stretched_term_min_months: 96,
    rate_markup_tolerance_points: 2,
    fee_fair_caps: [],
    unmatched_fee_cap: 10_000,
    above_market_tolerance_bps: 300,
  },
  {
    stretched_term_min_months: 36,
    rate_markup_tolerance_points: 10,
    fee_fair_caps: [{ name: 'doc fee', max_amount: 1 }],
    above_market_tolerance_bps: 5_000,
  },
];

const SALE_PRICES: readonly (MoneyCents | undefined)[] = [undefined, 2_890_000];
const TERMS: readonly (number | undefined)[] = [undefined, 60, 72];
const APRS: readonly (number | undefined)[] = [undefined, 6.9];
const QUALIFIED: readonly (number | undefined)[] = [undefined, 5.9];

const SNAPSHOTS: readonly { readonly label: string; readonly value?: ValuationSnapshot }[] = [
  { label: 'no snapshot' },
  {
    label: 'this car, with retail',
    value: {
      vehicle_instance_id: INSTANCE,
      retail: 2_600_000,
      source: 'mock-kbb',
      captured_at: '2026-08-01T00:00:00.000Z',
    },
  },
  {
    label: 'this car, no retail band',
    value: {
      vehicle_instance_id: INSTANCE,
      wholesale: 2_400_000,
      trade_in: 2_300_000,
      private_party: 2_700_000,
      source: 'mock-kbb',
      captured_at: '2026-08-01T00:00:00.000Z',
    },
  },
  {
    label: 'another car’s snapshot',
    value: {
      vehicle_instance_id: OTHER_INSTANCE,
      retail: 2_600_000,
      source: 'mock-kbb',
      captured_at: '2026-08-01T00:00:00.000Z',
    },
  },
];

const INSTANCE_IDS: readonly (string | undefined)[] = [undefined, INSTANCE];

const FEE_SETS: readonly Offer['fees'][] = [[], [{ name: 'doc fee', amount: 199_500 }]];

interface Case {
  readonly label: string;
  readonly offer: Offer;
  readonly qualified_apr?: number;
  readonly valuation?: ValuationSnapshot;
  readonly vehicle_instance_id?: string;
}

function* cases(): Generator<Case> {
  for (const sale_price of SALE_PRICES) {
    for (const term_months of TERMS) {
      for (const apr of APRS) {
        for (const qualified_apr of QUALIFIED) {
          for (const snapshot of SNAPSHOTS) {
            for (const vehicle_instance_id of INSTANCE_IDS) {
              for (const fees of FEE_SETS) {
                const offer: Offer = {
                  fees: fees.map((fee) => ({ ...fee })),
                  flags: [],
                  ...(sale_price !== undefined && { sale_price }),
                  ...(term_months !== undefined && { term_months }),
                  ...(apr !== undefined && { apr }),
                };
                yield {
                  label: [
                    `price=${String(sale_price)}`,
                    `term=${String(term_months)}`,
                    `apr=${String(apr)}`,
                    `qual=${String(qualified_apr)}`,
                    `snapshot=${snapshot.label}`,
                    `instance=${String(vehicle_instance_id)}`,
                    `fees=${String(fees.length)}`,
                  ].join(' '),
                  offer,
                  ...(qualified_apr !== undefined && { qualified_apr }),
                  ...(snapshot.value !== undefined && { valuation: snapshot.value }),
                  ...(vehicle_instance_id !== undefined && { vehicle_instance_id }),
                };
              }
            }
          }
        }
      }
    }
  }
}

const ALL = [...cases()];

describe('deriveEvaluability equals @flag-engine over the whole presence matrix (D9)', () => {
  it('covers a matrix worth calling one', () => {
    expect(ALL.length).toBe(
      SALE_PRICES.length *
        TERMS.length *
        APRS.length *
        QUALIFIED.length *
        SNAPSHOTS.length *
        INSTANCE_IDS.length *
        FEE_SETS.length,
    );
    expect(ALL.length).toBeGreaterThan(200);
  });

  it('agrees with the engine on every case, under every config', () => {
    for (const config of CONFIGS) {
      for (const input of ALL) {
        const engine = evaluateOffer(
          input.offer,
          {
            walk_away_number: 3_000_000,
            ...(input.qualified_apr !== undefined && { qualified_apr: input.qualified_apr }),
            ...(input.valuation !== undefined && { valuation: input.valuation }),
            ...(input.vehicle_instance_id !== undefined && { vehicle_instance_id: input.vehicle_instance_id }),
          },
          config,
        );
        const api = deriveEvaluability(input);
        expect([...api.unevaluable], `${input.label} | ${String(config.stretched_term_min_months)}`).toEqual(
          engine.unevaluable,
        );
      }
    }
  });

  it('is invariant across configs — evaluability is a fact about inputs, not thresholds', () => {
    for (const input of ALL) {
      const answers = CONFIGS.map((config) =>
        evaluateOffer(input.offer, { walk_away_number: 3_000_000 }, config).unevaluable.join(','),
      );
      expect(new Set(answers).size, input.label).toBe(1);

      const derived = new Set(
        CONFIGS.map(() => deriveEvaluability({ offer: input.offer }).unevaluable.join(',')),
      );
      expect(derived.size, input.label).toBe(1);
    }
  });

  it('emits OFFER_FLAGS order, duplicate-free, exactly as the engine does', () => {
    for (const input of ALL.slice(0, 40)) {
      const { unevaluable } = deriveEvaluability(input);
      expect(new Set(unevaluable).size).toBe(unevaluable.length);
      const positions = unevaluable.map((flag: OfferFlag) => OFFER_FLAGS.indexOf(flag));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  it('reports every flag unevaluable when there is no offer at all — a state the engine cannot be asked about', () => {
    // `evaluateOffer` requires an `Offer`, so "no offer yet" has no engine
    // answer to be pinned against. The API still must not read it as "fine".
    const { unevaluable, reasons } = deriveEvaluability({});
    expect([...unevaluable]).toEqual([...OFFER_FLAGS]);
    for (const flag of OFFER_FLAGS) expect(reasons.get(flag)).toBe('no_offer');
  });

  it('never reports junk_fee unevaluable — fees[] is a required spine field', () => {
    for (const input of ALL) {
      expect(deriveEvaluability(input).unevaluable, input.label).not.toContain('junk_fee');
    }
  });
});
