/**
 * T-016 tester — the migration set, read as text (design §6.2).
 *
 * These NEVER skip. ADR-008 makes "no Postgres configured" the default state of
 * the repo, so the rules that matter most are asserted against the `.sql` files
 * themselves. A rule that only bites when someone remembers to stand up a
 * database is a rule that rots.
 *
 * The mandates covered here structurally:
 *   - tenancy split      — `dealerships` global, `dealership_contacts` private
 *   - receipt append-only — no UPDATE/DELETE path exists to grant or to write
 *   - one vehicle target  — by arity: no `vehicle_targets` table at all
 *   - make/model mismatch — `vehicle_instances` carries no make/model column
 *   - ADR-005             — no DEFAULT on any optional money column
 *   - ADR-007             — the retail band lives on an INSTANCE-keyed snapshot
 *   - no audio anywhere   — no recording/transcript/audio column, no `bytea`
 */

import { describe, expect, it } from 'vitest';

import { ACCOUNT_SCOPED_TABLES, GLOBAL_TABLES, TABLES } from '@db';

import {
  allMigrationCode,
  columnNames,
  foreignKeyNamed,
  loadMigrationFiles,
  parseForeignKeys,
  parseGrants,
  parseTables,
  stripDollarQuoted,
  tableNamed,
} from './helpers.js';

const files = loadMigrationFiles();
const code = allMigrationCode();
const tables = parseTables();
const createdTables = tables.map((t) => t.name);

