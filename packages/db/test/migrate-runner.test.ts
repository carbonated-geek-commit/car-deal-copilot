/**
 * T-016 tester — `loadMigrations` and `runMigrations`, including every failure
 * path the design names (§2.4, §4.5, §4.6, AC-15).
 *
 * The runner is the part of ADR-008's "small in-repo runner" that a framework
 * would otherwise have owned, so its failure behaviour is the part worth
 * proving hardest — and all of it is reachable without a server:
 *
 *   - a version gap or a duplicate version is refused, not silently applied;
 *   - checksum drift on an APPLIED migration is refused, never auto-repaired
 *     (auto-repair lets a schema diverge from its own history — the same class
 *     of dishonesty as a green DB test that never touched a database);
 *   - a failing DDL rolls its file back WHOLE, writes no ledger row, and stops
 *     the set, so the database is left at the last fully-applied version;
 *   - a re-run applies nothing and reports `applied: []` — that is success.
 *
 * The stub handle proves the runner's ORDER and control flow only. Whether
 * Postgres accepts the DDL is a different question, asked in the
 * DATABASE_URL-gated suite and reported SKIPPED when it cannot be asked.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { loadMigrations, runMigrations, type DbLogEvent } from '@db';

import { createFakeHandle, expectErr, expectOk, MIGRATIONS_DIR } from './helpers.js';

/**
 * Awaits the callback before cleaning up. A sync-only version would rmSync the
 * fixture out from under an async body and let the assertions run after the
 * files were gone — a test that passes because it never really ran.
 */
