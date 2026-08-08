/**
 * The migration runner — forward-only, checksum-verified, advisory-locked,
 * idempotent (docs/design/T-016.md §2.4, §3.10, §4.5, §4.6; ADR-008).
 *
 * ADR-008 chose plain `.sql` files plus a small in-repo runner over a migration
 * framework. The whole runner is below: read the directory, take one advisory
 * lock, apply each pending file in its own transaction, record it in the same
 * transaction. "Re-runnable without effect" is a property of that LEDGER, not
 * of `IF NOT EXISTS` sprinkled through the files.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { IsoTimestamp } from '@core';

import { APP_ROLE, MIGRATION_LOCK_KEY } from './config.js';
import { err, ok, type DbError, type DbResult } from './errors.js';
import { asSessionCapable, type DbHandle, type DbLogger, type Queryable } from './pool.js';

export interface MigrationSource {
  /** Zero-padded, e.g. `'0007'`. */
  version: string;
  /** Slug after the version, e.g. `'dealer_threads'`. */
  name: string;
  sql: string;
  /** sha-256 hex of the file with CRLF normalized to LF. */
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: IsoTimestamp;
  duration_ms: number;
}

export interface MigrationReport {
  /** Applied by THIS run, in order. Empty on a re-run — that is success. */
  applied: readonly AppliedMigration[];
  /** Versions already present in `schema_migrations` before this run. */
  already_applied: readonly string[];
}

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  name        text        NOT NULL,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms int         NOT NULL
)`;

function defaultDir(): string {
  return fileURLToPath(new URL('../migrations/', import.meta.url));
}

/** CRLF is normalized away first: a checkout on Windows must not re-checksum. */
function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function conflict<T>(message: string): DbResult<T> {
  return err({ code: 'migration_conflict', message });
}

/**
 * Reads `packages/db/migrations` by default; `dir` exists so tests can point at
 * a fixture directory without touching the real set.
 */
export function loadMigrations(dir: string = defaultDir()): DbResult<readonly MigrationSource[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return conflict(`migration directory is missing or unreadable: ${dir}`);
  }

  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();
  if (files.length === 0) return conflict(`migration directory contains no .sql files: ${dir}`);

  const sources: MigrationSource[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const match = FILENAME.exec(file);
    if (match === null) {
      return conflict(`migration filename does not match NNNN_slug.sql: ${file}`);
    }
    const version = match[1] as string;
    const name = match[2] as string;
    if (seen.has(version)) return conflict(`duplicate migration version ${version}`);
    seen.add(version);

    let sql: string;
    try {
      sql = readFileSync(`${dir}/${file}`, 'utf8');
    } catch {
      return conflict(`migration file is unreadable: ${file}`);
    }
    sources.push({ version, name, sql, checksum: checksumOf(sql) });
  }

  // Contiguous from 0001. A gap means a file was deleted or never committed,
  // and applying what remains would produce a schema no history explains.
  for (const [index, source] of sources.entries()) {
    const expected = String(index + 1).padStart(4, '0');
    if (source.version !== expected) {
      return conflict(`migration version gap: expected ${expected}, found ${source.version}`);
    }
  }

  return ok(sources);
}

interface LedgerRow extends Record<string, unknown> {
  version: string;
  checksum: string;
}

/** Adds the one hint that turns a bare 42501 into an actionable message. */
function annotate(error: DbError, version: string): DbError {
  const message =
    error.code === 'permission_denied' && version === '0001'
      ? `migration ${version} failed: the migrating role needs CREATEROLE to create ${APP_ROLE}; ` +
        'it is not skipped, because the append-only grant would then be absent while the ' +
        'schema claimed it'
      : `migration ${version} failed: ${error.message}`;
  return { ...error, message };
}

async function applyOne(
  client: Queryable,
  source: MigrationSource,
  logger: DbLogger | undefined,
): Promise<DbResult<AppliedMigration>> {
  const started = Date.now();

  const begun = await client.query('BEGIN');
  if (!begun.ok) return { ok: false, error: begun.error };

  const executed = await client.query(source.sql);
  if (!executed.ok) {
    await client.query('ROLLBACK');
    const error = annotate(executed.error, source.version);
    logger?.({
      level: 'error',
      event: 'migration_failed',
      message: error.message,
      migration_version: source.version,
      ...(error.sqlstate !== undefined && { sqlstate: error.sqlstate }),
    });
    return { ok: false, error };
  }

  const duration_ms = Date.now() - started;
  // The ledger row shares the file's transaction, so a version is either fully
  // applied AND recorded, or neither. A process that dies mid-run resumes at
  // the first unapplied version.
  const recorded = await client.query<{ applied_at: unknown }>(
    `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
     VALUES ($1, $2, $3, $4) RETURNING applied_at`,
    [source.version, source.name, source.checksum, duration_ms],
  );
  if (!recorded.ok) {
    await client.query('ROLLBACK');
    const error = annotate(recorded.error, source.version);
    logger?.({
      level: 'error',
      event: 'migration_failed',
      message: error.message,
      migration_version: source.version,
    });
    return { ok: false, error };
  }

  const committed = await client.query('COMMIT');
  if (!committed.ok) {
    await client.query('ROLLBACK');
    return { ok: false, error: annotate(committed.error, source.version) };
  }

  const raw = recorded.value.rows[0]?.applied_at;
  const applied_at: IsoTimestamp =
    raw instanceof Date ? raw.toISOString() : new Date(String(raw)).toISOString();

  logger?.({
    level: 'info',
    event: 'migration_applied',
    message: `applied migration ${source.version}`,
    migration_version: source.version,
    duration_ms,
  });

  return ok({
    version: source.version,
    name: source.name,
    checksum: source.checksum,
    applied_at,
    duration_ms,
  });
}

/**
 * Forward-only, checksum-verified, advisory-locked, idempotent.
 *
 * Never throws. A second concurrent runner blocks on the advisory lock and then
 * finds everything applied, so two starting API processes and a test file
 * cannot half-apply a migration between them.
 */
export async function runMigrations(
  handle: DbHandle,
  options?: { dir?: string; logger?: DbLogger },
): Promise<DbResult<MigrationReport>> {
  const logger = options?.logger;

  const sources = options?.dir === undefined ? loadMigrations() : loadMigrations(options.dir);
  if (!sources.ok) return { ok: false, error: sources.error };

  // Preflight BEFORE the lock, so an unsupported server is one clear message
  // rather than a confusing DDL error half-way through the set (design D9).
  const pinged = await handle.ping();
  if (!pinged.ok) return { ok: false, error: pinged.error };

  const sessionCapable = asSessionCapable(handle);
  if (sessionCapable === undefined) {
    return err({
      code: 'unknown',
      message: 'handle does not support a pinned session; use createDbHandle',
    });
  }

  return sessionCapable.session<MigrationReport>(async (client) => {
    const locked = await client.query('SELECT pg_advisory_lock($1::bigint)', [
      MIGRATION_LOCK_KEY,
    ]);
    if (!locked.ok) return { ok: false, error: locked.error };

    try {
      // Bootstraps against a genuinely empty database — the ledger is not a
      // chicken-and-egg problem because the runner, not a migration, creates it.
      const ledger = await client.query(LEDGER_DDL);
      if (!ledger.ok) return { ok: false, error: ledger.error };

      const existing = await client.query<LedgerRow>(
        'SELECT version, checksum FROM schema_migrations',
      );
      if (!existing.ok) return { ok: false, error: existing.error };

      const applied_checksums = new Map<string, string>(
        existing.value.rows.map((row) => [row.version, row.checksum]),
      );

      // Checksum drift is NOT auto-repaired. Someone edited an applied
      // migration; the fix is a NEW migration, never a rewritten one. Silent
      // repair would let a schema diverge from its own history.
      for (const source of sources.value) {
        const recorded = applied_checksums.get(source.version);
        if (recorded !== undefined && recorded !== source.checksum) {
          logger?.({
            level: 'error',
            event: 'migration_failed',
            message: `checksum drift on migration ${source.version}`,
            migration_version: source.version,
          });
          return conflict(
            `migration ${source.version} was modified after it was applied; add a new migration instead`,
          );
        }
      }

      const already_applied: string[] = [];
      const applied: AppliedMigration[] = [];

      for (const source of sources.value) {
        if (applied_checksums.has(source.version)) {
          already_applied.push(source.version);
          logger?.({
            level: 'info',
            event: 'migration_skipped',
            message: `migration ${source.version} already applied`,
            migration_version: source.version,
          });
          continue;
        }
        const outcome = await applyOne(client, source, logger);
        // No later file runs: the database is left at the last fully-applied
        // version, never half a migration.
        if (!outcome.ok) return { ok: false, error: outcome.error };
        applied.push(outcome.value);
      }

      return ok({ applied, already_applied });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
    }
  });
}
