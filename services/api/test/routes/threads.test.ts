/**
 * Dealer-thread routes (docs/design/T-020.md §3.1, D12; AC-9).
 *
 * specs/01 W2 asks for one make/model with many dealerships side by side, each
 * column carrying "who you're working with" and a "process step". Q12 fixes the
 * six-step sequence.
 *
 * D12 — `dealership_id` is SET at creation and is not mutable. AC-9's "allow
 * updating" is satisfied by the create/bind route that sets it, and the tests
 * below assert the immutability the same way the design argues for it: there is
 * no shape in which the change is expressible, and attempting it at a different
 * URL creates a SECOND thread rather than moving the first.
 */

import type { Deal, DealerThread } from '@core';
import { PROCESS_STEPS } from '@core';
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
  errorCodeOf,
  idFor,
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

describe('create / bind a thread to a GLOBAL dealership', () => {
  it('creates on first PUT (201) and is idempotent on replay (200)', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-1', ACCOUNT_A, dealBody());
    const dealership_id = await createDealership(booted, ACCOUNT_A, NORTHSIDE);

    const first = await call(booted, 'PUT', `/deals/deal-1/threads/${dealership_id}`, ACCOUNT_A, {});
    const again = await call(booted, 'PUT', `/deals/deal-1/threads/${dealership_id}`, ACCOUNT_A, {});
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);

    const deal = bodyOf<Deal>(await call(booted, 'GET', '/deals/deal-1', ACCOUNT_A));
    expect(deal.dealer_threads).toHaveLength(1);
    expect(deal.dealer_threads[0]?.dealership_id).toBe(dealership_id);
    expect(deal.dealer_threads[0]?.process_step).toBe('information_gather');
  });

  it('refuses a dealership the GLOBAL directory does not know, and mints none', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-1', ACCOUNT_A, dealBody());

    const res = await call(booted, 'PUT', '/deals/deal-1/threads/dl-ghost-00000000', ACCOUNT_A, {});
    expect(res.statusCode).toBe(404);
    expect(errorCodeOf(res)).toBe('not_found');

    // Threading never creates a global row as a side effect.
    expect(await booted.directory.get('dl-ghost-00000000')).toBeUndefined();
    const listed = await call(booted, 'GET', '/dealerships', ACCOUNT_A);
    expect(bodyOf<{ dealerships: unknown[] }>(listed).dealerships).toEqual([]);
  });

  it('holds many dealerships side by side against one anchor (specs/01 W2)', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-1', ACCOUNT_A, dealBody());
    const north = await createDealership(booted, ACCOUNT_A, NORTHSIDE);
    const south = await createDealership(booted, ACCOUNT_A, SOUTHSIDE);

    await call(booted, 'PUT', `/deals/deal-1/threads/${north}`, ACCOUNT_A, {});
    await call(booted, 'PUT', `/deals/deal-1/threads/${south}`, ACCOUNT_A, {});

    const deal = bodyOf<Deal>(await call(booted, 'GET', '/deals/deal-1', ACCOUNT_A));
    expect(deal.dealer_threads.map((t) => t.dealership_id).sort()).toEqual([north, south].sort());
  });
});

