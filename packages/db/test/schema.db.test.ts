/**
 * T-016 tester — the schema, exercised against a REAL Postgres (design §6.1).
 *
 * ADR-008 GATE: every test in this file is skipped when `DATABASE_URL` is
 * absent, and the skip is REPORTED as a skip. It is never faked into a pass and
 * never deleted to keep a suite green — the whole point of AC-15 is that the
 * DDL was executed by a server, and a green report from a run that never opened
 * a socket would be a lie about precisely that.
 *
 * The suite runs the real migration set into a scratch schema and drops it
 * afterwards, so pointing `DATABASE_URL` at a database never rewrites whatever
 * that database already holds.
 *
 * Privilege checks use `has_table_privilege('deal_copilot_app', ...)` rather
 * than `SET ROLE`: migration 0001 creates the role NOLOGIN (it is a privilege
 * bucket, not a login), so the catalog is the honest way to ask what it holds.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';

import { isTargetVehicleLocked, type Deal } from '@core';
import {
  ACCOUNT_SCOPED_TABLES,
  APP_ROLE,
  createDbHandle,
  runMigrations,
  TABLES,
  TABLE_PRIVILEGES,
  type DbError,
  type DbHandle,
  type DbResult,
  type QueryOutcome,
} from '@db';

import {
  DATABASE_URL,
  describeDb,
  expectErr,
  expectOk,
  scopedConnectionString,
  scratchSchemaName,
} from './helpers.js';

const SCHEMA = scratchSchemaName();

let base: DbHandle | undefined;
let db: DbHandle | undefined;

function handle(): DbHandle {
  if (db === undefined) throw new Error('scoped handle was not created');
  return db;
}

async function run<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: readonly unknown[],
): Promise<DbResult<QueryOutcome<R>>> {
  return handle().query<R>(sql, params);
}

async function rows<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: readonly unknown[],
): Promise<readonly R[]> {
  return (expectOk(await run<R>(sql, params))).rows;
}

async function failure(sql: string, params?: readonly unknown[]): Promise<DbError> {
  return expectErr(await run(sql, params));
}

/** Ids seeded once and reused; every test reads, only a few write. */
const ids = {
  accountA: '',
  accountB: '',
  dealership: '',
  contactA: '',
  contactB: '',
  dealA: '',
  dealA2: '',
  dealB: '',
  threadA: '',
  threadA2: '',
  threadB: '',
  instanceA: '',
  bundleA: '',
};

async function scalar(sql: string, params?: readonly unknown[]): Promise<string> {
  const result = await rows<{ v: string }>(sql, params);
  return String(result[0]?.v ?? '');
}

