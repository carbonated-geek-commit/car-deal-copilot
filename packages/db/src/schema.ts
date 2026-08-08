/**
 * The schema's VOCABULARY — identifiers, not row shapes (docs/design/T-016.md
 * D10; T-015 §2.2 rule 5: "Row shapes stay inside `@store-pg`").
 *
 * `@db` publishes what a caller must be able to NAME: table names, pg enum
 * type names with their label tuples, the constraint names T-017 matches on,
 * and which tables carry an account scope. It publishes no interface describing
 * a row, because a row interface here would be a second definition of the spine
 * in a different file (ADR-001).
 *
 * The label tuples buy the one test that makes AC-2 mechanical: every pg enum's
 * labels are compared against the corresponding frozen array in `@core`, so a
 * spine change breaks the DB suite instead of silently diverging.
 */

export const TABLES = {
  accounts: 'accounts',
  dealerships: 'dealerships',
  dealership_contacts: 'dealership_contacts',
  deals: 'deals',
  dealer_threads: 'dealer_threads',
  vehicle_instances: 'vehicle_instances',
  thread_contact_points: 'thread_contact_points',
  offers: 'offers',
  offer_fees: 'offer_fees',
  offer_flags: 'offer_flags',
  messages: 'messages',
  message_attachments: 'message_attachments',
  valuation_snapshots: 'valuation_snapshots',
  vehicle_data: 'vehicle_data',
  receipt_bundles: 'receipt_bundles',
  receipt_entries: 'receipt_entries',
  object_refs: 'object_refs',
  deal_documents: 'deal_documents',
  dossiers: 'dossiers',
  deal_identities: 'deal_identities',
  processed_events: 'processed_events',
  quarantined_payloads: 'quarantined_payloads',
  unrouted_inbound: 'unrouted_inbound',
  schema_migrations: 'schema_migrations',
} as const;

/**
 * pg enum type name → its labels, in creation order (migration `0002`).
 *
 * The first nine mirror a frozen array in `@core` label-for-label; the rest are
 * infrastructure sourced from `@receipt`, `@comms`, and specs/00 "Store".
 */
export const PG_ENUMS: Readonly<Record<string, readonly string[]>> = {
  deal_path: ['online', 'hybrid', 'in_person'],
  deal_status: ['draft', 'active', 'negotiating', 'closed', 'burned'],
  message_channel: ['call', 'sms', 'email', 'note'],
  message_direction: ['in', 'out', 'internal'],
  message_author: ['dealer', 'buyer', 'concierge'],
  vehicle_condition: ['new', 'used', 'certified'],
  dealership_contact_role: [
    'general_manager',
    'sales_manager',
    'finance_manager',
    'sales_agent',
  ],
  process_step: [
    'information_gather',
    'deal_negotiation',
    'deal_approval',
    'financing',
    'final_sale',
    'pickup',
  ],
  // ADR-002: `payment_packing`, never `packed_payment`. ADR-007: `above_market`.
  offer_flag: ['payment_packing', 'rate_markup', 'junk_fee', 'over_walkaway', 'above_market'],
  receipt_entry_kind: ['note', 'sms', 'email', 'call_meta'],
  message_origin_kind: ['provider', 'in_app'],
  unrouted_reason: ['no_identity_match', 'no_thread_match'],
  object_ref_kind: ['email_attachment', 'document', 'dossier', 'raw_payload'],
  contact_point_kind: ['phone', 'email'],
};

/**
 * Tables the ACCOUNT SCOPE applies to: `account_id NOT NULL`, participating in
 * a composite foreign key whose chain terminates at `accounts`.
 */
export const ACCOUNT_SCOPED_TABLES: readonly string[] = [
  TABLES.deals,
  TABLES.dealership_contacts,
  TABLES.dealer_threads,
  TABLES.vehicle_instances,
  TABLES.thread_contact_points,
  TABLES.offers,
  TABLES.messages,
  TABLES.valuation_snapshots,
  TABLES.vehicle_data,
  TABLES.receipt_bundles,
  TABLES.receipt_entries,
  TABLES.object_refs,
  TABLES.message_attachments,
  TABLES.deal_documents,
  TABLES.dossiers,
  TABLES.deal_identities,
];

