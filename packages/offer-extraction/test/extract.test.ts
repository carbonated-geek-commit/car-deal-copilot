/**
 * T-007 tester — unit suite (docs/design/T-007.md §2, §4, §5.1, §6).
 *
 * Covers the design's interfaces AND its error paths:
 *  - money parsing table (D6: cents-exactness, "23.5k", leading-zero/huge rejects)
 *  - term normalization (years → months, plausibility bounds, exclusions)
 *  - monthly/price disambiguation tokens and the D5 precision gate
 *  - APR bounds (0 < apr < 50) and down/discount/marketing exclusions
 *  - fee span claiming (a fee amount must never double as sale_price)
 *  - channel-agnostic single entry point (AC-3)
 *  - totality: never throws on hostile/garbled/huge input (D4), bounded time (§4.3)
 *  - determinism + fresh, non-mutating results (§4.3)
 *  - public surface is exactly one pure function — no webhook/ack/queue/storage
 *    surface can exist (design §5.2: seam safety by construction)
 *  - type-level: the emitted offer is a projection of the @core Offer, no
 *    parallel type (AC-2, D1 fallback)
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MoneyCents, Offer, OfferFee, OfferFlag } from '@core';
import * as api from '@offer-extraction';
import { extractOffer } from '@offer-extraction';
import type { ExtractedOffer, ExtractionInput, ExtractionResult } from '@offer-extraction';
import { parseAmountCents } from '../src/money';

const sms = (text: string): ExtractionInput => ({ channel: 'sms', text });

/** Unwrap the found arm or fail loudly. */
function expectFound(result: ExtractionResult): ExtractedOffer {
  if (!result.found) throw new Error('expected {found: true}, got {found: false}');
  return result.offer;
}

// ---------------------------------------------------------------------------
// Public surface (design §2 / §5.2 — seam safety by construction)
// ---------------------------------------------------------------------------

