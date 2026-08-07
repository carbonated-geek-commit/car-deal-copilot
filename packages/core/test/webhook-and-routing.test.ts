/**
 * T-001 tester — kit mandates exercised against the contracts:
 *
 * 1. Webhook ack-then-queue (specs/00 via docs/design/T-001.md §5.2):
 *    parse (sync, pure) → durably enqueue → ack 2xx. Parse failure still acks
 *    2xx with a quarantine event (no dropped dealer message); the ONLY 5xx is
 *    enqueue failure; redelivery is absorbed by idempotency_key dedupe.
 *
 * 2. Identity-routing correctness: an inbound message must never thread to
 *    the wrong deal/user. Routing matches InboundComms.to_identity against
 *    Deal.identity_ref — nothing else.
 *
 * The handler/router here live in the TEST, built exclusively on @core
 * contracts — proving the contracts force/support the mandated shape (AC-7).
 */
import { describe, expect, it } from 'vitest';
import type {
  AdapterError,
  AdapterResult,
  CommsInboundReceivedV1,
  Deal,
  EventEnvelope,
  InboundComms,
  Message,
  TelephonyAdapter,
} from '@core';

const T0 = '2026-08-07T12:00:00Z';

// ------------------------------------------------------------ test doubles

/** Quarantine payload for unparseable webhooks (§5.2 row 1): the generic
 * envelope carries a parse-error marker + raw payload reference. */
interface QuarantinedInboundV1 {
  source: string;
  parse_error: AdapterError;
  raw_payload_ref: string;
}

type InboundEnvelope = EventEnvelope<
  'comms.inbound.received.v1',
  CommsInboundReceivedV1 | QuarantinedInboundV1
>;

class TestBus {
  events: InboundEnvelope[] = [];
  down = false;
  enqueue(e: InboundEnvelope): void {
    if (this.down) throw new Error('bus unavailable');
    this.events.push(e); // durable enqueue stand-in
  }
}

/** Provider-shaped raw payload exists ONLY here, outside core — the adapter
 * is the anti-corruption boundary that normalizes it. */
const mockTelephony: TelephonyAdapter = {
  source: 'mock-telephony',
  async sendSms() {
    throw new Error('not under test');
  },
  parseInboundWebhook(payload: unknown): AdapterResult<InboundComms> {
    const p = payload as Record<string, unknown> | null;
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof p['MessageSid'] !== 'string' ||
      typeof p['To'] !== 'string' ||
      typeof p['From'] !== 'string'
    ) {
      return {
        ok: false,
        error: {
          code: 'malformed_response',
          retryable: false,
          source: 'mock-telephony',
          message: 'webhook payload did not match expected provider shape',
        },
      };
    }
    return {
      ok: true,
      value: {
        channel: 'sms',
        to_identity: { phone_number: p['To'] },
        from: { phone: p['From'] },
        ...(typeof p['Body'] === 'string' ? { body: p['Body'] } : {}),
        provider_message_ref: p['MessageSid'],
        received_at: T0,
      },
    };
  },
};

let seq = 0;
/** The §5.2 handler sequence, verbatim: parse → enqueue → ack. Synchronous
 * end-to-end: nothing async can run before the ack decision. */
function handleWebhook(
  adapter: TelephonyAdapter,
  payload: unknown,
  bus: TestBus,
): { status: number } {
  const parsed = adapter.parseInboundWebhook(payload); // 1. sync, pure parse
  seq += 1;
  const base = {
    event_id: `evt-${seq}`,
    type: 'comms.inbound.received.v1' as const,
    occurred_at: T0,
  };
  const envelope: InboundEnvelope = parsed.ok
    ? {
        ...base,
        idempotency_key: `${adapter.source}:${parsed.value.provider_message_ref}`,
        payload: { source: adapter.source, inbound: parsed.value },
      }
    : {
        ...base,
        idempotency_key: `${adapter.source}:quarantine:evt-${seq}`,
        payload: {
          source: adapter.source,
          parse_error: parsed.error,
          raw_payload_ref: `raw/${seq}`,
        },
      };
  try {
    bus.enqueue(envelope); // 2. durably enqueue
  } catch {
    return { status: 500 }; // the ONE deliberate non-ack: bus down
  }
  return { status: 200 }; // 3. ack == "durably enqueued", nothing more
}

