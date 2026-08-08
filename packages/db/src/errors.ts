/**
 * `@db` error vocabulary — one mapping, owned in one place.
 *
 * docs/design/T-016.md §2.3, §4.3, D6.
 *
 * House rule, inherited from `@core`'s `AdapterResult`: **failure is a value,
 * never an exception.** Nothing exported from this package throws; every entry
 * point returns a `DbResult`.
 *
 * `DbError.message` is LOG-SAFE BY CONTRACT: codes, SQLSTATEs, table names,
 * constraint names, column names, migration versions. It never carries a bound
 * parameter, a row value, a message body, an email address, a phone number, a
 * VIN, a price, or the connection string — the receipt trail is evidence, and a
 * log that mirrors it is an uncontrolled second copy of the very PII the
 * tenancy split exists to contain (design §4.8).
 */

export type DbErrorCode =
  /** `DATABASE_URL` absent — a STATE, not a fault (ADR-008). */
  | 'not_configured'
  /** Could not reach or authenticate (`08*`, `28*`). */
  | 'connection_failed'
  /** `server_version_num` below {@link MIN_SERVER_VERSION_NUM} (design D9). */
  | 'server_too_old'
  /** `42501` — includes UPDATE/DELETE on `receipt_entries` hitting the grant wall. */
  | 'permission_denied'
  /** `23505`. */
  | 'unique_violation'
  /** `23503` — includes the cross-account composite foreign key. */
  | 'foreign_key_violation'
  /** `23502`. */
  | 'not_null_violation'
  /** `23514`, `22P02`, `22003`. */
  | 'check_violation'
  /** `DC001` — the receipt trail was written against. */
  | 'append_only_violation'
  /** `DC002` — a write-once value changed after its lock. */
  | 'write_once_violation'
  /** `DC003` — reserved: a cross-account reference caught by a trigger. */
  | 'tenancy_violation'
  /** `40001` / `40P01` — retryable. */
  | 'serialization_failure'
  /** `57014` — deliberately NOT retryable. */
  | 'statement_timeout'
  /** Checksum drift, a version gap, or a duplicate version. */
  | 'migration_conflict'
  /** `57P01`, `53300` — retry with backoff at the caller. */
  | 'unavailable'
  /** Unmapped. NEVER guessed as retryable. */
  | 'unknown';

export interface DbError {
  code: DbErrorCode;
  /** Stated explicitly so a caller never has to guess (design §4.7). */
  retryable: boolean;
  /** Log-safe by contract — see the module header. */
  message: string;
  sqlstate?: string;
  table?: string;
  constraint?: string;
}

export type DbResult<T> = { ok: true; value: T } | { ok: false; error: DbError };

/** Project-specific SQLSTATEs raised by this schema's triggers (design D6). */
export const SQLSTATE_APPEND_ONLY = 'DC001';
export const SQLSTATE_WRITE_ONCE = 'DC002';
export const SQLSTATE_TENANCY = 'DC003';

interface Classification {
  code: DbErrorCode;
  retryable: boolean;
}

const EXACT: Readonly<Record<string, Classification>> = {
  '42501': { code: 'permission_denied', retryable: false },
  '23505': { code: 'unique_violation', retryable: false },
  '23503': { code: 'foreign_key_violation', retryable: false },
  '23502': { code: 'not_null_violation', retryable: false },
  '23514': { code: 'check_violation', retryable: false },
  '22P02': { code: 'check_violation', retryable: false },
  '22003': { code: 'check_violation', retryable: false },
  [SQLSTATE_APPEND_ONLY]: { code: 'append_only_violation', retryable: false },
  [SQLSTATE_WRITE_ONCE]: { code: 'write_once_violation', retryable: false },
  [SQLSTATE_TENANCY]: { code: 'tenancy_violation', retryable: false },
  '40001': { code: 'serialization_failure', retryable: true },
  '40P01': { code: 'serialization_failure', retryable: true },
  // Re-running a statement that already blew its time budget reproduces the
  // cost. Deliberately not retryable (design §4.3).
  '57014': { code: 'statement_timeout', retryable: false },
  '57P01': { code: 'unavailable', retryable: true },
  '53300': { code: 'unavailable', retryable: true },
};

/**
 * Pure and total. Exported so callers can assert the mapping directly instead
 * of provoking each failure against a live server.
 *
 * Class `08` (connection exception) and class `28` (invalid authorization) both
 * mean "we did not get a usable session", which is `connection_failed`; the
 * design's "`08xxx` after connect" case is indistinguishable from a SQLSTATE
 * alone, and both classifications are retryable, so the caller's decision is
 * unchanged either way.
 */
export function classifySqlstate(sqlstate: string): Classification {
  const exact = EXACT[sqlstate];
  if (exact !== undefined) return { ...exact };
  if (sqlstate.startsWith('08')) return { code: 'connection_failed', retryable: true };
  if (sqlstate.startsWith('28')) return { code: 'connection_failed', retryable: false };
  // An unknown failure is never guessed as retryable: that is how a
  // non-idempotent INSERT gets applied twice (design §4.3, last row).
  return { code: 'unknown', retryable: false };
}

interface DbErrorFields {
  code: DbErrorCode;
  message: string;
  retryable?: boolean;
  sqlstate?: string;
  table?: string;
  constraint?: string;
}

/**
 * Builds a `DbError` without ever assigning `undefined` to an optional field —
 * the toolchain sets `exactOptionalPropertyTypes` (design §2.3 note).
 */
export function dbError(fields: DbErrorFields): DbError {
  return {
    code: fields.code,
    retryable: fields.retryable ?? false,
    message: fields.message,
    ...(fields.sqlstate !== undefined && { sqlstate: fields.sqlstate }),
    ...(fields.table !== undefined && { table: fields.table }),
    ...(fields.constraint !== undefined && { constraint: fields.constraint }),
  };
}

export function err<T = never>(fields: DbErrorFields): DbResult<T> {
  return { ok: false, error: dbError(fields) };
}

export function ok<T>(value: T): DbResult<T> {
  return { ok: true, value };
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Maps anything a driver call may reject with onto a `DbError`.
 *
 * `fallbackMessage` is STATIC text supplied by the caller. A driver message is
 * never copied through: node-postgres puts the offending value into `detail`
 * and sometimes into `message`, which would put a row value into a log.
 */
export function fromUnknown(cause: unknown, fallbackMessage: string): DbError {
  if (typeof cause === 'object' && cause !== null) {
    const source = cause as Record<string, unknown>;
    const sqlstate = readString(source, 'code');
    if (sqlstate !== undefined && /^[0-9A-Z]{5}$/.test(sqlstate)) {
      const { code, retryable } = classifySqlstate(sqlstate);
      const table = readString(source, 'table');
      const constraint = readString(source, 'constraint');
      return dbError({
        code,
        retryable,
        message: `${fallbackMessage} (sqlstate ${sqlstate})`,
        sqlstate,
        ...(table !== undefined && { table }),
        ...(constraint !== undefined && { constraint }),
      });
    }
    // Driver-level failures (DNS, refused socket, TLS) carry an errno-style
    // code rather than a SQLSTATE.
    if (sqlstate !== undefined) {
      return dbError({
        code: 'connection_failed',
        retryable: true,
        message: `${fallbackMessage} (driver code ${sqlstate})`,
      });
    }
  }
  return dbError({ code: 'unknown', retryable: false, message: fallbackMessage });
}
