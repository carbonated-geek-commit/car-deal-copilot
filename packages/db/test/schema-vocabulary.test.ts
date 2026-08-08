/**
 * T-016 tester — the exported vocabulary must describe the migration set, and
 * the spine enums must be the spine (design D10, §6.1 T2, AC-2).
 *
 * `@db` publishes identifiers rather than row shapes, which is only useful if
 * the identifiers are TRUE. Every constant here is checked twice: against the
 * `.sql` files (does the database actually have this?) and, for the nine spine
 * enums, against the frozen array in `@core` (is this still the spine?).
 *
 * ADR-001's promise is "defined once, imported everywhere". A Postgres enum is
 * a second place the same closed set is written down, so it is the one place
 * that promise can quietly break — and the break would be invisible until a
 * label diverged in production. These run with no database, always.
 */

import { describe, expect, it } from 'vitest';

import {
  DEALERSHIP_CONTACT_ROLES,
  MESSAGE_AUTHORS,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  OFFER_FLAGS,
  PROCESS_STEPS,
  VEHICLE_CONDITIONS,
} from '@core';
import {
  ACCOUNT_SCOPED_TABLES,
  APP_ROLE,
  CONSTRAINTS,
  GLOBAL_TABLES,
  MIN_SERVER_VERSION_NUM,
  PG_ENUMS,
  TABLE_PRIVILEGES,
  TABLES,
} from '@db';

import { allMigrationCode, parseEnumTypes, parseGrants, parseTables } from './helpers.js';

const code = allMigrationCode();
const createdTables = parseTables().map((t) => t.name);
const sqlEnums = parseEnumTypes();

describe('spine enums are the spine, label for label and in order (AC-2)', () => {
  const SPINE: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['message_channel', MESSAGE_CHANNELS],
    ['message_direction', MESSAGE_DIRECTIONS],
    ['message_author', MESSAGE_AUTHORS],
    ['vehicle_condition', VEHICLE_CONDITIONS],
    ['dealership_contact_role', DEALERSHIP_CONTACT_ROLES],
    ['process_step', PROCESS_STEPS],
    ['offer_flag', OFFER_FLAGS],
  ];

  it.each(SPINE)('pg enum %s equals its @core frozen array', (typeName, frozen) => {
    expect(PG_ENUMS[typeName]).toEqual(frozen);
    expect(sqlEnums[typeName]).toEqual(frozen);
  });

  it('carries deal_path and deal_status, which @core states as unions not arrays', () => {
    expect(PG_ENUMS['deal_path']).toEqual(['online', 'hybrid', 'in_person']);
    expect(PG_ENUMS['deal_status']).toEqual([
      'draft',
      'active',
      'negotiating',
      'closed',
      'burned',
    ]);
    expect(sqlEnums['deal_path']).toEqual(PG_ENUMS['deal_path']);
    expect(sqlEnums['deal_status']).toEqual(PG_ENUMS['deal_status']);
  });

  it('names payment_packing canonically and admits no legacy alias (ADR-002)', () => {
    expect(sqlEnums['offer_flag']).toContain('payment_packing');
    expect(sqlEnums['offer_flag']).not.toContain('packed_payment');
    expect(code).not.toMatch(/packed_payment/i);
  });

  it('carries above_market as a first-class flag label (ADR-007)', () => {
    expect(sqlEnums['offer_flag']).toContain('above_market');
    expect(OFFER_FLAGS).toContain('above_market');
  });

  it('declares in SQL exactly the enum types PG_ENUMS publishes — no more, no fewer', () => {
    expect(Object.keys(sqlEnums).sort()).toEqual(Object.keys(PG_ENUMS).sort());
    for (const [typeName, labels] of Object.entries(PG_ENUMS)) {
      expect(sqlEnums[typeName], typeName).toEqual(labels);
    }
  });

  it('has no enum label mentioning audio, recording, or a transcript', () => {
    for (const labels of Object.values(sqlEnums)) {
      for (const label of labels) {
        expect(label).not.toMatch(/audio|recording|transcript/i);
      }
    }
  });
});

