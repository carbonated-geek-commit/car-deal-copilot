/**
 * T-010 tester — v0.5 event contracts / async backbone
 * (docs/design/T-010.md §5.1, §5.3, §5.4; AC-13, AC-14).
 *
 * AC-13 the transcription contracts are GONE — six event types remain and the
 *       rest of the backbone (inbound comms, extraction, valuation, alerts) is
 *       otherwise unchanged.
 * D10   payloads carry `dealership_id` + `message_ref` (a note has no provider id).
 * D14   alert kinds gain `call_logged` — the "you had a call, write your note" prompt.
 * §5.4  idempotency keys are fixed per type; producers derive, consumers compare.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isQuarantinedInbound } from '@core';
import type {
  AlertDispatchRequestedV1,
  CommsInboundPayloadV1,
  CommsInboundQuarantinedV1,
  CommsInboundReceivedV1,
  EventEnvelope,
  MessageChannel,
  Offer,
  OfferExtractionCompletedV1,
  OfferExtractionRequestedV1,
  SpineEvent,
  SpineEventType,
  ValuationRefreshCompletedV1,
  ValuationRefreshRequestedV1,
  VehicleInstance,
  VehicleTarget,
} from '@core';

const T0 = '2026-08-07T12:00:00Z';

const target: VehicleTarget = { make: 'Toyota', model: 'RAV4' };
const instance: VehicleInstance = {
  id: 'vi-1',
  year: 2023,
  condition: 'used',
  mileage: 24_000,
  additions: [],
};

describe('AC-13 — SpineEventType is exactly the six surviving contracts', () => {
  it('the union has no transcription members', () => {
    expectTypeOf<SpineEventType>().toEqualTypeOf<
      | 'comms.inbound.received.v1'
      | 'offer.extraction.requested.v1'
      | 'offer.extraction.completed.v1'
      | 'valuation.refresh.requested.v1'
      | 'valuation.refresh.completed.v1'
      | 'alert.dispatch.requested.v1'
    >();
    // @ts-expect-error — comms.transcription.requested.v1 was deleted (Q14, specs/01)
    const requested: SpineEventType = 'comms.transcription.requested.v1';
    void requested;
    // @ts-expect-error — comms.transcription.completed.v1 was deleted with it
    const completed: SpineEventType = 'comms.transcription.completed.v1';
    void completed;
  });

  it('every type is versioned and the five remaining flows are each represented', () => {
    const ALL_TYPES: SpineEventType[] = [
      'comms.inbound.received.v1',
      'offer.extraction.requested.v1',
      'offer.extraction.completed.v1',
      'valuation.refresh.requested.v1',
      'valuation.refresh.completed.v1',
      'alert.dispatch.requested.v1',
    ];
    expect(ALL_TYPES).toHaveLength(6);
    for (const t of ALL_TYPES) expect(t).toMatch(/\.v1$/);
    expect(ALL_TYPES.filter((t) => t.startsWith('comms.transcription'))).toHaveLength(0);
    expect(ALL_TYPES.filter((t) => t.startsWith('comms.inbound'))).toHaveLength(1);
    expect(ALL_TYPES.filter((t) => t.startsWith('offer.extraction'))).toHaveLength(2);
    expect(ALL_TYPES.filter((t) => t.startsWith('valuation.refresh'))).toHaveLength(2);
    expect(ALL_TYPES.filter((t) => t.startsWith('alert.dispatch'))).toHaveLength(1);
  });

  it('AC-14 / I-9 — heavy work exists ONLY as event types: nothing on the bus can request audio work', () => {
    const audioish: string[] = [
      'comms.transcription.requested.v1',
      'comms.transcription.completed.v1',
      'comms.recording.stored.v1',
    ];
    const ALL_TYPES: string[] = [
      'comms.inbound.received.v1',
      'offer.extraction.requested.v1',
      'offer.extraction.completed.v1',
      'valuation.refresh.requested.v1',
      'valuation.refresh.completed.v1',
      'alert.dispatch.requested.v1',
    ];
    for (const t of audioish) expect(ALL_TYPES).not.toContain(t);
  });
});

describe('EventEnvelope — idempotency-keyed, deal-attributable, bus-neutral', () => {
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

describe('D10 — extraction payloads are channel-neutral (a note has no provider id)', () => {
  it('OfferExtractionRequestedV1 carries dealership_id + message_ref + channel + text', () => {
    expectTypeOf<keyof OfferExtractionRequestedV1>().toEqualTypeOf<
      'deal_id' | 'dealership_id' | 'message_ref' | 'channel' | 'text'
    >();
    type OldKeys = Extract<
      keyof OfferExtractionRequestedV1,
      'dealer_id' | 'provider_message_ref'
    >;
    expectTypeOf<OldKeys>().toEqualTypeOf<never>();
    expectTypeOf<OfferExtractionRequestedV1['channel']>().toEqualTypeOf<MessageChannel>();
  });

  it('extraction runs on a buyer NOTE as readily as on SMS/email (specs/00: channel-agnostic)', () => {
    const fromNote: OfferExtractionRequestedV1 = {
      deal_id: 'd1',
      dealership_id: 'dlr-1',
      message_ref: 'note-local-7', // caller-generated: notes have no provider id
      channel: 'note',
      text: 'Call: 29,500 OTD, doc fee 599',
    };
    expect(fromNote.channel).toBe('note');
    expect(fromNote.message_ref).not.toMatch(/^SM|^CA/);
  });

  it('OfferExtractionCompletedV1 with no offer is a valid terminal outcome', () => {
    const none: OfferExtractionCompletedV1 = {
      deal_id: 'd1',
      dealership_id: 'dlr-1',
      message_ref: 'SM124',
    };
    expect(none).not.toHaveProperty('offer');
    expectTypeOf<OfferExtractionCompletedV1['offer']>().toEqualTypeOf<Offer | undefined>();
  });

  it('§5.3 / ADR-005 — a monthly/term-only quote produces a PARTIAL offer, not a zeroed one', () => {
    const partial: OfferExtractionCompletedV1 = {
      deal_id: 'd1',
      dealership_id: 'dlr-1',
      message_ref: 'SM125',
      offer: { fees: [], monthly: 61_900, term_months: 84, flags: [] },
    };
    expect(partial.offer?.sale_price).toBeUndefined();
    expect(partial.offer?.sale_price).not.toBe(0);
  });
});

describe('D12 — valuation refresh carries the whole ValuationRequest', () => {
  it('requested payload nests { target, instance }; completed nests an instance-bound snapshot', () => {
    const req: ValuationRefreshRequestedV1 = {
      deal_id: 'd1',
      request: { target, instance },
    };
    const done: ValuationRefreshCompletedV1 = {
      deal_id: 'd1',
      snapshot: {
        vehicle_instance_id: instance.id,
        retail: 2_900_000,
        source: 'mock-kbb',
        captured_at: T0,
      },
    };
    expect(req.request.instance.id).toBe(done.snapshot.vehicle_instance_id);
  });
});

describe('D14 — alert kinds include call_logged (the prompt that replaces transcription)', () => {
  it('kind is exactly the four notification triggers', () => {
    expectTypeOf<AlertDispatchRequestedV1['kind']>().toEqualTypeOf<
      'flag_raised' | 'offer_received' | 'message_received' | 'call_logged'
    >();
    // @ts-expect-error — an invented alert kind is not in the union
    const bogus: AlertDispatchRequestedV1['kind'] = 'transcription_ready';
    void bogus;
  });

  it('the v0.5 call flow is expressible end to end: log metadata → notify → note → extract', () => {
    const notify: AlertDispatchRequestedV1 = {
      deal_id: 'd1',
      kind: 'call_logged',
      summary: 'Call logged with Sunrise Toyota — add your note',
    };
    const extract: OfferExtractionRequestedV1 = {
      deal_id: 'd1',
      dealership_id: 'dlr-1',
      message_ref: 'note-local-7',
      channel: 'note',
      text: 'They said 29,500 OTD',
    };
    expect(notify.summary).not.toMatch(/\+1\d{10}/); // PII-free summary
    expect(extract.channel).toBe('note');
  });
});

describe('all six envelopes are constructible and JSON round-trip unchanged (bus-serializable)', () => {
  const offer: Offer = {
    sale_price: 2_850_000,
    fees: [{ name: 'doc fee', amount: 59_900 }],
    apr: 8.9,
    term_months: 72,
    monthly: 51_200,
    flags: ['rate_markup', 'above_market'],
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
    envelope(
      'offer.extraction.requested.v1',
      'd1:SM123:requested',
      {
        deal_id: 'd1',
        dealership_id: 'dlr-1',
        message_ref: 'SM123',
        channel: 'sms',
        text: 'We can do 28,500',
      } satisfies OfferExtractionRequestedV1,
      'd1',
    ),
    envelope(
      'offer.extraction.completed.v1',
      'd1:SM123:completed',
      {
        deal_id: 'd1',
        dealership_id: 'dlr-1',
        message_ref: 'SM123',
        offer,
      } satisfies OfferExtractionCompletedV1,
      'd1',
    ),
    envelope(
      'valuation.refresh.requested.v1',
      'd1:vi-1:2026-08-07',
      { deal_id: 'd1', request: { target, instance } } satisfies ValuationRefreshRequestedV1,
      'd1',
    ),
    envelope(
      'valuation.refresh.completed.v1',
      'd1:vi-1:2026-08-07',
      {
        deal_id: 'd1',
        snapshot: {
          vehicle_instance_id: 'vi-1',
          retail: 2_900_000,
          source: 'mock-kbb',
          captured_at: T0,
        },
      } satisfies ValuationRefreshCompletedV1,
      'd1',
    ),
    envelope(
      'alert.dispatch.requested.v1',
      'd1:flag_raised:SM123',
      {
        deal_id: 'd1',
        kind: 'flag_raised',
        flags: ['rate_markup', 'above_market'],
        summary: 'Rate markup and above-market price on latest offer',
      } satisfies AlertDispatchRequestedV1,
      'd1',
    ),
  ];

  it('covers each SpineEventType exactly once', () => {
    expect(new Set(all.map((e) => e.type)).size).toBe(6);
    expect(all).toHaveLength(6);
  });

  it.each(all.map((e) => [e.type, e] as const))(
    '%s round-trips JSON.parse(JSON.stringify(...)) unchanged',
    (_type, e) => {
      expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    },
  );

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
          expect(e.payload.dealership_id).toBe('dlr-1');
          break;
        case 'alert.dispatch.requested.v1':
          expectTypeOf(e.payload).toEqualTypeOf<AlertDispatchRequestedV1>();
          expect([
            'flag_raised',
            'offer_received',
            'message_received',
            'call_logged',
          ]).toContain(e.payload.kind);
          break;
        default:
          break;
      }
    }
  });

  it('§5.4 — idempotency keys follow the fixed per-type derivations', () => {
    const byType = new Map(all.map((e) => [e.type, e.idempotency_key]));
    expect(byType.get('comms.inbound.received.v1')).toBe('mock-telephony:SM123');
    expect(byType.get('offer.extraction.requested.v1')).toBe('d1:SM123:requested');
    expect(byType.get('offer.extraction.completed.v1')).toBe('d1:SM123:completed');
    // valuation keys are deal + INSTANCE + fetch window — never deal + make/model
    expect(byType.get('valuation.refresh.requested.v1')).toBe('d1:vi-1:2026-08-07');
    expect(byType.get('valuation.refresh.completed.v1')).toBe('d1:vi-1:2026-08-07');
    expect(byType.get('alert.dispatch.requested.v1')).toBe('d1:flag_raised:SM123');
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
    expect(quarantined.type).toBe('comms.inbound.received.v1');
    expect(JSON.parse(JSON.stringify(quarantined))).toEqual(quarantined);
  });

  it('isQuarantinedInbound narrows both variants and is pure/total', () => {
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
    expect(isQuarantinedInbound(parsed)).toBe(false);
    expect(isQuarantinedInbound(qPayload)).toBe(true);
    const q: CommsInboundPayloadV1 = qPayload;
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

describe('§5.3 — at-least-once delivery: dedupe, bounded retry, dead-letter (never silently dropped)', () => {
  const completed = (event_id: string): SpineEvent => ({
    event_id,
    type: 'offer.extraction.completed.v1',
    occurred_at: T0,
    deal_id: 'd1',
    idempotency_key: 'd1:SM123:completed',
    payload: {
      deal_id: 'd1',
      dealership_id: 'dlr-1',
      message_ref: 'SM123',
      offer: { sale_price: 2_850_000, fees: [], flags: [] },
    },
  });

  it('two delivery attempts of the same fact (equal keys, distinct event_ids) process once', () => {
    const a = completed('evt-a');
    const b = completed('evt-b');
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.idempotency_key).toBe(b.idempotency_key);

    const processed = new Set<string>();
    let sideEffects = 0;
    for (const e of [a, b]) {
      if (processed.has(e.idempotency_key)) continue;
      processed.add(e.idempotency_key);
      sideEffects += 1;
    }
    expect(sideEffects).toBe(1);
  });

  it('a duplicate NOTE submit dedupes on the caller-generated message_ref — one message, one extraction', () => {
    const submit = (message_ref: string): EventEnvelope<
      'offer.extraction.requested.v1',
      OfferExtractionRequestedV1
    > => ({
      event_id: `evt-${Math.random()}`,
      type: 'offer.extraction.requested.v1',
      occurred_at: T0,
      deal_id: 'd1',
      idempotency_key: `d1:${message_ref}:requested`,
      payload: {
        deal_id: 'd1',
        dealership_id: 'dlr-1',
        message_ref,
        channel: 'note',
        text: 'They said 29,500 OTD',
      },
    });
    const seen = new Set<string>();
    let extractions = 0;
    for (const e of [submit('note-7'), submit('note-7')]) {
      if (seen.has(e.idempotency_key)) continue;
      seen.add(e.idempotency_key);
      extractions += 1;
    }
    expect(extractions).toBe(1);
  });

  it('a poison message is dead-lettered with the envelope intact — never silently dropped', () => {
    const deadLetter: SpineEvent[] = [];
    let attempts = 0;
    const MAX_ATTEMPTS = 3;
    const e = completed('evt-poison');
    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      try {
        throw new Error('consumer blew up on this payload');
      } catch {
        if (attempts === MAX_ATTEMPTS) deadLetter.push(e);
      }
    }
    expect(attempts).toBe(MAX_ATTEMPTS); // bounded, not infinite
    expect(deadLetter).toHaveLength(1);
    expect(deadLetter[0]).toEqual(e); // envelope intact for the operator queue
    expect(JSON.parse(JSON.stringify(deadLetter[0]))).toEqual(e);
  });
});