async function withTempDir(
  files: Readonly<Record<string, string>>,
  fn: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(`${tmpdir()}/t016-`);
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(`${dir}/${name}`, body, 'utf8');
    }
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadMigrations (§4.6)', () => {
  it('reads the real set, contiguous from 0001, with a slug per file', async () => {
    const sources = expectOk(loadMigrations());
    expect(sources.length).toBeGreaterThanOrEqual(14);
    sources.forEach((source, index) => {
      expect(source.version).toBe(String(index + 1).padStart(4, '0'));
      expect(source.name).toMatch(/^[a-z0-9_]+$/);
      expect(source.sql.length).toBeGreaterThan(0);
      expect(source.checksum).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('produces a stable checksum across two loads', async () => {
    const first = expectOk(loadMigrations());
    const second = expectOk(loadMigrations(MIGRATIONS_DIR));
    expect(second.map((s) => s.checksum)).toEqual(first.map((s) => s.checksum));
  });

  it('normalizes CRLF so a Windows checkout does not re-checksum the world', async () => {
    await withTempDir({ '0001_a.sql': 'SELECT 1;\nSELECT 2;\n' }, async (lf) => {
      await withTempDir({ '0001_a.sql': 'SELECT 1;\r\nSELECT 2;\r\n' }, (crlf) => {
        expect(expectOk(loadMigrations(crlf))[0]?.checksum).toBe(
          expectOk(loadMigrations(lf))[0]?.checksum,
        );
      });
    });
  });

  it('refuses a missing directory', async () => {
    const error = expectErr(loadMigrations(`${MIGRATIONS_DIR}/does-not-exist`));
    expect(error.code).toBe('migration_conflict');
  });

  it('refuses a directory with no .sql files', async () => {
    await withTempDir({ 'README.md': 'nothing here' }, (dir) => {
      expect(expectErr(loadMigrations(dir)).code).toBe('migration_conflict');
    });
  });

  it('refuses a filename that does not match NNNN_slug.sql', async () => {
    await withTempDir({ 'first.sql': 'SELECT 1;' }, (dir) => {
      const error = expectErr(loadMigrations(dir));
      expect(error.code).toBe('migration_conflict');
      expect(error.message).toContain('first.sql');
    });
  });

  it('refuses a duplicate version, even under two different slugs', async () => {
    await withTempDir({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' }, (dir) => {
      const error = expectErr(loadMigrations(dir));
      expect(error.code).toBe('migration_conflict');
      expect(error.message).toContain('duplicate');
    });
  });

  it('refuses a version gap — a deleted file leaves a schema no history explains', async () => {
    await withTempDir({ '0001_a.sql': 'SELECT 1;', '0003_c.sql': 'SELECT 3;' }, (dir) => {
      const error = expectErr(loadMigrations(dir));
      expect(error.code).toBe('migration_conflict');
      expect(error.message).toContain('gap');
    });
  });

  it('refuses a set that does not start at 0001', async () => {
    await withTempDir({ '0002_b.sql': 'SELECT 2;' }, (dir) => {
      expect(expectErr(loadMigrations(dir)).code).toBe('migration_conflict');
    });
  });
});

describe('runMigrations control flow (§4.5, AC-15)', () => {
  const FIXTURE = { '0001_a.sql': 'CREATE TABLE a ();', '0002_b.sql': 'CREATE TABLE b ();' };

  it('applies every pending file in version order, each inside its own transaction', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle();
      const report = expectOk(await runMigrations(handle, { dir }));
      expect(report.applied.map((a) => a.version)).toEqual(['0001', '0002']);
      expect(report.already_applied).toEqual([]);

      const sql = handle.calls.map((c) => c.sql);
      expect(sql.filter((s) => s === 'BEGIN').length).toBe(2);
      expect(sql.filter((s) => s === 'COMMIT').length).toBe(2);
      // The ledger row shares its file's transaction: BEGIN, DDL, INSERT, COMMIT.
      const firstBegin = sql.indexOf('BEGIN');
      const firstInsert = sql.findIndex((s) => s.includes('INSERT INTO schema_migrations'));
      const firstCommit = sql.indexOf('COMMIT');
      expect(firstBegin).toBeLessThan(firstInsert);
      expect(firstInsert).toBeLessThan(firstCommit);
    });
  });

  it('takes the advisory lock before the ledger and releases it after', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle();
      expectOk(await runMigrations(handle, { dir }));
      const sql = handle.calls.map((c) => c.sql);
      const lock = sql.findIndex((s) => s.includes('pg_advisory_lock'));
      const ledger = sql.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS schema_migrations'));
      const unlock = sql.findIndex((s) => s.includes('pg_advisory_unlock'));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(ledger);
      expect(unlock).toBeGreaterThan(ledger);
    });
  });

  it('bootstraps the ledger itself, so an EMPTY database is not a chicken-and-egg problem', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle({ ledger: [] });
      expectOk(await runMigrations(handle, { dir }));
      expect(handle.sqlText()).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    });
  });

  it('is re-runnable without effect: nothing applied, everything already applied', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const first = createFakeHandle();
      const initial = expectOk(await runMigrations(first, { dir }));
      const second = createFakeHandle({ ledger: first.ledger });
      const report = expectOk(await runMigrations(second, { dir }));

      expect(initial.applied.length).toBe(2);
      expect(report.applied).toEqual([]);
      expect(report.already_applied).toEqual(['0001', '0002']);
      // No DDL executed on the second pass — idempotency is a property of the
      // LEDGER, not of `IF NOT EXISTS` sprinkled through the files.
      expect(second.sqlText()).not.toContain('CREATE TABLE a ()');
      expect(second.sqlText()).not.toContain('BEGIN');
    });
  });

  it('refuses checksum drift on an applied migration and never auto-repairs it', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle({
        ledger: [{ version: '0001', checksum: 'a-checksum-from-a-different-file' }],
      });
      const error = expectErr(await runMigrations(handle, { dir }));
      expect(error.code).toBe('migration_conflict');
      expect(error.message).toContain('0001');
      // Nothing was applied, and no ledger row was rewritten.
      expect(handle.sqlText()).not.toContain('INSERT INTO schema_migrations');
      expect(handle.sqlText()).not.toContain('UPDATE schema_migrations');
    });
  });

  it('checks the WHOLE set for drift before applying anything pending', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle({ ledger: [{ version: '0002', checksum: 'drifted' }] });
      expect(expectErr(await runMigrations(handle, { dir })).code).toBe('migration_conflict');
      // 0001 is pending and would otherwise have gone first.
      expect(handle.sqlText()).not.toContain('CREATE TABLE a ()');
    });
  });

  it('rolls a failing file back whole, records no ledger row, and stops the set', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle({
        failOn: (sql) =>
          sql.includes('CREATE TABLE a ()')
            ? { code: 'check_violation', retryable: false, message: 'bad ddl', sqlstate: '42601' }
            : undefined,
      });
      const error = expectErr(await runMigrations(handle, { dir }));
      expect(error.message).toContain('0001');
      const sql = handle.sqlText();
      expect(sql).toContain('ROLLBACK');
      expect(sql).not.toContain('COMMIT');
      expect(sql).not.toContain('INSERT INTO schema_migrations');
      // No later file runs: the database is left at the last fully-applied
      // version, never half a migration.
      expect(sql).not.toContain('CREATE TABLE b ()');
    });
  });

  it('releases the advisory lock even when a migration fails', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle({
        failOn: (sql) =>
          sql.includes('CREATE TABLE a ()')
            ? { code: 'unknown', retryable: false, message: 'bad ddl' }
            : undefined,
      });
      expectErr(await runMigrations(handle, { dir }));
      expect(handle.sqlText()).toContain('pg_advisory_unlock');
    });
  });

  it('explains a missing CREATEROLE on 0001 instead of skipping the grants', async () => {
    await withTempDir({ '0001_roles.sql': 'CREATE ROLE x;' }, async (dir) => {
      const handle = createFakeHandle({
        failOn: (sql) =>
          sql.includes('CREATE ROLE x')
            ? {
                code: 'permission_denied',
                retryable: false,
                message: 'permission denied',
                sqlstate: '42501',
              }
            : undefined,
      });
      const error = expectErr(await runMigrations(handle, { dir }));
      expect(error.code).toBe('permission_denied');
      // AC-6's guarantee would be FALSE while the suite looked green, so the
      // runner must refuse rather than warn past it.
      expect(error.message).toContain('CREATEROLE');
      expect(error.message).toContain('deal_copilot_app');
    });
  });

  it('fails the preflight on an unsupported server, before taking the lock (D9)', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle({ server_version_num: 130000 });
      const error = expectErr(await runMigrations(handle, { dir }));
      expect(error.code).toBe('server_too_old');
      expect(handle.sqlText()).not.toContain('pg_advisory_lock');
    });
  });

  it('refuses a handle that cannot pin a session rather than half-applying the set', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const handle = createFakeHandle({ withoutSession: true });
      const error = expectErr(await runMigrations(handle, { dir }));
      expect(error.code).toBe('unknown');
      expect(error.message).toContain('session');
      expect(handle.sqlText()).not.toContain('BEGIN');
    });
  });

  it('surfaces a bad migration directory without touching the handle at all', async () => {
    const handle = createFakeHandle();
    return runMigrations(handle, { dir: `${MIGRATIONS_DIR}/nope` }).then((result) => {
      expect(expectErr(result).code).toBe('migration_conflict');
      expect(handle.calls).toEqual([]);
    });
  });

  it('emits log events only when a logger is supplied, and leaks no row data', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const events: DbLogEvent[] = [];
      const first = createFakeHandle();
      expectOk(await runMigrations(first, { dir, logger: (e) => events.push(e) }));
      expect(events.map((e) => e.event)).toContain('migration_applied');
      for (const event of events) {
        expect(event.message).not.toContain('postgres://');
        expect(typeof event.message).toBe('string');
      }

      const quiet = createFakeHandle();
      expectOk(await runMigrations(quiet, { dir }));
      // No logger, no output: a library must not leak into a caller's log stream.
      expect(events.every((e) => e.migration_version !== '9999')).toBe(true);
    });
  });

  it('logs migration_skipped rather than silently ignoring an applied version', async () => {
    await withTempDir(FIXTURE, async (dir) => {
      const first = createFakeHandle();
      expectOk(await runMigrations(first, { dir }));
      const events: DbLogEvent[] = [];
      const second = createFakeHandle({ ledger: first.ledger });
      expectOk(await runMigrations(second, { dir, logger: (e) => events.push(e) }));
      expect(events.map((e) => e.event)).toEqual(['migration_skipped', 'migration_skipped']);
    });
  });
});
