/**
 * The connection handle — the ONLY module in the repo that imports `pg`
 * (T-015 §2.2 rule 4; docs/design/T-016.md §2.2, §4.2, §4.4, §5.21).
 *
 * No `pg` type crosses this boundary: not `Pool`, not `PoolClient`, not
 * `QueryResult`. `Queryable` / `DbHandle` / `QueryOutcome` are ours, so
 * swapping the driver would not change a line of `@store-pg`.
 *
 * The load-bearing property is that **`Queryable` is what T-017 receives**: a
 * repository takes a `Queryable`, so the same code runs on the pool and inside
 * a transaction, and no repository ever reads `DATABASE_URL`.
 */
import { Pool, type PoolClient } from 'pg';

import {
  DEFAULT_APPLICATION_NAME,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MIN_SERVER_VERSION_NUM,
  type DbConfig,
} from './config.js';
import { err, fromUnknown, ok, type DbResult } from './errors.js';

export type DbLogLevel = 'info' | 'warn' | 'error';

/** Fields are log-safe by the same contract as `DbError.message` (§4.8). */
export interface DbLogEvent {
  level: DbLogLevel;
  event:
    | 'pool_opened'
    | 'pool_closed'
    | 'migration_applied'
    | 'migration_skipped'
    | 'migration_failed'
    | 'query_failed'
    | 'transaction_rolled_back';
  message: string;
  migration_version?: string;
  duration_ms?: number;
  sqlstate?: string;
}

/**
 * `@db` writes nothing anywhere unless a logger is supplied — no `console`, no
 * file, no global. Silence is the default so a library cannot leak into a
 * caller's log stream.
 */
export type DbLogger = (event: DbLogEvent) => void;

export interface QueryOutcome<R> {
  readonly rows: readonly R[];
  /** Rows affected for INSERT/UPDATE/DELETE; rows returned for SELECT. */
  readonly row_count: number;
}

export interface Queryable {
  /**
   * Parameterized only. `sql` is static text; every value travels in `params`.
   * Never throws — failure is a value.
   */
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbResult<QueryOutcome<R>>>;
}

export interface DbHandle extends Queryable {
  /**
   * One connection, one transaction. COMMIT iff the callback resolves
   * `ok: true`; ROLLBACK on `ok: false` AND on a thrown exception (which is
   * caught and mapped, so `transaction` itself never throws either).
   */
  transaction<T>(fn: (tx: Queryable) => Promise<DbResult<T>>): Promise<DbResult<T>>;
  /** Liveness plus the server-version preflight. */
  ping(): Promise<DbResult<{ server_version_num: number }>>;
  /** Idempotent; safe to call on an already-closed handle. */
  close(): Promise<void>;
}

/**
 * INTERNAL to `@db` — deliberately not re-exported from `index.ts`.
 *
 * The migration runner needs several transactions on ONE session, because
 * `pg_advisory_lock` is session-scoped and must span the whole run while each
 * migration file still commits on its own (design §4.5). `transaction` cannot
 * express that, and widening the public surface to make it possible would hand
 * every repository a connection-pinning primitive it has no business holding.
 */
export interface SessionCapableHandle extends DbHandle {
  session<T>(fn: (client: Queryable) => Promise<DbResult<T>>): Promise<DbResult<T>>;
}

/** Narrowing used by the runner; keeps `session` off the public interface. */
export function asSessionCapable(handle: DbHandle): SessionCapableHandle | undefined {
  const candidate = handle as Partial<SessionCapableHandle>;
  return typeof candidate.session === 'function' ? (handle as SessionCapableHandle) : undefined;
}

async function runQuery<R>(
  target: Pool | PoolClient,
  sql: string,
  params: readonly unknown[] | undefined,
  logger: DbLogger | undefined,
): Promise<DbResult<QueryOutcome<R>>> {
  try {
    const result =
      params === undefined ? await target.query(sql) : await target.query(sql, [...params]);
    return ok({
      rows: result.rows as readonly R[],
      row_count: result.rowCount ?? result.rows.length,
    });
  } catch (cause) {
    const error = fromUnknown(cause, 'query failed');
    logger?.({
      level: 'error',
      event: 'query_failed',
      message: error.message,
      ...(error.sqlstate !== undefined && { sqlstate: error.sqlstate }),
    });
    return { ok: false, error };
  }
}

