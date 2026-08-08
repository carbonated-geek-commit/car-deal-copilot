/**
 * T-010 tester — kit mandates exercised against the v0.5 contracts.
 *
 * 1. Webhook ack-then-queue (AC-14 / I-9, docs/design/T-010.md §5.2):
 *    parse (sync, pure) → durably enqueue → ack 2xx. Parse failure STILL acks
 *    2xx with a quarantine event; the ONLY 5xx is enqueue failure; redelivery is
 *    absorbed by idempotency_key dedupe; an inbound claiming `note` is a parse
 *    failure, never a fabricated internal message (D11 / I-7).
 * 2. Identity routing never crosses accounts or deals.
 * 3. Make/model mismatch rejection (specs/00 "Cardinality invariants"): the
 *    contradiction is caught at INPUT, because a VehicleInstance cannot carry
 *    make/model at all.
 * 4. Dealership tenancy: the global record is shareable; contacts are not
 *    reachable across accounts, and a cross-account read is indistinguishable
 *    from not-found (§5.3).
 * 5. Append-only receipt trail: messages accumulate; nothing in core offers an
 *    update or delete path.
 *
 * The handler/router/validator here live in the TEST, built exclusively on
 * @core contracts — proving the contracts force the mandated shape.
 */
import { describe, expect, it } from 'vitest';
import { isQuarantinedInbound, isTargetVehicleLocked } from '@core';
import type {
  AdapterResult,
  CommsInboundPayloadV1,
  Deal,
  DealerThread,
  Dealership,
  DealershipContact,
  EventEnvelope,
  InboundComms,
  Message,
  TelephonyAdapter,
  VehicleInstance,
  VehicleTarget,
  VinDecode,
} from '@core';

const T0 = '2026-08-07T12:00:00Z';

// ------------------------------------------------------------ test doubles

type InboundEnvelope = EventEnvelope<'comms.inbound.received.v1', CommsInboundPayloadV1>;

class TestBus {
  events: InboundEnvelope[] = [];
  down = false;
  enqueue(e: InboundEnvelope): void {
    if (this.down) throw new Error('bus unavailable');
    this.events.push(e);
  }
}

/** Provider-shaped raw payload exists ONLY here, outside core — the adapter is
 * the anti-corruption boundary that normalizes it. */
