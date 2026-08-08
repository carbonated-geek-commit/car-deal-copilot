/**
 * Dealership data tenancy (docs/design/T-020.md §5.4, D2, D15; AC-10; Q12
 * AMENDED).
 *
 * specs/00 "Dealership data tenancy": names and locations are GLOBAL — one row
 * per real dealership, shared across accounts — while the PEOPLE are
 * ACCOUNT-PRIVATE. Both halves are enforced by shape rather than by a filter
 * someone has to remember, so these tests assert the shape as well as the
 * behaviour: the global view has no place a contact could sit, and the only
 * route that returns a contact is a deal-scoped thread route behind a
 * `DealHandle`.
 */

import type { Dealership } from '@core';
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
  errorCodeOf,
  idFor,
  scenario,
  type Booted,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

describe('the GLOBAL half — one row per real dealership', () => {
  it('creates on first entry (201) and finds on the second (200), never rewriting', async () => {
    booted = await boot();
    const first = await call(booted, 'POST', '/dealerships', ACCOUNT_A, NORTHSIDE);
    const second = await call(booted, 'POST', '/dealerships', ACCOUNT_A, NORTHSIDE);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(bodyOf<Dealership>(second)).toEqual(bodyOf<Dealership>(first));
  });

  it('converges two DIFFERENT accounts on ONE global row (the point of a shared directory)', async () => {
    booted = await boot();
    const a = await call(booted, 'POST', '/dealerships', ACCOUNT_A, NORTHSIDE);
    const b = await call(booted, 'POST', '/dealerships', ACCOUNT_B, NORTHSIDE);

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(bodyOf<Dealership>(b).id).toBe(bodyOf<Dealership>(a).id);

    const listed = bodyOf<{ dealerships: readonly Dealership[] }>(
      await call(booted, 'GET', '/dealerships', ACCOUNT_B),
    );
    expect(listed.dealerships).toHaveLength(1);
  });

  it('normalizes migration 0004’s natural key rather than minting a near-duplicate', async () => {
    booted = await boot();
    const canonical = await call(booted, 'POST', '/dealerships', ACCOUNT_A, NORTHSIDE);
    const messy = await call(booted, 'POST', '/dealerships', ACCOUNT_B, {
      name: '  northside motors ',
      state: 'nc',
      city: ' RALEIGH',
      zip_code: '27601 ',
    });
    expect(messy.statusCode).toBe(200);
    expect(bodyOf<Dealership>(messy).id).toBe(bodyOf<Dealership>(canonical).id);
    expect(bodyOf<Dealership>(messy).id).toBe(idFor(NORTHSIDE));
  });

  it('reads back globally — either account can fetch the row by id', async () => {
    booted = await boot();
    const id = await createDealership(booted, ACCOUNT_A, NORTHSIDE);

    for (const account of [ACCOUNT_A, ACCOUNT_B]) {
      const res = await call(booted, 'GET', `/dealerships/${id}`, account);
      expect(res.statusCode, account).toBe(200);
      expect(bodyOf<Dealership>(res).name).toBe('Northside Motors');
    }
  });

  it('exposes exactly the five public fields and no place for a person', async () => {
    booted = await boot();
    const id = await createDealership(booted, ACCOUNT_A, NORTHSIDE);
    const res = await call(booted, 'GET', `/dealerships/${id}`, ACCOUNT_A);
    expect(Object.keys(bodyOf<Dealership>(res)).sort()).toEqual(['city', 'id', 'name', 'state', 'zip_code']);
  });

  it('offers no update and no delete on the global record (D15)', async () => {
    booted = await boot();
    const id = await createDealership(booted, ACCOUNT_A, NORTHSIDE);

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await call(booted, method, `/dealerships/${id}`, ACCOUNT_B, { name: 'Renamed By A Stranger' });
      expect(res.statusCode, method).toBe(404);
    }
    // The row another account's deals depend on is untouched.
    const after = await call(booted, 'GET', `/dealerships/${id}`, ACCOUNT_A);
    expect(bodyOf<Dealership>(after).name).toBe('Northside Motors');
  });

  it('searches by name prefix, bounded, and returns no contact anywhere', async () => {
    booted = await boot();
    await createDealership(booted, ACCOUNT_A, NORTHSIDE);
    await createDealership(booted, ACCOUNT_A, SOUTHSIDE);

    const hits = bodyOf<{ dealerships: readonly Dealership[] }>(
      await call(booted, 'GET', '/dealerships?q=north', ACCOUNT_B),
    );
    expect(hits.dealerships.map((d) => d.name)).toEqual(['Northside Motors']);
    expect(JSON.stringify(hits)).not.toContain('working_with');
  });

  it('still requires an account context, even with no deal in the URL', async () => {
    booted = await boot();
    const bare = await booted.app.inject({ method: 'POST', url: '/dealerships', payload: NORTHSIDE });
    expect(bare.statusCode).toBe(401);
  });
});