describe('public surface (design §2)', () => {
  it('exports exactly one runtime binding: extractOffer — no webhook/ack/queue/storage surface exists', () => {
    expect(Object.keys(api).sort()).toEqual(['extractOffer']);
    expect(typeof api.extractOffer).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Money conventions (D6)
// ---------------------------------------------------------------------------

describe('money parsing (D6 conventions)', () => {
  it('parses to exact integer cents', () => {
    expect(parseAmountCents('23,500', false)).toBe(2350000);
    expect(parseAmountCents('23.5', true)).toBe(2350000); // "23.5k"
    expect(parseAmountCents('450', false)).toBe(45000);
    expect(parseAmountCents('31,542.18', false)).toBe(3154218); // cents-exact
    expect(parseAmountCents('0.01', false)).toBe(1);
  });

  it('rejects zero, leading-zero id fragments, and implausibly huge amounts', () => {
    expect(parseAmountCents('0', false)).toBeUndefined();
    expect(parseAmountCents('0134', false)).toBeUndefined(); // phone/id fragment
    expect(parseAmountCents('20000', true)).toBeUndefined(); // $20M > $10M ceiling
  });

  it('"$23,500" with price context → sale_price 2350000 (public API)', () => {
    const offer = expectFound(extractOffer(sms('The price is $23,500 for this one.')));
    expect(offer).toStrictEqual({ fees: [], flags: [], sale_price: 2350000 });
  });

  it('"23.5k" shorthand with price context → sale_price 2350000', () => {
    const offer = expectFound(extractOffer(sms('They are asking 23.5k for it.')));
    expect(offer).toStrictEqual({ fees: [], flags: [], sale_price: 2350000 });
  });
});

// ---------------------------------------------------------------------------
// Term normalization (D6, design §4.2 bounds 12–120)
// ---------------------------------------------------------------------------

describe('term normalization (D6)', () => {
  it('"6 years" normalizes to 72 months', () => {
    const offer = expectFound(extractOffer(sms('Financing runs 6 years at 4.9% APR.')));
    expect(offer).toStrictEqual({ fees: [], flags: [], apr: 4.9, term_months: 72 });
  });

  it('"72 months" stays 72 (term-only partial passes the gate — AC-4)', () => {
    const offer = expectFound(extractOffer(sms('We can look at 72 months if that helps.')));
    expect(offer).toStrictEqual({ fees: [], flags: [], term_months: 72 });
  });

  it('warranty durations are not loan terms (D5)', () => {
    expect(extractOffer(sms('It comes with a 36 month warranty included.'))).toStrictEqual({
      found: false,
    });
  });

  it('elapsed time is not a loan term (D5)', () => {
    expect(extractOffer(sms('We serviced it for the last 24 months.'))).toStrictEqual({
      found: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Monthly vs price disambiguation (design §4.2, D5)
// ---------------------------------------------------------------------------

describe('monthly/price disambiguation (D5/D6)', () => {
  it('"$450/mo" → monthly, never sale_price', () => {
    const offer = expectFound(extractOffer(sms('$450/mo')));
    expect(offer).toStrictEqual({ fees: [], flags: [], monthly: 45000 });
  });

  it('bare "$450" with no periodicity context is omitted → no offer', () => {
    expect(extractOffer(sms('Okay $450 then.'))).toStrictEqual({ found: false });
  });

  it('"price is $12,000" → sale_price', () => {
    const offer = expectFound(extractOffer(sms('The price is $12,000 for this one.')));
    expect(offer).toStrictEqual({ fees: [], flags: [], sale_price: 1200000 });
  });

  it('"$12,000 down" is a down payment, not a price → no offer', () => {
    expect(extractOffer(sms('We would need $12,000 down to get there.'))).toStrictEqual({
      found: false,
    });
  });

  it('marketing teaser monthly ("as low as $199/mo") is omitted (precision stance)', () => {
    expect(extractOffer(sms('Payments as low as $199/mo on select models.'))).toStrictEqual({
      found: false,
    });
  });
});

// ---------------------------------------------------------------------------
// APR rule (design §4.2: 0 < apr < 50, context-gated)
// ---------------------------------------------------------------------------

describe('APR rule (design §4.2)', () => {
  it('percent with rate context → apr as a percent number (apr-only partial passes the gate)', () => {
    const offer = expectFound(extractOffer(sms('We could structure it at 5.9% APR.')));
    expect(offer).toStrictEqual({ fees: [], flags: [], apr: 5.9 });
  });

  it('"10% down" is not a rate → no offer', () => {
    expect(extractOffer(sms('We need 10% down to proceed.'))).toStrictEqual({ found: false });
  });

  it('out-of-bounds percent (55% APR) is omitted', () => {
    expect(extractOffer(sms('They quoted him 55% APR at the other store.'))).toStrictEqual({
      found: false,
    });
  });

  it('0% is outside the open bound (0 < apr) and omitted', () => {
    expect(extractOffer(sms('0% APR financing available on select models.'))).toStrictEqual({
      found: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Fees (design §4.2, D5, D6)
// ---------------------------------------------------------------------------

describe('fee rule (design §4.2)', () => {
  it('fee amounts claim their spans — a fee never doubles as sale_price', () => {
    const offer = expectFound(extractOffer(sms('Doc fee $899 on top of the $23,900 price.')));
    expect(offer).toStrictEqual({
      fees: [{ name: 'Doc fee', amount: 89900 }],
      flags: [],
      sale_price: 2390000,
    });
  });

  it('an unlabeled "fee" with no qualifier is rejected (D5)', () => {
    expect(extractOffer(sms('The fee is $500.'))).toStrictEqual({ found: false });
  });

  it('negated/waived fees are not charged fees', () => {
    expect(extractOffer(sms('There is no $299 doc fee at our store.'))).toStrictEqual({
      found: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Channel-agnostic entry point (AC-3)
// ---------------------------------------------------------------------------

describe('channel-agnostic entry point (AC-3)', () => {
  it('the same offer text extracts identically through call, sms, and email', () => {
    const text = 'We can do $23,500 out the door.';
    const byChannel = (['call', 'sms', 'email'] as const).map((channel) =>
      extractOffer({ channel, text }),
    );
    for (const result of byChannel) {
      expect(result).toStrictEqual({
        found: true,
        offer: { fees: [], flags: [], sale_price: 2350000 },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Totality & bounded time (D4, §4.3, error paths §5.1)
// ---------------------------------------------------------------------------

describe('totality — extractOffer never throws (D4)', () => {
  it('missing input entirely → {found: false}, no throw', () => {
    let result: ExtractionResult | undefined;
    expect(() => {
      result = extractOffer(undefined as never);
    }).not.toThrow();
    expect(result).toStrictEqual({ found: false });
  });

  it('non-string text → {found: false}, no throw', () => {
    let result: ExtractionResult | undefined;
    expect(() => {
      result = extractOffer({ channel: 'sms', text: 42 as never });
    }).not.toThrow();
    expect(result).toStrictEqual({ found: false });
  });

  it('unknown channel hint degrades to minimal normalization, never a throw or a drop', () => {
    const result = extractOffer({ channel: 'fax' as never, text: 'We can get you to $389/mo.' });
    expect(result).toStrictEqual({ found: true, offer: { fees: [], flags: [], monthly: 38900 } });
  });

  it('whitespace-only text → {found: false}', () => {
    expect(extractOffer(sms('   \n\t   '))).toStrictEqual({ found: false });
  });

  it('control/garbage characters → {found: false}, no throw', () => {
    let result: ExtractionResult | undefined;
    expect(() => {
      result = extractOffer(sms(' �[31m!!!###'));
    }).not.toThrow();
    expect(result).toStrictEqual({ found: false });
  });

  it('very large adversarial input stays under a wall-clock sanity budget (§4.3 — no ReDoS)', () => {
    const paragraph =
      'Thanks again for stopping by today, we appreciate you taking the time to walk the lot with us and talk through the options. ';
    const adversarial =
      '1,111,111,111,111,111,111,111 ' + '9'.repeat(200) + ' $$$$ 12.34.56.78 twenty or thirty ';
    let big = '';
    while (big.length < 300_000) big += paragraph + adversarial;

    for (const channel of ['sms', 'call', 'email'] as const) {
      const started = Date.now();
      let result: ExtractionResult | undefined;
      expect(() => {
        result = extractOffer({ channel, text: big });
      }).not.toThrow();
      const elapsed = Date.now() - started;
      expect(result).toBeDefined();
      expect(elapsed, `channel "${channel}" took ${elapsed}ms on ${big.length} chars`).toBeLessThan(
        2000,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism, freshness, non-mutation (§4.3)
// ---------------------------------------------------------------------------

describe('determinism & freshness (§4.3)', () => {
  it('same input → deeply-equal result, but always a fresh object graph', () => {
    const input = sms('Good news! We can get you to $389/mo. When can you come in?');
    const a = extractOffer(input);
    const b = extractOffer(input);
    expect(a).toStrictEqual(b);
    expect(a).not.toBe(b);
    const offerA = expectFound(a);
    const offerB = expectFound(b);
    expect(offerA).not.toBe(offerB);
    expect(offerA.fees).not.toBe(offerB.fees);
    expect(offerA.flags).not.toBe(offerB.flags);
  });

  it('input is read-only: a frozen input object works and is unchanged', () => {
    const frozen = Object.freeze({
      channel: 'sms',
      text: 'The price is $12,000 for this one.',
    }) as ExtractionInput;
    let result: ExtractionResult | undefined;
    expect(() => {
      result = extractOffer(frozen);
    }).not.toThrow();
    expect(result).toStrictEqual({
      found: true,
      offer: { fees: [], flags: [], sale_price: 1200000 },
    });
    expect(frozen.text).toBe('The price is $12,000 for this one.');
    expect(frozen.channel).toBe('sms');
  });
});

// ---------------------------------------------------------------------------
// Type-level: spine referenced, never redefined (AC-2, D1 fallback, D3)
// ---------------------------------------------------------------------------

describe('type-level — no parallel offer type (AC-2, D1 resolved by ADR-005)', () => {
  it('ExtractedOffer IS the @core Offer (ADR-005 collapse): identical type, identical fields', () => {
    expectTypeOf<ExtractedOffer>().toEqualTypeOf<Offer>();
    expectTypeOf<keyof ExtractedOffer>().toEqualTypeOf<keyof Offer>();
    expectTypeOf<ExtractedOffer['fees']>().toEqualTypeOf<OfferFee[]>();
    expectTypeOf<ExtractedOffer['flags']>().toEqualTypeOf<OfferFlag[]>();
    expectTypeOf<ExtractedOffer['apr']>().toEqualTypeOf<Offer['apr']>();
    expectTypeOf<ExtractedOffer['term_months']>().toEqualTypeOf<Offer['term_months']>();
    expectTypeOf<ExtractedOffer['monthly']>().toEqualTypeOf<Offer['monthly']>();
    expectTypeOf<ExtractedOffer['sale_price']>().toEqualTypeOf<MoneyCents | undefined>();
  });

  it('a canonical Offer is accepted where ExtractedOffer is expected, and vice versa (attachable to Message.extracted_offer unchanged — ADR-005)', () => {
    const fromOffer: ExtractedOffer = {} as Offer;
    const toOffer: Offer = {} as ExtractedOffer;
    expect(fromOffer).toBeDefined();
    expect(toOffer).toBeDefined();
  });

  it('result narrows on the found discriminant (D2)', () => {
    const result = extractOffer(sms('$389/mo works for us'));
    if (result.found) {
      expectTypeOf(result.offer).toEqualTypeOf<ExtractedOffer>();
      expect(result.offer.flags).toEqual([]); // D3
    } else {
      throw new Error('expected a found result for a monthly-quoting text');
    }
  });
});
