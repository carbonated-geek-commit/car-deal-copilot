/**
 * Connection configuration and the constants the schema pins.
 *
 * docs/design/T-016.md §2.1, §4.1, D9.
 */
import process from 'node:process';

export interface DbConfig {
  /** libpq connection URI. Never logged — it carries a password. */
  connection_string: string;
  /** Shows up in `pg_stat_activity`. Default `'deal-copilot'`. */
  application_name?: string;
  /** Pool ceiling. Default 10. */
  max_connections?: number;
  /** Server-side `statement_timeout`, ms. Default 10_000. */
  statement_timeout_ms?: number;
  /** TCP connect timeout, ms. Default 5_000. */
  connect_timeout_ms?: number;
}

/** The role the application connects as. Migration `0001` creates it. */
export const APP_ROLE = 'deal_copilot_app';

/**
 * Minimum server version this schema is valid against (design D9).
 *
 * 14, not 13, for headroom: `gen_random_uuid()` is core from 13, so no
 * extension is installed anywhere in the migration set — an extension would be
 * a new moving part on an approved integration.
 */
export const MIN_SERVER_VERSION_NUM = 140000;

export const DEFAULT_APPLICATION_NAME = 'deal-copilot';
export const DEFAULT_MAX_CONNECTIONS = 10;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Advisory-lock key held for the duration of a migration run (design §4.5).
 * A decimal string, cast to `bigint` in SQL, so the exact 64-bit value reaches
 * the server without passing through a float or a driver-specific BigInt path.
 */
export const MIGRATION_LOCK_KEY = '8160160160160160';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * ADR-008: the API DEFAULTS to the in-memory store, and Postgres is used only
 * when `DATABASE_URL` is present.
 *
 * `undefined` here is therefore the NORMAL PoC state and means exactly "no
 * Postgres configured". It is never an error, and it must never be turned into
 * a fabricated `postgres://localhost/...` default — that would convert "not
 * configured" into "misconfigured" and produce a connection failure at startup
 * on every developer machine that never asked for a database.
 *
 * A present-but-unparseable `DATABASE_URL` is deliberately NOT swallowed into
 * `undefined`: it is returned as configuration and fails loudly at handle
 * creation, because silently falling back to in-memory when a database WAS
 * configured is the degradation that 2xx's a dealer webhook and loses the
 * message.
 *
 * `env` is injectable so callers and tests never mutate the real environment.
 */
export function readDbConfigFromEnv(env: Env = process.env): DbConfig | undefined {
  const raw = env['DATABASE_URL'];
  if (raw === undefined || raw.trim() === '') return undefined;
  return { connection_string: raw.trim() };
}
