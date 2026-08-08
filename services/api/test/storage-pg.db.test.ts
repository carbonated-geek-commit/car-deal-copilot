/**
 * The Postgres / object-store composition (docs/design/T-019.md §1.2, §8.5;
 * AC-12).
 *
 * ADR-008: **DB-dependent tests SKIP when `DATABASE_URL` is unset, and skipped
 * is reported as skipped — never as passed.** With no database configured, the
 * offline suite still proves the app starts and serves with zero external
 * services, that a partial object-store config aborts startup, and that an
 * unreachable `DATABASE_URL` aborts rather than degrades. It does NOT prove the
 * Postgres composition works, and nothing here lets a green run claim it does.
 */

import process from 'node:process';
import { describe, expect, it } from 'vitest';

import {
  createContainer,
  createPermissiveDealGate,
  createPocHeaderResolver,
  buildServer,
  readApiConfig,
  resolveStoragePlan,
  type ApiConfig,
} from '../src/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const OBJECT_STORE_BUCKET = process.env['OBJECT_STORE_BUCKET'];

const configFromEnv = (): ApiConfig => {
  const result = readApiConfig(process.env);
  if (!result.ok) throw new Error(`configuration is invalid: ${result.error.message}`);
  return result.value;
};

describe.skipIf(DATABASE_URL === undefined || DATABASE_URL.trim() === '')(
  'composed against a real Postgres (skipped unless DATABASE_URL is set)',
  () => {
    it('plans the relational plane as postgres, never as memory', () => {
      const config = configFromEnv();
      expect(config.database?.connection_string).toBeTruthy();
      const plan = resolveStoragePlan(config);
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.value.relational).toBe('postgres');
    });

    it('either composes a postgres-backed container or refuses — never an in-memory one', async () => {
      const config = configFromEnv();
      const plan = resolveStoragePlan(config);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;

      const result = await createContainer({ config, plan: plan.value });
      if (result.ok) {
        // A configured database that composed successfully must be the one in use.
        expect(result.value.sessions.mode).toBe('postgres');
        expect(result.value.plan.relational).toBe('postgres');
        await result.value.close();
        return;
      }
      // §8.6: `@store-pg` (T-017) is not built yet, so the honest outcome
      // today is a REFUSAL — either the preflight could not reach the server,
      // or no Postgres store implementation is bound. Neither may degrade to
      // the in-memory store, and the refusal never echoes the connection
      // string.
      expect(['unavailable', 'internal']).toContain(result.error.code);
      expect(result.error.message).not.toContain(String(DATABASE_URL));
    }, 30_000);

    it('serves against the configured backends when it does compose', async () => {
      const config = configFromEnv();
      const plan = resolveStoragePlan(config);
      if (!plan.ok) return;
      const container = await createContainer({ config, plan: plan.value });
      if (!container.ok) {
        // Nothing to serve: startup refused, which is itself the ADR-008 rule.
        expect(container.error.code).toBeTruthy();
        return;
      }
      const server = await buildServer({
        container: container.value,
        config,
        resolver: createPocHeaderResolver(),
        gate: createPermissiveDealGate(),
        logger: false,
      });
      expect(server.ok).toBe(true);
      if (server.ok) {
        const ready = await server.value.inject({ method: 'GET', url: '/readyz' });
        expect(ready.statusCode).toBe(200);
        expect((JSON.parse(ready.body) as { storage: { relational: string } }).storage.relational).toBe('postgres');
        await server.value.close();
      }
      await container.value.close();
    }, 30_000);
  },
);

describe.skipIf(
  DATABASE_URL === undefined ||
    DATABASE_URL.trim() === '' ||
    OBJECT_STORE_BUCKET === undefined ||
    OBJECT_STORE_BUCKET.trim() === '',
)('composed against a real Postgres AND a local object store (skipped unless both are set)', () => {
  it('reports durable raw payloads and drains the write-behind window before the db handle closes', async () => {
    const config = configFromEnv();
    const plan = resolveStoragePlan(config);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.objects).toBe('s3');
    expect(plan.value.raw_payload_durability).toBe('durable');

    const container = await createContainer({ config, plan: plan.value });
    if (!container.ok) {
      expect(container.error.code).toBeTruthy();
      return;
    }
    // §4.6: close() flushes the raw-payload window and only then closes the DB
    // handle. A clean close with no reported failure is the observable.
    await expect(container.value.close()).resolves.toBeUndefined();
  }, 30_000);
});