describe('migration file discipline (design §1.1)', () => {
  it('names every file NNNN_slug.sql with contiguous versions from 0001', () => {
    expect(files.length).toBeGreaterThan(0);
    files.forEach((migration, index) => {
      expect(migration.file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(migration.version).toBe(String(index + 1).padStart(4, '0'));
    });
  });

  it('contains no transaction control — the runner owns the transaction', () => {
    // A PL/pgSQL body's `BEGIN` has no semicolon after it, so this matches only
    // statement-level transaction control.
    for (const migration of files) {
      expect(migration.code, migration.file).not.toMatch(/\bBEGIN\s*;/i);
      expect(migration.code, migration.file).not.toMatch(/\bCOMMIT\s*;/i);
      expect(migration.code, migration.file).not.toMatch(/\bROLLBACK\s*;/i);
      expect(migration.code, migration.file).not.toMatch(/\bSAVEPOINT\b/i);
      // Cannot run inside the runner's per-file transaction.
      expect(migration.code, migration.file).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i);
    }
  });

  it('is forward-only: no DROP TABLE, DROP COLUMN, TRUNCATE, or DELETE FROM', () => {
    for (const migration of files) {
      expect(migration.code, migration.file).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(migration.code, migration.file).not.toMatch(/\bDROP\s+COLUMN\b/i);
      // Statement-leading only: `REVOKE ... TRUNCATE` and `BEFORE TRUNCATE` are
      // the two places the word appears legitimately, and both DEFEND the trail.
      expect(migration.code, migration.file).not.toMatch(/^\s*TRUNCATE\b/im);
      expect(migration.code, migration.file).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });

  it('never cascades a delete — nothing in this schema is ever deleted (D5)', () => {
    expect(code).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    expect(code).not.toMatch(/ON\s+DELETE\s+SET\s+NULL/i);
    for (const fk of parseForeignKeys()) {
      expect(fk.onDelete, fk.name).toContain('ON DELETE RESTRICT');
    }
  });

  it('installs no Postgres extension and reaches no external host', () => {
    expect(code).not.toMatch(/CREATE\s+EXTENSION/i);
    // Mock-only integrations stay mocks: an adapter id is provenance text, a URL
    // or a credential would be a live integration smuggled into DDL.
    expect(code).not.toMatch(/https?:\/\//i);
    expect(code).not.toMatch(/\b(api[_-]?key|secret|password\s*=)/i);
  });

  it('grants every table it creates, in the file that creates it (rule 6)', () => {
    const granted = new Set(parseGrants().map((g) => g.table));
    for (const table of createdTables) {
      expect(granted.has(table), `${table} is created but never granted`).toBe(true);
    }
  });
});

describe('no audio, no recording, no transcript, no bytes (AC-12, AC-13)', () => {
  it('declares no column whose name mentions recording, transcript, or audio', () => {
    for (const table of tables) {
      for (const column of columnNames(table)) {
        expect(column, `${table.name}.${column}`).not.toMatch(/recording|transcript|audio/i);
      }
    }
  });

  it('declares no bytea column anywhere — bytes live in the object store', () => {
    expect(stripDollarQuoted(code)).not.toMatch(/\bbytea\b/i);
  });

  it('blocks an audio/* content type at the one place bytes are addressable', () => {
    const objectRefs = tableNamed(TABLES.object_refs);
    expect(objectRefs.body).toMatch(/object_refs_no_audio/);
    expect(objectRefs.body.replace(/\s+/g, ' ')).toContain("NOT LIKE 'audio/%'");
  });

  it('keeps call evidence to metadata only — start, duration, other party', () => {
    const messages = tableNamed(TABLES.messages);
    const names = columnNames(messages);
    expect(names).toContain('call_started_at');
    expect(names).toContain('call_duration_seconds');
    expect(names).toContain('call_party');
    expect(names).not.toContain('recording_url');
    expect(names).not.toContain('transcript');
  });
});

describe('the tenancy split, enforced by the schema (AC-3, AC-4, AC-5)', () => {
  it('keeps dealerships GLOBAL — no account, owner, or tenant column', () => {
    const dealerships = tableNamed(TABLES.dealerships);
    const names = columnNames(dealerships);
    expect(names).toEqual(['id', 'name', 'state', 'city', 'zip_code', 'created_at']);
    for (const column of names) {
      expect(column).not.toMatch(/account|owner|tenant/i);
    }
  });

  it('gives dealerships a natural key so a directory can be batch-loaded later', () => {
    expect(code).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+dealerships_natural_uidx/i);
  });

  it('keeps dealership_contacts PRIVATE — account_id NOT NULL plus a referencable pair', () => {
    const contacts = tableNamed(TABLES.dealership_contacts);
    const accountId = contacts.columns.find((c) => c.name === 'account_id');
    expect(accountId?.definition).toContain('NOT NULL');
    expect(accountId?.definition).toContain('REFERENCES ACCOUNTS');
    expect(contacts.body.replace(/\s+/g, ' ')).toContain(
      'CONSTRAINT dealership_contacts_account_id_uk UNIQUE (account_id, id)',
    );
  });

  it('reaches a contact only through the referrer own account (composite FK, D2)', () => {
    const fk = foreignKeyNamed('dealer_threads_contact_fk');
    expect(fk.columns).toEqual(['account_id', 'working_with_contact_id']);
    expect(fk.target).toBe(TABLES.dealership_contacts);
    expect(fk.targetColumns).toEqual(['account_id', 'id']);
    // MATCH SIMPLE is load-bearing: a NULL contact must stay legal, because a
    // thread has no contact until the buyer is handed to a person.
    expect(fk.onDelete).not.toContain('MATCH FULL');
  });

  it('pins a thread account to its deal, so the account cannot be forged to reach a stranger', () => {
    const fk = foreignKeyNamed('dealer_threads_deal_fk');
    expect(fk.columns).toEqual(['account_id', 'deal_id']);
    expect(fk.target).toBe(TABLES.deals);
    expect(fk.targetColumns).toEqual(['account_id', 'id']);
  });

  it('carries account_id NOT NULL on every account-scoped table', () => {
    for (const name of ACCOUNT_SCOPED_TABLES) {
      const table = tableNamed(name);
      const accountId = table.columns.find((c) => c.name === 'account_id');
      expect(accountId, `${name} has no account_id`).toBeDefined();
      expect(accountId?.definition, name).toContain('NOT NULL');
    }
  });

  it('classifies every created table as scoped or deliberately global', () => {
    const classified = new Set<string>([...ACCOUNT_SCOPED_TABLES, ...GLOBAL_TABLES]);
    for (const table of createdTables) {
      expect(classified.has(table), `${table} is neither scoped nor listed as global`).toBe(true);
    }
    // Disjoint: a table cannot be both, and a typo in one list must not hide in
    // the other.
    for (const name of ACCOUNT_SCOPED_TABLES) {
      expect(GLOBAL_TABLES).not.toContain(name);
    }
  });

  it('never lets a deal-scoped row bind to a thread from ANOTHER DEAL — messages', () => {
    // dealer_threads already publishes UNIQUE (account_id, deal_id, id) for
    // exactly this purpose. `messages` carries BOTH deal_id and thread_id, so
    // without the deal in the foreign key a message can name deal A while
    // pointing at a thread that belongs to deal B (same account) — the deal
    // half of "a read must never cross accounts or deals".
    const fk = foreignKeyNamed('messages_thread_fk');
    expect(fk.columns).toEqual(['account_id', 'deal_id', 'thread_id']);
    expect(fk.targetColumns).toEqual(['account_id', 'deal_id', 'id']);
  });

  it('never lets a deal-scoped row bind to a thread from ANOTHER DEAL — offers', () => {
    const fk = foreignKeyNamed('offers_thread_fk');
    expect(fk.columns).toEqual(['account_id', 'deal_id', 'thread_id']);
    expect(fk.targetColumns).toEqual(['account_id', 'deal_id', 'id']);
  });

  it('publishes the referencable triple every deal-scoped referrer of an offer needs', () => {
    // Without UNIQUE (account_id, deal_id, id) on `offers`, the two foreign keys
    // below cannot carry the deal at all — an account that owns two deals is not
    // a boundary between them.
    expect(tableNamed(TABLES.offers).body.replace(/\s+/g, ' ')).toContain(
      'CONSTRAINT offers_account_deal_id_uk UNIQUE (account_id, deal_id, id)',
    );
  });

  it('never lets a message link an extracted offer from ANOTHER DEAL', () => {
    const fk = foreignKeyNamed('messages_extracted_offer_fk');
    expect(fk.columns).toEqual(['account_id', 'deal_id', 'extracted_offer_id']);
    expect(fk.target).toBe(TABLES.offers);
    expect(fk.targetColumns).toEqual(['account_id', 'deal_id', 'id']);
  });

  it('never lets a thread name ANOTHER DEAL offer as its current offer (ADR-006, AC-8)', () => {
    // current_offer_id feeds ADR-006's rollup AND the third disjunct of the
    // 0014 write-once trigger, so a mis-bound edge decides one deal's lock from
    // another deal's evidence.
    const fk = foreignKeyNamed('dealer_threads_current_offer_fk');
    expect(fk.columns).toEqual(['account_id', 'deal_id', 'current_offer_id']);
    expect(fk.target).toBe(TABLES.offers);
    expect(fk.targetColumns).toEqual(['account_id', 'deal_id', 'id']);
  });

  it('gives a receipt bundle to at most ONE deal — a dossier is never two deals evidence', () => {
    // receipt_entries key only on receipt_bundle_id, so a shared bundle puts
    // deal B's evidence inside deal A's dossier with nothing able to detect it.
    expect(tableNamed(TABLES.deals).body.replace(/\s+/g, ' ')).toContain(
      'CONSTRAINT deals_receipt_bundle_uk UNIQUE (receipt_bundle_id)',
    );
  });

  it('never reassigns a released number or alias to another account (specs/01 zero cross-user leakage)', () => {
    // The partial unique indexes only bind ACTIVE values. specs/01: a burned
    // number is "never reassigned to another platform user"; Re-use is the SAME
    // user carrying a number into a new deal.
    expect(code).toMatch(
      /CREATE\s+TRIGGER\s+deal_identities_owner_pinned\s+AFTER\s+INSERT\s+OR\s+UPDATE\s+ON\s+deal_identities/i,
    );
    const body = code.replace(/\s+/g, ' ');
    expect(body).toContain('d.phone_number = NEW.phone_number');
    expect(body).toContain('d.email_alias = NEW.email_alias');
    expect(body).toContain('d.account_id <> NEW.account_id');
    expect(body).toContain("ERRCODE = 'DC003'");
  });

  it('scopes the inbound contact-point index to one deal at the index level', () => {
    const points = tableNamed(TABLES.thread_contact_points);
    expect(points.body.replace(/\s+/g, ' ')).toContain(
      'PRIMARY KEY (deal_id, point_kind, point_value)',
    );
  });
});

describe('the receipt trail is append-only at the database level (AC-6, AC-7)', () => {
  it('grants the application exactly SELECT and INSERT on receipt_entries', () => {
    const grants = parseGrants().filter((g) => g.table === TABLES.receipt_entries);
    expect(grants.length).toBe(1);
    expect([...(grants[0]?.privileges ?? [])].sort()).toEqual(['INSERT', 'SELECT']);
  });

  it('revokes UPDATE, DELETE and TRUNCATE from the app role and from PUBLIC', () => {
    const flat = code.replace(/\s+/g, ' ');
    expect(flat).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON receipt_entries FROM deal_copilot_app;',
    );
    expect(flat).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON receipt_entries FROM PUBLIC;');
  });

  it('grants DELETE or TRUNCATE on NO table anywhere', () => {
    for (const grant of parseGrants()) {
      expect(grant.privileges, `${grant.table} in ${grant.file}`).not.toContain('DELETE');
      expect(grant.privileges, `${grant.table} in ${grant.file}`).not.toContain('TRUNCATE');
      expect(grant.privileges, `${grant.table} in ${grant.file}`).not.toContain('ALL');
    }
  });

  it('raises DC001 from a trigger on UPDATE, DELETE and TRUNCATE — grants alone bind only the app', () => {
    expect(code).toMatch(
      /CREATE\s+TRIGGER\s+receipt_entries_no_update\s+BEFORE\s+UPDATE\s+ON\s+receipt_entries/i,
    );
    expect(code).toMatch(
      /CREATE\s+TRIGGER\s+receipt_entries_no_delete\s+BEFORE\s+DELETE\s+ON\s+receipt_entries/i,
    );
    expect(code).toMatch(
      /CREATE\s+TRIGGER\s+receipt_entries_no_truncate\s+BEFORE\s+TRUNCATE\s+ON\s+receipt_entries/i,
    );
    expect(code).toContain("ERRCODE = 'DC001'");
  });

  it('stores the author on every entry — NOT NULL, and never defaulted', () => {
    const entries = tableNamed(TABLES.receipt_entries);
    const author = entries.columns.find((c) => c.name === 'author');
    expect(author?.definition).toContain('MESSAGE_AUTHOR');
    expect(author?.definition).toContain('NOT NULL');
    expect(author?.definition).not.toContain('DEFAULT');
  });

  it('makes dealer-attributed self-authored evidence unrepresentable', () => {
    const flat = tableNamed(TABLES.receipt_entries).body.replace(/\s+/g, ' ');
    expect(flat).toContain("kind <> 'note'");
    expect(flat).toContain("author <> 'dealer'");
    expect(flat).toContain("kind <> 'call_meta' OR author <> 'dealer'");
  });

  it('assigns seq and appended_at from a trigger, never from the caller (D7)', () => {
    expect(code).toMatch(
      /CREATE\s+TRIGGER\s+receipt_entries_stamp\s+BEFORE\s+INSERT\s+ON\s+receipt_entries/i,
    );
    expect(code).toContain('NEW.appended_at := now()');
    expect(code).toContain('UPDATE receipt_bundles SET next_seq = next_seq + 1');
  });

  it('derives channel from kind in the schema, so the trail cannot mislabel one', () => {
    const channel = tableNamed(TABLES.receipt_entries).columns.find((c) => c.name === 'channel');
    expect(channel?.definition).toContain('GENERATED ALWAYS AS');
    expect(channel?.definition).toContain('STORED');
  });

  it('normalizes a blank dedupe_key to NULL rather than rejecting the append (D8)', () => {
    // A rejected append is a LOST receipt entry; the safe failure direction for
    // a trail whose value is completeness is a possible duplicate.
    expect(code).toContain("btrim(coalesce(NEW.dedupe_key, '')) = ''");
    expect(code).toMatch(/receipt_entries_bundle_dedupe_uidx[\s\S]*WHERE\s+dedupe_key\s+IS\s+NOT\s+NULL/i);
  });
});

