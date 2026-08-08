/**
 * T-014 tester — test harness (design §5).
 *
 * `createCommsService` with `InMemoryQueue` + `InMemoryCommsStore` +
 * `InMemoryRawPayloadStore`, fixture adapters, and injected deterministic
 * `now` / `new_event_id`. No external infrastructure, no DATABASE_URL, no
 * network, no timers (AC-15).
 *
 * v0.5 shape changes from the T-009 harness:
 *   - the speech-capture double is GONE (design D1): there is no port to
 *     inject, so the harness cannot offer one;
 *   - `makeDeal` builds a v0.5 `VehicleTarget` (`{ make, model }` — the deal's
 *     shopping anchor; a specific car is a per-thread `VehicleInstance`);
 *   - `callPayload` carries `call_meta`, never an audio handle;
 *   - `makeThread` / `bindContact` / `seedDeal` exist because a v0.5 thread
 *     hangs off a KNOWN `dealership_id`: this service never mints a
 *     `Dealership` (design D9/D10), so an inbound sender only routes once the
 *     account has bound that contact point inside that deal;
 *   - two passive probes record the fan-out events the service publishes
 *     (`alert.dispatch.requested.v1` and `offer.extraction.requested.v1`).
 *     Neither has a consumer inside the service, so observing them is the only
 *     way to assert "exactly one alert" / "no extraction was requested".
 *
 * Seed: `seedDeal(...)` per scenario.
 * Drive: `intake.ingest(...)` or `notes.submitNote(...)` → assert the ack →
 *        `queue.drain()` → assert via the read model.
 *
 * All identities/contacts are synthetic (+1555… fictional range, .test TLD).
 */

import type {
  AlertDispatchRequestedV1,
  CallMeta,
  Deal,
  DealerThread,
  DealershipContact,
  IdentityRef,
  InboundComms,
  IsoTimestamp,
  Message,
  Offer,
  OfferExtractionRequestedV1,
  ProcessStep,
  VehicleInstance,
} from '@core';
import {
  createCommsService,
  InMemoryCommsStore,
  InMemoryQueue,
  InMemoryRawPayloadStore,
  type CommsService,
  type ConsentHook,
} from '../../src/index.js';
import { FixtureEmailAdapter, FixtureTelephonyAdapter } from './adapters.js';

// ---- deterministic time points -----------------------------------------

export const T0: IsoTimestamp = '2026-08-07T10:00:00.000Z';
export const T1: IsoTimestamp = '2026-08-07T10:05:00.000Z';
export const T2: IsoTimestamp = '2026-08-07T10:10:00.000Z';
export const T3: IsoTimestamp = '2026-08-07T10:15:00.000Z';
export const FIXED_NOW: IsoTimestamp = '2026-08-07T12:00:00.000Z';

// ---- synthetic identities, dealerships, and contacts -------------------

/** Our provisioned identity for deal A. */
export const IDENTITY_A: IdentityRef = {
  identity_id: 'identity-a',
  phone_number: '+15550100001',
  email_alias: 'deal-a@buyer.test',
};

/** Our provisioned identity for deal B — adjacent number (near-miss bait). */
export const IDENTITY_B: IdentityRef = {
  identity_id: 'identity-b',
  phone_number: '+15550100002',
  email_alias: 'deal-b@buyer.test',
};

/**
 * GLOBAL `Dealership` ids. The row itself lives in a globally shared table
 * this service never writes to — here the id is simply a known reference the
 * account has already established (specs/00 "Dealership data tenancy").
 */
export const DEALERSHIP_A = 'dealership-synthetic-motors';
export const DEALERSHIP_B = 'dealership-second-city-autos';

/** The dealership's contact points (the same dealership may contact several deals). */
export const DEALER_PHONE = '+15550200001';
export const DEALER_EMAIL = 'sales@synthetic-motors.test';

/** ACCOUNT-PRIVATE contact — embedded in one account's DealerThread, never global. */
export const CONTACT_A: DealershipContact = {
  name: 'Sam Fixture',
  role: 'sales_agent',
  phone: DEALER_PHONE,
  email: DEALER_EMAIL,
};

// ---- builders -----------------------------------------------------------

export function makeDeal(id: string, identity?: IdentityRef): Deal {
  return {
    id,
    owner_id: 'user-1',
    path: 'online',
    status: 'active',
    // v0.5: the deal's shopping ANCHOR — make/model only. A specific car is a
    // per-thread VehicleInstance, which deliberately carries no make/model.
    target_vehicle: { make: 'Synthetica', model: 'Cart' },
    budget: 30_000_00,
    walk_away_number: 25_000_00,
    ...(identity !== undefined ? { identity_ref: identity } : {}),
    dealer_threads: [],
    offers: [],
    created_at: '2026-08-01T00:00:00.000Z',
  };
}

export interface ThreadArgs {
  dealership_id?: string;
  process_step?: ProcessStep;
  working_with?: DealershipContact;
  vehicle_instance?: VehicleInstance;
  messages?: Message[];
  current_offer?: Offer;
}

export function makeThread(a: ThreadArgs = {}): DealerThread {
  return {
    dealership_id: a.dealership_id ?? DEALERSHIP_A,
    process_step: a.process_step ?? 'information_gather',
    messages: a.messages ?? [],
    ...(a.working_with !== undefined ? { working_with: a.working_with } : {}),
    ...(a.vehicle_instance !== undefined ? { vehicle_instance: a.vehicle_instance } : {}),
    ...(a.current_offer !== undefined ? { current_offer: a.current_offer } : {}),
  };
}

export interface SmsArgs {
  ref: string;
  body?: string;
  toPhone?: string;
  fromPhone?: string;
  at?: IsoTimestamp;
}

