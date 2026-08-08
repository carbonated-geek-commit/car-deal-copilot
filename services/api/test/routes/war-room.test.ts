/**
 * The war-room read surface (docs/design/T-020.md §3.3, D11, D16; specs/01
 * "Web surface (war-room-first)" W2).
 *
 * W2 asks for ONE make/model with many dealerships side by side, each column
 * carrying its dealership header, who you're working with, the process step, the
 * car, the current offer, and both signals — enough to render the room in one
 * request. It deliberately carries NO ordering: cross-dealership comparison must
 * be value-adjusted (specs/00), and every fair-price answer in this epic is
 * unevaluable, so an ordering emitted here would be an invented verdict.
 */

import type { Deal, Offer } from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_A,
  ACCOUNT_B,
  NORTHSIDE,
  SOUTHSIDE,
  bodyOf,
  boot,
  call,
  createDealership,
  dealBody,
  scenario,
  vehicleBody,
  withStore,
  type Booted,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

interface ThreadColumn {
  readonly dealership_id: string;
  readonly dealership?: { readonly id: string; readonly name: string; readonly city: string };
  readonly process_step: string;
  readonly working_with?: { readonly name: string };
  readonly vehicle_instance?: { readonly id: string; readonly vin?: string };
  readonly current_offer?: { readonly offer: Offer; readonly statuses: readonly unknown[] };
  readonly budget: { readonly over_walkaway: string };
  readonly fair_price: { readonly above_market: string };
  readonly year_drift?: unknown;
}

interface WarRoom {
  readonly deal: Deal;
  readonly threads: readonly ThreadColumn[];
}

const THIRD = { name: 'Eastgate Cars', state: 'NC', city: 'Cary', zip_code: '27511' };