describeDb('T-016 schema against a real Postgres', () => {
  beforeAll(async () => {
    if (DATABASE_URL === undefined) return;
    base = createDbHandle({ connection_string: DATABASE_URL });
    expectOk(await base.query(`CREATE SCHEMA "${SCHEMA}"`));

    db = createDbHandle({
      connection_string: scopedConnectionString(DATABASE_URL, SCHEMA),
    });
    const report = expectOk(await runMigrations(db));
    expect(report.applied.length).toBeGreaterThanOrEqual(14);

    ids.accountA = await scalar('INSERT INTO accounts DEFAULT VALUES RETURNING id AS v');
    ids.accountB = await scalar('INSERT INTO accounts DEFAULT VALUES RETURNING id AS v');
    ids.dealership = await scalar(
      `INSERT INTO dealerships (name, state, city, zip_code)
       VALUES ('Bay Motors', 'CA', 'Oakland', '94607') RETURNING id AS v`,
    );
    ids.contactA = await scalar(
      `INSERT INTO dealership_contacts (account_id, dealership_id, name, role)
       VALUES ($1, $2, 'Dana', 'sales_manager') RETURNING id AS v`,
      [ids.accountA, ids.dealership],
    );
    ids.contactB = await scalar(
      `INSERT INTO dealership_contacts (account_id, dealership_id, name, role)
       VALUES ($1, $2, 'Rey', 'finance_manager') RETURNING id AS v`,
      [ids.accountB, ids.dealership],
    );

    const insertDeal = async (account: string): Promise<string> =>
      scalar(
        `INSERT INTO deals (account_id, path, target_make, target_model,
                            target_year_from, target_year_to, budget_cents, walk_away_cents)
         VALUES ($1, 'hybrid', 'Honda', 'Accord', 2018, 2022, 3500000, 3200000)
         RETURNING id AS v`,
        [account],
      );
    ids.dealA = await insertDeal(ids.accountA);
    ids.dealA2 = await insertDeal(ids.accountA);
    ids.dealB = await insertDeal(ids.accountB);

    const insertThread = async (account: string, deal: string, dealership: string): Promise<string> =>
      scalar(
        `INSERT INTO dealer_threads (account_id, deal_id, dealership_id)
         VALUES ($1, $2, $3) RETURNING id AS v`,
        [account, deal, dealership],
      );
    ids.threadA = await insertThread(ids.accountA, ids.dealA, ids.dealership);
    ids.threadA2 = await insertThread(ids.accountA, ids.dealA2, ids.dealership);
    ids.threadB = await insertThread(ids.accountB, ids.dealB, ids.dealership);

    ids.instanceA = await scalar(
      `INSERT INTO vehicle_instances (account_id, thread_id, vin, year, condition)
       VALUES ($1, $2, '1HGCV1F30JA000001', 2020, 'used') RETURNING id AS v`,
      [ids.accountA, ids.threadA],
    );
    ids.bundleA = await scalar(
      'INSERT INTO receipt_bundles (account_id) VALUES ($1) RETURNING id AS v',
      [ids.accountA],
    );
  }, 60_000);

  afterAll(async () => {
    await db?.close();
    if (base !== undefined) {
      await base.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await base.close();
    }
  }, 60_000);

  // ---- T1 · migrations run forward, then do nothing (AC-15) --------------

  it('re-runs with no effect and reports every version already applied', async () => {
    const report = expectOk(await runMigrations(handle()));
    expect(report.applied).toEqual([]);
    expect(report.already_applied.length).toBeGreaterThanOrEqual(14);
  });

  // ---- T2 · enums, as the server sees them (AC-2) ------------------------

  it('creates every pg enum with the labels @db publishes, in order', async () => {
    const labels = await rows<{ typname: string; labels: string[] }>(
      `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1
        GROUP BY t.typname`,
      [SCHEMA],
    );
    const seen = new Map(labels.map((row) => [row.typname, row.labels]));
    expect(seen.get('offer_flag')).toEqual([
      'payment_packing',
      'rate_markup',
      'junk_fee',
      'over_walkaway',
      'above_market',
    ]);
    expect(seen.get('message_author')).toEqual(['dealer', 'buyer', 'concierge']);
    expect(seen.get('message_channel')).toEqual(['call', 'sms', 'email', 'note']);
  });

  // ---- T3 · no audio, no transcript, no bytes (AC-12, AC-13) -------------

  it('has no column anywhere named for a recording, a transcript, or audio', async () => {
    const found = await rows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = $1
          AND (column_name ILIKE '%recording%' OR column_name ILIKE '%transcript%'
               OR column_name ILIKE '%audio%')`,
      [SCHEMA],
    );
    expect(found).toEqual([]);
  });

  it('has no bytea column anywhere — bytes live in the object store', async () => {
    const found = await rows(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = $1 AND data_type = 'bytea'`,
      [SCHEMA],
    );
    expect(found).toEqual([]);
  });

  it('rejects an audio content type on the one table that addresses bytes', async () => {
    const error = await failure(
      `INSERT INTO object_refs (account_id, kind, bucket, object_key, content_type)
       VALUES ($1, 'document', 'b', 'k-audio', 'audio/mpeg')`,
      [ids.accountA],
    );
    expect(error.code).toBe('check_violation');
  });

  // ---- T4 / T5 · the tenancy split (AC-3, AC-4, AC-5) --------------------

  it('keeps dealerships global — the table has no account column', async () => {
    const found = await rows(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'dealerships' AND column_name = 'account_id'`,
      [SCHEMA],
    );
    expect(found).toEqual([]);
  });

  it('accepts a batch re-import of the same dealership as a conflict, not a duplicate', async () => {
    const error = await failure(
      `INSERT INTO dealerships (name, state, city, zip_code)
       VALUES ('bay motors', 'ca', 'OAKLAND', '94607')`,
    );
    expect(error.code).toBe('unique_violation');
  });

  it('refuses a contact row with no account', async () => {
    const error = await failure(
      `INSERT INTO dealership_contacts (dealership_id, name, role)
       VALUES ($1, 'Nobody', 'sales_agent')`,
      [ids.dealership],
    );
    expect(error.code).toBe('not_null_violation');
  });

  it('cannot point one account thread at ANOTHER account contact', async () => {
    const error = await failure(
      'UPDATE dealer_threads SET working_with_contact_id = $1 WHERE id = $2',
      [ids.contactB, ids.threadA],
    );
    expect(error.code).toBe('foreign_key_violation');
    expect(error.constraint).toBe('dealer_threads_contact_fk');
  });

  it('accepts a contact from the SAME account, and accepts none at all', async () => {
    expectOk(
      await run('UPDATE dealer_threads SET working_with_contact_id = $1 WHERE id = $2', [
        ids.contactA,
        ids.threadA,
      ]),
    );
    // Absent until the buyer is handed to a person — MATCH SIMPLE keeps this legal.
    expectOk(
      await run('UPDATE dealer_threads SET working_with_contact_id = NULL WHERE id = $1', [
        ids.threadA,
      ]),
    );
  });

  it('cannot hang a thread off another account deal', async () => {
    const error = await failure(
      `INSERT INTO dealer_threads (account_id, deal_id, dealership_id) VALUES ($1, $2, $3)`,
      [ids.accountA, ids.dealB, ids.dealership],
    );
    expect(error.code).toBe('foreign_key_violation');
  });

  it('cannot snapshot another account vehicle instance', async () => {
    const error = await failure(
      `INSERT INTO valuation_snapshots (account_id, vehicle_instance_id, retail_cents, source, captured_at)
       VALUES ($1, $2, 2900000, 'mock-kbb', now())`,
      [ids.accountB, ids.instanceA],
    );
    expect(error.code).toBe('foreign_key_violation');
  });

  it('cannot bind a message to a thread belonging to ANOTHER DEAL', async () => {
    // The deal half of the isolation rule. dealA and dealA2 share an account, so
    // the account chain cannot catch this one — only the deal must.
    const error = await failure(
      `INSERT INTO messages (account_id, deal_id, thread_id, channel, direction, author,
                             body, occurred_at, message_ref, origin_kind, origin_source)
       VALUES ($1, $2, $3, 'sms', 'in', 'dealer', 'hi', now(), 'x-cross-deal', 'provider', 'mock')`,
      [ids.accountA, ids.dealA, ids.threadA2],
    );
    expect(error.code).toBe('foreign_key_violation');
  });

  it('gives every account-scoped table a NOT NULL account_id', async () => {
    for (const table of ACCOUNT_SCOPED_TABLES) {
      const found = await rows<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = 'account_id'`,
        [SCHEMA, table],
      );
      expect(found.length, table).toBe(1);
      expect(found[0]?.is_nullable, table).toBe('NO');
    }
  });

  // ---- T6 / T13 · the receipt trail is append-only (AC-6) ----------------

  async function appendEntry(overrides: {
    kind?: string;
    author?: string;
    direction?: string;
    body?: string;
    dedupe?: string | null;
  } = {}): Promise<DbResult<QueryOutcome<{ id: string; seq: string; channel: string }>>> {
    return run<{ id: string; seq: string; channel: string }>(
      `INSERT INTO receipt_entries (account_id, receipt_bundle_id, kind, author, direction,
                                    occurred_at, appended_at, body, dedupe_key)
       VALUES ($1, $2, $3::receipt_entry_kind, $4::message_author, $5::message_direction,
               now(), now(), $6, $7)
       RETURNING id, seq::text AS seq, channel::text AS channel`,
      [
        ids.accountA,
        ids.bundleA,
        overrides.kind ?? 'note',
        overrides.author ?? 'buyer',
        overrides.direction ?? 'internal',
        overrides.body ?? 'a note',
        overrides.dedupe ?? null,
      ],
    );
  }

  it('grants the application SELECT and INSERT on receipt_entries and nothing more', async () => {
    const privileges = await rows<{ p: string; held: boolean }>(
      `SELECT p, has_table_privilege($1, 'receipt_entries', p) AS held
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p`,
      [APP_ROLE],
    );
    const held = new Map(privileges.map((row) => [row.p, row.held]));
    expect(held.get('SELECT')).toBe(true);
    expect(held.get('INSERT')).toBe(true);
    expect(held.get('UPDATE')).toBe(false);
    expect(held.get('DELETE')).toBe(false);
    expect(held.get('TRUNCATE')).toBe(false);
  });

  it('grants no DELETE or TRUNCATE on any table in the schema', async () => {
    for (const table of Object.keys(TABLE_PRIVILEGES)) {
      if (table === TABLES.schema_migrations) continue;
      const held = await rows<{ del: boolean; trunc: boolean }>(
        `SELECT has_table_privilege($1, $2, 'DELETE') AS del,
                has_table_privilege($1, $2, 'TRUNCATE') AS trunc`,
        [APP_ROLE, `${SCHEMA}.${table}`],
      );
      expect(held[0]?.del, table).toBe(false);
      expect(held[0]?.trunc, table).toBe(false);
    }
  });

  it('rejects UPDATE, DELETE and TRUNCATE on receipt_entries even as the OWNER', async () => {
    expectOk(await appendEntry());
    // A grant binds the application. A trigger also binds the table owner, a
    // later migration, and a psql operator — which is why there are two layers.
    const updated = await failure("UPDATE receipt_entries SET body = 'edited'");
    expect(updated.sqlstate).toBe('DC001');
    expect(updated.code).toBe('append_only_violation');

    const deleted = await failure('DELETE FROM receipt_entries');
    expect(deleted.sqlstate).toBe('DC001');

    const truncated = await failure('TRUNCATE receipt_entries');
    expect(truncated.sqlstate).toBe('DC001');
  });

  it('blocks a parent delete rather than cascading into the trail', async () => {
    const error = await failure('DELETE FROM receipt_bundles WHERE id = $1', [ids.bundleA]);
    expect(error.code).toBe('append_only_violation');
  });

  // ---- T7 · every entry carries its author (AC-7) ------------------------

  it('refuses an entry with no author, and offers no default', async () => {
    const error = await failure(
      `INSERT INTO receipt_entries (account_id, receipt_bundle_id, kind, direction,
                                    occurred_at, appended_at, body)
       VALUES ($1, $2, 'note', 'internal', now(), now(), 'x')`,
      [ids.accountA, ids.bundleA],
    );
    expect(error.code).toBe('not_null_violation');
  });

  it('refuses a note attributed to the dealer — self-authored evidence stays labelled', async () => {
    const error = await failure(
      `INSERT INTO receipt_entries (account_id, receipt_bundle_id, kind, author, direction,
                                    occurred_at, appended_at, body)
       VALUES ($1, $2, 'note', 'dealer', 'internal', now(), now(), 'x')`,
      [ids.accountA, ids.bundleA],
    );
    expect(error.code).toBe('check_violation');
  });

  it('assigns seq from the store and derives channel from kind', async () => {
    const first = expectOk(await appendEntry({ kind: 'sms', author: 'dealer', direction: 'in' }));
    const second = expectOk(await appendEntry({ kind: 'email', author: 'dealer', direction: 'in' }));
    expect(Number(second.rows[0]?.seq)).toBe(Number(first.rows[0]?.seq) + 1);
    expect(first.rows[0]?.channel).toBe('sms');
    expect(second.rows[0]?.channel).toBe('email');
  });

  it('appends twice with a blank dedupe key — a lost entry is worse than a duplicate', async () => {
    expectOk(await appendEntry({ dedupe: '   ' }));
    expectOk(await appendEntry({ dedupe: '   ' }));
  });

  it('deduplicates on a real key, first write wins', async () => {
    expectOk(await appendEntry({ dedupe: 'anchor-1' }));
    const error = await failure(
      `INSERT INTO receipt_entries (account_id, receipt_bundle_id, kind, author, direction,
                                    occurred_at, appended_at, body, dedupe_key)
       VALUES ($1, $2, 'note', 'buyer', 'internal', now(), now(), 'dup', 'anchor-1')`,
      [ids.accountA, ids.bundleA],
    );
    expect(error.code).toBe('unique_violation');
  });

  // ---- T8 · one target, write-once (AC-8) -------------------------------

  it('has no vehicle_targets table — a second target is unrepresentable', async () => {
    const found = await rows(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'vehicle_targets'`,
      [SCHEMA],
    );
    expect(found).toEqual([]);
  });

  it('agrees with @core isTargetVehicleLocked, case for case', async () => {
    interface Case {
      label: string;
      status: 'draft' | 'active';
      withOffer: boolean;
    }
    const cases: readonly Case[] = [
      { label: 'draft, no offers', status: 'draft', withOffer: false },
      { label: 'draft, one offer attached', status: 'draft', withOffer: true },
      { label: 'left draft, no offers', status: 'active', withOffer: false },
      { label: 'left draft, one offer attached', status: 'active', withOffer: true },
    ];

    for (const testCase of cases) {
      const dealId = await scalar(
        `INSERT INTO deals (account_id, path, status, target_make, target_model,
                            budget_cents, walk_away_cents)
         VALUES ($1, 'online', $2::deal_status, 'Honda', 'Accord', 3000000, 2800000)
         RETURNING id AS v`,
        [ids.accountA, testCase.status],
      );
      if (testCase.withOffer) {
        expectOk(
          await run('INSERT INTO offers (account_id, deal_id, sale_price_cents) VALUES ($1, $2, 2900000)', [
            ids.accountA,
            dealId,
          ]),
        );
      }

      const predicate: Pick<Deal, 'status' | 'offers' | 'dealer_threads'> = {
        status: testCase.status,
        offers: testCase.withOffer ? [{ fees: [], flags: [] }] : [],
        dealer_threads: [],
      };
      const expectedLocked = isTargetVehicleLocked(predicate);

      const attempt = await run("UPDATE deals SET target_model = 'Civic' WHERE id = $1", [dealId]);
      const actualLocked = !attempt.ok;
      expect(actualLocked, `${testCase.label}: schema and @core disagree`).toBe(expectedLocked);
      if (!attempt.ok) {
        expect(attempt.error.sqlstate, testCase.label).toBe('DC002');
        expect(attempt.error.code, testCase.label).toBe('write_once_violation');
      }
    }
  });

  it('locks the target once a thread carries a current offer', async () => {
    const offerId = await scalar(
      `INSERT INTO offers (account_id, deal_id, thread_id, sale_price_cents)
       VALUES ($1, $2, $3, 2900000) RETURNING id AS v`,
      [ids.accountA, ids.dealA, ids.threadA],
    );
    expectOk(
      await run('UPDATE dealer_threads SET current_offer_id = $1 WHERE id = $2', [
        offerId,
        ids.threadA,
      ]),
    );
    const error = await failure("UPDATE deals SET target_make = 'Toyota' WHERE id = $1", [
      ids.dealA,
    ]);
    expect(error.sqlstate).toBe('DC002');
  });

  it('leaves everything BUT make and model editable after the lock', async () => {
    expectOk(await run('UPDATE deals SET budget_cents = 3600000 WHERE id = $1', [ids.dealA]));
  });

  // ---- T9 / T10 · soft guides (AC-10, AC-11) ----------------------------

  it('accepts an instance a decade outside the deal year range — a soft guide', async () => {
    expectOk(
      await run(
        `INSERT INTO vehicle_instances (account_id, thread_id, year, condition)
         VALUES ($1, $2, 2005, 'used')`,
        [ids.accountA, ids.threadA2],
      ),
    );
  });

  it('accepts a VIN that is not a VIN, and accepts none at all', async () => {
    expectOk(
      await run(
        `INSERT INTO vehicle_instances (account_id, thread_id, vin, year, condition)
         VALUES ($1, $2, 'not-a-vin', 2021, 'certified')`,
        [ids.accountB, ids.threadB],
      ),
    );
  });

  // ---- T11 · ADR-005 and the flag set (AC-14) ---------------------------

  it('accepts an offer with NO sale price — absent is a first-class state', async () => {
    const offerId = await scalar(
      'INSERT INTO offers (account_id, deal_id) VALUES ($1, $2) RETURNING id AS v',
      [ids.accountA, ids.dealA],
    );
    const stored = await rows<{ sale_price_cents: string | null; apr: string | null }>(
      'SELECT sale_price_cents, apr FROM offers WHERE id = $1',
      [offerId],
    );
    // NULL, never 0: a zero here would be ADR-005's silently-passed flag.
    expect(stored[0]?.sale_price_cents).toBeNull();
    expect(stored[0]?.apr).toBeNull();

    expectOk(
      await run("INSERT INTO offer_flags (offer_id, flag) VALUES ($1, 'payment_packing')", [offerId]),
    );
    expectOk(
      await run("INSERT INTO offer_flags (offer_id, flag) VALUES ($1, 'above_market')", [offerId]),
    );
    const duplicate = await failure(
      "INSERT INTO offer_flags (offer_id, flag) VALUES ($1, 'above_market')",
      [offerId],
    );
    expect(duplicate.code).toBe('unique_violation');
  });

  it('cannot store the pre-ADR-002 flag name at all', async () => {
    const offerId = await scalar(
      'INSERT INTO offers (account_id, deal_id) VALUES ($1, $2) RETURNING id AS v',
      [ids.accountA, ids.dealA],
    );
    const error = await failure(
      "INSERT INTO offer_flags (offer_id, flag) VALUES ($1, 'packed_payment')",
      [offerId],
    );
    expect(error.code).toBe('check_violation');
  });

  // ---- T12 · instance-bound valuation (AC-9, ADR-007) -------------------

  it('has no deal_id on valuation_snapshots — a make/model price is unrepresentable', async () => {
    const found = await rows(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'valuation_snapshots' AND column_name = 'deal_id'`,
      [SCHEMA],
    );
    expect(found).toEqual([]);
  });

  it('refuses a snapshot with no vehicle instance', async () => {
    const error = await failure(
      `INSERT INTO valuation_snapshots (account_id, retail_cents, source, captured_at)
       VALUES ($1, 2900000, 'mock-kbb', now())`,
      [ids.accountA],
    );
    expect(error.code).toBe('not_null_violation');
  });

  it('stores a retail band with the other three absent, and absent stays absent', async () => {
    const snapshotId = await scalar(
      `INSERT INTO valuation_snapshots (account_id, vehicle_instance_id, retail_cents, source, captured_at)
       VALUES ($1, $2, 2850000, 'mock-kbb', now()) RETURNING id AS v`,
      [ids.accountA, ids.instanceA],
    );
    const stored = await rows<{ wholesale_cents: string | null; retail_cents: string }>(
      'SELECT wholesale_cents, retail_cents FROM valuation_snapshots WHERE id = $1',
      [snapshotId],
    );
    expect(stored[0]?.wholesale_cents).toBeNull();
    expect(Number(stored[0]?.retail_cents)).toBe(2850000);
  });

  it('gives one thread exactly one vehicle instance', async () => {
    const error = await failure(
      `INSERT INTO vehicle_instances (account_id, thread_id, year, condition)
       VALUES ($1, $2, 2019, 'new')`,
      [ids.accountA, ids.threadA],
    );
    expect(error.code).toBe('unique_violation');
  });

  // ---- T15 · the keyed writes that make redelivery safe -----------------

  it('rejects a redelivered dealer message on (deal_id, message_ref)', async () => {
    const insert = `INSERT INTO messages (account_id, deal_id, thread_id, channel, direction,
                                          author, body, occurred_at, message_ref, origin_kind, origin_source)
                    VALUES ($1, $2, $3, 'sms', 'in', 'dealer', 'best I can do', now(),
                            'provider-msg-1', 'provider', 'mock-sms')`;
    expectOk(await run(insert, [ids.accountA, ids.dealA, ids.threadA]));
    const error = await failure(insert, [ids.accountA, ids.dealA, ids.threadA]);
    expect(error.code).toBe('unique_violation');
    expect(error.constraint).toBe('messages_deal_message_ref_uk');
  });

  it('refuses a fabricated dealer-authored note on the message spine too', async () => {
    const error = await failure(
      `INSERT INTO messages (account_id, deal_id, thread_id, channel, direction, author,
                             body, occurred_at, message_ref, origin_kind)
       VALUES ($1, $2, $3, 'note', 'internal', 'dealer', 'they said', now(), 'note:1', 'in_app')`,
      [ids.accountA, ids.dealA, ids.threadA],
    );
    expect(error.code).toBe('check_violation');
  });

  it('binds one live identity to at most one deal, platform-wide', async () => {
    expectOk(
      await run(
        `INSERT INTO deal_identities (account_id, deal_id, identity_id, phone_number, bound_at)
         VALUES ($1, $2, 'id-1', '+15550001111', now())`,
        [ids.accountA, ids.dealA],
      ),
    );
    // Deliberately crosses the account boundary: inbound routing happens before
    // any account is known, so "a dealer reaches a stranger" must be impossible.
    const error = await failure(
      `INSERT INTO deal_identities (account_id, deal_id, identity_id, phone_number, bound_at)
       VALUES ($1, $2, 'id-2', '+15550001111', now())`,
      [ids.accountB, ids.dealB],
    );
    expect(error.code).toBe('unique_violation');
  });

  it('processes an event once, platform-wide', async () => {
    const insert = `INSERT INTO processed_events (consumer, idempotency_key)
                    VALUES ('comms', 'evt-1')`;
    expectOk(await run(insert));
    expect((await failure(insert)).code).toBe('unique_violation');
  });

  it('gives one deal one thread per dealership', async () => {
    const error = await failure(
      'INSERT INTO dealer_threads (account_id, deal_id, dealership_id) VALUES ($1, $2, $3)',
      [ids.accountA, ids.dealA, ids.dealership],
    );
    expect(error.code).toBe('unique_violation');
    expect(error.constraint).toBe('dealer_threads_deal_dealership_uk');
  });
});
