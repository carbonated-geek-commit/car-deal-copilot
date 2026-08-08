/**
 * T-010 tester — behaviors the v0.5 contracts must FORCE, derived from design
 * rows that the first pass left unexercised (docs/design/T-010.md §2.5, §4.3,
 * §5.3, §7 builder note).
 *
 * ADR-006  `current_offer` is a PER-FIELD newest-wins rollup: a later
 *          monthly/term-only quote must not erase an earlier stated sale_price
 *          (§5.3 row "text states monthly/term only … merged per-field into
 *          current_offer"). Whole-offer replacement would silently destroy a
 *          stated price and hand ADR-005 a false "unevaluable".
 * Q20/§4.3 Budget ceiling and fair price are two DIFFERENT questions with two
 *          different inputs. Neither verdict may be substituted for, or inferred
 *          from, the other — including when only one of them is evaluable.
 * ADR-007  `above_market` compares against the RETAIL band and only retail:
 *          wholesale / trade_in / private_party must not move the verdict.
 * §7 note  `exactOptionalPropertyTypes` is what makes "absence is typed as
 *          absence" (I-4) real: an optional field must be OMITTED, never set to
 *          `undefined`. If that compiler flag were relaxed, the honesty
 *          guarantee would quietly weaken — these assertions fail first.
 * §5.3     A retryable consumer failure that succeeds on redelivery must produce
 *          exactly one side effect and no dead-letter (the first pass covered
 *          only the poison/exhausted path).
 *
 * Type-level assertions here are load-bearing via typecheck.test.ts, which runs
 * `tsc -p packages/core --noEmit` over src AND test.
 */
import { describe, expect, it } from 'vitest';
import { isTargetVehicleLocked } from '@core';
import type {
  Deal,
  DealerThread,
  Message,
  Offer,
  ValuationSnapshot,
  VehicleInstance,
} from '@core';

const T = (h: number) => `2026-08-07T${String(h).padStart(2, '0')}:00:00Z`;

const makeDeal = (over: Partial<Deal> = {}): Deal => ({
  id: 'deal-1',
  owner_id: 'user-1',
  path: 'hybrid',
  status: 'draft',
  target_vehicle: { make: 'Toyota', model: 'RAV4' },
  budget: 3_200_000,
  walk_away_number: 3_000_000,
  dealer_threads: [],
  offers: [],
  created_at: T(12),
  ...over,
});

// --------------------------------------------------------- ADR-006 rollup

/**
 * Per-field newest-message-wins accumulation over a thread's message history.
 * Built ONLY on @core contracts: the spine exports no rollup helper (it exports
 * no mutators at all, I-8), so this is the shape ADR-006 obliges T-020 to
 * implement — and the shape the types must make expressible.
 */
const rollupCurrentOffer = (messages: Message[]): Offer | undefined => {
  let current: Offer | undefined;
  for (const m of messages) {
    const next = m.extracted_offer;
    if (next === undefined) continue;
    if (current === undefined) {
      current = { ...next };
      continue;
    }
    current = {
      ...current,
      // arrays are always present on an Offer: newest statement wins wholesale
      fees: next.fees,
      flags: next.flags,
      // optional scalars: a newer message that is SILENT on a field does not
      // erase it — only a newer STATEMENT overrides.
      ...(next.sale_price !== undefined ? { sale_price: next.sale_price } : {}),
      ...(next.apr !== undefined ? { apr: next.apr } : {}),
      ...(next.term_months !== undefined ? { term_months: next.term_months } : {}),
      ...(next.monthly !== undefined ? { monthly: next.monthly } : {}),
    };
  }
  return current;
};

const dealerMsg = (hour: number, extracted_offer: Offer, body: string): Message => ({
  channel: 'sms',
  direction: 'in',
  author: 'dealer',
  body,
  timestamp: T(hour),
  extracted_offer,
});

