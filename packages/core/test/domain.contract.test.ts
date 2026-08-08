/**
 * T-001 tester — spine domain type contracts (docs/design/T-001.md §2, §6).
 *
 * AC-1: Deal/DealerThread/Message/Offer field-for-field per specs/00.
 * AC-2: ValuationSnapshot/VehicleData cached + timestamped.
 * AC-3: identity_ref provider-agnostic (no provisioner field).
 * ADR-002: `payment_packing` canonical; `packing` must not exist.
 * D2: no extra required fields (no synthetic Message.id / Offer.id).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  OFFER_FLAGS,
  type Deal,
  type DealPath,
  type DealStatus,
  type DealerContact,
  type DealerThread,
  type IdentityRef,
  type IsoTimestamp,
  type Message,
  type MessageChannel,
  type MessageDirection,
  type MoneyCents,
  type Offer,
  type OfferFee,
  type OfferFlag,
  type ValuationSnapshot,
  type VehicleData,
  type VehicleSpec,
  type Vin,
} from '@core';

const T0: IsoTimestamp = '2026-08-07T12:00:00Z';

describe('spine enums (spec-fixed)', () => {
  it('DealPath / DealStatus / MessageChannel / MessageDirection are exactly the spec unions', () => {
    expectTypeOf<DealPath>().toEqualTypeOf<'online' | 'hybrid' | 'in_person'>();
    expectTypeOf<DealStatus>().toEqualTypeOf<
      'draft' | 'active' | 'negotiating' | 'closed' | 'burned'
    >();
    expectTypeOf<MessageChannel>().toEqualTypeOf<'call' | 'sms' | 'email'>();
    expectTypeOf<MessageDirection>().toEqualTypeOf<'in' | 'out'>();
  });

  it('OfferFlag is exactly the ADR-002 vocabulary (payment_packing canonical)', () => {
    expectTypeOf<OfferFlag>().toEqualTypeOf<
      'payment_packing' | 'rate_markup' | 'junk_fee' | 'over_walkaway'
    >();
    // @ts-expect-error — ADR-002: the spec's shorthand 'packing' is NOT a legal flag value
    const bad: OfferFlag = 'packing';
    void bad;
  });

  it('OFFER_FLAGS runtime const carries the full canonical vocabulary and nothing else', () => {
    expect([...OFFER_FLAGS].sort()).toEqual([
      'junk_fee',
      'over_walkaway',
      'payment_packing',
      'rate_markup',
    ]);
    expect(OFFER_FLAGS).toContain('payment_packing');
    expect(OFFER_FLAGS).not.toContain('packing');
  });

  it('OFFER_FLAGS is readonly at the type level', () => {
    expectTypeOf(OFFER_FLAGS).toEqualTypeOf<readonly OfferFlag[]>();
    // Never executed — compile-time assertion only.
    const _typeOnly = (flags: typeof OFFER_FLAGS) => {
      // @ts-expect-error — readonly array exposes no mutator
      flags.push('junk_fee');
    };
    void _typeOnly;
  });
});

describe('Deal (aggregate root) — AC-1 field-for-field', () => {
  it('has exactly the spec field list, no extras (D2)', () => {
    expectTypeOf<keyof Deal>().toEqualTypeOf<
      | 'id'
      | 'owner_id'
      | 'path'
      | 'status'
      | 'target_vehicle'
      | 'resolved_vehicle'
      | 'budget'
      | 'walk_away_number'
      | 'identity_ref'
      | 'dealer_threads'
      | 'offers'
      | 'receipt_bundle_id'
      | 'created_at'
      | 'burned_at'
    >();
  });

  it('accepts a fully-populated literal', () => {
    const deal = {
      id: 'deal-1',
      owner_id: 'user-1',
      path: 'hybrid',
      status: 'negotiating',
      target_vehicle: { make: 'Toyota', model: 'RAV4', year: 2023, trim: 'XLE' },
      resolved_vehicle: '4T3ZWRFVXNU090000',
      budget: 3_200_000,
      walk_away_number: 3_000_000,
      identity_ref: {
        identity_id: 'ident-1',
        phone_number: '+15550001111',
        email_alias: 'deal-1@relay.example',
      },
      dealer_threads: [],
      offers: [],
      receipt_bundle_id: 'rb-1',
      created_at: T0,
      burned_at: '2026-08-08T12:00:00Z',
    } satisfies Deal;
    expect(deal.walk_away_number).toBeLessThan(deal.budget);
  });

  it('accepts the minimal pre-contact shape: identity_ref absent until first dealer contact (lazy provisioning)', () => {
    const draft: Deal = {
      id: 'deal-2',
      owner_id: 'user-1',
      path: 'online',
      status: 'draft',
      target_vehicle: { make: 'Honda', model: 'Civic' },
      budget: 2_500_000,
      walk_away_number: 2_400_000,
      dealer_threads: [],
      offers: [],
      created_at: T0,
    };
    expect(draft.identity_ref).toBeUndefined();
    expect(draft.resolved_vehicle).toBeUndefined();
    expect(draft.burned_at).toBeUndefined();
  });

  it('money fields are MoneyCents (integer-cents convention), timestamps are IsoTimestamp', () => {
    expectTypeOf<Deal['budget']>().toEqualTypeOf<MoneyCents>();
    expectTypeOf<Deal['walk_away_number']>().toEqualTypeOf<MoneyCents>();
    expectTypeOf<Deal['created_at']>().toEqualTypeOf<IsoTimestamp>();
    expectTypeOf<Deal['resolved_vehicle']>().toEqualTypeOf<Vin | undefined>();
  });
});

describe('DealerThread / DealerContact — AC-1', () => {
  it('DealerThread has exactly the spec fields', () => {
    expectTypeOf<keyof DealerThread>().toEqualTypeOf<
      'dealer_id' | 'dealer_name' | 'contact' | 'messages' | 'current_offer'
    >();
    expectTypeOf<keyof DealerContact>().toEqualTypeOf<'phone' | 'email' | 'address'>();
  });

  it('accepts a thread literal with messages and a current offer', () => {
    const offer = {
      sale_price: 2_950_000,
      fees: [{ name: 'doc fee', amount: 59_900 }],
      apr: 6.9,
      term_months: 60,
      monthly: 58_400,
      flags: ['junk_fee'],
    } satisfies Offer;
    const thread = {
      dealer_id: 'dlr-1',
      dealer_name: 'Sunrise Toyota',
      contact: { phone: '+15559990000', email: 'sales@sunrise.example' },
      messages: [
        {
          channel: 'sms',
          direction: 'in',
          body: 'Out the door 29,500',
          timestamp: T0,
          extracted_offer: offer,
        },
      ],
      current_offer: offer,
    } satisfies DealerThread;
    expect(thread.messages).toHaveLength(1);
  });
});

describe('Message — AC-1 (channel/direction/body|recording_url|transcript/timestamp/extracted_offer?)', () => {
  it('has exactly the spec fields — no synthetic Message.id (D2)', () => {
    expectTypeOf<keyof Message>().toEqualTypeOf<
      | 'channel'
      | 'direction'
      | 'body'
      | 'recording_url'
      | 'transcript'
      | 'timestamp'
      | 'extracted_offer'
    >();
  });

  it('accepts recording_url: null (consumer transcribe-only posture, specs/01)', () => {
    const call = {
      channel: 'call',
      direction: 'in',
      recording_url: null,
      transcript: 'dealer quoted 29,500 out the door',
      timestamp: T0,
    } satisfies Message;
    expect(call.recording_url).toBeNull();
    expectTypeOf<Message['recording_url']>().toEqualTypeOf<string | null | undefined>();
  });

  it('accepts a bodied SMS with no call fields', () => {
    const sms = {
      channel: 'sms',
      direction: 'out',
      body: 'Can you do 28,000?',
      timestamp: T0,
    } satisfies Message;
    expect(sms.body).toBe('Can you do 28,000?');
  });
});

describe('Offer / OfferFee — AC-1', () => {
  it('has exactly the spec fields — no synthetic Offer.id (D2)', () => {
    expectTypeOf<keyof Offer>().toEqualTypeOf<
      'sale_price' | 'fees' | 'apr' | 'term_months' | 'monthly' | 'flags'
    >();
    expectTypeOf<keyof OfferFee>().toEqualTypeOf<'name' | 'amount'>();
  });

  it('accepts a cash offer (no apr/term/monthly) with empty flags', () => {
    const cash: Offer = {
      sale_price: 2_800_000,
      fees: [],
      flags: [],
    };
    expect(cash.apr).toBeUndefined();
    expectTypeOf<Offer['flags']>().toEqualTypeOf<OfferFlag[]>();
  });
});

describe('IdentityRef — AC-3 provider-agnostic by construction', () => {
  it('has exactly identity_id + phone_number? + email_alias? and nothing else', () => {
    expectTypeOf<keyof IdentityRef>().toEqualTypeOf<
      'identity_id' | 'phone_number' | 'email_alias'
    >();
  });

  it('has no provider / provisioner / vendor style field at any key', () => {
    type Forbidden = Extract<
      keyof IdentityRef,
      | 'provider'
      | 'provider_id'
      | 'provisioner'
      | 'vendor'
      | 'carrier'
      | 'twilio_sid'
      | 'account_sid'
    >;
    expectTypeOf<Forbidden>().toEqualTypeOf<never>();
    const ref: IdentityRef = {
      identity_id: 'ident-9',
      // @ts-expect-error — encoding who provisioned the identity is forbidden (specs/00)
      provider: 'twilio',
    };
    void ref;
  });
});

describe('ValuationSnapshot / VehicleData — AC-2 cached, timestamped', () => {
  it('both carry fetched_at: IsoTimestamp', () => {
    expectTypeOf<ValuationSnapshot['fetched_at']>().toEqualTypeOf<IsoTimestamp>();
    expectTypeOf<VehicleData['fetched_at']>().toEqualTypeOf<IsoTimestamp>();
  });

  it('ValuationSnapshot accepts spec-vehicle or VIN, the four value bands, and provenance source', () => {
    const bySpec = {
      vehicle: { make: 'Toyota', model: 'RAV4', year: 2023 } satisfies VehicleSpec,
      mileage: 24_000,
      values: {
        wholesale: 2_500_000,
        trade_in: 2_600_000,
        retail: 2_900_000,
        private_party: 2_750_000,
      },
      source: 'mock-kbb',
      fetched_at: T0,
    } satisfies ValuationSnapshot;
    const byVin = {
      vehicle: { vin: '4T3ZWRFVXNU090000' },
      values: { wholesale: 2_450_000 },
      source: 'mock-manheim',
      fetched_at: T0,
    } satisfies ValuationSnapshot;
    expect(bySpec.values.retail).toBeGreaterThan(byVin.values.wholesale!);
    expectTypeOf<keyof ValuationSnapshot['values']>().toEqualTypeOf<
      'wholesale' | 'trade_in' | 'retail' | 'private_party'
    >();
  });

  it('VehicleData composes decode + recalls + optional history, all timestamped', () => {
    const vd = {
      vin: '4T3ZWRFVXNU090000',
      decode: {
        vin: '4T3ZWRFVXNU090000',
        make: 'Toyota',
        model: 'RAV4',
        year: 2022,
        body_class: 'SUV',
      },
      recalls: [
        {
          campaign_id: '22V123000',
          component: 'FUEL SYSTEM',
          summary: 'Fuel pump may fail',
          issued_at: T0,
        },
      ],
      history: {
        vin: '4T3ZWRFVXNU090000',
        accident_count: 0,
        title_brands: [],
        source: 'mock-carfax',
        fetched_at: T0,
      },
      fetched_at: T0,
    } satisfies VehicleData;
    expect(vd.history?.title_brands).toEqual([]); // empty = clean title
    expect(vd.recalls[0]?.campaign_id).toBe('22V123000');
  });
});