describe('one deal, one vehicle target (AC-8) and one instance per thread (AC-9)', () => {
  it('has no vehicle_targets table at all — a second target is unrepresentable', () => {
    expect(createdTables).not.toContain('vehicle_targets');
    expect(code).not.toMatch(/target_vehicle_id/i);
  });

  it('embeds the target on the deal, both year bounds optional and paired', () => {
    const deals = tableNamed(TABLES.deals);
    const names = columnNames(deals);
    expect(names).toContain('target_make');
    expect(names).toContain('target_model');
    expect(deals.columns.find((c) => c.name === 'target_make')?.definition).toContain('NOT NULL');
    expect(deals.columns.find((c) => c.name === 'target_model')?.definition).toContain('NOT NULL');
    expect(deals.body.replace(/\s+/g, ' ')).toContain(
      'CHECK ((target_year_from IS NULL) = (target_year_to IS NULL))',
    );
  });

  it('keeps year_range a SOFT guide — nothing relates an instance year to it (AC-10)', () => {
    const instances = tableNamed(TABLES.vehicle_instances);
    expect(instances.body).not.toMatch(/target_year/i);
    expect(code).not.toMatch(/year\s*(>=|<=|BETWEEN)\s*target_year/i);
  });

  it('rejects a make/model mismatch by omission — an instance has no make or model', () => {
    const names = columnNames(tableNamed(TABLES.vehicle_instances));
    expect(names).not.toContain('make');
    expect(names).not.toContain('model');
  });

  it('gives each thread its own instance and forbids sharing one', () => {
    const instances = tableNamed(TABLES.vehicle_instances);
    expect(instances.body.replace(/\s+/g, ' ')).toContain(
      'CONSTRAINT vehicle_instances_thread_uk UNIQUE (thread_id)',
    );
  });

  it('leaves VIN user-entered and unvalidated (AC-11, Q16)', () => {
    const vin = tableNamed(TABLES.vehicle_instances).columns.find((c) => c.name === 'vin');
    expect(vin?.definition).toBe('TEXT');
  });

  it('mirrors isTargetVehicleLocked three disjuncts in the write-once trigger', () => {
    const flat = code.replace(/\s+/g, ' ');
    expect(flat).toContain("OLD.status <> 'draft'");
    expect(flat).toContain('EXISTS (SELECT 1 FROM offers o WHERE o.deal_id = OLD.id)');
    expect(flat).toMatch(/dealer_threads t WHERE t\.deal_id = OLD\.id AND t\.current_offer_id IS NOT NULL/);
    expect(flat).toContain("ERRCODE = 'DC002'");
    expect(code).toMatch(
      /CREATE\s+TRIGGER\s+deals_target_vehicle_write_once\s+BEFORE\s+UPDATE\s+ON\s+deals/i,
    );
  });
});