describe('ADR-006 — current_offer accumulates PER FIELD; silence never erases a stated fact', () => {
  it('a later monthly/term-only quote keeps the earlier stated sale_price', () => {
    const messages = [
      dealerMsg(12, { sale_price: 2_950_000, fees: [{ name: 'doc fee', amount: 59_900 }], flags: [] },
        '29,500 plus a 599 doc fee'),
      dealerMsg(13, { fees: [], monthly: 61_900, term_months: 84, flags: [] },
        'We can get you to 619 a month for 84'),
    ];
    const current = rollupCurrentOffer(messages);
    expect(current?.sale_price).toBe(2_950_000); // survived the silent message
    expect(current?.monthly).toBe(61_900);
    expect(current?.term_months).toBe(84);
    // the failure this guards against, stated explicitly:
    expect(current?.sale_price).not.toBeUndefined();
    expect(current?.sale_price).not.toBe(0);
  });

  it('whole-offer replacement would destroy the price — the rollup must not degrade to it', () => {
    const messages = [
      dealerMsg(12, { sale_price: 2_950_000, fees: [], flags: [] }, '29,500'),
      dealerMsg(13, { fees: [], monthly: 61_900, flags: [] }, '619 a month'),
    ];
    const naiveNewestWholeOffer = messages.filter((m) => m.extracted_offer).at(-1)?.extracted_offer;
    expect(naiveNewestWholeOffer?.sale_price).toBeUndefined(); // the bug…
    expect(rollupCurrentOffer(messages)?.sale_price).toBe(2_950_000); // …not the contract
  });

  it('a newer STATEMENT of the same field does override (newest-wins, not first-wins)', () => {
    const messages = [
      dealerMsg(12, { sale_price: 2_950_000, fees: [], apr: 8.9, flags: ['rate_markup'] }, '29,500'),
      dealerMsg(13, { sale_price: 2_990_000, fees: [], flags: [] }, 'Sorry — 29,900'),
    ];
    const current = rollupCurrentOffer(messages);
    expect(current?.sale_price).toBe(2_990_000);
    expect(current?.apr).toBe(8.9); // untouched by a message that did not mention APR
    expect(current?.flags).toEqual([]); // newest statement's flag set
  });

  it('the rollup never invents an offer: a thread with no extracted offer has none', () => {
    const chatter: Message[] = [
      { channel: 'sms', direction: 'in', author: 'dealer', body: 'Come on in!', timestamp: T(12) },
      { channel: 'note', direction: 'internal', author: 'buyer', body: 'no numbers yet', timestamp: T(13) },
    ];
    expect(rollupCurrentOffer(chatter)).toBeUndefined();
  });

  it('write-once coupling: the anchor locks on the ROLLED-UP offer, so rollup precedes acceptance', () => {
    // isTargetVehicleLocked reads `current_offer`, not message-level extractions.
    // ADR-006 is therefore load-bearing for AC-4: T-020 must roll up as part of
    // accepting an offer, or a priced deal would stay unlocked.
    const messages = [dealerMsg(12, { sale_price: 2_950_000, fees: [], flags: [] }, '29,500')];
    const unrolled: DealerThread = {
      dealership_id: 'dlr-1',
      process_step: 'deal_negotiation',
      messages,
    };
    expect(isTargetVehicleLocked(makeDeal({ dealer_threads: [unrolled] }))).toBe(false);

    const rolled: DealerThread = { ...unrolled, current_offer: rollupCurrentOffer(messages)! };
    expect(isTargetVehicleLocked(makeDeal({ dealer_threads: [rolled] }))).toBe(true);
  });
});

// ------------------------------------------- Q20 / §4.3 — two questions

type BudgetVerdict = 'unevaluable' | 'over_walkaway' | 'within_budget';
type MarketVerdict = 'unevaluable' | 'above_market' | 'at_or_below_market';

/** "Can I afford it?" — deal-level ceiling vs the offer's out-the-door total. */
const budgetVerdict = (deal: Deal, offer: Offer | undefined): BudgetVerdict => {
  if (offer?.sale_price === undefined) return 'unevaluable';
  const otd = offer.sale_price + offer.fees.reduce((s, f) => s + f.amount, 0);
  return otd > deal.walk_away_number ? 'over_walkaway' : 'within_budget';
};