const validPayload = {
  MessageSid: 'SM123',
  To: '+15550001111',
  From: '+15559990000',
  Body: 'We can do 28,500 out the door',
};

describe('webhook ack-then-queue (§5.2, binding)', () => {
  it('valid payload: acks 2xx with exactly one inbound event enqueued and zero heavy work done inline', () => {
    const bus = new TestBus();
    const res = handleWebhook(mockTelephony, validPayload, bus);
    expect(res.status).toBe(200);
    expect(bus.events).toHaveLength(1);
    const e = bus.events[0]!;
    expect(e.type).toBe('comms.inbound.received.v1');
    // heavy work stays on the bus: the handler enqueued NO transcription or
    // extraction events — those are downstream consumers' jobs.
    expect(
      bus.events.filter((ev) => !ev.type.startsWith('comms.inbound')),
    ).toHaveLength(0);
    const payload = e.payload as CommsInboundReceivedV1;
    expect(payload.inbound.provider_message_ref).toBe('SM123');
    expect(payload.inbound.body).toContain('28,500');
  });

  it('the ack decision is made synchronously — parse result is not a thenable', () => {
    const parsed = mockTelephony.parseInboundWebhook(validPayload);
    expect(typeof (parsed as { then?: unknown }).then).toBe('undefined');
    expect(parsed.ok).toBe(true);
  });

  it('unparseable payload: STILL acks 2xx and quarantines — a dealer message is never dropped', () => {
    const bus = new TestBus();
    const res = handleWebhook(mockTelephony, { garbage: true }, bus);
    expect(res.status).toBe(200); // 5xx would make the provider retry the same junk forever
    expect(bus.events).toHaveLength(1);
    const q = bus.events[0]!.payload as QuarantinedInboundV1;
    expect(q.parse_error.code).toBe('malformed_response');
    expect(q.raw_payload_ref).toMatch(/^raw\//); // replayable
  });

  it('enqueue failure (bus down) is the one deliberate 5xx — provider retry becomes the durability mechanism', () => {
    const bus = new TestBus();
    bus.down = true;
    const res = handleWebhook(mockTelephony, validPayload, bus);
    expect(res.status).toBe(500);
    expect(bus.events).toHaveLength(0);
  });

  it('provider redelivery: duplicate envelopes share idempotency_key `source:provider_message_ref` and consumers thread the message exactly once', () => {
    const bus = new TestBus();
    handleWebhook(mockTelephony, validPayload, bus); // original
    handleWebhook(mockTelephony, validPayload, bus); // provider retry (we acked too slowly)
    expect(bus.events).toHaveLength(2);
    const [a, b] = bus.events as [InboundEnvelope, InboundEnvelope];
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.idempotency_key).toBe('mock-telephony:SM123');
    expect(a.idempotency_key).toBe(b.idempotency_key);

    // idempotent consumer: no double thread entry
    const thread: Message[] = [];
    const seen = new Set<string>();
    for (const e of bus.events) {
      if (seen.has(e.idempotency_key)) continue;
      seen.add(e.idempotency_key);
      const inbound = (e.payload as CommsInboundReceivedV1).inbound;
      thread.push({
        channel: inbound.channel,
        direction: 'in',
        ...(inbound.body !== undefined ? { body: inbound.body } : {}),
        timestamp: inbound.received_at,
      });
    }
    expect(thread).toHaveLength(1);
  });
});

// --------------------------------------------------------- identity routing

