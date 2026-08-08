/**
 * T-016 tester — shared fixtures for the `@db` suite.
 *
 * Three groups of helper live here:
 *
 *  1. **A small SQL reader.** The migration set is the deliverable, so most of
 *     what T-016 promises is provable by reading the `.sql` files: which tables
 *     exist, which columns they carry, which grants they hand out, which
 *     triggers guard them. These checks run with NO database, which matters
 *     because ADR-008 makes the no-Postgres configuration the DEFAULT one — a
 *     suite that could only speak when `DATABASE_URL` was set would be silent
 *     exactly where the project normally lives.
 *
 *  2. **A fake `DbHandle`.** `runMigrations` has a control flow full of failure
 *     paths (checksum drift, a DDL failure mid-set, a handle with no pinned
 *     session, a failed preflight) and every one of them is reachable without a
 *     server. An untested failure mode is a finding, so they are all driven
 *     here through a recording stub.
 *
 *  3. **The ADR-008 skip gate.** `describeDb` is `describe.skip` when
 *     `DATABASE_URL` is absent. Skipped is REPORTED as skipped — never quietly
 *     dropped and never reported as passed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { describe } from 'vitest';

import type { DbError, DbHandle, DbResult, Queryable, QueryOutcome } from '@db';

// ---------------------------------------------------------------------------
// 1. reading the migration set
// ---------------------------------------------------------------------------

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface MigrationFile {
  file: string;
  version: string;
  name: string;
  /** Raw text, comments and all. */
  raw: string;
  /** Comments stripped — what the server actually executes. */
  code: string;
}

/** Strips `--` line comments without touching a `--` that sits inside a string. */
function stripLineComments(sql: string): string {
  const out: string[] = [];
  for (const line of sql.split('\n')) {
    let inSingle = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "'") inSingle = !inSingle;
      if (!inSingle && ch === '-' && line[i + 1] === '-') {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join('\n');
}

/**
 * Removes `$$ ... $$` bodies. PL/pgSQL bodies contain their own `BEGIN`,
 * parentheses and semicolons, so table parsing has to see the file without
 * them; trigger assertions read `raw` instead.
 */
export function stripDollarQuoted(sql: string): string {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, ' $$BODY$$ ');
}

export function loadMigrationFiles(): readonly MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((file) => {
      const raw = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      const match = /^(\d+)_([a-z0-9_]+)\.sql$/.exec(file);
      return {
        file,
        version: match?.[1] ?? '',
        name: match?.[2] ?? '',
        raw,
        code: stripLineComments(raw),
      };
    });
}

/** Every migration's executable text, concatenated. */
export function allMigrationCode(): string {
  return loadMigrationFiles()
    .map((m) => m.code)
    .join('\n');
}

export interface ParsedTable {
  name: string;
  /** The text between the outermost parentheses of `CREATE TABLE`. */
  body: string;
  /** Column definitions only — table constraints are excluded. */
  columns: readonly ParsedColumn[];
  file: string;
}

export interface ParsedColumn {
  name: string;
  /** Everything after the column name, upper-cased for matching. */
  definition: string;
}

const CONSTRAINT_LEADERS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'FOREIGN',
  'CHECK',
  'EXCLUDE',
  'LIKE',
]);