describe('ADR-005 unevaluable semantics and ADR-007 retail band', () => {
  const OPTIONAL_MONEY = [
    ['offers', 'sale_price_cents'],
    ['offers', 'apr'],
    ['offers', 'term_months'],
    ['offers', 'monthly_cents'],
    ['valuation_snapshots', 'wholesale_cents'],
    ['valuation_snapshots', 'trade_in_cents'],
    ['valuation_snapshots', 'retail_cents'],
    ['valuation_snapshots', 'private_party_cents'],
  ] as const;

  it.each(OPTIONAL_MONEY)('leaves %s.%s nullable with NO default — absent stays absent', (t, c) => {
    const column = tableNamed(t).columns.find((col) => col.name === c);
    expect(column, `${t}.${c}`).toBeDefined();
    expect(column?.definition, `${t}.${c}`).not.toContain('NOT NULL');
    expect(column?.definition, `${t}.${c}`).not.toContain('DEFAULT');
  });

  it('has no DEFAULT 0 on any column anywhere — a zero default is a fabricated input', () => {
    expect(stripDollarQuoted(code)).not.toMatch(/DEFAULT\s+0\b/i);
  });

  it('keys the valuation snapshot on the INSTANCE and gives it no deal_id (ADR-007)', () => {
    const snapshots = tableNamed(TABLES.valuation_snapshots);
    const names = columnNames(snapshots);
    expect(names).toContain('vehicle_instance_id');
    expect(names).toContain('retail_cents');
    expect(names).not.toContain('deal_id');
    const fk = foreignKeyNamed('valuation_snapshots_instance_fk');
    expect(fk.columns).toEqual(['account_id', 'vehicle_instance_id']);
    expect(fk.target).toBe(TABLES.vehicle_instances);
  });

  it('keys vehicle_data on the instance too, with no deal-level fallback', () => {
    const names = columnNames(tableNamed(TABLES.vehicle_data));
    expect(names).toContain('vehicle_instance_id');
    expect(names).not.toContain('deal_id');
  });

  it('never computes a flag in SQL — the database only stores the engine output', () => {
    const flat = stripDollarQuoted(code);
    expect(flat).not.toMatch(/above_market\s*=/i);
    // A comparison against a LITERAL is well-formedness (`>= 0`); a comparison
    // against another COLUMN would be the flag engine re-implemented in SQL —
    // ADR-001's parallel definition in a different language.
    expect(flat).not.toMatch(/walk_away_cents\s*[<>]=?\s*[a-z]/i);
    expect(flat).not.toMatch(/retail_cents\s*[<>]=?\s*[a-z]/i);
    expect(flat).not.toMatch(/sale_price_cents\s*[<>]=?\s*[a-z]/i);
  });
});
