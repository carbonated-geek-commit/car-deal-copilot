/**
 * T-010 tester — v0.5 adapter contracts and their error paths
 * (docs/design/T-010.md §3, §3.1, §5.2, §5.3).
 *
 * AC-10 ValuationRequest requires a whole VehicleInstance — no call shape prices
 *       a bare make/model (D12); the adapter stamps vehicle_instance_id.
 * AC-13/I-6 no audio handle survives: InboundComms carries call_meta?, not call_ref.
 * D11   InboundChannel excludes `note` — a provider-sourced note is unrepresentable.
 * §5.3  every valuation failure mode is exercised: provider_unavailable, rate_limited,
 *       not_found (⇒ UNEVALUABLE, never "fine"), invalid_input, auth, malformed_response.
 * I-13  contracts speak domain types only — no provider SDK type, header, or credential.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AdapterError,
  AdapterErrorCode,
  AdapterResult,
  CallMeta,
  CreditPrequalAdapter,
  EmailAdapter,
  IdentityRef,
  InboundChannel,
  InboundComms,
  MessageChannel,
  OutboundEmail,
  OutboundSms,
  PrequalResult,
  ProviderSendReceipt,
  RecallRecord,
  TelephonyAdapter,
  ValuationAdapter,
  ValuationRequest,
  ValuationSnapshot,
  VehicleDataAdapter,
  VehicleHistoryAdapter,
  VehicleInstance,
  VehicleTarget,
  VinDecode,
} from '@core';

const T0 = '2026-08-07T12:00:00Z';

type IsPromise<T> = T extends Promise<unknown> ? true : false;

const err = (code: AdapterErrorCode, retryable: boolean, source: string): AdapterError => ({
  code,
  retryable,
  source,
  message: `adapter reported ${code}`,
});

const fail = <T>(e: AdapterError): AdapterResult<T> => ({ ok: false, error: e });
const ok = <T>(value: T): AdapterResult<T> => ({ ok: true, value });

const target: VehicleTarget = { make: 'Toyota', model: 'RAV4' };
const instance: VehicleInstance = {
  id: 'vi-1',
  vin: '4T3ZWRFVXNU090000',
  year: 2023,
  trim: 'XLE',
  mileage: 24_000,
  condition: 'used',
  additions: [],
};

// -------------------------------------------------------- result/error shape

describe('AdapterResult / AdapterError — uniform result & error shape (unchanged by v0.5)', () => {
  it('AdapterErrorCode is exactly the six-code table', () => {
    expectTypeOf<AdapterErrorCode>().toEqualTypeOf<
      | 'invalid_input'
      | 'not_found'
      | 'auth'
      | 'rate_limited'
      | 'provider_unavailable'
      | 'malformed_response'
    >();
  });

  it('the retryability table is exhaustive over the codes and JSON/bus-safe', () => {
    const RETRYABLE: Record<AdapterErrorCode, boolean> = {
      invalid_input: false,
      not_found: false,
      auth: false,
      rate_limited: true,
      provider_unavailable: true,
      malformed_response: false,
    };
    const retryableCodes = (Object.keys(RETRYABLE) as AdapterErrorCode[]).filter(
      (c) => RETRYABLE[c],
    );
    expect(retryableCodes.sort()).toEqual(['provider_unavailable', 'rate_limited']);
    for (const [code, retryable] of Object.entries(RETRYABLE)) {
      const e = err(code as AdapterErrorCode, retryable, 'mock-adapter');
      expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    }
  });

  it('AdapterError has exactly code/retryable/source/message — no field fits a raw payload or PII', () => {
    expectTypeOf<keyof AdapterError>().toEqualTypeOf<
      'code' | 'retryable' | 'source' | 'message'
    >();
    type LeakyKeys = Extract<
      keyof AdapterError,
      'raw_payload' | 'body' | 'phone' | 'email' | 'vin' | 'headers' | 'response'
    >;
    expectTypeOf<LeakyKeys>().toEqualTypeOf<never>();
  });

  it('discriminated union narrows on ok', () => {
    const r: AdapterResult<number> = fail(err('not_found', false, 'mock-kbb'));
    if (r.ok) {
      expectTypeOf(r.value).toEqualTypeOf<number>();
    } else {
      expect(r.error.code).toBe('not_found');
      // @ts-expect-error — no value on the failure branch
      void r.value;
    }
    const s = ok(42);
    if (s.ok) {
      expect(s.value).toBe(42);
      // @ts-expect-error — no error on the success branch
      void s.error;
    }
  });
});

// ------------------------------------------------------------ surface shape

describe('adapter interfaces expose exactly their contract surface — no mutators, no heavy sync work', () => {
  it('ValuationAdapter: source + getValuation only', () => {
    expectTypeOf<keyof ValuationAdapter>().toEqualTypeOf<'source' | 'getValuation'>();
  });
  it('VehicleDataAdapter: source + decodeVin + getRecalls only', () => {
    expectTypeOf<keyof VehicleDataAdapter>().toEqualTypeOf<
      'source' | 'decodeVin' | 'getRecalls'
    >();
  });
  it('VehicleHistoryAdapter: source + getHistory only', () => {
    expectTypeOf<keyof VehicleHistoryAdapter>().toEqualTypeOf<'source' | 'getHistory'>();
  });
  it('CreditPrequalAdapter: source + getPrequal only — no method returns raw credit data', () => {
    expectTypeOf<keyof CreditPrequalAdapter>().toEqualTypeOf<'source' | 'getPrequal'>();
  });
  it('TelephonyAdapter: source + sendSms + parseInboundWebhook — no transcription method exists (AC-13)', () => {
    expectTypeOf<keyof TelephonyAdapter>().toEqualTypeOf<
      'source' | 'sendSms' | 'parseInboundWebhook'
    >();
    type Transcriptionish = Extract<
      keyof TelephonyAdapter,
      'transcribe' | 'getRecording' | 'fetchAudio' | 'requestTranscription'
    >;
    expectTypeOf<Transcriptionish>().toEqualTypeOf<never>();
  });
  it('EmailAdapter: source + sendEmail + parseInboundWebhook only', () => {
    expectTypeOf<keyof EmailAdapter>().toEqualTypeOf<
      'source' | 'sendEmail' | 'parseInboundWebhook'
    >();
  });
});

describe('I-9 — parseInboundWebhook stays SYNCHRONOUS and pure (ack-then-queue is structurally forced)', () => {
  it('return type is AdapterResult<InboundComms>, not a Promise', () => {
    expectTypeOf<
      IsPromise<ReturnType<TelephonyAdapter['parseInboundWebhook']>>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsPromise<ReturnType<EmailAdapter['parseInboundWebhook']>>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      ReturnType<TelephonyAdapter['parseInboundWebhook']>
    >().toEqualTypeOf<AdapterResult<InboundComms>>();
  });

  it('send and fetch paths ARE async (I/O), unlike inbound parse', () => {
    expectTypeOf<IsPromise<ReturnType<TelephonyAdapter['sendSms']>>>().toEqualTypeOf<true>();
    expectTypeOf<IsPromise<ReturnType<EmailAdapter['sendEmail']>>>().toEqualTypeOf<true>();
    expectTypeOf<
      IsPromise<ReturnType<ValuationAdapter['getValuation']>>
    >().toEqualTypeOf<true>();
  });
});

// ----------------------------------------------------------- valuation D12

describe('AC-10 / D12 / I-3 — a valuation is ALWAYS of one specific car', () => {
  it('ValuationRequest is exactly { target, instance } — both required', () => {
    expectTypeOf<keyof ValuationRequest>().toEqualTypeOf<'target' | 'instance'>();
    expectTypeOf<ValuationRequest['instance']>().toEqualTypeOf<VehicleInstance>();
    expectTypeOf<ValuationRequest['target']>().toEqualTypeOf<VehicleTarget>();
  });

  it('a request without an instance does not typecheck — no bare make/model pricing', () => {
    // @ts-expect-error — instance is required: specs/00 cannot price "Honda Accord"
    const bare: ValuationRequest = { target };
    void bare;
  });

  it('the v0.4 { vehicle, mileage } request shape is gone', () => {
    const legacy: ValuationRequest = {
      target,
      instance,
      // @ts-expect-error — mileage lives on the instance now, not on the request
      mileage: 24_000,
    };
    void legacy;
  });

  const mockValuation: ValuationAdapter = {
    source: 'mock-kbb',
    async getValuation(req: ValuationRequest) {
      if (req.instance.mileage !== undefined && req.instance.mileage < 0) {
        return fail<ValuationSnapshot>(err('invalid_input', false, 'mock-kbb'));
      }
      if (req.instance.id === 'vi-unknown') {
        return fail<ValuationSnapshot>(err('not_found', false, 'mock-kbb'));
      }
      if (req.instance.id === 'vi-timeout') {
        return fail<ValuationSnapshot>(err('provider_unavailable', true, 'mock-kbb'));
      }
      if (req.instance.id === 'vi-throttled') {
        return fail<ValuationSnapshot>(err('rate_limited', true, 'mock-kbb'));
      }
      if (req.instance.id === 'vi-badcreds') {
        return fail<ValuationSnapshot>(err('auth', false, 'mock-kbb'));
      }
      if (req.instance.id === 'vi-drifted') {
        return fail<ValuationSnapshot>(err('malformed_response', false, 'mock-kbb'));
      }
      return ok<ValuationSnapshot>({
        vehicle_instance_id: req.instance.id, // the stamping rule (§3)
        retail: 2_900_000,
        trade_in: 2_600_000,
        source: 'mock-kbb',
        captured_at: T0,
      });
    },
  };

  it('success stamps vehicle_instance_id from the request and carries provenance + captured_at', async () => {
    const r = await mockValuation.getValuation({ target, instance });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.vehicle_instance_id).toBe('vi-1');
      expect(r.value.source).toBe('mock-kbb');
      expect(r.value.captured_at).toBe(T0);
    }
  });

  it('two dealerships pricing the same model get snapshots keyed to their OWN instances', async () => {
    const other: VehicleInstance = {
      id: 'vi-2',
      year: 2022,
      condition: 'certified',
      mileage: 41_000,
      additions: [],
    };
    const a = await mockValuation.getValuation({ target, instance });
    const b = await mockValuation.getValuation({ target, instance: other });
    if (a.ok && b.ok) {
      expect(a.value.vehicle_instance_id).not.toBe(b.value.vehicle_instance_id);
    }
  });

  it('§5.3 — retryable failures are marked retryable (provider_unavailable, rate_limited)', async () => {
    for (const id of ['vi-timeout', 'vi-throttled']) {
      const r = await mockValuation.getValuation({
        target,
        instance: { ...instance, id },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.retryable, id).toBe(true);
        expect(['provider_unavailable', 'rate_limited']).toContain(r.error.code);
      }
    }
  });

  it('§5.3 — terminal failures are marked non-retryable (not_found, invalid_input, auth, malformed_response)', async () => {
    const cases: Array<[string, AdapterErrorCode]> = [
      ['vi-unknown', 'not_found'],
      ['vi-badcreds', 'auth'],
      ['vi-drifted', 'malformed_response'],
    ];
    for (const [id, code] of cases) {
      const r = await mockValuation.getValuation({ target, instance: { ...instance, id } });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code, id).toBe(code);
        expect(r.error.retryable, id).toBe(false);
      }
    }
    const bad = await mockValuation.getValuation({
      target,
      instance: { ...instance, mileage: -5 },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('invalid_input');
      expect(bad.error.retryable).toBe(false);
    }
  });

  it('§5.3 / ADR-005 — `not_found` makes fair price UNEVALUABLE, never "fine"', async () => {
    type FairPrice = 'unevaluable' | 'above_market' | 'at_or_below_market';
    const verdict = (
      snapshot: AdapterResult<ValuationSnapshot>,
      sale_price?: number,
    ): FairPrice => {
      if (!snapshot.ok) return 'unevaluable';
      // ADR-007: the comparison band is RETAIL, and only retail.
      if (snapshot.value.retail === undefined || sale_price === undefined) return 'unevaluable';
      return sale_price > snapshot.value.retail ? 'above_market' : 'at_or_below_market';
    };
    const missing = await mockValuation.getValuation({
      target,
      instance: { ...instance, id: 'vi-unknown' },
    });
    expect(verdict(missing, 2_950_000)).toBe('unevaluable');
    expect(verdict(missing, 2_950_000)).not.toBe('at_or_below_market'); // never a silent pass
    const found = await mockValuation.getValuation({ target, instance });
    expect(verdict(found, 2_950_000)).toBe('above_market');
    expect(verdict(found, 2_800_000)).toBe('at_or_below_market');
    // ADR-007: an offer above trade_in but below retail is NOT above_market
    expect(verdict(found, 2_700_000)).toBe('at_or_below_market');
    // a priced offer against a snapshot with no retail band is still unevaluable
    const noRetail: AdapterResult<ValuationSnapshot> = ok({
      vehicle_instance_id: instance.id,
      wholesale: 2_450_000,
      source: 'mock-manheim',
      captured_at: T0,
    });
    expect(verdict(noRetail, 2_950_000)).toBe('unevaluable');
    // ADR-005: a missing sale_price is unevaluable, never zero-and-therefore-cheap
    expect(verdict(found, undefined)).toBe('unevaluable');
  });

  it('adapters never throw across the boundary — every path returns an AdapterResult', async () => {
    const ids = ['vi-1', 'vi-unknown', 'vi-timeout', 'vi-throttled', 'vi-badcreds', 'vi-drifted'];
    for (const id of ids) {
      await expect(
        mockValuation.getValuation({ target, instance: { ...instance, id } }),
      ).resolves.toHaveProperty('ok');
    }
  });
});

describe('vehicle data / history adapters — instance-driven, VIN-keyed calls', () => {
  const mockNhtsa: VehicleDataAdapter = {
    source: 'mock-nhtsa',
    async decodeVin(v) {
      return ok<VinDecode>({ vin: v, make: 'Toyota', model: 'RAV4', year: 2022 });
    },
    async getRecalls() {
      return ok<RecallRecord[]>([]);
    },
  };

  const mockHistory: VehicleHistoryAdapter = {
    source: 'mock-carfax',
    async getHistory(v) {
      return ok({
        vin: v,
        accident_count: 1,
        title_brands: ['salvage'],
        source: 'mock-carfax',
        fetched_at: T0,
      });
    },
  };

  it('decode/recalls/history run against domain types only', async () => {
    const d = await mockNhtsa.decodeVin(instance.vin!);
    if (d.ok) expect(d.value.year).toBe(2022);
    const h = await mockHistory.getHistory(instance.vin!);
    if (h.ok) expect(h.value.title_brands).toContain('salvage');
  });

  it('§5.3 — an instance with no VIN means decodeVin/getRecalls are never called at all', async () => {
    const vinless: VehicleInstance = {
      id: 'vi-9',
      year: 2026,
      condition: 'new',
      additions: [],
    };
    let calls = 0;
    const counting: VehicleDataAdapter = {
      source: 'mock-nhtsa',
      async decodeVin(v) {
        calls += 1;
        return mockNhtsa.decodeVin(v);
      },
      async getRecalls(v) {
        calls += 1;
        return mockNhtsa.getRecalls(v);
      },
    };
    if (vinless.vin !== undefined) {
      await counting.decodeVin(vinless.vin);
      await counting.getRecalls(vinless.vin);
    }
    expect(calls).toBe(0); // "VIN not provided" is not an error state
  });
});

describe('credit prequal — pass-through only (specs/01 credit residency; mock-only per CLAUDE.md)', () => {
  it('PrequalResult holds exactly a token + derived numbers + timestamp', () => {
    expectTypeOf<keyof PrequalResult>().toEqualTypeOf<
      'provider_token' | 'qualified_apr' | 'approved_amount_max' | 'fetched_at'
    >();
    type ForbiddenCreditKeys = Extract<
      keyof PrequalResult,
      'ssn' | 'credit_score' | 'report' | 'bureau_payload' | 'tradelines' | 'dob'
    >;
    expectTypeOf<ForbiddenCreditKeys>().toEqualTypeOf<never>();
  });

  it('getPrequal takes and returns only the opaque provider token + derived results', async () => {
    const mockPrequal: CreditPrequalAdapter = {
      source: 'mock-prequal',
      async getPrequal(provider_token) {
        return ok<PrequalResult>({
          provider_token,
          qualified_apr: 6.4,
          approved_amount_max: 3_500_000,
          fetched_at: T0,
        });
      },
    };
    const r = await mockPrequal.getPrequal('tok-opaque-123');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value).sort()).toEqual([
        'approved_amount_max',
        'fetched_at',
        'provider_token',
        'qualified_apr',
      ]);
    }
  });
});

describe('outbound send — client_ref idempotency (no double-texting a dealer)', () => {
  const identity: IdentityRef = {
    identity_id: 'ident-1',
    phone_number: '+15550001111',
    email_alias: 'deal-1@relay.example',
  };

  it('OutboundSms / OutboundEmail require a caller-supplied client_ref and send FROM an IdentityRef', () => {
    expectTypeOf<keyof OutboundSms>().toEqualTypeOf<
      'from' | 'to_phone' | 'body' | 'client_ref'
    >();
    expectTypeOf<keyof OutboundEmail>().toEqualTypeOf<
      'from' | 'to_email' | 'subject' | 'body' | 'client_ref'
    >();
    expectTypeOf<OutboundSms['from']>().toEqualTypeOf<IdentityRef>();
    expectTypeOf<keyof ProviderSendReceipt>().toEqualTypeOf<
      'provider_message_ref' | 'accepted_at'
    >();
  });

  it('an adapter honoring the contract dedupes retries on client_ref — exactly one provider send', async () => {
    const providerSends: string[] = [];
    const seen = new Map<string, ProviderSendReceipt>();
    const mockTelephony: TelephonyAdapter = {
      source: 'mock-telephony',
      async sendSms(msg: OutboundSms) {
        const existing = seen.get(msg.client_ref);
        if (existing) return ok(existing);
        providerSends.push(msg.client_ref);
        const receipt: ProviderSendReceipt = {
          provider_message_ref: `pm-${providerSends.length}`,
          accepted_at: T0,
        };
        seen.set(msg.client_ref, receipt);
        return ok(receipt);
      },
      parseInboundWebhook() {
        return fail<InboundComms>(err('malformed_response', false, 'mock-telephony'));
      },
    };

    const msg: OutboundSms = {
      from: identity,
      to_phone: '+15559990000',
      body: 'Can you do 28,000?',
      client_ref: 'send-attempt-abc',
    };
    const first = await mockTelephony.sendSms(msg);
    const retry = await mockTelephony.sendSms(msg);
    expect(providerSends).toEqual(['send-attempt-abc']);
    expect(first).toEqual(retry);
  });
});

// ------------------------------------------------------------ InboundComms

describe('D11 / I-6 / I-7 — InboundComms is the only shape a webhook payload may become', () => {
  it('has exactly the v0.5 fields: call_meta replaced call_ref', () => {
    expectTypeOf<keyof InboundComms>().toEqualTypeOf<
      | 'channel'
      | 'to_identity'
      | 'from'
      | 'body'
      | 'call_meta'
      | 'provider_message_ref'
      | 'received_at'
    >();
    type HasCallRef = 'call_ref' extends keyof InboundComms ? true : false;
    expectTypeOf<HasCallRef>().toEqualTypeOf<false>();
    expectTypeOf<InboundComms['call_meta']>().toEqualTypeOf<CallMeta | undefined>();
  });

  it('no audio handle can be attached to an inbound item (Q14: nothing exists to point at)', () => {
    const withAudio: InboundComms = {
      channel: 'call',
      to_identity: { phone_number: '+15550001111' },
      from: { phone: '+15559990000' },
      call_meta: { started_at: T0, duration_seconds: 96 },
      // @ts-expect-error — no audio is ever captured or stored (specs/01; Q14)
      call_ref: 'call-audio-handle-55',
      provider_message_ref: 'CA55',
      received_at: T0,
    };
    void withAudio;
  });

  it('InboundChannel excludes `note` — a provider payload can never become an authored note', () => {
    expectTypeOf<InboundChannel>().toEqualTypeOf<'call' | 'sms' | 'email'>();
    type NoteExcluded = Extract<InboundChannel, 'note'>;
    expectTypeOf<NoteExcluded>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<MessageChannel, InboundChannel>>().toEqualTypeOf<'note'>();
    const fabricated: InboundComms = {
      // @ts-expect-error — a note is authored in-app; a webhook may not claim to be one
      channel: 'note',
      to_identity: { phone_number: '+15550001111' },
      from: { phone: '+15559990000' },
      provider_message_ref: 'SM1',
      received_at: T0,
    };
    void fabricated;
  });

  it('to_identity keys are drawn from IdentityRef so deal routing needs no provider shape', () => {
    expectTypeOf<keyof InboundComms['to_identity']>().toEqualTypeOf<
      'phone_number' | 'email_alias'
    >();
    type MustBeIdentityRefKeys = Exclude<
      keyof InboundComms['to_identity'],
      keyof IdentityRef
    >;
    expectTypeOf<MustBeIdentityRefKeys>().toEqualTypeOf<never>();
  });

  it('carries provider_message_ref as a required idempotency anchor and is bus-serializable', () => {
    expectTypeOf<InboundComms['provider_message_ref']>().toEqualTypeOf<string>();
    const inbound: InboundComms = {
      channel: 'sms',
      to_identity: { phone_number: '+15550001111' },
      from: { phone: '+15559990000' },
      body: 'We can do 28,500',
      provider_message_ref: 'SM123',
      received_at: T0,
    };
    expect(JSON.parse(JSON.stringify(inbound))).toEqual(inbound);
  });

  it('an inbound call carries metadata only — no body, no audio', () => {
    const call: InboundComms = {
      channel: 'call',
      to_identity: { phone_number: '+15550001111' },
      from: { phone: '+15559990000' },
      call_meta: { started_at: T0, duration_seconds: 214, party: '+15559990000' },
      provider_message_ref: 'CA55',
      received_at: T0,
    };
    expect(call.body).toBeUndefined();
    expect(Object.keys(call)).not.toContain('call_ref');
  });
});