describe('process_step across the six-step sequence (Q12)', () => {
  it('accepts every member of the spine vocabulary', async () => {
    booted = await boot();
    const s = await scenario(booted);

    for (const step of PROCESS_STEPS) {
      const res = await call(booted, 'PATCH', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A, {
        process_step: step,
      });
      expect(res.statusCode, step).toBe(200);
      expect(bodyOf<DealerThread>(res).process_step).toBe(step);
    }
    expect(PROCESS_STEPS).toHaveLength(6);
  });

  it('rejects a step outside the vocabulary before any store call', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await call(booted, 'PATCH', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A, {
      process_step: 'haggling',
    });
    expect(res.statusCode).toBe(400);
    expect(errorCodeOf(res)).toBe('invalid_request');

    const thread = bodyOf<DealerThread>(
      await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A),
    );
    expect(thread.process_step).toBe('information_gather');
  });

  it('carries the thread’s vehicle instance and contact through a step change', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(
      booted,
      'PUT',
      `/deals/${s.deal_id}/threads/${s.dealership_id}/vehicle-instance`,
      ACCOUNT_A,
      vehicleBody(),
    );
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/working-with`, ACCOUNT_A, {
      name: 'Dana Reyes',
      role: 'finance_manager',
    });

    const res = await call(booted, 'PATCH', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A, {
      process_step: 'financing',
    });
    const thread = bodyOf<DealerThread>(res);
    expect(thread.process_step).toBe('financing');
    expect(thread.vehicle_instance?.year).toBe(2021);
    expect(thread.working_with?.name).toBe('Dana Reyes');
  });

  it('404s a step change on a thread that does not exist', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-1', ACCOUNT_A, dealBody());
    const dealership_id = await createDealership(booted, ACCOUNT_A, NORTHSIDE);

    const res = await call(booted, 'PATCH', `/deals/deal-1/threads/${dealership_id}`, ACCOUNT_A, {
      process_step: 'pickup',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('working_with — the account-private half (specs/00 "Dealership data tenancy")', () => {
  it('sets and reads back the contact inside the gated deal', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/working-with`, ACCOUNT_A, {
      name: 'Dana Reyes',
      role: 'finance_manager',
      phone: '+15551230000',
      email: 'dana@northside.example',
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf<DealerThread>(res).working_with).toEqual({
      name: 'Dana Reyes',
      role: 'finance_manager',
      phone: '+15551230000',
      email: 'dana@northside.example',
    });
  });

  it('rejects a role outside the vocabulary without echoing the value', async () => {
    booted = await boot();
    const s = await scenario(booted);

    const res = await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/working-with`, ACCOUNT_A, {
      name: 'Dana Reyes',
      role: 'chief_haggler',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('chief_haggler');
  });

  it('is unreachable from another account, contact values and all', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/working-with`, ACCOUNT_A, {
      name: 'Dana Reyes',
      role: 'sales_agent',
      phone: '+15551230000',
    });

    for (const url of [
      `/deals/${s.deal_id}/threads/${s.dealership_id}`,
      `/deals/${s.deal_id}/war-room`,
      `/deals/${s.deal_id}`,
    ]) {
      const res = await call(booted, 'GET', url, ACCOUNT_B);
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('Dana Reyes');
      expect(res.body, url).not.toContain('+15551230000');
    }
  });
});

describe('dealership_id is the thread’s identity and is not mutable (D12)', () => {
  it('offers no request shape that could move a thread to another dealership', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const other = await createDealership(booted, ACCOUNT_A, SOUTHSIDE);

    for (const [method, payload] of [
      ['PATCH', { dealership_id: other }],
      ['PUT', { dealership_id: other }],
    ] as const) {
      const res = await call(booted, method, `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A, payload);
      expect(res.statusCode, method).toBe(400);
    }

    const deal = bodyOf<Deal>(await call(booted, 'GET', `/deals/${s.deal_id}`, ACCOUNT_A));
    expect(deal.dealer_threads.map((t) => t.dealership_id)).toEqual([s.dealership_id]);
  });

  it('creates a SECOND thread rather than moving the first — evidence never changes hands', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await withStore(booted, s.deal_id, ACCOUNT_A, (session) => {
      const thread = session.store.getThread(s.deal_id, s.dealership_id);
      if (thread === undefined) throw new Error('thread missing');
      session.store.appendMessage(s.deal_id, s.dealership_id, {
        message: {
          channel: 'note',
          direction: 'internal',
          author: 'buyer',
          body: 'they quoted 28,900',
          timestamp: '2026-08-08T12:00:00.000Z',
        },
        message_ref: 'note:seed-1',
        origin: { kind: 'in_app' },
      });
    });

    const other = await createDealership(booted, ACCOUNT_A, SOUTHSIDE);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${other}`, ACCOUNT_A, {});

    const deal = bodyOf<Deal>(await call(booted, 'GET', `/deals/${s.deal_id}`, ACCOUNT_A));
    expect(deal.dealer_threads).toHaveLength(2);
    const original = deal.dealer_threads.find((t) => t.dealership_id === s.dealership_id);
    const created = deal.dealer_threads.find((t) => t.dealership_id === other);
    expect(original?.messages).toHaveLength(1);
    expect(created?.messages).toEqual([]);
  });

  it('never registers a DELETE on any thread route', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const res = await call(booted, 'DELETE', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A);
    expect(res.statusCode).toBe(404);
  });
});

describe('thread reads never cross an account or a deal', () => {
  it('answers a thread only inside the deal that owns it', async () => {
    booted = await boot();
    const a = await scenario(booted, { deal_id: 'deal-1' });
    await call(booted, 'PUT', '/deals/deal-2', ACCOUNT_A, dealBody());

    // The same dealership, a different deal — no thread there.
    const res = await call(booted, 'GET', `/deals/deal-2/threads/${a.dealership_id}`, ACCOUNT_A);
    expect(res.statusCode).toBe(404);
  });

  it('uses the deterministic dealership id the directory minted', async () => {
    booted = await boot();
    const s = await scenario(booted);
    expect(s.dealership_id).toBe(idFor(NORTHSIDE));
  });

  it('never exposes another account’s thread', async () => {
    booted = await boot();
    const s = await scenario(booted);
    const res = await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_B);
    expect(res.statusCode).toBe(404);
  });
});