/** Splits on commas that sit at parenthesis depth zero. */
export function splitTopLevel(body: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inSingle = false;
  for (const ch of body) {
    if (ch === "'") inSingle = !inSingle;
    if (!inSingle && ch === '(') depth += 1;
    if (!inSingle && ch === ')') depth -= 1;
    if (!inSingle && ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/** Reads from `openIndex` (the `(`) to its matching `)`. */
function balanced(text: string, openIndex: number): string {
  let depth = 0;
  let inSingle = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") inSingle = !inSingle;
    if (inSingle) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return '';
}

export function parseTables(): readonly ParsedTable[] {
  const tables: ParsedTable[] = [];
  for (const migration of loadMigrationFiles()) {
    const code = stripDollarQuoted(migration.code);
    const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s*\(/gi;
    let hit: RegExpExecArray | null = pattern.exec(code);
    while (hit !== null) {
      const openIndex = code.indexOf('(', hit.index);
      const body = balanced(code, openIndex);
      const columns: ParsedColumn[] = [];
      for (const part of splitTopLevel(body)) {
        const first = part.split(/\s+/)[0] ?? '';
        if (CONSTRAINT_LEADERS.has(first.toUpperCase())) continue;
        columns.push({
          name: first,
          definition: part.slice(first.length).trim().toUpperCase(),
        });
      }
      tables.push({
        name: hit[1] ?? '',
        body,
        columns,
        file: migration.file,
      });
      hit = pattern.exec(code);
    }
  }
  return tables;
}

export function tableNamed(name: string): ParsedTable {
  const found = parseTables().find((t) => t.name === name);
  if (found === undefined) throw new Error(`no CREATE TABLE for ${name} in the migration set`);
  return found;
}

export function columnNames(table: ParsedTable): readonly string[] {
  return table.columns.map((c) => c.name);
}

export interface ParsedGrant {
  privileges: readonly string[];
  table: string;
  role: string;
  file: string;
}

export function parseGrants(): readonly ParsedGrant[] {
  const grants: ParsedGrant[] = [];
  for (const migration of loadMigrationFiles()) {
    const pattern = /GRANT\s+([A-Z,\s]+?)\s+ON\s+(?:TABLE\s+)?([a-z0-9_]+)\s+TO\s+([a-z0-9_]+)/gi;
    let hit: RegExpExecArray | null = pattern.exec(migration.code);
    while (hit !== null) {
      grants.push({
        privileges: (hit[1] ?? '')
          .split(',')
          .map((p) => p.trim().toUpperCase())
          .filter((p) => p.length > 0),
        table: hit[2] ?? '',
        role: hit[3] ?? '',
        file: migration.file,
      });
      hit = pattern.exec(migration.code);
    }
  }
  // `GRANT USAGE ON SCHEMA public` is not a table grant.
  return grants.filter((g) => g.table !== 'public');
}

/** pg enum type name -> labels, read out of `0002_enums.sql`. */
export function parseEnumTypes(): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  const code = allMigrationCode();
  const pattern = /CREATE\s+TYPE\s+([a-z0-9_]+)\s+AS\s+ENUM\s*\(([^)]*)\)/gi;
  let hit: RegExpExecArray | null = pattern.exec(code);
  while (hit !== null) {
    out[hit[1] ?? ''] = (hit[2] ?? '')
      .split(',')
      .map((label) => label.trim().replace(/^'|'$/g, ''))
      .filter((label) => label.length > 0);
    hit = pattern.exec(code);
  }
  return out;
}

/** Foreign keys declared with an explicit `CONSTRAINT <name> FOREIGN KEY (...)`. */
export interface ParsedForeignKey {
  name: string;
  columns: readonly string[];
  target: string;
  targetColumns: readonly string[];
  onDelete: string;
}

export function parseForeignKeys(): readonly ParsedForeignKey[] {
  const out: ParsedForeignKey[] = [];
  const code = stripDollarQuoted(allMigrationCode());
  const pattern =
    /CONSTRAINT\s+([a-z0-9_]+)\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z0-9_]+)\s*\(([^)]*)\)([^,;]*)/gi;
  let hit: RegExpExecArray | null = pattern.exec(code);
  while (hit !== null) {
    const split = (s: string): readonly string[] =>
      s
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    out.push({
      name: hit[1] ?? '',
      columns: split(hit[2] ?? ''),
      target: hit[3] ?? '',
      targetColumns: split(hit[4] ?? ''),
      onDelete: (hit[5] ?? '').toUpperCase().trim(),
    });
    hit = pattern.exec(code);
  }
  return out;
}

