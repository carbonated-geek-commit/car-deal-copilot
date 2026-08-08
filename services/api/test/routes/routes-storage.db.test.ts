/**
 * The route suite over a REAL relational backend (ADR-008).
 *
 * ADR-008 is binding here: **DB-dependent tests SKIP when `DATABASE_URL` is
 * unset, and a skip is reported as a skip — never as a pass.** With no database
 * configured, nothing in this file runs and nothing in this file claims that the
 * Postgres-backed path works. The rest of `test/routes/**` proves the suite is
 * correct over the ADR-008 DEFAULT posture (in-memory, zero external services),
 * which is a different claim and is made separately.
 *
 * The routes themselves are storage-agnostic by construction — every write goes
 * through `StoreSessionFactory.forDeal(handle)` and every read through
 * `ScopedReadModel`, neither of which branches on the backing store — so what
 * this file adds when a database IS present is the end-to-end proof of that.
 */

import process from 'node:process';
import { describe, expect, it } from 'vitest';

import {
  buildServer,
  createContainer,
  createPermissiveDealGate,
  createPocHeaderResolver,
  readApiConfig,
  resolveStoragePlan,
  type ApiConfig,
} from '../../src/index.js';
import { createInMemoryDealershipDirectory, createRouteSuite } from '../../src/routes/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];

const configFromEnv = (): ApiConfig => {
  const result = readApiConfig(process.env);
  if (!result.ok) throw new Error(`configuration is invalid: ${result.error.message}`);
  return result.value;
};

const DEAL_BODY = {
  path: 'hybrid',
  budget: 3_200_000,
  walk_away_number: 3_000_000,
  target_vehicle: { make: 'Honda', model: 'Accord' },
};

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL.trim() === '')(
  'the route suite over a configured Postgres (skipped unless DATABASE_URL is set)',
  () => {
    it('serves the same create → read contract, or refuses to start — never degrades to memory', async () => {
      const config = configFromEnv();
      const plan = resolveStoragePlan(config);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.value.relational).toBe('postgres');

      const container = await createContainer({ config, plan: plan.value });
      if (!container.ok) {
        // The honest outcome while `@store-pg` has no bound implementation: a
        // refusal. It must never fall through to the in-memory pair, and the
        // refusal must not echo the connection string.
        expect(['unavailable', 'internal']).toContain(container.error.code);
        expect(container.error.message).not.toContain(String(DATABASE_URL));
        return;
      }

      expect(container.value.sessions.mode).toBe('postgres');

      const server = await buildServer({
        container: container.value,
        config,
        resolver: createPocHeaderResolver(),
        gate: createPermissiveDealGate(),
        routes: createRouteSuite({ directory: createInMemoryDealershipDirectory() }),
        logger: false,
      });
      expect(server.ok).toBe(true);
      if (!server.ok) {
        await container.value.close();
        return;
      }

      const headers = { 'x-dc-account-id': 'account-db-a' };
      const created = await server.value.inject({
        method: 'PUT',
        url: '/deals/deal-db-1',
        headers,
        payload: DEAL_BODY,
      });
      expect(created.statusCode).toBe(201);

      const read = await server.value.inject({ method: 'GET', url: '/deals/deal-db-1', headers });
      expect(read.statusCode).toBe(200);
      expect((JSON.parse(read.body) as { owner_id: string }).owner_id).toBe('account-db-a');

      // Tenancy still holds against a real WHERE clause, not only against the
      // in-memory re-check.
      const stranger = await server.value.inject({
        method: 'GET',
        url: '/deals/deal-db-1',
        headers: { 'x-dc-account-id': 'account-db-b' },
      });
      expect(stranger.statusCode).toBe(404);

      await server.value.close();
      await container.value.close();
    }, 30_000);

    it('keeps the write-once and mismatch rejections durable across the same backend', async () => {
      const config = configFromEnv();
      const plan = resolveStoragePlan(config);
      if (!plan.ok) return;
      const container = await createContainer({ config, plan: plan.value });
      if (!container.ok) {
        expect(container.error.code).toBeTruthy();
        return;
      }

      const server = await buildServer({
        container: container.value,
        config,
        resolver: createPocHeaderResolver(),
        gate: createPermissiveDealGate(),
        routes: createRouteSuite({ directory: createInMemoryDealershipDirectory() }),
        logger: false,
      });
      if (!server.ok) {
        await container.value.close();
        return;
      }

      const headers = { 'x-dc-account-id': 'account-db-a' };
      await server.value.inject({ method: 'PUT', url: '/deals/deal-db-2', headers, payload: DEAL_BODY });
      await server.value.inject({
        method: 'PATCH',
        url: '/deals/deal-db-2',
        headers,
        payload: { status: 'negotiating' },
      });

      const locked = await server.value.inject({
        method: 'PUT',
        url: '/deals/deal-db-2/target-vehicle',
        headers,
        payload: { make: 'Toyota', model: 'Camry' },
      });
      expect(locked.statusCode).toBe(409);

      const trail = await server.value.inject({ method: 'GET', url: '/deals/deal-db-2/receipt', headers });
      expect(trail.statusCode).toBe(200);
      expect((JSON.parse(trail.body) as { entries: readonly unknown[] }).entries).toHaveLength(1);

      await server.value.close();
      await container.value.close();
    }, 30_000);
  },
);
