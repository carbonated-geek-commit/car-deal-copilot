/**
 * `@db` public API — the ONLY import surface for the Postgres seam.
 *
 * Reached as `import { ... } from '@db'`. Bare specifier only: there are no
 * `@db/*` alias entries, so deep imports are unresolvable by construction.
 *
 * Scope (docs/design/T-016.md): the schema, the migration set, the migration
 * runner, and the connection handle. **No repository code** — every query
 * implementation is T-017, and it receives a `Queryable` rather than reaching
 * for `DATABASE_URL` itself.
 *
 * `IsoTimestamp` is imported from `@core` and never redeclared (ADR-001). This
 * package declares infrastructure types only; no spine type is redefined,
 * widened, or mirrored as "a row type that happens to match".
 */

export {
  APP_ROLE,
  MIGRATION_LOCK_KEY,
  MIN_SERVER_VERSION_NUM,
  readDbConfigFromEnv,
  type DbConfig,
} from './config.js';

export {
  classifySqlstate,
  SQLSTATE_APPEND_ONLY,
  SQLSTATE_TENANCY,
  SQLSTATE_WRITE_ONCE,
  type DbError,
  type DbErrorCode,
  type DbResult,
} from './errors.js';

export {
  createDbHandle,
  type DbHandle,
  type DbLogEvent,
  type DbLogger,
  type DbLogLevel,
  type Queryable,
  type QueryOutcome,
} from './pool.js';

export {
  loadMigrations,
  runMigrations,
  type AppliedMigration,
  type MigrationReport,
  type MigrationSource,
} from './migrate.js';

export {
  ACCOUNT_SCOPED_TABLES,
  CONSTRAINTS,
  GLOBAL_TABLES,
  PG_ENUMS,
  TABLE_PRIVILEGES,
  TABLES,
} from './schema.js';