describe('TABLES / scope lists / CONSTRAINTS describe the real schema', () => {
  it('lists every table the migrations create, plus the runner ledger', () => {
    const published = new Set<string>(Object.values(TABLES));
    for (const table of createdTables) {
      expect(published.has(table), `${table} is created but missing from TABLES`).toBe(true);
    }
    // schema_migrations is created by the runner, not by a migration file.
    for (const name of published) {
      if (name === TABLES.schema_migrations) continue;
      expect(createdTables, `${name} is published but never created`).toContain(name);
    }
  });

  it('partitions TABLES into scoped and global with nothing left unclassified', () => {
    const classified = [...ACCOUNT_SCOPED_TABLES, ...GLOBAL_TABLES].sort();
    expect(classified).toEqual(Object.values(TABLES).sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('keeps dealerships in GLOBAL_TABLES and out of ACCOUNT_SCOPED_TABLES', () => {
    expect(GLOBAL_TABLES).toContain(TABLES.dealerships);
    expect(ACCOUNT_SCOPED_TABLES).not.toContain(TABLES.dealerships);
  });

  it('keeps dealership_contacts account-scoped, never global', () => {
    expect(ACCOUNT_SCOPED_TABLES).toContain(TABLES.dealership_contacts);
    expect(GLOBAL_TABLES).not.toContain(TABLES.dealership_contacts);
  });

  it('names constraints that actually exist — renaming one must break the build', () => {
    for (const [key, name] of Object.entries(CONSTRAINTS)) {
      expect(code, `CONSTRAINTS.${key} = ${name}`).toContain(name);
    }
  });
});

describe('TABLE_PRIVILEGES states the grants the migrations hand out (AC-6)', () => {
  const granted = new Map<string, readonly string[]>(
    parseGrants().map((g) => [g.table, [...g.privileges].sort()]),
  );

  it('grants receipt_entries exactly SELECT and INSERT and says so', () => {
    expect([...(TABLE_PRIVILEGES[TABLES.receipt_entries] ?? [])].sort()).toEqual([
      'INSERT',
      'SELECT',
    ]);
    expect(granted.get(TABLES.receipt_entries)).toEqual(['INSERT', 'SELECT']);
  });

  it('matches the SQL for every table it describes', () => {
    for (const [table, privileges] of Object.entries(TABLE_PRIVILEGES)) {
      if (table === TABLES.schema_migrations) {
        expect(privileges).toEqual([]);
        expect(granted.has(table)).toBe(false);
        continue;
      }
      expect(granted.get(table), table).toEqual([...privileges].sort());
    }
  });

  it('describes every granted table, so a new grant cannot slip in unlisted', () => {
    for (const table of granted.keys()) {
      expect(Object.keys(TABLE_PRIVILEGES), table).toContain(table);
    }
  });

  it('never claims DELETE or TRUNCATE on anything', () => {
    for (const [table, privileges] of Object.entries(TABLE_PRIVILEGES)) {
      expect(privileges, table).not.toContain('DELETE');
      expect(privileges, table).not.toContain('TRUNCATE');
    }
  });

  it('grants only to the role the migrations create', () => {
    for (const grant of parseGrants()) {
      expect(grant.role).toBe(APP_ROLE);
    }
    expect(code).toContain(`CREATE ROLE ${APP_ROLE} NOLOGIN`);
    // NOLOGIN is the point: this role is a privilege bucket, and a password in
    // the repo would be a credential in the repo.
    expect(code).not.toMatch(new RegExp(`${APP_ROLE}[^;]*PASSWORD`, 'i'));
  });
});

describe('pinned constants', () => {
  it('floors the server at 14 so no extension is needed for gen_random_uuid (D9)', () => {
    expect(MIN_SERVER_VERSION_NUM).toBe(140000);
    expect(code).toContain('gen_random_uuid()');
    expect(code).not.toMatch(/uuid-ossp|pgcrypto/i);
  });
});
