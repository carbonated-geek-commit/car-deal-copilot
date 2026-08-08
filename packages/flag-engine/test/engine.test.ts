/**
 * T-002 flag-engine test suite (docs/design/T-002.md §5, AC-7; ADR-005).
 *
 * Suites: per-flag firing / not-firing (AC-2..5), boundary semantics (D4),
 * missing inputs → unevaluable (D3 as refined by ADR-005), vocabulary
 * (AC-6 / ADR-002), purity & determinism (AC-1 / D5 / D7), combined fixtures,
 * and the §4.1 error paths (total function: NaN / negative / malformed config
 * never throw), plus the §4.2 structural posture (no async, no I/O surface,
 * closed export set).
 *
 * ADR-005: `evaluateOffer` returns `{ flags, unevaluable }`. A flag whose
 * required inputs are missing is NOT emitted and appears in `unevaluable`
 * (distinguishable from evaluated-but-not-triggered); missing inputs are
 * never defaulted to zero. `payment_packing` stays evaluable from term alone;
 * `over_walkaway` requires a stated `sale_price`.
 *
 * All engine access goes through the public `@flag-engine` surface (design §2).
 */

import { describe, expect, it } from 'vitest';
import { OFFER_FLAGS } from '@core';
import type { Offer, OfferFlag } from '@core';
import { evaluateOffer } from '@flag-engine';
import * as flagEngineApi from '@flag-engine';
import type { FlagContext, FlagEngineConfig, FlagEvaluation } from '@flag-engine';
import {
  BENIGN_CONTEXT,
  CONFIG_WITH_UNMATCHED_CAP,
  FIXTURE_CONFIG,
  deepFreeze,
  makeEverythingWrongOffer,
  makeOffer,
  makeOfferWithout,
} from './fixtures.js';

/** Fired-flags shorthand — most suites assert on the emitted set only. */
function flagsOf(offer: Offer, context: FlagContext, config: FlagEngineConfig): OfferFlag[] {
  return evaluateOffer(offer, context, config).flags;
}

// ---------------------------------------------------------------------------
// Type-level vocabulary checks (AC-6, ADR-002, ADR-005) — validated by
// `npx tsc -p packages/flag-engine --noEmit`, inert at runtime.
// ---------------------------------------------------------------------------

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

// The return type is exactly FlagEvaluation (ADR-005), whose two members are
// @core OfferFlag[] — not a wider string union.
type _returnTypeIsFlagEvaluation = Expect<Eq<ReturnType<typeof evaluateOffer>, FlagEvaluation>>;
type _flagsMemberIsOfferFlagArray = Expect<Eq<FlagEvaluation['flags'], OfferFlag[]>>;
type _unevaluableMemberIsOfferFlagArray = Expect<
  Eq<FlagEvaluation['unevaluable'], OfferFlag[]>
>;

// ADR-002: 'packing' is not in the flag vocabulary at the type level.
// @ts-expect-error -- 'packing' must not be assignable to OfferFlag
const _packingIsNotAFlag: OfferFlag = 'packing';

// ---------------------------------------------------------------------------

