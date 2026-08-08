/**
 * T-010 tester — v0.5 spine domain contracts (docs/design/T-010.md §2, §1, §6).
 *
 * AC-1  VehicleTarget exists; VehicleSpec is gone.
 * AC-2  VehicleInstance carries a declared key + the priceable attributes.
 * AC-3  Deal.target_vehicle is a VehicleTarget; resolved_vehicle is absent.
 * AC-5  Dealership is GLOBAL — no account/owner field, no staff[].
 * AC-6  DealershipContact is account-PRIVATE — no id, no account field.
 * AC-7  DealerThread v0.5 fields; the Epic-1 dealer_id/dealer_name/contact shape is gone.
 * AC-8  Message is the ratified shape (channel +note, direction +internal, author, call_meta?).
 * AC-9  Message.recording_url / .transcript do not exist — absent, not nullable.
 * AC-10 ValuationSnapshot / VehicleData bind to vehicle_instance_id.
 * AC-11 Five flags incl. above_market; payment_packing canonical (ADR-002/ADR-007).
 * AC-12 Offer.sale_price optional; missing input ⇒ UNEVALUABLE, never zero (ADR-005).
 * AC-15 identity_ref stays provider-agnostic.
 *
 * NOTE: `@ts-expect-error` and `expectTypeOf` assertions are erased at runtime.
 * `typecheck.test.ts` runs `tsc -p packages/core --noEmit` inside the suite so
 * every type-level assertion in this file is load-bearing, not decorative.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DEALERSHIP_CONTACT_ROLES,
  MESSAGE_AUTHORS,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  OFFER_FLAGS,
  PROCESS_STEPS,
  VEHICLE_CONDITIONS,
  isTargetVehicleLocked,
  type CallMeta,
  type Deal,
  type DealPath,
  type DealStatus,
  type DealerThread,
  type Dealership,
  type DealershipContact,
  type DealershipContactRole,
  type IdentityRef,
  type IsoTimestamp,
  type Message,
  type MessageAuthor,
  type MessageChannel,
  type MessageDirection,
  type MoneyCents,
  type Offer,
  type OfferFee,
  type OfferFlag,
  type ProcessStep,
  type ValuationSnapshot,
  type VehicleCondition,
  type VehicleData,
  type VehicleInstance,
  type VehicleTarget,
  type VehicleTargetDraft,
  type Vin,
  type YearRange,
} from '@core';

const T0: IsoTimestamp = '2026-08-07T12:00:00Z';

// ------------------------------------------------------------------ fixtures

const instance: VehicleInstance = {
  id: 'vi-1',
  vin: '4T3ZWRFVXNU090000',
  year: 2023,
  trim: 'XLE',
  mileage: 24_000,
  condition: 'used',
  additions: ['roof rack', 'all-weather mats'],
};

const contact: DealershipContact = {
  name: 'Dana Reyes',
  role: 'sales_manager',
  phone: '+15559990000',
};

const offer: Offer = {
  sale_price: 2_950_000,
  fees: [{ name: 'doc fee', amount: 59_900 }],
  apr: 6.9,
  term_months: 60,
  monthly: 58_400,
  flags: ['junk_fee'],
};

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
  created_at: T0,
  ...over,
});

// ------------------------------------------------------------ enums / vocab

describe('spine enums — v0.5 vocabularies (spec-fixed)', () => {
  it('DealPath / DealStatus are unchanged by the migration', () => {
    expectTypeOf<DealPath>().toEqualTypeOf<'online' | 'hybrid' | 'in_person'>();
    expectTypeOf<DealStatus>().toEqualTypeOf<
      'draft' | 'active' | 'negotiating' | 'closed' | 'burned'
    >();
  });

  it('AC-8 — MessageChannel gains `note`, MessageDirection gains `internal`, MessageAuthor exists', () => {
    expectTypeOf<MessageChannel>().toEqualTypeOf<'call' | 'sms' | 'email' | 'note'>();
    expectTypeOf<MessageDirection>().toEqualTypeOf<'in' | 'out' | 'internal'>();
    expectTypeOf<MessageAuthor>().toEqualTypeOf<'dealer' | 'buyer' | 'concierge'>();
  });

  it('VehicleCondition / DealershipContactRole / ProcessStep are exactly the spec unions', () => {
    expectTypeOf<VehicleCondition>().toEqualTypeOf<'new' | 'used' | 'certified'>();
    expectTypeOf<DealershipContactRole>().toEqualTypeOf<
      'general_manager' | 'sales_manager' | 'finance_manager' | 'sales_agent'
    >();
    expectTypeOf<ProcessStep>().toEqualTypeOf<
      | 'information_gather'
      | 'deal_negotiation'
      | 'deal_approval'
      | 'financing'
      | 'final_sale'
      | 'pickup'
    >();
  });

  it('AC-11 — OfferFlag is exactly the five-flag vocabulary; payment_packing canonical (ADR-002)', () => {
    expectTypeOf<OfferFlag>().toEqualTypeOf<
      'payment_packing' | 'rate_markup' | 'junk_fee' | 'over_walkaway' | 'above_market'
    >();
    // @ts-expect-error — ADR-002: the spec's shorthand 'packing' is NOT a legal flag value
    const shorthand: OfferFlag = 'packing';
    void shorthand;
    // @ts-expect-error — a sixth invented flag is not in the vocabulary
    const invented: OfferFlag = 'below_market';
    void invented;
  });

  it('AC-11 — OFFER_FLAGS carries all five names and nothing else', () => {
    expect([...OFFER_FLAGS].sort()).toEqual([
      'above_market',
      'junk_fee',
      'over_walkaway',
      'payment_packing',
      'rate_markup',
    ]);
    expect(OFFER_FLAGS).toContain('above_market');
    expect(OFFER_FLAGS).not.toContain('packing');
  });

  it('D13 — every enum has exactly one shared readonly vocabulary array, membership-exact', () => {
    expect([...MESSAGE_CHANNELS].sort()).toEqual(['call', 'email', 'note', 'sms']);
    expect([...MESSAGE_DIRECTIONS].sort()).toEqual(['in', 'internal', 'out']);
    expect([...MESSAGE_AUTHORS].sort()).toEqual(['buyer', 'concierge', 'dealer']);
    expect([...VEHICLE_CONDITIONS].sort()).toEqual(['certified', 'new', 'used']);
    expect([...DEALERSHIP_CONTACT_ROLES].sort()).toEqual([
      'finance_manager',
      'general_manager',
      'sales_agent',
      'sales_manager',
    ]);
    expect([...PROCESS_STEPS].sort()).toEqual([
      'deal_approval',
      'deal_negotiation',
      'final_sale',
      'financing',
      'information_gather',
      'pickup',
    ]);
    expectTypeOf(MESSAGE_CHANNELS).toEqualTypeOf<readonly MessageChannel[]>();
    expectTypeOf(PROCESS_STEPS).toEqualTypeOf<readonly ProcessStep[]>();
  });

  it('the vocabulary arrays are readonly at the type level (no push into the spine vocabulary)', () => {
    const typeOnly = (flags: typeof OFFER_FLAGS) => {
      // @ts-expect-error — readonly array exposes no mutator
      flags.push('junk_fee');
    };
    void typeOnly;
  });
});

// ------------------------------------------------------------------- vehicle

describe('AC-1 / AC-2 — the VehicleTarget / VehicleInstance split (Q11 AMENDED)', () => {
  it('VehicleTarget has exactly make + model + year_range?', () => {
    expectTypeOf<keyof VehicleTarget>().toEqualTypeOf<'make' | 'model' | 'year_range'>();
    expectTypeOf<YearRange>().toEqualTypeOf<{ from: number; to: number }>();
    const target: VehicleTarget = {
      make: 'Toyota',
      model: 'RAV4',
      year_range: { from: 2020, to: 2025 },
    };
    expect(target.year_range?.to).toBe(2025);
  });

  it('VehicleInstance has a declared identity key plus the priceable attributes (D1)', () => {
    expectTypeOf<keyof VehicleInstance>().toEqualTypeOf<
      'id' | 'vin' | 'year' | 'trim' | 'mileage' | 'condition' | 'additions'
    >();
    expectTypeOf<VehicleInstance['id']>().toEqualTypeOf<string>();
    expectTypeOf<VehicleInstance['vin']>().toEqualTypeOf<Vin | undefined>();
    expectTypeOf<VehicleInstance['condition']>().toEqualTypeOf<VehicleCondition>();
    expectTypeOf<VehicleInstance['additions']>().toEqualTypeOf<string[]>();
    expect(instance.additions).toHaveLength(2);
  });

  it('I-2 — VehicleInstance structurally carries NO make/model: a thread cannot contradict the anchor', () => {
    type HasMake = 'make' extends keyof VehicleInstance ? true : false;
    type HasModel = 'model' extends keyof VehicleInstance ? true : false;
    expectTypeOf<HasMake>().toEqualTypeOf<false>();
    expectTypeOf<HasModel>().toEqualTypeOf<false>();
    const contradictory: VehicleInstance = {
      id: 'vi-x',
      year: 2023,
      condition: 'used',
      additions: [],
      // @ts-expect-error — the deal's anchor is not restatable per thread (I-2)
      make: 'Honda',
    };
    void contradictory;
  });

  it('a NEW instance omits vin/trim/mileage — absence is normal, not an error (Q16)', () => {
    const fresh: VehicleInstance = {
      id: 'vi-2',
      year: 2026,
      condition: 'new',
      additions: [],
    };
    expect(fresh.vin).toBeUndefined();
    expect(fresh.mileage).toBeUndefined();
  });

  it('Q16 — a malformed/fake VIN is ACCEPTED: VIN is user-entered and unvalidated at launch', () => {
    const sloppy: VehicleInstance = {
      id: 'vi-3',
      vin: 'not-a-real-vin',
      year: 2021,
      condition: 'used',
      additions: [],
    };
    expectTypeOf<Vin>().toEqualTypeOf<string>();
    expect(sloppy.vin).toBe('not-a-real-vin');
  });

  it('Q16 — year_range is a SOFT guide: an out-of-range instance year is representable and not rejected', () => {
    const target: VehicleTarget = { make: 'Toyota', model: 'RAV4', year_range: { from: 2022, to: 2024 } };
    const drifted: VehicleInstance = { id: 'vi-4', year: 2019, condition: 'used', additions: [] };
    const inRange =
      target.year_range === undefined ||
      (drifted.year >= target.year_range.from && drifted.year <= target.year_range.to);
    expect(inRange).toBe(false); // outside the guide…
    expect(drifted.year).toBe(2019); // …and still a perfectly valid instance
  });
});

// ---------------------------------------------------------------- tenancy

describe('AC-5 / AC-6 / I-5 — dealership data tenancy split (Q12 AMENDED)', () => {
  it('Dealership is GLOBAL: exactly id/name/state/city/zip_code, no account or owner field', () => {
    expectTypeOf<keyof Dealership>().toEqualTypeOf<
      'id' | 'name' | 'state' | 'city' | 'zip_code'
    >();
    type Accountish = Extract<
      keyof Dealership,
      'account_id' | 'owner_id' | 'org_id' | 'tenant_id' | 'user_id'
    >;
    expectTypeOf<Accountish>().toEqualTypeOf<never>();
  });

  it('Dealership carries NO staff[] — the people were moved out so they cannot be redistributed', () => {
    type HasStaff = 'staff' extends keyof Dealership ? true : false;
    type HasContacts = 'contacts' extends keyof Dealership ? true : false;
    expectTypeOf<HasStaff>().toEqualTypeOf<false>();
    expectTypeOf<HasContacts>().toEqualTypeOf<false>();
    const global: Dealership = {
      id: 'dlr-1',
      name: 'Sunrise Toyota',
      state: 'CA',
      city: 'Fresno',
      // @ts-expect-error — global record must not hold account-private people
      staff: [contact],
      zip_code: '93720',
    };
    void global;
  });

  it('zip_code is a string — leading zeros are real ZIPs', () => {
    expectTypeOf<Dealership['zip_code']>().toEqualTypeOf<string>();
    const eastCoast: Dealership = {
      id: 'dlr-2',
      name: 'Bay State Motors',
      state: 'MA',
      city: 'Boston',
      zip_code: '02108',
    };
    expect(eastCoast.zip_code).toBe('02108');
    expect(eastCoast.zip_code.startsWith('0')).toBe(true);
  });

  it('DealershipContact is account-PRIVATE: name/role/phone?/email? and NO id, NO account field', () => {
    expectTypeOf<keyof DealershipContact>().toEqualTypeOf<
      'name' | 'role' | 'phone' | 'email'
    >();
    type Addressable = Extract<
      keyof DealershipContact,
      'id' | 'contact_id' | 'account_id' | 'dealership_id' | 'owner_id'
    >;
    expectTypeOf<Addressable>().toEqualTypeOf<never>();
  });

  it('there is no globally addressable contact record: contacts are only reachable through a thread', () => {
    const thread: DealerThread = {
      dealership_id: 'dlr-1',
      working_with: contact,
      process_step: 'deal_negotiation',
      messages: [],
    };
    // The only path to a contact is deal → thread → working_with. A global lookup
    // shape does not exist in the spine, so there is nothing to leak.
    expect(thread.working_with?.name).toBe('Dana Reyes');
    expectTypeOf<DealerThread['working_with']>().toEqualTypeOf<DealershipContact | undefined>();
  });
});

// -------------------------------------------------------------- aggregate

describe('AC-3 / AC-7 — Deal and DealerThread v0.5 shapes', () => {
  it('Deal has exactly the v0.5 field list — resolved_vehicle is GONE (Q11 AMENDED)', () => {
    expectTypeOf<keyof Deal>().toEqualTypeOf<
      | 'id'
      | 'owner_id'
      | 'path'
      | 'status'
      | 'target_vehicle'
      | 'budget'
      | 'walk_away_number'
      | 'identity_ref'
      | 'dealer_threads'
      | 'offers'
      | 'receipt_bundle_id'
      | 'created_at'
      | 'burned_at'
    >();
    type HasResolved = 'resolved_vehicle' extends keyof Deal ? true : false;
    expectTypeOf<HasResolved>().toEqualTypeOf<false>();
    expectTypeOf<Deal['target_vehicle']>().toEqualTypeOf<VehicleTarget>();
  });

  it('a Deal cannot carry a resolved VIN — VIN belongs to the instance', () => {
    const deal: Deal = makeDeal({
      // @ts-expect-error — Deal.resolved_vehicle was removed; VIN lives on VehicleInstance
      resolved_vehicle: '4T3ZWRFVXNU090000',
    });
    void deal;
  });

  it('money is MoneyCents and timestamps are IsoTimestamp', () => {
    expectTypeOf<Deal['budget']>().toEqualTypeOf<MoneyCents>();
    expectTypeOf<Deal['walk_away_number']>().toEqualTypeOf<MoneyCents>();
    expectTypeOf<Deal['created_at']>().toEqualTypeOf<IsoTimestamp>();
  });

  it('DealerThread has exactly the v0.5 fields; the Epic-1 shape is gone', () => {
    expectTypeOf<keyof DealerThread>().toEqualTypeOf<
      | 'dealership_id'
      | 'vehicle_instance'
      | 'working_with'
      | 'process_step'
      | 'messages'
      | 'current_offer'
    >();
    type OldFields = Extract<
      keyof DealerThread,
      'dealer_id' | 'dealer_name' | 'contact'
    >;
    expectTypeOf<OldFields>().toEqualTypeOf<never>();
  });

  it('D4 — a fresh information_gather thread carries neither instance nor contact (nothing is fabricated)', () => {
    const early: DealerThread = {
      dealership_id: 'dlr-1',
      process_step: 'information_gather',
      messages: [],
    };
    expect(early.vehicle_instance).toBeUndefined();
    expect(early.working_with).toBeUndefined();
    expect(early.current_offer).toBeUndefined();
  });

  it('a fully-populated thread composes instance + contact + messages + current_offer (ADR-006 rollup)', () => {
    const thread = {
      dealership_id: 'dlr-1',
      vehicle_instance: instance,
      working_with: contact,
      process_step: 'deal_negotiation',
      messages: [
        {
          channel: 'sms',
          direction: 'in',
          author: 'dealer',
          body: 'Out the door 29,500',
          timestamp: T0,
          extracted_offer: offer,
        },
      ],
      current_offer: offer,
    } satisfies DealerThread;
    expect(thread.messages).toHaveLength(1);
    expect(thread.current_offer?.sale_price).toBe(2_950_000);
  });

  it('one deal spans many dealerships, each with its OWN instance (cardinality invariant)', () => {
    const deal = makeDeal({
      status: 'negotiating',
      dealer_threads: [
        {
          dealership_id: 'dlr-1',
          vehicle_instance: { id: 'vi-a', year: 2023, condition: 'used', mileage: 24_000, additions: [] },
          process_step: 'deal_negotiation',
          messages: [],
        },
        {
          dealership_id: 'dlr-2',
          vehicle_instance: { id: 'vi-b', year: 2022, condition: 'certified', mileage: 41_000, additions: [] },
          process_step: 'deal_negotiation',
          messages: [],
        },
      ],
    });
    const instanceIds = deal.dealer_threads.map((t) => t.vehicle_instance?.id);
    expect(new Set(instanceIds).size).toBe(2); // variation lives per thread, never on the deal
    const dealershipIds = deal.dealer_threads.map((t) => t.dealership_id);
    expect(new Set(dealershipIds).size).toBe(dealershipIds.length); // ≤1 thread per dealership
  });
});

// ------------------------------------------------------- write-once anchor

describe('AC-4 / I-1 — target_vehicle make/model are write-once', () => {
  it('make/model are readonly: silent mutation is a compile error everywhere', () => {
    // Mechanism 1 of 3 (§2.7) is COMPILE-time. `readonly` is erased at runtime,
    // so these lines would assign if they ever compiled — which is exactly why
    // typecheck.test.ts runs tsc: an un-erroring @ts-expect-error fails the gate.
    const scratch = makeDeal();
    // @ts-expect-error — make is readonly; there is no silent-mutation path
    scratch.target_vehicle.make = 'Honda';
    // @ts-expect-error — model is readonly for the same reason
    scratch.target_vehicle.model = 'Accord';
    // Mechanism 2 is the RUNTIME predicate every write path must consult, and it
    // is unaffected by whatever a rogue caller did to the object in memory.
    const locked = makeDeal({ status: 'negotiating', offers: [offer] });
    expect(isTargetVehicleLocked(locked)).toBe(true);
    expect(makeDeal().target_vehicle.make).toBe('Toyota');
  });

  it('VehicleTargetDraft is the ONLY settable form (deal creation)', () => {
    const draft: VehicleTargetDraft = { make: 'Toyota', model: 'RAV4' };
    draft.make = 'Honda'; // legal only on the draft
    draft.model = 'Accord';
    expect(draft.make).toBe('Honda');
    expectTypeOf<keyof VehicleTargetDraft>().toEqualTypeOf<keyof VehicleTarget>();
  });

  it('year_range stays mutable — it is a soft guide the buyer may widen or narrow', () => {
    const target: VehicleTarget = { make: 'Toyota', model: 'RAV4', year_range: { from: 2021, to: 2024 } };
    target.year_range = { from: 2019, to: 2025 };
    expect(target.year_range.from).toBe(2019);
  });

  it('isTargetVehicleLocked truth table — draft with no offers anywhere is UNLOCKED', () => {
    expect(isTargetVehicleLocked(makeDeal())).toBe(false);
    expect(
      isTargetVehicleLocked(
        makeDeal({
          dealer_threads: [
            { dealership_id: 'dlr-1', process_step: 'information_gather', messages: [] },
          ],
        }),
      ),
    ).toBe(false); // a thread alone does not lock — only an attached offer does
  });

  it('isTargetVehicleLocked — any attached offer locks the anchor', () => {
    expect(isTargetVehicleLocked(makeDeal({ offers: [offer] }))).toBe(true);
    expect(
      isTargetVehicleLocked(
        makeDeal({
          dealer_threads: [
            {
              dealership_id: 'dlr-1',
              process_step: 'deal_negotiation',
              messages: [],
              current_offer: offer,
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('isTargetVehicleLocked — leaving draft locks the anchor for every non-draft status', () => {
    for (const status of ['active', 'negotiating', 'closed', 'burned'] as const) {
      expect(isTargetVehicleLocked(makeDeal({ status })), status).toBe(true);
    }
  });

  it('isTargetVehicleLocked is pure and total — accepts a bare Pick, never throws, reads no clock', () => {
    const minimal: Pick<Deal, 'status' | 'offers' | 'dealer_threads'> = {
      status: 'draft',
      offers: [],
      dealer_threads: [],
    };
    expect(() => isTargetVehicleLocked(minimal)).not.toThrow();
    expect(isTargetVehicleLocked(minimal)).toBe(false);
    // repeated calls agree — no time dependence, no hidden state
    expect(isTargetVehicleLocked(minimal)).toBe(isTargetVehicleLocked(minimal));
    expectTypeOf(isTargetVehicleLocked).returns.toEqualTypeOf<boolean>();
  });

  it('§5.3 — a post-lock make/model write is rejected terminally (retry cannot help)', () => {
    const locked = makeDeal({ status: 'negotiating', offers: [offer] });
    type Rejection = { ok: false; reason: 'target_vehicle_locked'; retryable: false };
    const setTarget = (
      deal: Deal,
      next: VehicleTargetDraft,
    ): { ok: true; target: VehicleTarget } | Rejection =>
      isTargetVehicleLocked(deal)
        ? { ok: false, reason: 'target_vehicle_locked', retryable: false }
        : { ok: true, target: next };

    const rejected = setTarget(locked, { make: 'Honda', model: 'Accord' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.retryable).toBe(false);
    expect(locked.target_vehicle.make).toBe('Toyota'); // anchor untouched
    expect(setTarget(makeDeal(), { make: 'Honda', model: 'Accord' }).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ message

describe('AC-8 / AC-9 / I-6 / I-7 — the ratified Message shape (Q22)', () => {
  it('has exactly the ratified fields — no synthetic id (D15)', () => {
    expectTypeOf<keyof Message>().toEqualTypeOf<
      'channel' | 'direction' | 'author' | 'body' | 'call_meta' | 'timestamp' | 'extracted_offer'
    >();
    type HasId = 'id' extends keyof Message ? true : false;
    expectTypeOf<HasId>().toEqualTypeOf<false>();
  });

  it('AC-9 — recording_url and transcript do not exist: absent, not nullable, not deprecated', () => {
    type HasRecording = 'recording_url' extends keyof Message ? true : false;
    type HasTranscript = 'transcript' extends keyof Message ? true : false;
    expectTypeOf<HasRecording>().toEqualTypeOf<false>();
    expectTypeOf<HasTranscript>().toEqualTypeOf<false>();
    const call: Message = {
      channel: 'call',
      direction: 'in',
      author: 'dealer',
      call_meta: { started_at: T0, duration_seconds: 214, party: '+15559990000' },
      timestamp: T0,
      // @ts-expect-error — no audio is ever captured or stored (specs/01; Q14)
      recording_url: null,
    };
    void call;
    const transcribed: Message = {
      channel: 'call',
      direction: 'in',
      author: 'dealer',
      timestamp: T0,
      // @ts-expect-error — transcripts were removed; a buyer note replaces them
      transcript: 'dealer quoted 29,500 out the door',
    };
    void transcribed;
  });

  it('I-7 — author is REQUIRED and has no default: nothing is ever inferred', () => {
    expectTypeOf<Message['author']>().toEqualTypeOf<MessageAuthor>();
    // @ts-expect-error — author is required; it may not be inferred from direction
    const authorless: Message = {
      channel: 'note',
      direction: 'internal',
      body: 'They floated 29,500 on the phone',
      timestamp: T0,
    };
    void authorless;
  });

  it('a buyer-authored note is channel=note + direction=internal + author=buyer', () => {
    const note = {
      channel: 'note',
      direction: 'internal',
      author: 'buyer',
      body: 'Call: they said 29,500 OTD, doc fee 599',
      timestamp: T0,
    } satisfies Message;
    expect(note.channel).toBe('note');
    expect(note.direction).toBe('internal');
  });

  it('I-6 — a call record carries CallMeta (time/duration/party) and nothing pointing at audio', () => {
    expectTypeOf<keyof CallMeta>().toEqualTypeOf<'started_at' | 'duration_seconds' | 'party'>();
    type AudioIsh = Extract<
      keyof CallMeta,
      'recording_url' | 'audio_url' | 'call_ref' | 'recording_sid' | 'media_url'
    >;
    expectTypeOf<AudioIsh>().toEqualTypeOf<never>();
    const missed: Message = {
      channel: 'call',
      direction: 'in',
      author: 'dealer',
      call_meta: { started_at: T0 }, // missed/in-flight: no duration, blocked caller: no party
      timestamp: T0,
    };
    expect(missed.call_meta?.duration_seconds).toBeUndefined();
    expect(missed.body).toBeUndefined(); // a bare call record has no text
  });

  it('a concierge-authored outbound message is representable (B2B/operator path)', () => {
    const sent = {
      channel: 'email',
      direction: 'out',
      author: 'concierge',
      body: 'Following up on the out-the-door figure.',
      timestamp: T0,
    } satisfies Message;
    expect(sent.author).toBe('concierge');
  });
});

// -------------------------------------------------------------------- offer

describe('AC-12 / I-4 — Offer and ADR-005 unevaluable-never-zero semantics', () => {
  it('Offer has exactly the spec fields — no synthetic id', () => {
    expectTypeOf<keyof Offer>().toEqualTypeOf<
      'sale_price' | 'fees' | 'apr' | 'term_months' | 'monthly' | 'flags'
    >();
    expectTypeOf<keyof OfferFee>().toEqualTypeOf<'name' | 'amount'>();
    expectTypeOf<Offer['flags']>().toEqualTypeOf<OfferFlag[]>();
  });

  it('sale_price stays optional: absent means the dealer stated no price (ADR-005)', () => {
    expectTypeOf<Offer['sale_price']>().toEqualTypeOf<MoneyCents | undefined>();
    const monthlyOnly: Offer = { fees: [], monthly: 61_900, term_months: 84, flags: [] };
    expect(monthlyOnly.sale_price).toBeUndefined();
    expect(monthlyOnly.sale_price).not.toBe(0); // absence is NOT zero
  });

  it('a missing sale_price yields UNEVALUABLE for over_walkaway — never a silent pass', () => {
    type Verdict = 'unevaluable' | 'over' | 'within';
    const evaluateWalkaway = (deal: Deal, o: Offer): Verdict => {
      if (o.sale_price === undefined) return 'unevaluable';
      const otd = o.sale_price + o.fees.reduce((s, f) => s + f.amount, 0);
      return otd > deal.walk_away_number ? 'over' : 'within';
    };
    const deal = makeDeal();
    expect(evaluateWalkaway(deal, { fees: [], flags: [] })).toBe('unevaluable');
    expect(evaluateWalkaway(deal, { sale_price: 3_100_000, fees: [], flags: [] })).toBe('over');
    expect(evaluateWalkaway(deal, { sale_price: 2_900_000, fees: [], flags: [] })).toBe('within');
    // the unevaluable case must not be reported as the passing case
    expect(evaluateWalkaway(deal, { fees: [], flags: [] })).not.toBe('within');
  });

  it('core exports no default/coalesce helper that could turn an absence into zero', async () => {
    const core = (await import('@core')) as Record<string, unknown>;
    const coercive = Object.keys(core).filter((n) =>
      /(default|coalesce|orZero|fallback|ensure)/i.test(n),
    );
    expect(coercive).toEqual([]);
  });

  it('a cash offer omits apr/term/monthly and carries empty flags', () => {
    const cash: Offer = { sale_price: 2_800_000, fees: [], flags: [] };
    expect(cash.apr).toBeUndefined();
    expect(cash.flags).toEqual([]);
  });
});

// ----------------------------------------------------------- identity_ref

describe('AC-15 / I-10 — identity_ref stays provider-agnostic', () => {
  it('has exactly identity_id + phone_number? + email_alias? and nothing else', () => {
    expectTypeOf<keyof IdentityRef>().toEqualTypeOf<
      'identity_id' | 'phone_number' | 'email_alias'
    >();
  });

  it('no provider / provisioner / vendor field is introduced by this migration', () => {
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

  it('identity_ref is absent until first dealer contact (lazy provisioning)', () => {
    const draft = makeDeal();
    expect(draft.identity_ref).toBeUndefined();
  });
});

// ------------------------------------------- instance-bound cached records

describe('AC-10 / I-3 — ValuationSnapshot and VehicleData bind to a vehicle_instance_id', () => {
  it('ValuationSnapshot has flat bands + vehicle_instance_id + provenance (D5, ADR-007)', () => {
    expectTypeOf<keyof ValuationSnapshot>().toEqualTypeOf<
      | 'vehicle_instance_id'
      | 'wholesale'
      | 'trade_in'
      | 'retail'
      | 'private_party'
      | 'source'
      | 'captured_at'
    >();
    expectTypeOf<ValuationSnapshot['vehicle_instance_id']>().toEqualTypeOf<string>();
    expectTypeOf<ValuationSnapshot['captured_at']>().toEqualTypeOf<IsoTimestamp>();
  });

  it('a snapshot of a bare make/model is unrepresentable — the old `vehicle` anchor is gone', () => {
    const legacy: ValuationSnapshot = {
      vehicle_instance_id: instance.id,
      // @ts-expect-error — snapshots are ALWAYS of one specific car, never a make/model
      vehicle: { make: 'Toyota', model: 'RAV4' },
      source: 'mock-kbb',
      captured_at: T0,
    };
    void legacy;
  });

  it('the v0.4 nested `values` block is gone — bands are flat (D5, ADR-007 names `snapshot.retail`)', () => {
    const nested: ValuationSnapshot = {
      vehicle_instance_id: instance.id,
      // @ts-expect-error — ADR-007 refers to ValuationSnapshot.retail directly
      values: { retail: 2_900_000 },
      source: 'mock-kbb',
      captured_at: T0,
    };
    void nested;
  });

  it('a snapshot with no vehicle_instance_id does not typecheck (AC-10 made structural)', () => {
    // @ts-expect-error — vehicle_instance_id is required: no snapshot without a car
    const missingKey: ValuationSnapshot = {
      retail: 2_900_000,
      source: 'mock-kbb',
      captured_at: T0,
    };
    void missingKey;
  });

  it('every band is optional — a partial snapshot is honest, not zero-filled (I-4)', () => {
    const partial: ValuationSnapshot = {
      vehicle_instance_id: instance.id,
      wholesale: 2_450_000,
      source: 'mock-manheim',
      captured_at: T0,
    };
    expect(partial.retail).toBeUndefined();
    expect(partial.retail).not.toBe(0);
    expectTypeOf<ValuationSnapshot['retail']>().toEqualTypeOf<MoneyCents | undefined>();
  });

  it('VehicleData binds to vehicle_instance_id, not a VIN, and carries captured_at (D6)', () => {
    expectTypeOf<keyof VehicleData>().toEqualTypeOf<
      'vehicle_instance_id' | 'decode' | 'recalls' | 'history' | 'captured_at'
    >();
    type HasVin = 'vin' extends keyof VehicleData ? true : false;
    expectTypeOf<HasVin>().toEqualTypeOf<false>();
  });

  it('§5.3 — an instance with no VIN yields VehicleData with decode absent (not an error state)', () => {
    const vinless: VehicleData = {
      vehicle_instance_id: 'vi-2',
      recalls: [],
      captured_at: T0,
    };
    expect(vinless.decode).toBeUndefined();
    expect(vinless.history).toBeUndefined();
    expect(vinless.recalls).toEqual([]);
  });

  it('D7 — reliability is deliberately not modelled (no invented shape)', () => {
    type HasReliability = 'reliability' extends keyof VehicleData ? true : false;
    expectTypeOf<HasReliability>().toEqualTypeOf<false>();
  });

  it('VehicleData composes decode + recalls + history for one specific car', () => {
    const vd = {
      vehicle_instance_id: instance.id,
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
      captured_at: T0,
    } satisfies VehicleData;
    expect(vd.history?.title_brands).toEqual([]); // empty = clean title
    expect(vd.recalls[0]?.campaign_id).toBe('22V123000');
  });
});