function bindClient(client: PoolClient, logger: DbLogger | undefined): Queryable {
  return {
    query: <R extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
      runQuery<R>(client, sql, params, logger),
  };
}

/**
 * Creates a pool. LAZY — no socket is opened until the first `query` or
 * `ping`, so constructing a handle can never fail and never blocks startup.
 */
export function createDbHandle(config: DbConfig, logger?: DbLogger): DbHandle {
  const pool = new Pool({
    connectionString: config.connection_string,
    application_name: config.application_name ?? DEFAULT_APPLICATION_NAME,
    max: config.max_connections ?? DEFAULT_MAX_CONNECTIONS,
    statement_timeout: config.statement_timeout_ms ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: config.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });

  // An idle client that errors out (server restart, admin disconnect) emits on
  // the pool. Without a listener Node treats it as an unhandled 'error' event
  // and takes the process down — a database blip would become an outage.
  pool.on('error', () => {
    logger?.({
      level: 'warn',
      event: 'query_failed',
      message: 'idle pool client errored and was discarded',
    });
  });

  let closed = false;
  logger?.({ level: 'info', event: 'pool_opened', message: 'connection pool created' });

  const query = <R extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
    runQuery<R>(pool, sql, params, logger);

  async function session<T>(
    fn: (client: Queryable) => Promise<DbResult<T>>,
  ): Promise<DbResult<T>> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (cause) {
      return { ok: false, error: fromUnknown(cause, 'could not check out a connection') };
    }
    try {
      return await fn(bindClient(client, logger));
    } catch (cause) {
      return { ok: false, error: fromUnknown(cause, 'session callback threw') };
    } finally {
      // ALWAYS released. A leaked client is a pool that dies slowly under load
      // and presents as a mysterious timeout ten minutes later.
      client.release();
    }
  }

  async function transaction<T>(
    fn: (tx: Queryable) => Promise<DbResult<T>>,
  ): Promise<DbResult<T>> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (cause) {
      return { ok: false, error: fromUnknown(cause, 'could not check out a connection') };
    }
    const tx = bindClient(client, logger);
    let destroy = false;
    try {
      const begun = await tx.query('BEGIN');
      if (!begun.ok) return { ok: false, error: begun.error };

      let outcome: DbResult<T>;
      try {
        outcome = await fn(tx);
      } catch (cause) {
        await tx.query('ROLLBACK');
        const error = fromUnknown(cause, 'transaction callback threw');
        logger?.({ level: 'error', event: 'transaction_rolled_back', message: error.message });
        return { ok: false, error };
      }

      if (!outcome.ok) {
        await tx.query('ROLLBACK');
        logger?.({
          level: 'warn',
          event: 'transaction_rolled_back',
          message: outcome.error.message,
        });
        return outcome;
      }

      const committed = await tx.query('COMMIT');
      if (!committed.ok) {
        // The transaction's state is now unknown, so the client is destroyed
        // rather than handed back to the pool.
        destroy = true;
        return { ok: false, error: committed.error };
      }
      return outcome;
    } finally {
      client.release(destroy);
    }
  }

  async function ping(): Promise<DbResult<{ server_version_num: number }>> {
    const result = await query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num",
    );
    if (!result.ok) return { ok: false, error: result.error };
    const version = Number.parseInt(result.value.rows[0]?.server_version_num ?? '', 10);
    if (!Number.isFinite(version)) {
      return err({ code: 'unknown', message: 'server did not report server_version_num' });
    }
    if (version < MIN_SERVER_VERSION_NUM) {
      return err({
        code: 'server_too_old',
        message: `postgres server_version_num ${String(version)} is below the required ${String(
          MIN_SERVER_VERSION_NUM,
        )}`,
      });
    }
    return ok({ server_version_num: version });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await pool.end();
    logger?.({ level: 'info', event: 'pool_closed', message: 'connection pool closed' });
  }

  const handle: SessionCapableHandle = { query, transaction, session, ping, close };
  return handle;
}