const mockTelephony: TelephonyAdapter = {
  source: 'mock-telephony',
  async sendSms() {
    throw new Error('not under test');
  },
  parseInboundWebhook(payload: unknown): AdapterResult<InboundComms> {
    const p = payload as Record<string, unknown> | null;
    const malformed: AdapterResult<InboundComms> = {
      ok: false,
      error: {
        code: 'malformed_response',
        retryable: false,
        source: 'mock-telephony',
        message: 'webhook payload did not match expected provider shape',
      },
    };
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof p['MessageSid'] !== 'string' ||
      typeof p['To'] !== 'string' ||
      typeof p['From'] !== 'string'
    ) {
      return malformed;
    }
    // D11: a provider payload that decodes to a note is a PARSE FAILURE, not an
    // internal message — notes are authored in-app and never arrive by webhook.
    if (p['Channel'] === 'note') return malformed;
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
/** The §5.2 handler sequence, verbatim: parse → enqueue → ack. */
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

describe('AC-14 / I-9 — webhook ack-then-queue (unaffected by the v0.5 migration)', () => {
  it('valid payload: acks 2xx with exactly one inbound event and zero heavy work inline', () => {
    const bus = new TestBus();
    const res = handleWebhook(mockTelephony, validPayload, bus);
    expect(res.status).toBe(200);
    expect(bus.events).toHaveLength(1);
    const e = bus.events[0]!;
    expect(e.type).toBe('comms.inbound.received.v1');
    expect(bus.events.filter((ev) => !ev.type.startsWith('comms.inbound'))).toHaveLength(0);
    if (isQuarantinedInbound(e.payload)) throw new Error('expected parsed payload');
    expect(e.payload.inbound.provider_message_ref).toBe('SM123');
  });

  it('the ack decision is made synchronously — the parse result is not a thenable', () => {
    const parsed = mockTelephony.parseInboundWebhook(validPayload);
    expect(typeof (parsed as { then?: unknown }).then).toBe('undefined');
    expect(parsed.ok).toBe(true);
  });

  it('unparseable payload: STILL acks 2xx and quarantines — a dealer message is never dropped', () => {
    const bus = new TestBus();
    const res = handleWebhook(mockTelephony, { garbage: true }, bus);
    expect(res.status).toBe(200);
    const q = bus.events[0]!.payload;
    if (!isQuarantinedInbound(q)) throw new Error('expected quarantined payload');
    expect(q.parse_error.code).toBe('malformed_response');
    expect(q.raw_payload_ref).toMatch(/^raw\//); // replayable
  });

  it('D11 / I-7 — a payload claiming channel `note` quarantines rather than fabricating an internal message', () => {
    const bus = new TestBus();
    const res = handleWebhook(
      mockTelephony,
      { ...validPayload, MessageSid: 'SM777', Channel: 'note' },
      bus,
    );
    expect(res.status).toBe(200);
    const q = bus.events[0]!.payload;
    expect(isQuarantinedInbound(q)).toBe(true);
    // nothing authored-looking reached the bus
    const threaded = bus.events.filter((e) => !isQuarantinedInbound(e.payload));
    expect(threaded).toHaveLength(0);
  });

  it('enqueue failure (bus down) is the one deliberate 5xx — provider retry becomes the durability mechanism', () => {
    const bus = new TestBus();
    bus.down = true;
    expect(handleWebhook(mockTelephony, validPayload, bus).status).toBe(500);
    expect(bus.events).toHaveLength(0);
  });

  it('redelivery: duplicates share `source:provider_message_ref` and thread exactly once, author-stamped', () => {
    const bus = new TestBus();
    handleWebhook(mockTelephony, validPayload, bus);
    handleWebhook(mockTelephony, validPayload, bus); // provider retry
    const [a, b] = bus.events as [InboundEnvelope, InboundEnvelope];
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.idempotency_key).toBe('mock-telephony:SM123');
    expect(a.idempotency_key).toBe(b.idempotency_key);

    const thread: Message[] = [];
    const seen = new Set<string>();
    for (const e of bus.events) {
      if (seen.has(e.idempotency_key)) continue;
      seen.add(e.idempotency_key);
      if (isQuarantinedInbound(e.payload)) continue;
      const inbound = e.payload.inbound;
      thread.push({
        channel: inbound.channel,
        direction: 'in',
        author: 'dealer', // I-7: stated by the ingest path, never inferred downstream
        ...(inbound.body !== undefined ? { body: inbound.body } : {}),
        timestamp: inbound.received_at,
      });
    }
    expect(thread).toHaveLength(1);
    expect(thread[0]?.author).toBe('dealer');
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
    if (!ref) return false;
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

describe('identity routing never crosses accounts or deals', () => {
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

  it('routes email by alias — cross-ACCOUNT isolation holds', () => {
    const routed = routeInbound(deals, inboundEmail('deal-b@relay.example'));
    expect(routed?.id).toBe('deal-B');
    expect(routed?.owner_id).toBe('user-2');
    expect(routed?.owner_id).not.toBe(dealA.owner_id);
  });

  it('two deals of the SAME owner do not bleed into each other', () => {
    const second = makeDeal('deal-D', 'user-1', {
      identity_id: 'ident-D',
      phone_number: '+15550003333',
    });
    const routed = routeInbound([...deals, second], inboundSms('+15550003333'));
    expect(routed?.id).toBe('deal-D');
    expect(routed?.id).not.toBe('deal-A');
  });

  it('unknown identity routes NOWHERE — never falls back to some deal', () => {
    expect(routeInbound(deals, inboundSms('+15550009999'))).toBeUndefined();
    expect(routeInbound(deals, inboundEmail('nobody@relay.example'))).toBeUndefined();
  });

  it('a deal without identity_ref (pre-contact) can never receive a routed message', () => {
    expect(routeInbound(deals, inboundSms('+15550001111'))?.id).not.toBe('deal-C');
    expect(routeInbound([dealDraft], inboundSms('+15550001111'))).toBeUndefined();
  });

  it('ambiguous identity (a provisioning bug) refuses to route rather than picking one', () => {
    const clone = makeDeal('deal-A2', 'user-3', {
      identity_id: 'ident-A2',
      phone_number: '+15550001111',
    });
    expect(routeInbound([...deals, clone], inboundSms('+15550001111'))).toBeUndefined();
  });

  it('burning a deal (identity retired) ends routing to it', () => {
    const burned: Deal = { ...dealA, status: 'burned', burned_at: T0 };
    const active = [burned, dealB].filter((d) => d.status !== 'burned');
    expect(routeInbound(active, inboundSms('+15550001111'))).toBeUndefined();
  });
});

// --------------------------------------------- make/model mismatch rejection

describe('make/model mismatch rejection (specs/00 "Cardinality invariants")', () => {
  const anchor: VehicleTarget = { make: 'Toyota', model: 'RAV4' };

  /** Buyer-entered form data — the ONLY place make/model can contradict the
   * anchor, because a VehicleInstance structurally cannot carry them (I-2). */
  interface InstanceEntry {
    id: string;
    vin?: string;
    year: number;
    condition: 'new' | 'used' | 'certified';
    make: string;
    model: string;
  }

  type Rejection = {
    ok: false;
    reason: 'vehicle_anchor_mismatch';
    highlight_vin: string | undefined;
    offer_new_deal: true;
  };

  const attachInstance = (
    target: VehicleTarget,
    entry: InstanceEntry,
  ): { ok: true; instance: VehicleInstance } | Rejection => {
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    if (!same(entry.make, target.make) || !same(entry.model, target.model)) {
      return {
        ok: false,
        reason: 'vehicle_anchor_mismatch',
        highlight_vin: entry.vin, // "highlighted in red against its VIN"
        offer_new_deal: true,
      };
    }
    return {
      ok: true,
      instance: {
        id: entry.id,
        ...(entry.vin !== undefined ? { vin: entry.vin } : {}),
        year: entry.year,
        condition: entry.condition,
        additions: [],
      },
    };
  };

  it('a matching entry becomes a VehicleInstance that carries no make/model at all', () => {
    const r = attachInstance(anchor, {
      id: 'vi-1',
      vin: '4T3ZWRFVXNU090000',
      year: 2023,
      condition: 'used',
      make: 'Toyota',
      model: 'RAV4',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.instance)).not.toContain('make');
      expect(Object.keys(r.instance)).not.toContain('model');
    }
  });

  it('a different MODEL is rejected, highlighted against its VIN, with a new-deal offer', () => {
    const r = attachInstance(anchor, {
      id: 'vi-2',
      vin: '1HGCV1F30LA000000',
      year: 2022,
      condition: 'used',
      make: 'Toyota',
      model: 'Highlander',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('vehicle_anchor_mismatch');
      expect(r.highlight_vin).toBe('1HGCV1F30LA000000');
      expect(r.offer_new_deal).toBe(true);
    }
  });

  it('a different MAKE is rejected the same way', () => {
    const r = attachInstance(anchor, {
      id: 'vi-3',
      year: 2023,
      condition: 'used',
      make: 'Honda',
      model: 'RAV4',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.highlight_vin).toBeUndefined(); // no VIN entered: still rejected
  });

  it('case/whitespace differences are not a mismatch', () => {
    const r = attachInstance(anchor, {
      id: 'vi-4',
      year: 2024,
      condition: 'certified',
      make: ' toyota ',
      model: 'rav4',
    });
    expect(r.ok).toBe(true);
  });

  it('a rejected entry never reaches the deal — the anchor and the thread list are untouched', () => {
    const deal = makeDeal('deal-E', 'user-1');
    const before = deal.dealer_threads.length;
    const r = attachInstance(deal.target_vehicle, {
      id: 'vi-5',
      year: 2023,
      condition: 'used',
      make: 'Honda',
      model: 'Accord',
    });
    if (!r.ok) {
      // nothing is written on rejection; the rejection itself is the receipt event
      expect(deal.dealer_threads).toHaveLength(before);
    }
    expect(deal.target_vehicle.make).toBe('Toyota');
  });

  it('a VIN decode contradicting the anchor is detectable without core ever storing the contradiction', () => {
    const decode: VinDecode = {
      vin: '1HGCV1F30LA000000',
      make: 'Honda',
      model: 'Accord',
      year: 2020,
    };
    const contradicts =
      decode.make.toLowerCase() !== anchor.make.toLowerCase() ||
      decode.model.toLowerCase() !== anchor.model.toLowerCase();
    expect(contradicts).toBe(true);
    // the decode is a cached record about a car, not a place the anchor can drift
    expect(Object.keys(decode)).toContain('make');
  });

  it('changing make/model on a locked deal is refused — the fix is a NEW deal', () => {
    const locked = makeDeal('deal-F', 'user-1');
    const withOffer: Deal = {
      ...locked,
      status: 'negotiating',
      offers: [{ sale_price: 2_900_000, fees: [], flags: [] }],
    };
    expect(isTargetVehicleLocked(withOffer)).toBe(true);
    const fresh: Deal = { ...makeDeal('deal-G', 'user-1'), status: 'draft' };
    expect(isTargetVehicleLocked(fresh)).toBe(false); // the new deal is the escape hatch
  });
});

// ------------------------------------------------------- dealership tenancy

describe('dealership tenancy — global record shared, contacts never cross accounts', () => {
  const sunrise: Dealership = {
    id: 'dlr-1',
    name: 'Sunrise Toyota',
    state: 'CA',
    city: 'Fresno',
    zip_code: '93720',
  };

  const accountAContact: DealershipContact = {
    name: 'Dana Reyes',
    role: 'finance_manager',
    phone: '+15559990000',
  };

  const dealOfA: Deal = {
    ...makeDeal('deal-A', 'user-1'),
    dealer_threads: [
      {
        dealership_id: sunrise.id,
        working_with: accountAContact,
        process_step: 'financing',
        messages: [],
      },
    ],
  };
  const dealOfB: Deal = {
    ...makeDeal('deal-B', 'user-2'),
    dealer_threads: [
      { dealership_id: sunrise.id, process_step: 'information_gather', messages: [] },
    ],
  };

  it('both accounts reference the SAME global dealership row (one row per real dealership)', () => {
    expect(dealOfA.dealer_threads[0]?.dealership_id).toBe(dealOfB.dealer_threads[0]?.dealership_id);
    expect(Object.keys(sunrise).sort()).toEqual(['city', 'id', 'name', 'state', 'zip_code']);
  });

  it('the global record holds nothing worth stealing — no people, no offers, no account', () => {
    const globalKeys = Object.keys(sunrise);
    for (const leaky of ['staff', 'contacts', 'account_id', 'owner_id', 'offers', 'deals']) {
      expect(globalKeys).not.toContain(leaky);
    }
  });

  it("§5.3 — account B reading account A's contact is indistinguishable from not-found", () => {
    /** Account-scoped read: the only path to a contact is through a deal the
     * requesting account owns. There is no id to look one up by. */
    const readContact = (
      deals: Deal[],
      requesting_owner_id: string,
      deal_id: string,
      dealership_id: string,
    ): DealershipContact | undefined =>
      deals
        .find((d) => d.id === deal_id && d.owner_id === requesting_owner_id)
        ?.dealer_threads.find((t) => t.dealership_id === dealership_id)?.working_with;

    const all = [dealOfA, dealOfB];
    expect(readContact(all, 'user-1', 'deal-A', 'dlr-1')?.name).toBe('Dana Reyes');
    // account B asking for account A's deal: undefined — same answer as a deal
    // that does not exist at all. No 403 confirming the record is real.
    expect(readContact(all, 'user-2', 'deal-A', 'dlr-1')).toBeUndefined();
    expect(readContact(all, 'user-2', 'deal-NONEXISTENT', 'dlr-1')).toBeUndefined();
    // and B's own thread with the same dealership simply has no contact yet
    expect(readContact(all, 'user-2', 'deal-B', 'dlr-1')).toBeUndefined();
  });

  it('sharing the global dealership does not share the private context attached to it', () => {
    const bView = dealOfB.dealer_threads[0]!;
    expect(bView.working_with).toBeUndefined();
    expect(bView.vehicle_instance).toBeUndefined();
    expect(bView.current_offer).toBeUndefined();
  });
});

// ---------------------------------------------------- append-only receipts

describe('I-8 — the receipt trail is append-only', () => {
  it('threading a message appends; nothing in the flow rewrites or removes history', () => {
    const thread: DealerThread = {
      dealership_id: 'dlr-1',
      process_step: 'deal_negotiation',
      messages: [],
    };
    const append = (t: DealerThread, m: Message): DealerThread => ({
      ...t,
      messages: [...t.messages, m],
    });
    const m1: Message = {
      channel: 'sms',
      direction: 'in',
      author: 'dealer',
      body: '29,500 OTD',
      timestamp: '2026-08-07T12:00:00Z',
    };
    const m2: Message = {
      channel: 'note',
      direction: 'internal',
      author: 'buyer',
      body: 'Called back — they held at 29,500',
      timestamp: '2026-08-07T13:00:00Z',
    };
    const after = append(append(thread, m1), m2);
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0]).toEqual(m1); // earlier entries are never rewritten
    const timestamps = after.messages.map((m) => m.timestamp);
    expect([...timestamps].sort()).toEqual(timestamps); // ordered by timestamp
  });

  it('a corrected offer is a NEW message, not an edit of the old one (ADR-006 rollup)', () => {
    const first: Message = {
      channel: 'sms',
      direction: 'in',
      author: 'dealer',
      body: '29,500 OTD',
      timestamp: '2026-08-07T12:00:00Z',
      extracted_offer: { sale_price: 2_950_000, fees: [], flags: [] },
    };
    const correction: Message = {
      channel: 'sms',
      direction: 'in',
      author: 'dealer',
      body: 'Sorry — 29,900',
      timestamp: '2026-08-07T12:05:00Z',
      extracted_offer: { sale_price: 2_990_000, fees: [], flags: [] },
    };
    const messages = [first, correction];
    // newest-wins rollup reads forward; the superseded fact stays on the record
    const current = messages
      .filter((m) => m.extracted_offer !== undefined)
      .at(-1)?.extracted_offer;
    expect(current?.sale_price).toBe(2_990_000);
    expect(messages[0]?.extracted_offer?.sale_price).toBe(2_950_000);
    expect(messages).toHaveLength(2);
  });
});