/**
 * Deliberately account-free, each for a stated reason (design §3.9) — an
 * explicit exception a reviewer can weigh, never a gap:
 *
 * - `dealerships` — the tenancy rule itself; an account column here is the bug.
 * - `accounts` — the scope ROOT. It does not carry an account reference; it is
 *   the account, and every scoped chain terminates here.
 * - `offer_fees`, `offer_flags` — child rows reachable only through an offer.
 * - `processed_events` — consumer-idempotency ledger over opaque keys.
 * - `quarantined_payloads` — unparseable, therefore unattributable.
 * - `unrouted_inbound` — `account_id` is nullable and present when known.
 * - `schema_migrations` — runner bookkeeping.
 */
export const GLOBAL_TABLES: readonly string[] = [
  TABLES.dealerships,
  TABLES.accounts,
  TABLES.offer_fees,
  TABLES.offer_flags,
  TABLES.processed_events,
  TABLES.quarantined_payloads,
  TABLES.unrouted_inbound,
  TABLES.schema_migrations,
];

/**
 * Stable constraint names T-017 matches on — `ON CONFLICT` targets and error
 * disambiguation. **Renaming one is a breaking change to this interface.**
 */
export const CONSTRAINTS = {
  message_dedupe: 'messages_deal_message_ref_uk',
  receipt_dedupe: 'receipt_entries_bundle_dedupe_uidx',
  receipt_seq: 'receipt_entries_bundle_seq_uk',
  processed_event: 'processed_events_pkey',
  thread_per_dealership: 'dealer_threads_deal_dealership_uk',
  identity_phone_active: 'deal_identities_phone_active_uidx',
  identity_email_active: 'deal_identities_email_active_uidx',
  contact_account_fk: 'dealer_threads_contact_fk',
  dealership_natural: 'dealerships_natural_uidx',
} as const;

/**
 * The privileges the application role (`APP_ROLE`) is granted on each table, as
 * the migrations grant them.
 *
 * Exported so the append-only guarantee is checked against a stated expectation
 * rather than against whatever the database happens to contain: `receipt_entries`
 * is exactly `SELECT, INSERT` (AC-6), and **no table anywhere grants DELETE or
 * TRUNCATE** — nothing in this schema is ever deleted (design D5; specs/01: a
 * burned thread is "archived (never deleted)").
 *
 * `schema_migrations` is runner bookkeeping created outside the migration set;
 * the application role holds nothing on it.
 */
export const TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  accounts: ['SELECT', 'INSERT', 'UPDATE'],
  dealerships: ['SELECT', 'INSERT', 'UPDATE'],
  dealership_contacts: ['SELECT', 'INSERT', 'UPDATE'],
  deals: ['SELECT', 'INSERT', 'UPDATE'],
  dealer_threads: ['SELECT', 'INSERT', 'UPDATE'],
  vehicle_instances: ['SELECT', 'INSERT', 'UPDATE'],
  thread_contact_points: ['SELECT', 'INSERT', 'UPDATE'],
  offers: ['SELECT', 'INSERT', 'UPDATE'],
  offer_fees: ['SELECT', 'INSERT', 'UPDATE'],
  offer_flags: ['SELECT', 'INSERT', 'UPDATE'],
  messages: ['SELECT', 'INSERT', 'UPDATE'],
  message_attachments: ['SELECT', 'INSERT', 'UPDATE'],
  valuation_snapshots: ['SELECT', 'INSERT', 'UPDATE'],
  vehicle_data: ['SELECT', 'INSERT', 'UPDATE'],
  receipt_bundles: ['SELECT', 'INSERT', 'UPDATE'],
  // AC-6, layer (a): the application literally does not hold the verbs.
  receipt_entries: ['SELECT', 'INSERT'],
  object_refs: ['SELECT', 'INSERT', 'UPDATE'],
  deal_documents: ['SELECT', 'INSERT', 'UPDATE'],
  dossiers: ['SELECT', 'INSERT', 'UPDATE'],
  deal_identities: ['SELECT', 'INSERT', 'UPDATE'],
  processed_events: ['SELECT', 'INSERT', 'UPDATE'],
  quarantined_payloads: ['SELECT', 'INSERT', 'UPDATE'],
  unrouted_inbound: ['SELECT', 'INSERT', 'UPDATE'],
  schema_migrations: [],
};
