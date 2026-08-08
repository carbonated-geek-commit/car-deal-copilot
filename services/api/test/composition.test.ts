/**
 * Configuration, the storage plan and the composition root
 * (docs/design/T-019.md §2.1–§2.3, §4.1, D7; ADR-008).
 *
 * Every case here is OFFLINE. That is the ADR-008 posture under test, not a
 * convenience: "the API DEFAULTS to the in-memory store and uses Postgres/S3
 * only when DATABASE_URL / object-store config are present."
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  UNAVAILABLE_BINDER,
  createContainer,
  createUnavailableRelationalBinder,
  describePlan,
  readApiConfig,
  resolveStoragePlan,
} from '../src/index.js';
import { configFor, memoryContainer, planFor, serve, type Served } from './fixtures/harness.js';

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

/** A port nothing listens on. Deterministic and offline: the connection is refused. */
const UNREACHABLE_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:1/deal_copilot';

describe('readApiConfig — the only env reader, and it takes a record', () => {
  it('defaults to loopback, 3000, 1 MiB, info, and NO backends', () => {
    const config = configFor({});
    expect(config.host).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.body_limit_bytes).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(config.log_level).toBe(DEFAULT_LOG_LEVEL);
    expect(config.database).toBeUndefined();
    expect(config.object_store).toBeUndefined();
  });

  it('reads what it is given, and never reaches for process.env', () => {
    const config = configFor({ API_HOST: ' 0.0.0.0 ', PORT: '8080', LOG_LEVEL: 'debug', API_BODY_LIMIT_BYTES: '2048' });
    expect(config).toMatchObject({ host: '0.0.0.0', port: 8080, log_level: 'debug', body_limit_bytes: 2048 });
  });

  it('refuses a malformed value rather than silently defaulting it', () => {
    const bad: readonly Record<string, string>[] = [
      { PORT: 'three thousand' },
      { PORT: '70000' },
      { PORT: '-1' },
      { API_BODY_LIMIT_BYTES: '0' },
      { API_BODY_LIMIT_BYTES: '1.5' },
      { LOG_LEVEL: 'chatty' },
    ];
    for (const env of bad) {
      const result = readApiConfig(env);
      expect(result.ok, JSON.stringify(env)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('internal');
    }
  });

  it('treats a blank DATABASE_URL as "not configured" and a present one as configured', () => {
    expect(configFor({ DATABASE_URL: '   ' }).database).toBeUndefined();
    expect(configFor({ DATABASE_URL: UNREACHABLE_DATABASE_URL }).database?.connection_string).toBe(
      UNREACHABLE_DATABASE_URL,
    );
  });

  it('never puts a connection string or a credential in an error message', () => {
    const result = readApiConfig({ PORT: 'nope', DATABASE_URL: 'postgres://u:secret@host/db' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain('secret');
  });
});

describe('resolveStoragePlan — one pure decision, before any I/O', () => {
  it('defaults both planes to memory, and calls that durable', () => {
    expect(planFor(configFor({}))).toEqual({ relational: 'memory', objects: 'memory', raw_payload_durability: 'durable' });
  });

  it('switches independently on DATABASE_URL and on the bucket', () => {
    expect(planFor(configFor({ DATABASE_URL: UNREACHABLE_DATABASE_URL })).relational).toBe('postgres');
    expect(planFor(configFor({ OBJECT_STORE_BUCKET: 'b', OBJECT_STORE_REGION: 'us-east-1' })).objects).toBe('s3');
  });

  it('reports postgres-without-an-object-store as volatile rather than pretending (D7)', () => {
    const plan = planFor(configFor({ DATABASE_URL: UNREACHABLE_DATABASE_URL }));
    expect(plan).toEqual({ relational: 'postgres', objects: 'memory', raw_payload_durability: 'volatile' });
    const both = planFor(configFor({ DATABASE_URL: UNREACHABLE_DATABASE_URL, OBJECT_STORE_BUCKET: 'b', OBJECT_STORE_REGION: 'r' }));
    expect(both.raw_payload_durability).toBe('durable');
  });

  it('aborts on a PARTIALLY configured object store — never degrades to a volatile one', () => {
    const result = resolveStoragePlan(configFor({ OBJECT_STORE_BUCKET: 'b' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
      expect(result.error.message).toContain('partially configured');
    }
  });

  it('describes MODES only — never a url, host, bucket or credential', () => {
    const described = describePlan(planFor(configFor({ OBJECT_STORE_BUCKET: 'secret-bucket', OBJECT_STORE_REGION: 'us-east-1' })));
    expect(described).toEqual({ relational: 'memory', objects: 's3', raw_payload_durability: 'durable' });
    expect(JSON.stringify(described)).not.toContain('secret-bucket');
  });
});

describe('the container, and the app, with ZERO external services', () => {
  it('builds every port behind the plan', async () => {
    const container = await memoryContainer();
    expect(container.plan.relational).toBe('memory');
    expect(Object.keys(container).sort()).toEqual(
      ['close', 'comms', 'objects', 'plan', 'queue', 'read', 'receiptsFor', 'sessions'].sort(),
    );
    expect(container.sessions.mode).toBe('memory');
    // AC-8: a handler holds ports, never a backend.
    expect(typeof container.comms.intake.ingest).toBe('function');
    expect(typeof container.objects.put).toBe('function');
    await container.close();
  });

  it('starts and serves liveness and readiness', async () => {
    served = await serve();
    const live = await served.app.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(JSON.parse(live.body)).toEqual({ status: 'ok' });

    const ready = await served.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(JSON.parse(ready.body)).toEqual({
      status: 'ready',
      storage: { relational: 'memory', objects: 'memory', raw_payload_durability: 'durable' },
      auth: { resolver: 'poc-header', provider: 'none' },
    });
  });

  it('names no authentication provider anywhere in the readiness body (AC-4)', async () => {
    served = await serve();
    const body = (await served.app.inject({ method: 'GET', url: '/readyz' })).body.toLowerCase();
    for (const provider of ['auth0', 'clerk', 'cognito']) expect(body).not.toContain(provider);
  });
});

describe('a configured database fails fast and never degrades (ADR-008)', () => {
  it('refuses to start when DATABASE_URL is unreachable', async () => {
    const config = configFor({ DATABASE_URL: UNREACHABLE_DATABASE_URL });
    const plan = planFor(config);
    expect(plan.relational).toBe('postgres');

    const result = await createContainer({ config, plan });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A connection failure is transient by @db's own judgement; what matters
      // is that it is a FAILURE and not a quiet in-memory container.
      expect(['unavailable', 'internal']).toContain(result.error.code);
      expect(result.error.message).not.toContain(UNREACHABLE_DATABASE_URL);
    }
  }, 30_000);

  it('has no code path from a Postgres failure to an in-memory store', async () => {
    const config = configFor({ DATABASE_URL: UNREACHABLE_DATABASE_URL });
    const result = await createContainer({ config, plan: planFor(config) });
    // The only two outcomes are "a postgres-backed container" and "no
    // container". `ok: true` with `sessions.mode === 'memory'` would be the
    // silent degradation ADR-008 forbids.
    if (result.ok) {
      expect(result.value.sessions.mode, 'degraded to in-memory after a Postgres failure').not.toBe('memory');
      await result.value.close();
    }
    expect(result.ok).toBe(false);
  }, 30_000);

  it('refuses rather than degrades when no Postgres store implementation is bound (§8.6)', async () => {
    const binder = createUnavailableRelationalBinder();
    expect(binder.name).toBe(UNAVAILABLE_BINDER);
    const bound = await binder.bind({ handle: {} as never });
    expect(bound.ok).toBe(false);
    if (!bound.ok) {
      expect(bound.error.message).toContain('T-017');
      expect(bound.error.message).toContain('refusing to start');
    }
  });
});
