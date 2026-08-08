/**
 * T-001 tester — adapter interface contracts (docs/design/T-001.md §3, §5.1, §5.4).
 *
 * AC-5: contracts for valuation, vehicle-data, telephony, email (+ D4 extras:
 * vehicle-history, credit-prequal); core services depend only on these shapes.
 * Error paths: uniform AdapterResult, the six-code error table, retryability.
 * Kit mandates touched here: ack-then-queue (parseInboundWebhook is sync;
 * no synchronous heavy-work method exists), credit residency (PrequalResult
 * is token + derived numbers only), outbound idempotency (client_ref dedupe).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AdapterError,
  AdapterErrorCode,
  AdapterResult,
  CreditPrequalAdapter,
  EmailAdapter,
  InboundComms,
  IdentityRef,
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
  VinDecode,
} from '@core';

const T0 = '2026-08-07T12:00:00Z';

type IsPromise<T> = T extends Promise<unknown> ? true : false;

// ---------------------------------------------------------------- fixtures

const err = (code: AdapterErrorCode, retryable: boolean, source: string): AdapterError => ({
  code,
  retryable,
  source,
  message: `adapter reported ${code}`,
});

const fail = <T>(e: AdapterError): AdapterResult<T> => ({ ok: false, error: e });
const ok = <T>(value: T): AdapterResult<T> => ({ ok: true, value });

describe('AdapterResult / AdapterError — uniform result & error shape (§3.1)', () => {
  it('AdapterErrorCode is exactly the six-code table from the design', () => {
    expectTypeOf<AdapterErrorCode>().toEqualTypeOf<
      | 'invalid_input'
      | 'not_found'
      | 'auth'
      | 'rate_limited'
      | 'provider_unavailable'
      | 'malformed_response'
    >();
  });

  it('the §5.1 retryability table is expressible and exhaustive over the codes', () => {
    // Record over the union forces compile-time exhaustiveness; values are the
    // binding behavioral contract downstream adapters are built against.
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
      // every error is JSON-serializable (log-safe, bus-safe)
      expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    }
  });

  it('AdapterError has exactly code/retryable/source/message — no field where a raw provider payload or PII fits', () => {
    expectTypeOf<keyof AdapterError>().toEqualTypeOf<
      'code' | 'retryable' | 'source' | 'message'
    >();
  });

  it('discriminated union narrows on ok', () => {
    const r: AdapterResult<number> = fail(err('not_found', false, 'mock-kbb'));
    if (r.ok) {
      expectTypeOf(r.value).toEqualTypeOf<number>();
    } else {
      expect(r.error.code).toBe('not_found');
      expect(r.error.retryable).toBe(false);
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

describe('adapter interfaces expose exactly their contract surface — nothing extra, no mutators (§3.2/§3.3)', () => {
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
  it('CreditPrequalAdapter: source + getPrequal only — no method can return raw credit data', () => {
    expectTypeOf<keyof CreditPrequalAdapter>().toEqualTypeOf<'source' | 'getPrequal'>();
  });
  it('TelephonyAdapter: source + sendSms + parseInboundWebhook only — no synchronous transcription/extraction method exists (ack-then-queue)', () => {
    expectTypeOf<keyof TelephonyAdapter>().toEqualTypeOf<
      'source' | 'sendSms' | 'parseInboundWebhook'
    >();
  });
  it('EmailAdapter: source + sendEmail + parseInboundWebhook only', () => {
    expectTypeOf<keyof EmailAdapter>().toEqualTypeOf<
      'source' | 'sendEmail' | 'parseInboundWebhook'
    >();
  });
});

describe('parseInboundWebhook is SYNCHRONOUS (§3.3 / §5.2 — must be safe before ack)', () => {
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

  it('send paths ARE async (I/O), unlike inbound parse', () => {
    expectTypeOf<IsPromise<ReturnType<TelephonyAdapter['sendSms']>>>().toEqualTypeOf<true>();
    expectTypeOf<IsPromise<ReturnType<EmailAdapter['sendEmail']>>>().toEqualTypeOf<true>();
    expectTypeOf<IsPromise<ReturnType<ValuationAdapter['getValuation']>>>().toEqualTypeOf<true>();
  });
});

describe('outbound-feed adapters are implementable and exercise both result branches (§5.1)', () => {
  const mockValuation: ValuationAdapter = {
    source: 'mock-kbb',
    async getValuation(req: ValuationRequest) {
      if (req.mileage !== undefined && req.mileage < 0) {
        return fail<ValuationSnapshot>(err('invalid_input', false, 'mock-kbb'));
      }
      if ('vin' in req.vehicle && req.vehicle.vin === 'UNKNOWNVIN000000X') {
        return fail<ValuationSnapshot>(err('not_found', false, 'mock-kbb'));
      }
      return ok<ValuationSnapshot>({
        vehicle: req.vehicle,
        ...(req.mileage !== undefined ? { mileage: req.mileage } : {}),
        values: { retail: 2_900_000, trade_in: 2_600_000 },
        source: 'mock-kbb',
        fetched_at: T0,
      });
    },
  };

  it('valuation success path yields a timestamped snapshot with provenance', async () => {
    const r = await mockValuation.getValuation({
      vehicle: { make: 'Toyota', model: 'RAV4' },
      mileage: 24_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.source).toBe('mock-kbb');
      expect(r.value.fetched_at).toBe(T0);
    }
  });

  it('valuation error paths return typed failures, never throw across the boundary', async () => {
    const notFound = await mockValuation.getValuation({
      vehicle: { vin: 'UNKNOWNVIN000000X' },
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) {
      expect(notFound.error.code).toBe('not_found');
      expect(notFound.error.retryable).toBe(false);
    }
    const badInput = await mockValuation.getValuation({
      vehicle: { make: 'Toyota', model: 'RAV4' },
      mileage: -5,
    });
    expect(badInput.ok).toBe(false);
    if (!badInput.ok) expect(badInput.error.code).toBe('invalid_input');
  });

  it('VehicleDataAdapter and VehicleHistoryAdapter are implementable against domain types only', async () => {
    const vin = '4T3ZWRFVXNU090000';
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
    const d = await mockNhtsa.decodeVin(vin);
    if (d.ok) expect(d.value.year).toBe(2022);
    const h = await mockHistory.getHistory(vin);
    if (h.ok) expect(h.value.title_brands).toContain('salvage');
  });
});

describe('credit prequal — pass-through only (specs/01 credit residency)', () => {
  it('PrequalResult holds exactly provider_token + derived numbers + timestamp — raw credit data has no place to land', () => {
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
      expect(r.value.provider_token).toBe('tok-opaque-123');
      expect(Object.keys(r.value).sort()).toEqual([
        'approved_amount_max',
        'fetched_at',
        'provider_token',
        'qualified_apr',
      ]);
    }
  });
});

describe('outbound send — client_ref idempotency (§5.4: no double-texting a dealer)', () => {
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
        if (existing) return ok(existing); // dedupe: same receipt, no second send
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
      client_ref: 'send-attempt-abc', // generated BEFORE first attempt, reused on retry
    };
    const first = await mockTelephony.sendSms(msg);
    const retry = await mockTelephony.sendSms(msg); // caller retry after e.g. timeout
    expect(providerSends).toEqual(['send-attempt-abc']); // exactly one real send
    expect(first).toEqual(retry); // same receipt both times
    if (first.ok) expect(first.value.provider_message_ref).toBe('pm-1');
  });
});

describe('InboundComms — identity-routing shape (§3.3)', () => {
  it('has exactly the normalized fields; to_identity uses IdentityRef vocabulary so routing can match a Deal', () => {
    expectTypeOf<keyof InboundComms>().toEqualTypeOf<
      | 'channel'
      | 'to_identity'
      | 'from'
      | 'body'
      | 'call_ref'
      | 'provider_message_ref'
      | 'received_at'
    >();
    // to_identity keys are drawn from IdentityRef's contact keys — field-name
    // parity is what makes deal routing possible without a provider shape.
    expectTypeOf<keyof InboundComms['to_identity']>().toEqualTypeOf<
      'phone_number' | 'email_alias'
    >();
    type ToIdentityKeys = keyof InboundComms['to_identity'];
    type MustBeIdentityRefKeys = Exclude<ToIdentityKeys, keyof IdentityRef>;
    expectTypeOf<MustBeIdentityRefKeys>().toEqualTypeOf<never>();
  });

  it('carries the provider_message_ref idempotency anchor as a required field', () => {
    expectTypeOf<InboundComms['provider_message_ref']>().toEqualTypeOf<string>();
    const inbound: InboundComms = {
      channel: 'sms',
      to_identity: { phone_number: '+15550001111' },
      from: { phone: '+15559990000' },
      body: 'We can do 28,500',
      provider_message_ref: 'SM123',
      received_at: T0,
    };
    // bus-serializable (it gets wrapped into comms.inbound.received.v1)
    expect(JSON.parse(JSON.stringify(inbound))).toEqual(inbound);
  });
});