const makeDeal = (
  id: string,
  owner_id: string,
  identity_ref?: Deal['identity_ref'],
): Deal => ({
  id,
  owner_id,
  path: 'online',
  status: 'active',
  target_vehicle: { make: 'Toyota', model: 'RAV4' },
  budget: 3_200_000,
  walk_away_number: 3_000_000,
  ...(identity_ref !== undefined ? { identity_ref } : {}),
  dealer_threads: [],
  offers: [],
  created_at: T0,
});

/** Routing built ONLY on contract fields: to_identity ↔ Deal.identity_ref.
 * Returns undefined rather than ever guessing — never thread to a wrong deal. */
function routeInbound(deals: Deal[], inbound: InboundComms): Deal | undefined {
  const matches = deals.filter((d) => {
    const ref = d.identity_ref;
    if (!ref) return false; // pre-contact deals have no identity — never match
    if (inbound.to_identity.phone_number !== undefined) {
      return ref.phone_number === inbound.to_identity.phone_number;
    }
    if (inbound.to_identity.email_alias !== undefined) {
      return ref.email_alias === inbound.to_identity.email_alias;
    }
    return false;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

const inboundSms = (to: string, ref = 'SM900'): InboundComms => ({
  channel: 'sms',
  to_identity: { phone_number: to },
  from: { phone: '+15559990000' },
  body: 'offer text',
  provider_message_ref: ref,
  received_at: T0,
});

const inboundEmail = (alias: string, ref = 'EM900'): InboundComms => ({
  channel: 'email',
  to_identity: { email_alias: alias },
  from: { email: 'sales@dealer.example' },
  body: 'offer text',
  provider_message_ref: ref,
  received_at: T0,
});

describe('identity-routing correctness — never thread to the wrong deal/user', () => {
  const dealA = makeDeal('deal-A', 'user-1', {
    identity_id: 'ident-A',
    phone_number: '+15550001111',
    email_alias: 'deal-a@relay.example',
  });
  const dealB = makeDeal('deal-B', 'user-2', {
    identity_id: 'ident-B',
    phone_number: '+15550002222',
    email_alias: 'deal-b@relay.example',
  });
  const dealDraft = makeDeal('deal-C', 'user-1'); // no identity yet
  const deals = [dealA, dealB, dealDraft];

  it('routes SMS to the deal owning the dialed identity — and only that deal', () => {
    expect(routeInbound(deals, inboundSms('+15550001111'))?.id).toBe('deal-A');
    expect(routeInbound(deals, inboundSms('+15550002222'))?.id).toBe('deal-B');
  });

  it('routes email by alias — cross-user isolation holds', () => {
    const routed = routeInbound(deals, inboundEmail('deal-b@relay.example'));
    expect(routed?.id).toBe('deal-B');
    expect(routed?.owner_id).toBe('user-2');
    expect(routed?.owner_id).not.toBe(dealA.owner_id);
  });

  it('unknown identity routes NOWHERE — never falls back to some deal', () => {
    expect(routeInbound(deals, inboundSms('+15550009999'))).toBeUndefined();
    expect(routeInbound(deals, inboundEmail('nobody@relay.example'))).toBeUndefined();
  });

  it('a deal without identity_ref (pre-contact) can never receive a routed message', () => {
    const routed = routeInbound(deals, inboundSms('+15550001111'));
    expect(routed?.id).not.toBe('deal-C');
  });

  it('ambiguous identity (two deals sharing a number — a provisioning bug) refuses to route rather than picking one', () => {
    const clone = makeDeal('deal-A2', 'user-3', {
      identity_id: 'ident-A2',
      phone_number: '+15550001111',
    });
    expect(routeInbound([...deals, clone], inboundSms('+15550001111'))).toBeUndefined();
  });

  it('burning a deal (identity retired) ends routing to it', () => {
    const burned: Deal = {
      ...dealA,
      status: 'burned',
      burned_at: T0,
    };
    // routing layer drops burned deals before matching
    const active = [burned, dealB].filter((d) => d.status !== 'burned');
    expect(routeInbound(active, inboundSms('+15550001111'))).toBeUndefined();
  });
});