export function foreignKeyNamed(name: string): ParsedForeignKey {
  const found = parseForeignKeys().find((fk) => fk.name === name);
  if (found === undefined) throw new Error(`no FOREIGN KEY constraint named ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// 2. the fake DbHandle
// ---------------------------------------------------------------------------

export interface FakeCall {
  sql: string;
  params?: readonly unknown[] | undefined;
}

export interface LedgerRow {
  version: string;
  checksum: string;
}

export interface FakeHandleOptions {
  /** Reported by `ping()`. Below 140000 must trip `server_too_old`. */
  server_version_num?: number;
  /** Rows already in `schema_migrations` before the run. */
  ledger?: readonly LedgerRow[];
  /** Return a `DbError` to make that statement fail. */
  failOn?: (sql: string) => DbError | undefined;
  /** Omit `session` so `asSessionCapable` cannot narrow the handle. */
  withoutSession?: boolean;
}

export interface FakeHandle extends DbHandle {
  calls: FakeCall[];
  ledger: LedgerRow[];
  sqlText(): string;
}

const EMPTY: readonly Record<string, unknown>[] = [];

/**
 * A `DbHandle` that answers the handful of statements the runner issues and
 * records every one. It is deliberately dumb: it proves the runner's ORDER and
 * its failure handling, never Postgres's behaviour — that is what the
 * DATABASE_URL-gated suite is for, and conflating the two is how a DB test ends
 * up green without a database.
 */
export function createFakeHandle(options: FakeHandleOptions = {}): FakeHandle {
  const calls: FakeCall[] = [];
  const ledger: LedgerRow[] = [...(options.ledger ?? [])];
  const version = options.server_version_num ?? 160000;

  function respond(sql: string): DbResult<readonly Record<string, unknown>[]> {
    const forced = options.failOn?.(sql);
    if (forced !== undefined) return { ok: false, error: forced };

    if (sql.includes('server_version_num')) {
      return { ok: true, value: [{ server_version_num: String(version) }] };
    }
    if (sql.includes('SELECT version, checksum FROM schema_migrations')) {
      return { ok: true, value: ledger.map((row) => ({ ...row })) };
    }
    if (sql.includes('INSERT INTO schema_migrations')) {
      return { ok: true, value: [{ applied_at: new Date('2026-08-07T00:00:00.000Z') }] };
    }
    return { ok: true, value: EMPTY };
  }

  const query = <R extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbResult<QueryOutcome<R>>> => {
    calls.push({ sql, params });
    if (sql.includes('INSERT INTO schema_migrations') && params !== undefined) {
      ledger.push({ version: String(params[0]), checksum: String(params[2]) });
    }
    const outcome = respond(sql);
    if (!outcome.ok) return Promise.resolve({ ok: false, error: outcome.error });
    const rows = outcome.value as unknown as readonly R[];
    return Promise.resolve({ ok: true, value: { rows, row_count: rows.length } });
  };

  const queryable: Queryable = { query };

  const handle = {
    query,
    calls,
    ledger,
    sqlText: () => calls.map((c) => c.sql).join('\n---\n'),
    transaction: <T>(fn: (tx: Queryable) => Promise<DbResult<T>>) => fn(queryable),
    ping: async (): Promise<DbResult<{ server_version_num: number }>> => {
      const result = await query<{ server_version_num: string }>(
        "SELECT current_setting('server_version_num') AS server_version_num",
      );
      if (!result.ok) return { ok: false, error: result.error };
      if (version < 140000) {
        return {
          ok: false,
          error: {
            code: 'server_too_old',
            retryable: false,
            message: `server_version_num ${String(version)} is below 140000`,
          },
        };
      }
      return { ok: true, value: { server_version_num: version } };
    },
    close: (): Promise<void> => Promise.resolve(),
    ...(options.withoutSession === true
      ? {}
      : { session: <T>(fn: (client: Queryable) => Promise<DbResult<T>>) => fn(queryable) }),
  };

  return handle as unknown as FakeHandle;
}

// ---------------------------------------------------------------------------
// 3. the ADR-008 skip gate
// ---------------------------------------------------------------------------

const rawDatabaseUrl = process.env['DATABASE_URL'];

/** `undefined` is the NORMAL PoC state (ADR-008), never an error. */
export const DATABASE_URL: string | undefined =
  rawDatabaseUrl === undefined || rawDatabaseUrl.trim() === '' ? undefined : rawDatabaseUrl.trim();

export const HAS_DATABASE = DATABASE_URL !== undefined;

/**
 * ADR-008: a DB-dependent test SKIPS when its configuration is absent, and the
 * skip is reported. It is never faked into a pass and never deleted to keep a
 * suite green — a green suite that never touched a database is a lie about the
 * one thing this task exists to prove.
 */
export const describeDb = HAS_DATABASE ? describe : describe.skip;

/**
 * Points a copy of `DATABASE_URL` at a scratch schema, so the suite never
 * writes into whatever schema the operator's database already holds.
 * `-csearch_path=` is passed through libpq's `options`, which applies to every
 * connection the pool opens rather than to one lucky checkout.
 */
export function scopedConnectionString(base: string, schema: string): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}options=${encodeURIComponent(`-csearch_path=${schema},public`)}`;
}

export function scratchSchemaName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `t016_${suffix}`;
}

export function expectOk<T>(result: DbResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

export function expectErr<T>(result: DbResult<T>): DbError {
  if (result.ok) throw new Error('expected an error, got ok');
  return result.error;
}