/** "Is this a good price?" — THIS instance's retail band vs the sale price (ADR-007). */
const marketVerdict = (
  snapshot: ValuationSnapshot | undefined,
  offer: Offer | undefined,
): MarketVerdict => {
  if (snapshot?.retail === undefined || offer?.sale_price === undefined) return 'unevaluable';
  return offer.sale_price > snapshot.retail ? 'above_market' : 'at_or_below_market';
};

describe('Q20 / §4.3 — budget ceiling and fair price are independent verdicts', () => {
  const deal = makeDeal({ walk_away_number: 3_000_000 });
  const snapshot: ValuationSnapshot = {
    vehicle_instance_id: 'vi-1',
    retail: 2_900_000,
    source: 'mock-kbb',
    captured_at: T(12),
  };

  it('within budget but ABOVE market — affordability must not be read as a good price', () => {
    const offer: Offer = { sale_price: 2_950_000, fees: [], flags: [] };
    expect(budgetVerdict(deal, offer)).toBe('within_budget');
    expect(marketVerdict(snapshot, offer)).toBe('above_market');
  });

  it('over walkaway but AT/BELOW market — a fair price is not automatically affordable', () => {
    const offer: Offer = {
      sale_price: 2_890_000,
      fees: [{ name: 'dealer prep', amount: 200_000 }],
      flags: [],
    };
    expect(budgetVerdict(deal, offer)).toBe('over_walkaway');
    expect(marketVerdict(snapshot, offer)).toBe('at_or_below_market');
  });

  it('D4 — a thread with no instance has no snapshot: market UNEVALUABLE while budget still answers', () => {
    const early: DealerThread = {
      dealership_id: 'dlr-1',
      process_step: 'information_gather',
      messages: [],
      current_offer: { sale_price: 2_800_000, fees: [], flags: [] },
    };
    expect(early.vehicle_instance).toBeUndefined();
    expect(marketVerdict(undefined, early.current_offer)).toBe('unevaluable');
    expect(marketVerdict(undefined, early.current_offer)).not.toBe('at_or_below_market');
    expect(budgetVerdict(deal, early.current_offer)).toBe('within_budget');
  });

  it('ADR-005 — a price-less offer leaves BOTH questions unevaluable, neither one passing', () => {
    const priceless: Offer = { fees: [], monthly: 61_900, term_months: 84, flags: [] };
    expect(budgetVerdict(deal, priceless)).toBe('unevaluable');
    expect(marketVerdict(snapshot, priceless)).toBe('unevaluable');
    expect(budgetVerdict(deal, priceless)).not.toBe('within_budget');
    expect(marketVerdict(snapshot, priceless)).not.toBe('at_or_below_market');
  });

  it('the two inputs live in different places and cannot be swapped', () => {
    // walk_away_number is on the Deal; the band is on a snapshot keyed by instance.
    expect(Object.keys(deal)).toContain('walk_away_number');
    expect(Object.keys(snapshot)).not.toContain('walk_away_number');
    expect(Object.keys(snapshot)).toContain('vehicle_instance_id');
    expect(Object.keys(deal)).not.toContain('retail');
  });
});

describe('ADR-007 — above_market compares to the RETAIL band and only retail', () => {
  const offer: Offer = { sale_price: 2_950_000, fees: [], flags: [] };
  const bands = { wholesale: 2_450_000, trade_in: 2_600_000, private_party: 3_100_000 };

  it('a sale price above retail is above_market even when below private_party', () => {
    const snapshot: ValuationSnapshot = {
      vehicle_instance_id: 'vi-1',
      ...bands,
      retail: 2_900_000,
      source: 'mock-kbb',
      captured_at: T(12),
    };
    expect(offer.sale_price!).toBeLessThan(snapshot.private_party!);
    expect(marketVerdict(snapshot, offer)).toBe('above_market');
  });

  it('moving ONLY the retail band flips the verdict; the other three do not', () => {
    const withRetail = (retail: number): ValuationSnapshot => ({
      vehicle_instance_id: 'vi-1',
      ...bands,
      retail,
      source: 'mock-kbb',
      captured_at: T(12),
    });
    expect(marketVerdict(withRetail(2_900_000), offer)).toBe('above_market');
    expect(marketVerdict(withRetail(3_000_000), offer)).toBe('at_or_below_market');
    // the non-retail bands were identical in both calls — they carry no verdict weight
  });

  it('a snapshot rich in other bands but missing retail is UNEVALUABLE, never a pass', () => {
    const noRetail: ValuationSnapshot = {
      vehicle_instance_id: 'vi-1',
      ...bands,
      source: 'mock-manheim',
      captured_at: T(12),
    };
    expect(noRetail.wholesale).toBeDefined();
    expect(marketVerdict(noRetail, offer)).toBe('unevaluable');
    expect(marketVerdict(noRetail, offer)).not.toBe('at_or_below_market');
  });
});