describe('the PRIVATE half — the people never leave the account', () => {
  it('has no globally addressable contact route at all', async () => {
    booted = await boot();
    const id = await createDealership(booted, ACCOUNT_A, NORTHSIDE);

    for (const url of [
      `/dealerships/${id}/contacts`,
      `/dealerships/${id}/working-with`,
      '/contacts',
      '/dealership-contacts',
    ]) {
      const res = await call(booted, 'GET', url, ACCOUNT_A);
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('keeps a contact readable ONLY through the deal thread that holds it', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/working-with`, ACCOUNT_A, {
      name: 'Dana Reyes',
      role: 'finance_manager',
      phone: '+15551230000',
    });

    const owner = await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_A);
    expect(owner.body).toContain('Dana Reyes');

    // The same dealership, read globally by the same account: still no person.
    const global_view = await call(booted, 'GET', `/dealerships/${s.dealership_id}`, ACCOUNT_A);
    expect(global_view.statusCode).toBe(200);
    expect(global_view.body).not.toContain('Dana Reyes');
    expect(global_view.body).not.toContain('+15551230000');
  });

  it('never leaks one account’s contact to another account that shares the dealership', async () => {
    booted = await boot();
    const a = await scenario(booted, { account: ACCOUNT_A, deal_id: 'deal-a' });
    await call(booted, 'PUT', `/deals/deal-a/threads/${a.dealership_id}/working-with`, ACCOUNT_A, {
      name: 'Dana Reyes',
      role: 'finance_manager',
      phone: '+15551230000',
      email: 'dana@northside.example',
    });

    // Account B works with the SAME global dealership on its own deal.
    const b = await scenario(booted, { account: ACCOUNT_B, deal_id: 'deal-b' });
    expect(b.dealership_id).toBe(a.dealership_id);
    await call(booted, 'PUT', `/deals/deal-b/threads/${b.dealership_id}/working-with`, ACCOUNT_B, {
      name: 'Sam Okafor',
      role: 'sales_agent',
    });

    const b_thread = await call(booted, 'GET', `/deals/deal-b/threads/${b.dealership_id}`, ACCOUNT_B);
    expect(b_thread.statusCode).toBe(200);
    expect(b_thread.body).toContain('Sam Okafor');
    for (const private_value of ['Dana Reyes', '+15551230000', 'dana@northside.example']) {
      expect(b_thread.body, private_value).not.toContain(private_value);
    }

    const b_war_room = await call(booted, 'GET', '/deals/deal-b/war-room', ACCOUNT_B);
    expect(b_war_room.body).not.toContain('Dana Reyes');
  });

  it('refuses a cross-account read of the deal that holds the contact', async () => {
    booted = await boot();
    const s = await scenario(booted);
    await call(booted, 'PUT', `/deals/${s.deal_id}/threads/${s.dealership_id}/working-with`, ACCOUNT_A, {
      name: 'Dana Reyes',
      role: 'sales_agent',
    });

    const res = await call(booted, 'GET', `/deals/${s.deal_id}/threads/${s.dealership_id}`, ACCOUNT_B);
    expect(res.statusCode).toBe(404);
    expect(errorCodeOf(res)).toBe('not_found');
    expect(res.body).not.toContain('Dana Reyes');
  });
});
