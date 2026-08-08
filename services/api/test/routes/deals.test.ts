/**
 * Deal routes (docs/design/T-020.md §3.1, D1, D2; AC-1, AC-16).
 *
 * Creation is `PUT /deals/:deal_id` because a `POST /deals` has no `:deal_id`,
 * therefore no `DealHandle`, therefore no reachable store. What is asserted here
 * is the consequence: the id is the caller's, `owner_id` is the SESSION's, and a
 * replay converges rather than duplicating.
 */

import type { Deal } from '@core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_A,
  ACCOUNT_B,
  bodyOf,
  boot,
  call,
  dealBody,
  errorCodeOf,
  type Booted,
} from './harness.js';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.close();
  booted = undefined;
});

describe('PUT /deals/:deal_id — creation through the only door (D1)', () => {
  it('creates at the caller-chosen id and answers 201', async () => {
    booted = await boot();
    const res = await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());
    expect(res.statusCode).toBe(201);

    const deal = bodyOf<Deal>(res);
    expect(deal.id).toBe('deal-7');
    expect(deal.status).toBe('draft');
    expect(deal.target_vehicle).toEqual({ make: 'Honda', model: 'Accord', year_range: { from: 2019, to: 2023 } });
    expect(deal.dealer_threads).toEqual([]);
    expect(deal.offers).toEqual([]);
  });

  it('takes owner_id from the session scope and never from the body', async () => {
    booted = await boot();
    // `owner_id` is not even expressible in the schema — a body that tries is
    // an `invalid_request`, so there is no path by which a caller could name
    // another account as owner.
    const smuggled = await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, {
      ...dealBody(),
      owner_id: ACCOUNT_B,
    });
    expect(smuggled.statusCode).toBe(400);
    expect(errorCodeOf(smuggled)).toBe('invalid_request');

    const created = await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());
    expect(bodyOf<Deal>(created).owner_id).toBe(ACCOUNT_A);
  });

  it('mints a deterministic receipt bundle id (D2)', async () => {
    booted = await boot();
    const res = await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());
    expect(bodyOf<Deal>(res).receipt_bundle_id).toBe('receipt:deal-7');
  });

  it('replays byte-identically: same body ⇒ 200 and the SAME stored state', async () => {
    booted = await boot();
    const first = await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());
    const replay = await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(bodyOf<Deal>(replay)).toEqual(bodyOf<Deal>(first));
  });

  it('refuses to replace a different deal at the same id (409)', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());
    const clash = await call(
      booted,
      'PUT',
      '/deals/deal-7',
      ACCOUNT_A,
      dealBody({ target_vehicle: { make: 'Toyota', model: 'RAV4' } }),
    );
    expect(clash.statusCode).toBe(409);
    expect(errorCodeOf(clash)).toBe('conflict');

    // Nothing was overwritten.
    const read = await call(booted, 'GET', '/deals/deal-7', ACCOUNT_A);
    expect(bodyOf<Deal>(read).target_vehicle.make).toBe('Honda');
  });

  it('never lets one account overwrite another account’s deal — 404, not 409', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());

    const foreign = await call(
      booted,
      'PUT',
      '/deals/deal-7',
      ACCOUNT_B,
      dealBody({ target_vehicle: { make: 'Toyota', model: 'RAV4' } }),
    );
    expect(foreign.statusCode).toBe(404);
    expect(errorCodeOf(foreign)).toBe('not_found');
    // Nothing about the real deal leaks into the refusal (T-019 D3).
    expect(foreign.body).not.toContain('Honda');
    expect(foreign.body).not.toContain(ACCOUNT_A);

    const still = await call(booted, 'GET', '/deals/deal-7', ACCOUNT_A);
    expect(bodyOf<Deal>(still).target_vehicle.model).toBe('Accord');
  });
});

describe('GET /deals/:deal_id — account and deal isolation', () => {
  it('serves the owner and gives everyone else the SAME 404 an absent deal gives', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());

    const owner = await call(booted, 'GET', '/deals/deal-7', ACCOUNT_A);
    expect(owner.statusCode).toBe(200);

    const stranger = await call(booted, 'GET', '/deals/deal-7', ACCOUNT_B);
    const absent = await call(booted, 'GET', '/deals/deal-nope', ACCOUNT_B);
    expect(stranger.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);

    const strip = (raw: string): unknown => ({
      ...(JSON.parse(raw) as { error: Record<string, unknown> }).error,
      request_id: '<id>',
    });
    expect(strip(stranger.body)).toEqual(strip(absent.body));
  });

  it('never serves one deal in answer to a request for another', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-1', ACCOUNT_A, dealBody());
    await call(
      booted,
      'PUT',
      '/deals/deal-2',
      ACCOUNT_A,
      dealBody({ target_vehicle: { make: 'Toyota', model: 'RAV4' } }),
    );

    const res = await call(booted, 'GET', '/deals/deal-2', ACCOUNT_A);
    expect(bodyOf<Deal>(res).id).toBe('deal-2');
    expect(res.body).not.toContain('Accord');
  });

  it('requires an account context on every route in the suite (401 before validation)', async () => {
    booted = await boot();
    const bare = await booted.app.inject({ method: 'GET', url: '/deals/deal-7' });
    expect(bare.statusCode).toBe(401);
    // …and the refusal describes no schema.
    expect(bare.body).not.toContain('target_vehicle');
  });
});

describe('PATCH /deals/:deal_id — everything except the anchor', () => {
  it('edits status, budget, walk_away_number and the soft year guide', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());

    const res = await call(booted, 'PATCH', '/deals/deal-7', ACCOUNT_A, {
      status: 'negotiating',
      walk_away_number: 2_950_000,
      target_vehicle: { year_range: { from: 2015, to: 2024 } },
    });
    expect(res.statusCode).toBe(200);

    const deal = bodyOf<Deal>(res);
    expect(deal.status).toBe('negotiating');
    expect(deal.walk_away_number).toBe(2_950_000);
    expect(deal.target_vehicle.year_range).toEqual({ from: 2015, to: 2024 });
    // The anchor itself is untouched.
    expect(deal.target_vehicle.make).toBe('Honda');
  });

  it('cannot express make or model at all (§5.1 layer 2)', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());

    for (const attempt of [
      { target_vehicle: { make: 'Toyota' } },
      { target_vehicle: { model: 'Camry' } },
      { make: 'Toyota' },
      { model: 'Camry' },
    ]) {
      const res = await call(booted, 'PATCH', '/deals/deal-7', ACCOUNT_A, attempt);
      expect(res.statusCode, JSON.stringify(attempt)).toBe(400);
      expect(errorCodeOf(res)).toBe('invalid_request');
    }

    const after = await call(booted, 'GET', '/deals/deal-7', ACCOUNT_A);
    expect(bodyOf<Deal>(after).target_vehicle).toEqual({
      make: 'Honda',
      model: 'Accord',
      year_range: { from: 2019, to: 2023 },
    });
  });

  it('rejects an unknown key rather than silently dropping it', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());
    const res = await call(booted, 'PATCH', '/deals/deal-7', ACCOUNT_A, { walkaway_number: 10 });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a foreign account with the same 404 (write path)', async () => {
    booted = await boot();
    await call(booted, 'PUT', '/deals/deal-7', ACCOUNT_A, dealBody());
    const res = await call(booted, 'PATCH', '/deals/deal-7', ACCOUNT_B, { status: 'burned' });
    expect(res.statusCode).toBe(404);

    const still = await call(booted, 'GET', '/deals/deal-7', ACCOUNT_A);
    expect(bodyOf<Deal>(still).status).toBe('draft');
  });
});