// ------------------------------ I-4 / §7 — absence is OMISSION, not `undefined`

describe('I-4 — exactOptionalPropertyTypes keeps "absent" distinct from "explicitly nothing"', () => {
  it('an optional field may not be set to undefined on VehicleInstance', () => {
    const omitted: VehicleInstance = { id: 'vi-1', year: 2026, condition: 'new', additions: [] };
    expect('vin' in omitted).toBe(false); // absent means the key is not there at all
    // @ts-expect-error — absence is omission; writing `undefined` fabricates a stated
    // blank. (exactOptionalPropertyTypes reports TS2375 at the declaration site.)
    const explicit: VehicleInstance = {
      id: 'vi-2',
      year: 2026,
      condition: 'new',
      additions: [],
      vin: undefined,
    };
    void explicit;
  });

  it('an offer with no stated price OMITS sale_price — it does not carry an undefined one', () => {
    const stated: Offer = { fees: [], flags: [] };
    expect('sale_price' in stated).toBe(false);
    // @ts-expect-error — ADR-005: "the dealer did not state a price" is an absent key
    const blanked: Offer = {
      fees: [],
      flags: [],
      sale_price: undefined,
    };
    void blanked;
  });

  it('a pre-instance thread OMITS vehicle_instance and working_with (D4, nothing fabricated)', () => {
    const thread: DealerThread = {
      dealership_id: 'dlr-1',
      process_step: 'information_gather',
      messages: [],
    };
    expect('vehicle_instance' in thread).toBe(false);
    expect('working_with' in thread).toBe(false);
    // @ts-expect-error — an unknown car is an omitted key, not a stated blank
    const fabricated: DealerThread = {
      dealership_id: 'dlr-2',
      process_step: 'information_gather',
      messages: [],
      vehicle_instance: undefined,
    };
    void fabricated;
  });
});

// --------------------------------- §5.3 — retryable consumer failure recovers

describe('§5.3 — a retryable consumer failure redelivers, succeeds, and lands exactly one effect', () => {
  it('transient failure then success: bounded attempts, one side effect, no dead-letter', () => {
    const IDEMPOTENCY_KEY = 'd1:SM123:completed';
    const MAX_ATTEMPTS = 3;
    const applied: string[] = [];
    const deadLetter: string[] = [];
    const processed = new Set<string>();

    let attempts = 0;
    let failuresRemaining = 1; // one transient blip (bus/DB hiccup), then healthy
    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      try {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error('transient downstream failure');
        }
        if (!processed.has(IDEMPOTENCY_KEY)) {
          processed.add(IDEMPOTENCY_KEY);
          applied.push(IDEMPOTENCY_KEY);
        }
        break; // succeeded — stop retrying
      } catch {
        if (attempts === MAX_ATTEMPTS) deadLetter.push(IDEMPOTENCY_KEY);
      }
    }

    expect(attempts).toBe(2); // recovered inside the bound
    expect(applied).toEqual([IDEMPOTENCY_KEY]); // exactly one effect
    expect(deadLetter).toEqual([]); // recovery is not a dead-letter
  });

  it('a redelivery arriving AFTER success is absorbed by the idempotency key, not re-applied', () => {
    const processed = new Set<string>();
    let effects = 0;
    for (const key of ['d1:SM123:completed', 'd1:SM123:completed']) {
      if (processed.has(key)) continue;
      processed.add(key);
      effects += 1;
    }
    expect(effects).toBe(1);
  });
});