describe('payment_packing (AC-2)', () => {
  it('fires when the term is stretched (84 mo, spec example)', () => {
    const offer = makeOffer({ term_months: 84 });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toContain('payment_packing');
  });

  it('does not fire on a normal term (60 mo), all other inputs benign', () => {
    expect(flagsOf(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG)).not.toContain(
      'payment_packing',
    );
  });

  it('boundary (D4): term = 72 fires (>= threshold — 72 itself is stretched)', () => {
    const offer = makeOffer({ term_months: 72 });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['payment_packing']);
  });

  it('boundary (D4): term = 71 does not fire', () => {
    const offer = makeOffer({ term_months: 71 });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('missing term_months (ADR-005): unevaluable — not emitted, surfaced distinctly', () => {
    const offer = makeOfferWithout(['term_months']);
    const result = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(result.flags).not.toContain('payment_packing');
    expect(result.unevaluable).toEqual(['payment_packing']);
  });

  it('missing term_months leaves the other flags unaffected', () => {
    // Everything wrong except the term is absent → the other three still fire.
    const offer = makeOfferWithout(['term_months'], {
      sale_price: 2_600_000,
      fees: [{ name: 'doc fee', amount: 60_000 }],
      apr: 9.9,
    });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([
      'rate_markup',
      'junk_fee',
      'over_walkaway',
    ]);
  });

  it('stays evaluable from the term alone — fires on a term-only partial offer (ADR-005 §2)', () => {
    // The payment-packing scenario itself: monthly/term quoted, no price stated.
    const offer = makeOfferWithout(['sale_price', 'apr'], { term_months: 84 });
    const result = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(result.flags).toEqual(['payment_packing']);
    expect(result.unevaluable).toEqual(['rate_markup', 'over_walkaway']);
  });
});

describe('rate_markup (AC-3)', () => {
  it('fires when APR is above the qualified rate', () => {
    const offer = makeOffer({ apr: 9.9 });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['rate_markup']);
  });

  it('does not fire when APR equals the qualified rate (equal-to is not "above" — D4)', () => {
    const offer = makeOffer({ apr: 5.9 });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('does not fire when APR is below the qualified rate', () => {
    const offer = makeOffer({ apr: 3.9 });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('boundary (D4): apr = qualified + tolerance does not fire; any epsilon above does', () => {
    const tolerantConfig: FlagEngineConfig = {
      ...FIXTURE_CONFIG,
      rate_markup_tolerance_points: 2,
    };
    const atBoundary = makeOffer({ apr: 7.9 }); // 5.9 + 2 exactly
    const justOver = makeOffer({ apr: 7.91 });
    expect(flagsOf(atBoundary, BENIGN_CONTEXT, tolerantConfig)).toEqual([]);
    expect(flagsOf(justOver, BENIGN_CONTEXT, tolerantConfig)).toEqual(['rate_markup']);
  });

  it('missing apr (ADR-005, cash deal): unevaluable — not emitted, surfaced distinctly', () => {
    const offer = makeOfferWithout(['apr', 'monthly']);
    const result = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(result.flags).not.toContain('rate_markup');
    expect(result.unevaluable).toEqual(['rate_markup']);
  });

  it('missing qualified_apr (ADR-005, no prequal): unevaluable even with a high APR', () => {
    const noPrequal: FlagContext = { walk_away_number: 2_600_000 };
    const offer = makeOffer({ apr: 24.9 });
    const result = evaluateOffer(offer, noPrequal, FIXTURE_CONFIG);
    expect(result.flags).not.toContain('rate_markup');
    expect(result.unevaluable).toEqual(['rate_markup']);
  });

  it('missing qualified_apr leaves the other flags unaffected', () => {
    const noPrequal: FlagContext = { walk_away_number: 2_600_000 };
    const offer = makeEverythingWrongOffer();
    expect(flagsOf(offer, noPrequal, FIXTURE_CONFIG)).toEqual([
      'payment_packing',
      'junk_fee',
      'over_walkaway',
    ]);
  });
});

describe('junk_fee (AC-4)', () => {
  it('fires when a matched fee is above its fair-value cap', () => {
    const offer = makeOffer({ fees: [{ name: 'doc fee', amount: 60_000 }] });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['junk_fee']);
  });

  it('boundary (D4): fee = cap does not fire; cap + 1 cent does', () => {
    const atCap = makeOffer({ fees: [{ name: 'doc fee', amount: 50_000 }] });
    const overCap = makeOffer({ fees: [{ name: 'doc fee', amount: 50_001 }] });
    expect(flagsOf(atCap, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
    expect(flagsOf(overCap, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['junk_fee']);
  });

  it('matches fee names after trim + lowercase normalization on both sides (D6)', () => {
    // Config cap name is 'Doc Fee'; offer fee is '  DOC FEE  '.
    const offer = makeOffer({ fees: [{ name: '  DOC FEE  ', amount: 50_001 }] });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['junk_fee']);
  });

  it('unmatched fee with unmatched_fee_cap set: fires above the catch-all cap (D6)', () => {
    const offer = makeOffer({ fees: [{ name: 'nitrogen tires', amount: 20_001 }] });
    expect(flagsOf(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual(['junk_fee']);
  });

  it('unmatched fee with unmatched_fee_cap set: does not fire at the catch-all cap', () => {
    const offer = makeOffer({ fees: [{ name: 'nitrogen tires', amount: 20_000 }] });
    expect(flagsOf(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual([]);
  });

  it('unmatched fee with unmatched_fee_cap omitted: never flags (D6)', () => {
    // Big enough to be junk by any intuition, but no cap matches — walk-away
    // absorbs it via a higher context so only junk_fee is under test.
    const offer = makeOffer({ fees: [{ name: 'paint protection', amount: 150_000 }] });
    const roomyContext: FlagContext = { ...BENIGN_CONTEXT, walk_away_number: 5_000_000 };
    expect(flagsOf(offer, roomyContext, FIXTURE_CONFIG)).toEqual([]);
  });

  it('a named cap takes precedence over the catch-all cap for matched fees (D6)', () => {
    // 40_000 exceeds the 20_000 catch-all but is under the 50_000 doc-fee cap.
    const offer = makeOffer({ fees: [{ name: 'doc fee', amount: 40_000 }] });
    expect(flagsOf(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual([]);
  });

  it('does not fire on an offer with no fees at all', () => {
    const offer = makeOffer({ fees: [] });
    expect(flagsOf(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual([]);
  });

  it('an empty fees[] is evaluated-not-triggered, never unevaluable (ADR-005 distinction)', () => {
    const offer = makeOffer({ fees: [] });
    const result = evaluateOffer(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP);
    expect(result.flags).not.toContain('junk_fee');
    expect(result.unevaluable).not.toContain('junk_fee');
  });

  it('multiple over-cap fees still emit junk_fee exactly once (D7 duplicate-free)', () => {
    const offer = makeOffer({
      fees: [
        { name: 'doc fee', amount: 60_000 },
        { name: 'nitrogen tires', amount: 30_000 },
      ],
      sale_price: 2_000_000, // keep total under walk-away
    });
    expect(flagsOf(offer, BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP)).toEqual(['junk_fee']);
  });
});

describe('over_walkaway (AC-5, D2 total = sale_price + Σ fees)', () => {
  it('fires when the out-the-door total crosses the walk-away number', () => {
    const offer = makeOffer({ sale_price: 2_600_000 }); // + 40_000 fee = 2_640_000
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['over_walkaway']);
  });

  it('boundary (D4): total = walk-away does not fire ("crosses" is strict)', () => {
    const offer = makeOffer({ sale_price: 2_560_000 }); // + 40_000 = 2_600_000 exactly
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('boundary (D4): total = walk-away + 1 cent fires', () => {
    const offer = makeOffer({ sale_price: 2_560_001 }); // + 40_000 = 2_600_001
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['over_walkaway']);
  });

  it('fees are part of the total: sale price alone under walk-away, fees push it over (D2)', () => {
    const offer = makeOffer({
      sale_price: 2_590_000, // under 2_600_000 on its own
      fees: [{ name: 'doc fee', amount: 40_000 }], // total 2_630_000 — over
    });
    expect(flagsOf(offer, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual(['over_walkaway']);
  });

  it('does not fire when the total is comfortably under', () => {
    expect(flagsOf(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('missing sale_price (ADR-005): unevaluable — not emitted, surfaced distinctly', () => {
    const offer = makeOfferWithout(['sale_price']);
    const result = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(result.flags).not.toContain('over_walkaway');
    expect(result.unevaluable).toEqual(['over_walkaway']);
  });

  it('missing sale_price is NEVER defaulted to zero (ADR-005)', () => {
    // If a missing price were treated as 0, the 40_000-cent fee alone would
    // cross this zero walk-away number and fire. It must not: unevaluable.
    const offer = makeOfferWithout(['sale_price']);
    const zeroWalkAway: FlagContext = { ...BENIGN_CONTEXT, walk_away_number: 0 };
    const result = evaluateOffer(offer, zeroWalkAway, FIXTURE_CONFIG);
    expect(result.flags).not.toContain('over_walkaway');
    expect(result.unevaluable).toContain('over_walkaway');
  });

  it('missing sale_price leaves the other flags unaffected', () => {
    const offer = makeOfferWithout(['sale_price'], {
      fees: [{ name: 'doc fee', amount: 60_000 }],
      apr: 9.9,
      term_months: 84,
    });
    const result = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(result.flags).toEqual(['payment_packing', 'rate_markup', 'junk_fee']);
    expect(result.unevaluable).toEqual(['over_walkaway']);
  });
});

describe('unevaluable set semantics (ADR-005)', () => {
  it('a fully-populated offer with prequal has an empty unevaluable set', () => {
    expect(evaluateOffer(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG).unevaluable).toEqual([]);
  });

  it('unevaluable is distinguishable from evaluated-but-not-triggered', () => {
    // Benign offer: nothing fires, everything was assessed.
    const assessed = evaluateOffer(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(assessed.flags).toEqual([]);
    expect(assessed.unevaluable).toEqual([]);
    // Price-less otherwise-benign offer: over_walkaway also absent from flags,
    // but now it is reported unevaluable — a different, visible state.
    const priceless = evaluateOffer(
      makeOfferWithout(['sale_price']),
      BENIGN_CONTEXT,
      FIXTURE_CONFIG,
    );
    expect(priceless.flags).toEqual([]);
    expect(priceless.unevaluable).toEqual(['over_walkaway']);
  });

  it('a bare partial offer (fees/flags only) makes exactly the input-requiring flags unevaluable', () => {
    const offer = makeOfferWithout(['sale_price', 'apr', 'term_months', 'monthly']);
    const result = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(result.flags).toEqual([]); // junk_fee assessed: 40_000 fee under cap
    expect(result.unevaluable).toEqual(['payment_packing', 'rate_markup', 'over_walkaway']);
  });

  it('flags and unevaluable are disjoint, each duplicate-free and in OFFER_FLAGS order', () => {
    const cases: Array<[Offer, FlagContext]> = [
      [makeOffer(), BENIGN_CONTEXT],
      [makeEverythingWrongOffer(), BENIGN_CONTEXT],
      [makeOfferWithout(['sale_price', 'apr']), { walk_away_number: 2_600_000 }],
      [makeOfferWithout(['sale_price', 'apr', 'term_months', 'monthly']), BENIGN_CONTEXT],
    ];
    for (const [offer, context] of cases) {
      const { flags, unevaluable } = evaluateOffer(offer, context, FIXTURE_CONFIG);
      for (const list of [flags, unevaluable]) {
        expect(new Set(list).size).toBe(list.length);
        const inSpineOrder = OFFER_FLAGS.filter((f) => list.includes(f));
        expect(list).toEqual(inSpineOrder);
      }
      for (const flag of flags) {
        expect(unevaluable).not.toContain(flag);
      }
    }
  });
});

describe('vocabulary (AC-6, ADR-002)', () => {
  const fixtures: Array<[Offer, FlagContext, FlagEngineConfig]> = [
    [makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG],
    [makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG],
    [makeOfferWithout(['apr', 'term_months', 'monthly']), BENIGN_CONTEXT, FIXTURE_CONFIG],
    [makeOfferWithout(['sale_price']), BENIGN_CONTEXT, FIXTURE_CONFIG],
    [makeOffer({ term_months: 84, apr: 9.9 }), BENIGN_CONTEXT, CONFIG_WITH_UNMATCHED_CAP],
  ];

  it('every emitted value — fired or unevaluable — is a member of @core OFFER_FLAGS', () => {
    for (const [offer, context, config] of fixtures) {
      const { flags, unevaluable } = evaluateOffer(offer, context, config);
      for (const flag of [...flags, ...unevaluable]) {
        expect(OFFER_FLAGS).toContain(flag);
      }
    }
  });

  it("the shorthand 'packing' never appears in any result (ADR-002 canonical name)", () => {
    for (const [offer, context, config] of fixtures) {
      const { flags, unevaluable } = evaluateOffer(offer, context, config);
      expect(flags).not.toContain('packing');
      expect(unevaluable).not.toContain('packing');
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
    expect(flagsOf(cleanEconomicsDirtyFlags, BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual([]);
  });

  it('returns fresh arrays, never a reference to offer.flags', () => {
    const offer = makeOffer();
    const result = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(result.flags).not.toBe(offer.flags);
    expect(result.unevaluable).not.toBe(offer.flags);
    expect(result.unevaluable).not.toBe(result.flags);
  });

  it('is deterministic: two calls with equal inputs are deep-equal', () => {
    const a = evaluateOffer(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    const b = evaluateOffer(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(a).toEqual(b);
  });

  it('multi-flag results come back in OFFER_FLAGS order, duplicate-free (D7)', () => {
    const flags = flagsOf(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(flags).toEqual([...OFFER_FLAGS]);
    expect(new Set(flags).size).toBe(flags.length);
  });

  it('re-evaluation of an already-flagged offer is idempotent (redelivery-safe, design §4.1)', () => {
    const offer = makeEverythingWrongOffer();
    const first = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG);
    const reFlagged: Offer = { ...offer, flags: first.flags };
    const second = evaluateOffer(reFlagged, BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(second).toEqual(first);
  });
});

describe('combined fixtures (design §5)', () => {
  it('the "everything wrong" offer emits all four flags and nothing unevaluable', () => {
    expect(evaluateOffer(makeEverythingWrongOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual({
      flags: ['payment_packing', 'rate_markup', 'junk_fee', 'over_walkaway'],
      unevaluable: [],
    });
  });

  it('a clean offer emits no flags and nothing unevaluable', () => {
    expect(evaluateOffer(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG)).toEqual({
      flags: [],
      unevaluable: [],
    });
  });
});

describe('error paths — total function, never throws (design §4.1)', () => {
  it('NaN apr: no throw, rate_markup conservatively does not fire', () => {
    const offer = makeOffer({ apr: Number.NaN });
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG).flags;
    }).not.toThrow();
    expect(flags).not.toContain('rate_markup');
  });

  it('NaN sale_price: no throw, over_walkaway conservatively does not fire', () => {
    const offer = makeOffer({ sale_price: Number.NaN });
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG).flags;
    }).not.toThrow();
    expect(flags).not.toContain('over_walkaway');
  });

  it('NaN fee amount: no throw, junk_fee conservatively does not fire', () => {
    const offer = makeOffer({ fees: [{ name: 'doc fee', amount: Number.NaN }] });
    let flags: OfferFlag[] = [];
    expect(() => {
      flags = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG).flags;
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
      flags = evaluateOffer(offer, BENIGN_CONTEXT, FIXTURE_CONFIG).flags;
    }).not.toThrow();
    for (const flag of flags) {
      expect(OFFER_FLAGS).toContain(flag);
    }
  });

  it('malformed config (negative thresholds, empty caps): no throw, well-typed result out', () => {
    const malformed: FlagEngineConfig = {
      stretched_term_min_months: -1,
      rate_markup_tolerance_points: -10,
      fee_fair_caps: [],
    };
    let result: FlagEvaluation | undefined;
    expect(() => {
      result = evaluateOffer(makeOffer(), BENIGN_CONTEXT, malformed);
    }).not.toThrow();
    expect(Array.isArray(result?.flags)).toBe(true);
    expect(Array.isArray(result?.unevaluable)).toBe(true);
    for (const flag of [...(result?.flags ?? []), ...(result?.unevaluable ?? [])]) {
      expect(OFFER_FLAGS).toContain(flag);
    }
  });

  it('offer with every optional field absent and zero fees: no throw, deterministic result', () => {
    const bareOffer: Offer = { fees: [], flags: [] };
    const bareContext: FlagContext = { walk_away_number: 0 };
    expect(evaluateOffer(bareOffer, bareContext, FIXTURE_CONFIG)).toEqual({
      flags: [],
      unevaluable: ['payment_packing', 'rate_markup', 'over_walkaway'],
    });
  });
});

describe('structural posture (design §2, §4.2 — no I/O surface, sync, closed API)', () => {
  it('the public runtime surface is exactly { evaluateOffer }', () => {
    expect(Object.keys(flagEngineApi).sort()).toEqual(['evaluateOffer']);
    expect(typeof flagEngineApi.evaluateOffer).toBe('function');
  });

  it('evaluateOffer is synchronous — a plain Function returning a result object, never a Promise', () => {
    expect(evaluateOffer.constructor.name).toBe('Function'); // not AsyncFunction
    const result = evaluateOffer(makeOffer(), BENIGN_CONTEXT, FIXTURE_CONFIG);
    expect(Array.isArray(result.flags)).toBe(true);
    expect(Array.isArray(result.unevaluable)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
  });
});