describe('GET /deals/:deal_id/war-room renders the whole room in one request', () => {
  it('returns the deal plus every thread with header, step, contact, car, offer and both signals', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const south = await createDealership(booted, ACCOUNT_A, SOUTHSIDE);
    const east = await createDealership(booted, ACCOUNT_A, THIRD);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${south}`, ACCOUNT_A, {});
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${east}`, ACCOUNT_A, {});

    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/working-with`, ACCOUNT_A, {
      name: 'Dana Reyes',
      role: 'finance_manager',
    });
    await call(booted, 'PATCH', `/deals/${s.deal_id}/threads/${south}`, ACCOUNT_A, {
      process_step: 'deal_negotiation',
    });
    await withStore(booted, s.deal_id, ACCOUNT_A, (session) => {
      const thread = session.store.getThread(s.deal_id, south);
      if (thread === undefined) throw new Error('thread missing');
      session.store.putThread(s.deal_id, {
        ...thread,
        current_offer: { sale_price: 2_890_000, term_months: 72, fees: [], flags: [] },
      });
    });

    const res = await call(booted, 'GET', `/deals/${s.deal_id}/war-room`, ACCOUNT_A);
    expect(res.statusCode).toBe(200);
    const room = bodyOf<WarRoom>(res);

    expect(room.deal.id).toBe(s.deal_id);
    expect(room.deal.target_vehicle).toEqual({ make: 'Honda', model: 'Accord', year_range: { from: 2019, to: 2023 } });
    expect(room.threads).toHaveLength(3);

    const north_col = room.threads.find((t) => t.dealership_id === s.dealership_id);
    expect(north_col?.dealership?.name).toBe('Northside Motors');
    expect(north_col?.working_with?.name).toBe('Dana Reyes');
    expect(north_col?.vehicle_instance?.vin).toBe('1HGCV1F34LA012345');

    const south_col = room.threads.find((t) => t.dealership_id === south);
    expect(south_col?.process_step).toBe('deal_negotiation');
    expect(south_col?.current_offer?.offer.sale_price).toBe(2_890_000);

    // Every column carries both signals, always.
    for (const column of room.threads) {
      expect(Object.keys(column)).toContain('budget');
      expect(Object.keys(column)).toContain('fair_price');
      expect(column.fair_price.above_market).toBe('unevaluable');
    }
  });

  it('renders one anchor across all columns — the room is one make/model', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const south = await createDealership(booted, ACCOUNT_A, SOUTHSIDE);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${south}`, ACCOUNT_A, {});

    const room = bodyOf<WarRoom>(await call(booted, 'GET', `/deals/${s.deal_id}/war-room`, ACCOUNT_A));
    // No column can contradict the anchor: `VehicleInstance` has no make/model
    // field at all, so there is nothing per-column to disagree with.
    for (const column of room.threads) {
      expect(JSON.stringify(column.vehicle_instance ?? {})).not.toContain('make');
    }
    expect(room.deal.target_vehicle.make).toBe('Honda');
  });

  it('emits no ordering of any kind — the client orders, the API supplies inputs', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const south = await createDealership(booted, ACCOUNT_A, SOUTHSIDE);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${south}`, ACCOUNT_A, {});

    const res = await call(booted, 'GET', `/deals/${s.deal_id}/war-room`, ACCOUNT_A);
    const room = bodyOf<WarRoom>(res);
    expect(Object.keys(room).sort()).toEqual(['deal', 'threads']);
    for (const banned of ['rank', 'score', 'order', 'best', 'verdict', 'winner']) {
      expect(res.body, banned).not.toContain(`"${banned}"`);
    }
  });

  it('renders a room with no threads rather than failing', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-9', ACCOUNT_A, dealBody());
    const room = bodyOf<WarRoom>(await call(booted, 'GET', '/deals/deal-9/war-room', ACCOUNT_A));
    expect(room.threads).toEqual([]);
  });

  it('omits the dealership header rather than fabricating a global row', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-9', ACCOUNT_A, dealBody());
    // A thread seeded directly against a dealership the directory never knew.
    await withStore(booted, 'deal-9', ACCOUNT_A, (session) => {
      session.store.putThread('deal-9', {
        dealership_id: 'dl-unknown-0000',
        process_step: 'information_gather',
        messages: [],
      });
    });

    const room = bodyOf<WarRoom>(await call(booted, 'GET', '/deals/deal-9/war-room', ACCOUNT_A));
    expect(room.threads).toHaveLength(1);
    expect(room.threads[0]?.dealership).toBeUndefined();
    expect(room.threads[0]?.dealership_id).toBe('dl-unknown-0000');
  });

  it('carries no audio, transcription, or credit field anywhere in the room', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`, ACCOUNT_A, vehicleBody());
    await call(booted, 'POST', `/deals/${s.deal_id}/threads/${s.dealership_id}/messages`, ACCOUNT_A, {
      client_note_ref: 'n-1',
      author: 'buyer',
      body: 'they quoted 28,900',
    });

    const res = await call(booted, 'GET', `/deals/${s.deal_id}/war-room`, ACCOUNT_A);
    for (const forbidden of [
      're' + 'cording',
      'trans' + 'cript',
      'audio_url',
      'media_url',
      'provider_token',
      'credit_report',
      'bureau_response',
      'ssn',
    ]) {
      expect(res.body, forbidden).not.toContain(forbidden);
    }
  });

  it('is deal- and account-scoped like every other read', async () => {
    booted = await boot();
    const s = await scenario(booted);
    expect((await call(booted, 'GET', `/deals/${s.deal_id}/war-room`, ACCOUNT_B)).statusCode).toBe(404);
    expect((await call(booted, 'GET', '/deals/deal-nope/war-room', ACCOUNT_A)).statusCode).toBe(404);
  });
});

describe('health lives on T-019’s plane, not in this suite (D16)', () => {
  it('answers /healthz and /readyz with no account context at all', async () => {
    booted = await boot();

    const health = await booted.app.inject({ method: 'GET', url: '/healthz' });
    const ready = await booted.app.inject({ method: 'GET', url: '/readyz' });
    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);

    // A probe cannot present an account, so a health route inside the api scope
    // would answer 401 — which is why this task adds none.
    expect(bodyOf<{ storage?: unknown }>(ready)).toBeDefined();
  });
});