export function smsPayload(a: SmsArgs): InboundComms {
  return {
    channel: 'sms',
    to_identity: { phone_number: a.toPhone ?? IDENTITY_A.phone_number! },
    from: { phone: a.fromPhone ?? DEALER_PHONE },
    body: a.body ?? 'hello',
    provider_message_ref: a.ref,
    received_at: a.at ?? T1,
  };
}

export interface EmailArgs {
  ref: string;
  body?: string;
  toAlias?: string;
  fromEmail?: string;
  at?: IsoTimestamp;
}

export function emailPayload(a: EmailArgs): InboundComms {
  return {
    channel: 'email',
    to_identity: { email_alias: a.toAlias ?? IDENTITY_A.email_alias! },
    from: { email: a.fromEmail ?? DEALER_EMAIL },
    body: a.body ?? 'hello',
    provider_message_ref: a.ref,
    received_at: a.at ?? T1,
  };
}

export interface CallArgs {
  ref: string;
  /** Provider-supplied call metadata. Absent ⇒ the service derives it (design D12). */
  call_meta?: CallMeta;
  toPhone?: string;
  fromPhone?: string;
  at?: IsoTimestamp;
}

/**
 * A v0.5 inbound call payload: metadata only. There is no field on
 * `InboundComms` for audio or for captured speech — Q14/specs/01 removed them
 * from the spine rather than nulling them, so this builder could not produce
 * one even by mistake.
 */
export function callPayload(a: CallArgs): InboundComms {
  return {
    channel: 'call',
    to_identity: { phone_number: a.toPhone ?? IDENTITY_A.phone_number! },
    from: { phone: a.fromPhone ?? DEALER_PHONE },
    ...(a.call_meta !== undefined ? { call_meta: a.call_meta } : {}),
    provider_message_ref: a.ref,
    received_at: a.at ?? T1,
  };
}

// ---- harness ------------------------------------------------------------

export interface Harness {
  service: CommsService;
  queue: InMemoryQueue;
  store: InMemoryCommsStore;
  raw: InMemoryRawPayloadStore;
  /** Every `alert.dispatch.requested.v1` the service published, in publish order. */
  alerts: AlertDispatchRequestedV1[];
  /** Every `offer.extraction.requested.v1` the service published, in publish order. */
  extractionRequests: OfferExtractionRequestedV1[];
}

export interface HarnessOpts {
  maxAttempts?: number;
  /** A hook, or a factory given the store (so a hook can observe durable state). */
  consent?: ConsentHook | ((store: InMemoryCommsStore) => ConsentHook);
  /** design D13 — in-app note bound. Provider-inbound text is never capped. */
  max_note_chars?: number;
}

export function makeHarness(opts: HarnessOpts = {}): Harness {
  const queue = new InMemoryQueue(
    opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {},
  );
  const store = new InMemoryCommsStore();
  const raw = new InMemoryRawPayloadStore();
  const alerts: AlertDispatchRequestedV1[] = [];
  const extractionRequests: OfferExtractionRequestedV1[] = [];

  // Passive probes. Neither event has a consumer inside the service (alert
  // dispatch is a later epic; the extraction request is consumed by the
  // service's own worker, and a second subscriber simply gets its own copy),
  // so these observe the fan-out without altering any outcome.
  queue.subscribe('probe-alerts', 'alert.dispatch.requested.v1', async (event) => {
    if (event.type === 'alert.dispatch.requested.v1') alerts.push(event.payload);
    return { status: 'done' };
  });
  queue.subscribe('probe-extraction-requests', 'offer.extraction.requested.v1', async (event) => {
    if (event.type === 'offer.extraction.requested.v1') extractionRequests.push(event.payload);
    return { status: 'done' };
  });

  const consent =
    typeof opts.consent === 'function' ? opts.consent(store) : opts.consent;

  let eid = 0;
  const service = createCommsService({
    telephony: new FixtureTelephonyAdapter(),
    email: new FixtureEmailAdapter(),
    queue,
    store,
    raw_payloads: raw,
    ...(consent !== undefined ? { consent } : {}),
    ...(opts.max_note_chars !== undefined ? { max_note_chars: opts.max_note_chars } : {}),
    now: () => FIXED_NOW,
    new_event_id: () => `evt-${++eid}`,
  });
  return { service, queue, store, raw, alerts, extractionRequests };
}

// ---- seeding helpers ----------------------------------------------------

export interface SeedContact {
  dealership_id?: string;
  phone?: string;
  email?: string;
}

/**
 * Seed a deal and bind ONE dealership contact point pair inside it.
 *
 * The contact index is deal-scoped by construction (`bindThreadContact` takes
 * `deal_id` first), so this helper cannot accidentally establish a global
 * contact → dealership mapping — which is precisely the tenancy rule under
 * test (specs/00 "Dealership data tenancy"; AC-9).
 */
export function seedDeal(
  h: Harness,
  deal_id: string,
  identity?: IdentityRef,
  contact: SeedContact = {},
): void {
  h.store.putDeal(makeDeal(deal_id, identity));
  h.store.bindThreadContact(deal_id, contact.dealership_id ?? DEALERSHIP_A, {
    phone: contact.phone ?? DEALER_PHONE,
    email: contact.email ?? DEALER_EMAIL,
  });
}

/** The single thread of `deal_id` (fails loudly if there is not exactly one). */
export function onlyThread(h: Harness, deal_id = 'deal-a'): DealerThread {
  const threads = h.service.read.getDeal(deal_id)!.dealer_threads;
  if (threads.length !== 1) {
    throw new Error(`expected exactly one thread on ${deal_id}, found ${threads.length}`);
  }
  return threads[0]!;
}
