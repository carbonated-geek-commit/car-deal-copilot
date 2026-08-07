/**
 * T-002 flag-engine test suite (docs/design/T-002.md §5, AC-7).
 *
 * Suites: per-flag firing / not-firing (AC-2..5), boundary semantics (D4),
 * missing inputs (D3), vocabulary (AC-6 / ADR-002), purity & determinism
 * (AC-1 / D5 / D7), combined fixtures, and the §4.1 error paths (total
 * function: NaN / negative / malformed config never throw), plus the §4.2
 * structural posture (no async, no I/O surface, closed export set).
 *
 * All engine access goes through the public `@flag-engine` surface (design §2).
 */

import { describe, expect, it } from 'vitest';
import { OFFER_FLAGS } from '@core';
import type { Offer, OfferFlag } from '@core';
import { evaluateOffer } from '@flag-engine';
import * as flagEngineApi from '@flag-engine';
import type { FlagContext, FlagEngineConfig } from '@flag-engine';
import {
  BENIGN_CONTEXT,
  CONFIG_WITH_UNMATCHED_CAP,
  FIXTURE_CONFIG,
  deepFreeze,
  makeEverythingWrongOffer,
  makeOffer,
  makeOfferWithout,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// Type-level vocabulary checks (AC-6, ADR-002) — validated by
// `npx tsc -p packages/flag-engine --noEmit`, inert at runtime.
// ---------------------------------------------------------------------------

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

// The return type is exactly @core's OfferFlag[] — not a wider string union.
type _returnTypeIsOfferFlagArray = Expect<Eq<ReturnType<typeof evaluateOffer>, OfferFlag[]>>;

// ADR-002: 'packing' is not in the flag vocabulary at the type level.
// @ts-expect-error -- 'packing' must not be assignable to OfferFlag
const _packingIsNotAFlag: OfferFlag = 'packing';

// ---------------------------------------------------------------------------

describe('payment_packing (AC-2)', () => {
  it('fires when the term is stretched (84 mo, spec example)', () => {
    const offer = makeOffer({ term_months: 84 });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toContain('payment_packing');
  });

  it('does not fire on a normal term (60 mo), all other inputs benign', () => {
    expect(evaluateOffer(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG)).not.toContain(
      'payment_packing',
    );
  });

  it('boundary (D4): term = 72 fires (>= threshold — 72 itself is stretched)', () => {
    const offer = makeOffer({ term_months: 72 });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['payment_packing']);
  });

  it('boundary (D4): term = 71 does not fire', () => {
    const offer = makeOffer({ term_months: 71 });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('missing term_months (D3): not assessed — cannot fire even at a stretched-looking offer', () => {
    const offer = makeOfferWithout(['term_months']);
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).not.toContain('payment_packing');
  });

  it('missing term_months leaves the other flags unaffected', () => {
    // Everything wrong except the term is absent → the other three still fire.
    const offer = makeOfferWithout(['term_months'], {
      sale_price: 2_600_000,
      fees: [{ name: 'doc fee', amount: 60_000 }],
      apr: 9.9,
    });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([
      'rate_markup',
      'junk_fee',
      'over_walkaway',
    ]);
  });
});

describe('rate_markup (AC-3)', () => {
  it('fires when APR is above the qualified rate', () => {
    const offer = makeOffer({ apr: 9.9 });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['rate_markup']);
  });

  it('does not fire when APR equals the qualified rate (equal-to is not "above" — D4)', () => {
    const offer = makeOffer({ apr: 5.9 });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('does not fire when APR is below the qualified rate', () => {
    const offer = makeOffer({ apr: 3.9 });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('boundary (D4): apr = qualified + tolerance does not fire; any epsilon above does', () => {
    const tolerantConfig: FlagEngineConfig = {
      ...FIXTURE_CONFIG,
      rate_markup_tolerance_points: 2,
    };
    const atBoundary = makeOffer({ apr: 7.9 }); // 5.9 + 2 exactly
    const justOver = makeOffer({ apr: 7.91 });
    expect(evaluateOffer(atBoundary, BENIGN_CONTEXT, tolerantConfig)).toEqual([]);
    expect(evaluateOffer(justOver, BENIGN_CONTEXT, tolerantConfig)).toEqual(['rate_markup']);
  });

  it('missing apr (D3, cash deal): not assessed — cannot fire', () => {
    const offer = makeOfferWithout(['apr', 'monthly']);
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).not.toContain('rate_markup');
  });

  it('missing qualified_apr (D3, no prequal): not assessed even with a high APR', () => {
    const noPrequal: FlagContext = { walk_away_number: 2_600_000 };
    const offer = makeOffer({ apr: 24.9 });
    expect(evaluateOffer(offer, noPrequal, FIXTURE_CONFIG)).not.toContain('rate_markup');
  });

  it('missing qualified_apr leaves the other flags unaffected', () => {
    const noPrequal: FlagContext = { walk_away_number: 2_600_000 };
    const offer = makeEverythingWrongOffer();
    expect(evaluateOffer(offer, noPrequal, FIXTURE_CONFIG)).toEqual([
      'payment_packing',
      'junk_fee',
      'over_walkaway',
    ]);
  });
});

describe('junk_fee (AC-4)', () => {
  it('fires when a matched fee is above its fair-value cap', () => {
    const offer = makeOffer({ fees: [{ name: 'doc fee', amount: 60_000 }] });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['junk_fee']);
  });

  it('boundary (D4): fee = cap does not fire; cap + 1 cent does', () => {
    const atCap = makeOffer({ fees: [{ name: 'doc fee', amount: 50_000 }] });
    const overCap = makeOffer({ fees: [{ name: 'doc fee', amount: 50_001 }] });
    expect(evaluateOffer(atCap, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
    expect(evaluateOffer(overCap, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['junk_fee']);
  });

  it('matches fee names after trim + lowercase normalization on both sides (D6)', () => {
    // Config cap name is 'Doc Fee'; offer fee is '  DOC FEE  '.
    const offer = makeOffer({ fees: [{ name: '  DOC FEE  ', amount: 50_001 }] });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['junk_fee']);
  });

  it('unmatched fee with unmatched_fee_cap set: fires above the catch-all cap (D6)', () => {
    const offer = makeOffer({ fees: [{ name: 'nitrogen tires', amount: 20_001 }] });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual(['junk_fee']);
  });

  it('unmatched fee with unmatched_fee_cap set: does not fire at the catch-all cap', () => {
    const offer = makeOffer({ fees: [{ name: 'nitrogen tires', amount: 20_000 }] });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual([]);
  });

  it('unmatched fee with unmatched_fee_cap omitted: never flags (D6)', () => {
    // Big enough to be junk by any intuition, but no cap matches — walk-away
    // absorbs it via a higher context so only junk_fee is under test.
    const offer = makeOffer({ fees: [{ name: 'paint protection', amount: 150_000 }] });
    const roomyContext: FlagContext = { ...BENIGN_CONTEXT, walk_away_number: 5_000_000 };
    expect(evaluateOffer(offer, roomyContext, FIXTURE_CONFIG)).toEqual([]);
  });

  it('a named cap takes precedence over the catch-all cap for matched fees (D6)', () => {
    // 40_000 exceeds the 20_000 catch-all but is under the 50_000 doc-fee cap.
    const offer = makeOffer({ fees: [{ name: 'doc fee', amount: 40_000 }] });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual([]);
  });

  it('does not fire on an offer with no fees at all', () => {
    const offer = makeOffer({ fees: [] });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual([]);
  });

  it('multiple over-cap fees still emit junk_fee exactly once (D7 duplicate-free)', () => {
    const offer = makeOffer({
      fees: [
        { name: 'doc fee', amount: 60_000 },
        { name: 'nitrogen tires', amount: 30_000 },
      ],
      sale_price: 2_000_000, // keep total under walk-away
    });
    const flags = evaluateOffer(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP);
    expect(flags).toEqual(['junk_fee']);
  });
});

describe('over_walkaway (AC-5, D2 total = sale_price + Σ fees)', () => {
  it('fires when the out-the-door total crosses the walk-away number', () => {
    const offer = makeOffer({ sale_price: 2_600_000 }); // + 40_000 fee = 2_640_000
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['over_walkaway']);
  });

  it('boundary (D4): total = walk-away does not fire ("crosses" is strict)', () => {
    const offer = makeOffer({ sale_price: 2_560_000 }); // + 40_000 = 2_600_000 exactly
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('boundary (D4): total = walk-away + 1 cent fires', () => {
    const offer = makeOffer({ sale_price: 2_560_001 }); // + 40_000 = 2_600_001
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['over_walkaway']);
  });

  it('fees are part of the total: sale price alone under walk-away, fees push it over (D2)', () => {
    const offer = makeOffer({
      sale_price: 2_590_000, // under 2_600_000 on its own
      fees: [{ name: 'doc fee', amount: 40_000 }], // total 2_630_000 — over
    });
    expect(evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['over_walkaway']);
  });

  it('does not fire when the total is comfortably under', () => {
    expect(evaluateOffer(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });
});

describe('vocabulary (AC-6, ADR-002)', () => {
  const fixtures: Array<[Offer, FlagContext, FlagEngineConfig]> = [
    [makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG],
    [makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG],
    [makeOfferWithout(['apr', 'term_months', 'monthly']), BENIGN_CONTEXT, FIXTURE_CONFIG],
    [makeOffer({ term_months: 84, apr: 9.9 }), BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP],
  ];

  it('every emitted value is a member of @core OFFER_FLAGS', () => {
    for (const [offer, context, config] of fixtures) {
      for (const flag of evaluateOffer(offer, context, config)) {
        expect(OFFER_FLAGS).toContain(flag);
      }
    }
  });

  it("the shorthand 'packing' never appears in any result (ADR-002 canonical name)", () => {
    for (const [offer, context, config] of fixtures) {
      expect(evaluateOffer(offer, context, config)).not.toContain('packing');
    }
  });
});

describe('purity, determinism, ordering (AC-1, D5, D7)', () => {
  it('does not mutate offer, context, or config (deep-equal before/after)', () => {
    const offer = makeEverythingWrongOffer();
    const context: FlagContext = { ...BENIGN_CONTEXT };
    const config: FlagEngineConfig = {
      ...FIXTURE_CONFIG,
      fee_fair_caps: FIXTURE_CONFIG.fee_fair_caps.map((c) => ({ ...c })),
    };
    const offerSnapshot = JSON.parse(JSON.stringify(offer));
    const contextSnapshot = JSON.parse(JSON.stringify(context));
    const configSnapshot = JSON.parse(JSON.stringify(config));

    evaluateOffer(offer, context, config);

    expect(offer).toEqual(offerSnapshot);
    expect(context).toEqual(contextSnapshot);
    expect(config).toEqual(configSnapshot);
  });

  it('accepts deeply frozen inputs without throwing (no mutation path exists)', () => {
    const offer = deepFreeze(makeEverythingWrongOffer());
    const context = deepFreeze<FlagContext>({ ...BENIGN_CONTEXT });
    const config = deepFreeze<FlagEngineConfig>({
      ...FIXTURE_CONFIG,
      fee_fair_caps: FIXTURE_CONFIG.fee_fair_caps.map((c) => ({ ...c })),
    });
    expect(() => evaluateOffer(offer, context, config)).not.toThrow();
  });

  it('ignores offer.flags on input — prepopulated garbage-but-valid flags do not leak through (D5)', () => {
    const cleanEconomicsDirtyFlags = makeOffer({
      flags: ['over_walkaway', 'junk_fee', 'payment_packing', 'rate_markup'],
    });
    expect(evaluateOffer(cleanEconomicsDirtyFlags, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('returns a fresh array, never a reference to offer.flags', () => {
    const offer = makeOffer();
    const result = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(result).not.toBe(offer.flags);
  });

  it('is deterministic: two calls with equal inputs are deep-equal', () => {
    const a = evaluateOffer(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    const b = evaluateOffer(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(a).toEqual(b);
  });

  it('multi-flag results come back in OFFER_FLAGS order, duplicate-free (D7)', () => {
    const flags = evaluateOffer(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(flags).toEqual([...OFFER_FLAGS]);
    expect(new Set(flags).size).toBe(flags.length);
  });

  it('re-evaluation of an already-flagged offer is idempotent (redelivery-safe, design §4.1)', () => {
    const offer = makeEverythingWrongOffer();
    const first = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    const reFlagged: Offer = { ...offer, flags: first };
    const second = evaluateOffer(reFlagged, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(second).toEqual(first);
  });
});

describe('combined fixtures (design §5)', () => {
  it('the "everything wrong" offer emits all four flags', () => {
    expect(evaluateOffer(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([
      'payment_packing',
      'rate_markup',
      'junk_fee',
      'over_walkaway',
    ]);
  });

  it('a clean offer emits []', () => {
    expect(evaluateOffer(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });
});

describe('error paths — total function, never throws (design §4.1)', () => {
  it('NaN apr: no throw, rate_markup conservatively does not fire', () => {
    const offer = makeOffer({ apr: Number.NaN });
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    }).not.toThrow();
    expect(flags).not.toContain('rate_markup');
  });

  it('NaN sale_price: no throw, over_walkaway conservatively does not fire', () => {
    const offer = makeOffer({ sale_price: Number.NaN });
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    }).not.toThrow();
    expect(flags).not.toContain('over_walkaway');
  });

  it('NaN fee amount: no throw, junk_fee conservatively does not fire', () => {
    const offer = makeOffer({ fees: [{ name: 'doc fee', amount: Number.NaN }] });
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    }).not.toThrow();
    expect(flags).not.toContain('junk_fee');
  });

  it('negative cents slipping past upstream: no throw, result stays within the vocabulary', () => {
    const offer = makeOffer({
      sale_price: -1_000_000,
      fees: [{ name: 'doc fee', amount: -5_000 }],
    });
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    }).not.toThrow();
    for (const flag of flags) {
      expect(OFFER_FLAGS).toContain(flag);
    }
  });

  it('malformed config (negative thresholds, empty caps): no throw, well-typed OfferFlag[] out', () => {
    const malformed: FlagEngineConfig = {
      stretched_term_min_months: -1,
      rate_markup_tolerance_points: -10,
      fee_fair_caps: [],
    };
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(makeOffer(), BENIGN_CONTEXT, malformed);
    }).not.toThrow();
    expect(Array.isArray(flags)).toBe(true);
    for (const flag of flags) {
      expect(OFFER_FLAGS).toContain(flag);
    }
  });

  it('offer with every optional field absent and zero fees: no throw, deterministic result', () => {
    const bareOffer: Offer = { sale_price: 0, fees: [], flags: [] };
    const bareContext: FlagContext = { walk_away_number: 0 };
    expect(evaluateOffer(bareOffer, bareContext, FIXTURE_CONFIG)).toEqual([]);
  });
});

describe('structural posture (design §2, §4.2 — no I/O surface, sync, closed API)', () => {
  it('the public runtime surface is exactly { evaluateOffer }', () => {
    expect(Object.keys(flagEngineApi).sort()).toEqual(['evaluateOffer']);
    expect(typeof flagEngineApi.evaluateOffer).toBe('function');
  });

  it('evaluateOffer is synchronous — a plain Function returning an array, never a Promise', () => {
    expect(evaluateOffer.constructor.name).toBe('Function'); // not AsyncFunction
    const result = evaluateOffer(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
  });
});
