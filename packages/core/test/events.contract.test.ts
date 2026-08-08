/**
 * T-001 tester — event contracts / async backbone (docs/design/T-001.md §4, §5.3).
 *
 * AC-6: events cover inbound-comms, transcription, offer extraction,
 * valuation refresh, alert dispatch.
 * AC-7: heavy work exists ONLY as event types (ack-then-queue support).
 * Envelopes are bus-neutral: plain JSON-serializable, idempotency-keyed.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isQuarantinedInbound } from '@core';
import type {
  AlertDispatchRequestedV1,
  CommsInboundPayloadV1,
  CommsInboundQuarantinedV1,
  CommsInboundReceivedV1,
  EventEnvelope,
  Offer,
  OfferExtractionCompletedV1,
  OfferExtractionRequestedV1,
  SpineEvent,
  SpineEventType,
  TranscriptionCompletedV1,
  TranscriptionRequestedV1,
  ValuationRefreshCompletedV1,
  ValuationRefreshRequestedV1,
} from '@core';

const T0 = '2026-08-07T12:00:00Z';

describe('SpineEventType — AC-6 coverage of the five backbone flows', () => {
  it('is exactly the eight .v1 contracts', () => {
    expectTypeOf<SpineEventType>().toEqualTypeOf<
      | 'comms.inbound.received.v1'
      | 'comms.transcription.requested.v1'
      | 'comms.transcription.completed.v1'
      | 'offer.extraction.requested.v1'
      | 'offer.extraction.completed.v1'
      | 'valuation.refresh.requested.v1'
      | 'valuation.refresh.completed.v1'
      | 'alert.dispatch.requested.v1'
    >();
  });

  it('every type is versioned (.v1 suffix) so payloads can evolve without breaking consumers', () => {
    const ALL_TYPES: SpineEventType[] = [
      'comms.inbound.received.v1',
      'comms.transcription.requested.v1',
      'comms.transcription.completed.v1',
      'offer.extraction.requested.v1',
      'offer.extraction.completed.v1',
      'valuation.refresh.requested.v1',
      'valuation.refresh.completed.v1',
      'alert.dispatch.requested.v1',
    ];
    expect(ALL_TYPES).toHaveLength(8);
    for (const t of ALL_TYPES) expect(t).toMatch(/\.v1$/);
    // five flows all present
    expect(ALL_TYPES.filter((t) => t.startsWith('comms.inbound'))).toHaveLength(1);
    expect(ALL_TYPES.filter((t) => t.startsWith('comms.transcription'))).toHaveLength(2);
    expect(ALL_TYPES.filter((t) => t.startsWith('offer.extraction'))).toHaveLength(2);
    expect(ALL_TYPES.filter((t) => t.startsWith('valuation.refresh'))).toHaveLength(2);
    expect(ALL_TYPES.filter((t) => t.startsWith('alert.dispatch'))).toHaveLength(1);
  });
});

describe('EventEnvelope — idempotency-keyed, deal-attributable, generic', () => {
  it('requires event_id, type, occurred_at, idempotency_key, payload; deal_id optional', () => {
    expectTypeOf<keyof EventEnvelope>().toEqualTypeOf<
      'event_id' | 'type' | 'occurred_at' | 'deal_id' | 'idempotency_key' | 'payload'
    >();
    expectTypeOf<EventEnvelope['idempotency_key']>().toEqualTypeOf<string>();
    // @ts-expect-error — an envelope without idempotency_key must not typecheck
    const missing: EventEnvelope<'alert.dispatch.requested.v1', AlertDispatchRequestedV1> = {
      event_id: 'e1',
      type: 'alert.dispatch.requested.v1',
      occurred_at: T0,
      payload: { deal_id: 'd1', kind: 'flag_raised', summary: 'x' },
    };
    void missing;
  });
});

describe('all eight envelopes are constructible and JSON round-trip unchanged (bus-serializable)', () => {
  const offer: Offer = {
    sale_price: 2_850_000,
    fees: [{ name: 'doc fee', amount: 59_900 }],
    apr: 8.9,
    term_months: 72,
    monthly: 51_200,
    flags: ['rate_markup'],
  };

  const envelope = <TType extends SpineEventType, TPayload>(
    type: TType,
    idempotency_key: string,
    payload: TPayload,
    deal_id?: string,
  ): EventEnvelope<TType, TPayload> => ({
    event_id: `evt-${type}`,
    type,
    occurred_at: T0,
    ...(deal_id !== undefined ? { deal_id } : {}),
    idempotency_key,
    payload,
  });

  const all: SpineEvent[] = [
    envelope('comms.inbound.received.v1', 'mock-telephony:SM123', {
      source: 'mock-telephony',
      inbound: {
        channel: 'sms',
        to_identity: { phone_number: '+15550001111' },
        from: { phone: '+15559990000' },
        body: 'We can do 28,500',
        provider_message_ref: 'SM123',
        received_at: T0,
      },
    } satisfies CommsInboundReceivedV1),
    envelope('comms.transcription.requested.v1', 'd1:CA55:transcription.requested', {
      deal_id: 'd1',
      dealer_id: 'dlr-1',
      call_ref: 'call-audio-handle-55',
      provider_message_ref: 'CA55',
    } satisfies TranscriptionRequestedV1, 'd1'),
    envelope('comms.transcription.completed.v1', 'd1:CA55:transcription.completed', {
      deal_id: 'd1',
      dealer_id: 'dlr-1',
      provider_message_ref: 'CA55',
      transcript: 'out the door twenty-eight five',
    } satisfies TranscriptionCompletedV1, 'd1'),
    envelope('offer.extraction.requested.v1', 'd1:SM123:extraction.requested', {
      deal_id: 'd1',
      dealer_id: 'dlr-1',
      provider_message_ref: 'SM123',
      channel: 'sms',
      text: 'We can do 28,500',
    } satisfies OfferExtractionRequestedV1, 'd1'),
    envelope('offer.extraction.completed.v1', 'd1:SM123:extraction.completed', {
      deal_id: 'd1',
      dealer_id: 'dlr-1',
      provider_message_ref: 'SM123',
      offer,
    } satisfies OfferExtractionCompletedV1, 'd1'),
    envelope('valuation.refresh.requested.v1', 'd1:2026-08-07', {
      deal_id: 'd1',
      request: { vehicle: { make: 'Toyota', model: 'RAV4' }, mileage: 24_000 },
    } satisfies ValuationRefreshRequestedV1, 'd1'),
    envelope('valuation.refresh.completed.v1', 'd1:2026-08-07', {
      deal_id: 'd1',
      snapshot: {
        vehicle: { make: 'Toyota', model: 'RAV4' },
        values: { retail: 2_900_000 },
        source: 'mock-kbb',
        fetched_at: T0,
      },
    } satisfies ValuationRefreshCompletedV1, 'd1'),
    envelope('alert.dispatch.requested.v1', 'd1:flag_raised:SM123', {
      deal_id: 'd1',
      kind: 'flag_raised',
      flags: ['rate_markup'],
      summary: 'Rate markup detected on latest offer',
    } satisfies AlertDispatchRequestedV1, 'd1'),
  ];

  it('covers each SpineEventType exactly once', () => {
    expect(new Set(all.map((e) => e.type)).size).toBe(8);
  });

  it.each(all.map((e) => [e.type, e] as const))(
    '%s round-trips JSON.parse(JSON.stringify(...)) unchanged',
    (_type, e) => {
      expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    },
  );

  it('extraction "no offer found" is a valid terminal outcome (offer absent)', () => {
    const none: OfferExtractionCompletedV1 = {
      deal_id: 'd1',
      dealer_id: 'dlr-1',
      provider_message_ref: 'SM124',
      // offer intentionally absent — the text contained no offer
    };
    expect(none).not.toHaveProperty('offer');
    expectTypeOf<OfferExtractionCompletedV1['offer']>().toEqualTypeOf<Offer | undefined>();
  });

  it('SpineEvent union narrows payload by type discriminant', () => {
    for (const e of all) {
      switch (e.type) {
        case 'comms.inbound.received.v1':
          expectTypeOf(e.payload).toEqualTypeOf<CommsInboundPayloadV1>();
          if (isQuarantinedInbound(e.payload)) throw new Error('expected parsed payload');
          expect(e.payload.inbound.provider_message_ref).toBe('SM123');
          break;
        case 'offer.extraction.completed.v1':
          expectTypeOf(e.payload).toEqualTypeOf<OfferExtractionCompletedV1>();
          break;
        case 'alert.dispatch.requested.v1':
          expectTypeOf(e.payload).toEqualTypeOf<AlertDispatchRequestedV1>();
          expect(['flag_raised', 'offer_received', 'message_received']).toContain(
            e.payload.kind,
          );
          break;
        default:
          break;
      }
    }
  });

  it('alert kinds are exactly the three notification triggers', () => {
    expectTypeOf<AlertDispatchRequestedV1['kind']>().toEqualTypeOf<
      'flag_raised' | 'offer_received' | 'message_received'
    >();
  });
});

describe('quarantine variant — comms.inbound.received.v1 carries parse failures (§5.2, binding)', () => {
  const qPayload: CommsInboundQuarantinedV1 = {
    source: 'mock-telephony',
    parse_error: {
      code: 'malformed_response',
      retryable: false,
      source: 'mock-telephony',
      message: 'webhook payload did not match expected provider shape',
    },
    raw_payload_ref: 'raw/1',
  };

  const quarantined: SpineEvent = {
    event_id: 'evt-q1',
    type: 'comms.inbound.received.v1',
    occurred_at: T0,
    idempotency_key: 'mock-telephony:quarantine:evt-q1',
    payload: qPayload,
  };

  it('a quarantine envelope IS a valid SpineEvent — no local type or untyped cast needed', () => {
    // the `quarantined` literal above typechecks as SpineEvent; runtime sanity:
    expect(quarantined.type).toBe('comms.inbound.received.v1');
  });

  it('round-trips JSON.parse(JSON.stringify(...)) unchanged (bus-serializable)', () => {
    expect(JSON.parse(JSON.stringify(quarantined))).toEqual(quarantined);
  });

  it('isQuarantinedInbound narrows both variants of the inbound payload', () => {
    const parsed: CommsInboundPayloadV1 = {
      source: 'mock-telephony',
      inbound: {
        channel: 'sms',
        to_identity: { phone_number: '+15550001111' },
        from: { phone: '+15559990000' },
        body: 'We can do 28,500',
        provider_message_ref: 'SM123',
        received_at: T0,
      },
    };
    const q: CommsInboundPayloadV1 = qPayload;
    expect(isQuarantinedInbound(parsed)).toBe(false);
    expect(isQuarantinedInbound(q)).toBe(true);
    if (isQuarantinedInbound(q)) {
      expectTypeOf(q).toEqualTypeOf<CommsInboundQuarantinedV1>();
      expect(q.parse_error.retryable).toBe(false);
    }
  });

  it('quarantine carries a raw-payload REFERENCE, never the raw payload itself', () => {
    const keys = Object.keys(quarantined.payload).sort();
    expect(keys).toEqual(['parse_error', 'raw_payload_ref', 'source']);
    expectTypeOf<CommsInboundQuarantinedV1['raw_payload_ref']>().toEqualTypeOf<string>();
  });
});

describe('at-least-once consumption — consumers dedupe on idempotency_key (§5.3)', () => {
  it('two delivery attempts of the same fact (equal keys, distinct event_ids) process once', () => {
    const make = (event_id: string): SpineEvent => ({
      event_id,
      type: 'comms.transcription.completed.v1',
      occurred_at: T0,
      deal_id: 'd1',
      idempotency_key: 'd1:CA55:transcription.completed', // producer-derived, fixed per type
      payload: {
        deal_id: 'd1',
        dealer_id: 'dlr-1',
        provider_message_ref: 'CA55',
        transcript: 'twenty-eight five out the door',
      },
    });
    const attempt1 = make('evt-a');
    const attempt2 = make('evt-b'); // redelivery: new publish attempt, same fact
    expect(attempt1.event_id).not.toBe(attempt2.event_id);
    expect(attempt1.idempotency_key).toBe(attempt2.idempotency_key);

    const processed = new Map<string, SpineEvent>();
    let sideEffects = 0;
    const consume = (e: SpineEvent) => {
      if (processed.has(e.idempotency_key)) return; // idempotent consumer
      processed.set(e.idempotency_key, e);
      sideEffects += 1;
    };
    consume(attempt1);
    consume(attempt2);
    expect(sideEffects).toBe(1);
    expect(processed.size).toBe(1);
  });
});
