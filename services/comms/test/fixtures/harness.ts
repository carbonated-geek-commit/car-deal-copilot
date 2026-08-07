/**
 * T-009 tester — test harness (design §7).
 *
 * `createCommsService` with `InMemoryQueue` + `InMemoryCommsStore` +
 * `InMemoryRawPayloadStore`, fixture adapters, a map-backed TranscriptStub,
 * and injected deterministic `now` / `new_event_id`. No external
 * infrastructure (AC-7).
 *
 * Seed: `putDeal` (+ `bindIdentity`) per scenario.
 * Drive: `intake.ingest(...)` → assert ack → `queue.drain()` → assert via read model.
 *
 * All identities/contacts are synthetic (+1555… fictional range, .test TLD).
 */

import type { Deal, IdentityRef, InboundComms, IsoTimestamp } from '@core';
import {
  createCommsService,
  InMemoryCommsStore,
  InMemoryQueue,
  InMemoryRawPayloadStore,
  type CommsService,
  type ConsentHook,
  type TranscriptStub,
} from '../../src/index.js';
import { FixtureEmailAdapter, FixtureTelephonyAdapter } from './adapters.js';

// ---- deterministic time points -----------------------------------------

export const T0: IsoTimestamp = '2026-08-07T10:00:00.000Z';
export const T1: IsoTimestamp = '2026-08-07T10:05:00.000Z';
export const T2: IsoTimestamp = '2026-08-07T10:10:00.000Z';
export const FIXED_NOW: IsoTimestamp = '2026-08-07T12:00:00.000Z';

// ---- synthetic identities and contacts ---------------------------------

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

/** The dealer's contact points (same dealer may contact several deals). */
export const DEALER_PHONE = '+15550200001';
export const DEALER_EMAIL = 'sales@synthetic-motors.test';

// ---- builders -----------------------------------------------------------

export function makeDeal(id: string, identity?: IdentityRef): Deal {
  return {
    id,
    owner_id: 'user-1',
    path: 'online',
    status: 'active',
    target_vehicle: { make: 'Synthetica', model: 'Cart', year: 2026 },
    budget: 30_000_00,
    walk_away_number: 25_000_00,
    ...(identity !== undefined ? { identity_ref: identity } : {}),
    dealer_threads: [],
    offers: [],
    created_at: '2026-08-01T00:00:00.000Z',
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
  callRef?: string;
  toPhone?: string;
  fromPhone?: string;
  at?: IsoTimestamp;
}

export function callPayload(a: CallArgs): InboundComms {
  return {
    channel: 'call',
    to_identity: { phone_number: a.toPhone ?? IDENTITY_A.phone_number! },
    from: { phone: a.fromPhone ?? DEALER_PHONE },
    ...(a.callRef !== undefined ? { call_ref: a.callRef } : {}),
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
  /** call_ref → transcript; missing key ⇒ stub returns undefined ⇒ retry (D9). */
  transcripts: Map<string, string>;
}

export function makeHarness(opts: { maxAttempts?: number; consent?: ConsentHook } = {}): Harness {
  const queue = new InMemoryQueue(
    opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {},
  );
  const store = new InMemoryCommsStore();
  const raw = new InMemoryRawPayloadStore();
  const transcripts = new Map<string, string>();
  const transcribe: TranscriptStub = {
    transcriptFor: (call_ref) => transcripts.get(call_ref),
  };
  let eid = 0;
  const service = createCommsService({
    telephony: new FixtureTelephonyAdapter(),
    email: new FixtureEmailAdapter(),
    queue,
    store,
    raw_payloads: raw,
    transcribe,
    ...(opts.consent !== undefined ? { consent: opts.consent } : {}),
    now: () => FIXED_NOW,
    new_event_id: () => `evt-${++eid}`,
  });
  return { service, queue, store, raw, transcripts };
}
